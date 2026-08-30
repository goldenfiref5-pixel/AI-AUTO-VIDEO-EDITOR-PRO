# Architecture

This document explains how the platform is put together and, where a decision
was non-obvious, why it was made that way.

## Processes

Three long-lived processes:

- **API** (`apps/api/src/server.ts`) — Express, serves the REST surface and the
  SSE progress streams. Runs migrations at boot.
- **Worker** (`apps/api/src/worker.ts`) — BullMQ consumer for three queues.
  Shares the API image; only the entrypoint differs.
- **Web** (`apps/web`) — Next.js App Router. Entirely client-rendered inside the
  authenticated shell, because every view is live data.

Redis carries the queues, cooperative-cancellation flags, distributed locks and
progress pub/sub. PostgreSQL holds all durable state.

## Queues

| Queue | Stages | Default concurrency |
| --- | --- | --- |
| `aiedit:analysis` | transcribe, analyze_references, story_analysis | `ANALYSIS_CONCURRENCY` |
| `aiedit:generation` | generate_images, generate_clips | `GENERATION_CONCURRENCY` |
| `aiedit:render` | render | `RENDER_CONCURRENCY` |

Rendering is separated because it is CPU-bound while generation is
network-bound; mixing them means one starves the other.

Stage dependencies live in the job payload (`dependsOn`). A dependent job that
finds its upstream still running re-delays itself rather than blocking a worker
slot. This is deliberately simpler than BullMQ flows: the dependency graph here
is a short chain, and re-checking on wake also handles the case where the
upstream job was retried.

### Cancellation

BullMQ cannot kill a running job, so cancellation is cooperative. `requestCancel`
sets a flag in both Redis and PostgreSQL; long stages call `assertNotCancelled`
at their checkpoints, and the renderer polls it into an `AbortSignal` that kills
the FFmpeg child process.

### Crash recovery

At boot the worker reclaims jobs stuck in a running state for more than 30
minutes and re-queues them. Combined with the per-scene render cache, a killed
worker costs minutes rather than a whole render.

## The Gemini key pool

`apps/api/src/gemini/keyPool.ts` is the only path to the Gemini API.

Every failure is classified (`gemini/client.ts#classify`) into a taxonomy that
answers two questions: *is this retryable*, and *is the key at fault*.

| HTTP | Condition | Class | Key at fault | Action |
| --- | --- | --- | --- | --- |
| 400 | "API key not valid" | `invalid_key` | yes | Disable the key |
| 400 | anything else | `bad_request` | no | Fail immediately |
| 401 | — | `invalid_key` | yes | Disable the key |
| 403 | expired/disabled | `invalid_key` | yes | Disable the key |
| 403 | otherwise | `permission` | yes | Mark blocked |
| 429 | quota language | `quota` | yes | Bench for ≥15 min |
| 429 | rate language | `rate_limit` | yes | Bench for the cooldown |
| 5xx | — | `server` | no | Retry with backoff |

A key at fault moves the request to the next key immediately. A transient
upstream failure retries on the same key with jittered exponential backoff. When
every key is exhausted, the last error surfaces as a 503.

Concurrency is capped per key with a semaphore, so one project cannot saturate a
key that other projects are sharing.

## Timing

The single most important invariant: **the timeline tiles the narration
exactly**.

1. Transcription returns word-level timings. Long audio is windowed at 10
   minutes with 4 seconds of overlap; segments starting before the committed
   boundary are dropped so the seam does not duplicate.
2. Story analysis produces scenes whose narration should be verbatim slices.
   Because models paraphrase, `assignTiming` consumes the word stream greedily
   with a 40-word lookahead resync: a scene claims as many words as its
   narration contains, and a mismatch is re-anchored rather than allowed to
   desynchronise everything downstream.
3. Scene boundaries are made contiguous — each scene's end is the next scene's
   start — and clamped to the transcript duration.
4. `enforceDurationBounds` merges shots too short to read and splits shots that
   overstay, always on word boundaries.
5. Rendering adds the transition tail to each clip so `xfade` consumes it,
   preserving the on-screen durations.

Residual drift is computed and shown in the timeline UI and scored in the
quality report. It is never hidden.

### Transcript editing

`pipeline/align.ts` re-times an edited transcript against the original word
timings using a longest-common-subsequence match over normalised tokens.
Surviving words keep their exact timings; unanchored runs are interpolated
across the gap between their neighbours, weighted by estimated syllable count.

The naive LCS table is O(n·m), which is unusable on a 100,000-word transcript,
so the alignment is windowed at 1,200 tokens with resynchronisation at the last
matched pair.

## Rendering

`apps/api/src/render/renderer.ts`:

1. **Plan transitions** for every cut, so clip lengths can include the tail each
   crossfade will consume.
2. **Normalise each scene** into a canvas-sized, constant-frame-rate, silent
   clip of exactly its on-screen duration. A generated motion clip is retimed
   (0.5×–2×) to fit, then padded by cloning the last frame if it still falls
   short. A still gets a `zoompan` Ken Burns move matching its camera motion. A
   scene with neither gets a neutral slate, so a failed generation costs one
   shot rather than the render.
3. **Join in batches of 40**, chaining `xfade` for blended cuts and `concat` for
   hard cuts. Batching keeps FFmpeg from opening 500 decoders at once. Batch
   boundaries prefer cuts that are already hard.
4. **Concatenate the batches** with the concat demuxer (stream copy, no
   re-encode).
5. **Final pass**: burn the ASS subtitle file with `subtitles`, mux the
   narration, encode to the target codec and container.

Scene clips are content-addressed on `(scene id, media, motion, duration,
canvas, fps)` and cached at project level, which is what makes an interrupted
render resumable.

## Captions

Captions are generated as Advanced SubStation Alpha rather than SRT because
libass is the only thing FFmpeg can burn that supports word-level highlighting,
karaoke timing and entry animations.

- `word` mode uses `\t` transforms at per-word offsets for a progressive reveal.
- `karaoke` mode uses `\kf` spans in centiseconds.
- `sentence` mode renders the whole cue with keyword highlighting.

Cues break on the word limit, on sentence and clause terminators, and always on
a pause longer than 700 ms — holding a caption over silence reads as a sync
error.

Colours are converted from CSS hex to ASS `&HAABBGGRR` (reversed byte order).
Font sizes are authored against a 1080px canvas and scaled to the real one.
Right-to-left languages have their word order reversed within each cue.

## Quality scoring

Most metrics are deterministic and computed from the project's own data —
character sheet coverage, Style DNA completeness, media coverage, cumulative
timeline drift, word timing coverage and transcription confidence. They are
cheap, reproducible, and cannot hallucinate.

Only story alignment and visual direction go to a model, and a failure there
degrades to a neutral score rather than blocking the export.

## Storage

`lib/storage.ts` presents one interface over local disk and S3-compatible object
storage. Both drivers implement `downloadTo`, because FFmpeg needs real file
paths and cannot read from an object store.

With the local driver, downloads are proxied through the API. With S3, the
client receives presigned URLs and the API is out of the data path.

## Security

- Gemini keys: AES-256-GCM at rest, HMAC fingerprint for dedupe, never returned
  to the browser.
- Refresh tokens: stored as SHA-256 hashes, single-use rotation.
- Google sign-in: local JWKS verification of signature, issuer, audience, expiry.
- URL ingestion: DNS resolution checked against private ranges on every redirect
  hop, plus size and time budgets.
- Uploads: written to disk, not buffered in memory, then probed with `ffprobe`
  before anything is trusted.
