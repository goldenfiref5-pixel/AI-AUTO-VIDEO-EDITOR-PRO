# AI Auto Editor Pro

An automated AI video production platform. A user uploads a **voiceover**, some
**style reference images** and optional **competitor reference videos**; the
system transcribes the narration, plans a storyboard, designs consistent
characters, generates every scene, animates them, syncs captions to the audio,
adds transitions and renders a finished video.

The voiceover is the single source of truth: it is the script, the story, the
timeline, the scene timing and the caption source. No separate script upload
exists, by design.

---

## The workflow

| Step | What the user does | What the system does |
| --- | --- | --- |
| 1 | Create a project (name, aspect ratio, target duration, language) | — |
| 2 | Upload the voiceover | Transcribes it with word-level timings |
| 3 | Review the transcript on **Review Generated Script** | Offers an optional AI improvement pass, as a proposal |
| 4 | Upload style references and competitor videos | Derives a Style DNA profile and a pacing profile |
| 5 | Click **Proceed To Video Generation** | Analyses the story into characters, locations and scenes |
| 6 | Review and edit the storyboard | — |
| 7 | Click **Generate Video** | Generates character sheets, scene images, motion clips |
| 8 | Click **Render** | Burns captions, applies transitions, muxes narration, encodes |

Everything from step 7 onward is automatic.

---

## Architecture

```
apps/
  api/      Express + TypeScript API, BullMQ workers, FFmpeg renderer
  web/      Next.js 14 App Router UI (React, TypeScript, Tailwind)
packages/
  shared/   Domain types, zod schemas, enums and presets shared by both
infra/      Dockerfiles
```

**Data:** PostgreSQL for all state, Redis for queues, locks and progress pub/sub,
local disk or S3/R2 for media.

**Processes:** the API and the workers are the same image with different
entrypoints. Workers can be scaled horizontally; the API can run behind a load
balancer.

### The pipeline

```
voiceover ──► transcribe ──► [user approves] ──► analyse references
                                                       │
                                                       ▼
                                                story analysis
                                          (characters, scenes, timing)
                                                       │
                                                       ▼
                                            [user reviews storyboard]
                                                       │
                              ┌────────────────────────┴───────────────┐
                              ▼                                        ▼
                    character sheets                            scene images
                              └────────────────────┬───────────────────┘
                                                   ▼
                                            motion clips (Veo)
                                                   ▼
                                    render: Ken Burns / clips → xfade
                                        → burned ASS captions
                                        → narration mux → encode
```

Each stage is a row in `jobs` plus a BullMQ job. Stages declare dependencies, so
motion generation waits for image generation without a scheduler.

---

## Key design decisions

**Timing is derived from the audio, never estimated.** The transcript carries
word-level timings. Scene boundaries are assigned by walking that word stream, so
a scene's start is a real word's start. The result is measured and reported as
"drift" in the timeline UI and in the quality report.

**Transcript edits keep their timing.** Editing the script would normally destroy
sync. Instead an LCS alignment matches the edited text against the original word
stream: surviving words keep their exact timings, and inserted runs are
distributed across the gap weighted by syllable count.

**Character consistency is an image problem, not a prompt problem.** Text
descriptions drift between generations. Each character gets a *reference sheet* —
one clean portrait — that is passed as a conditioning image into every scene
featuring them. That is what Character Lock actually does.

**Style DNA is a prompt fragment, not a mood board.** Reference images are
analysed once into a dense, comma-separated descriptor appended verbatim to every
scene prompt, plus the reference frames themselves when Style Lock is on.

**Transitions preserve sync.** `xfade` shortens a concatenation by the transition
duration. Each scene clip is therefore rendered *longer* by exactly the duration
of the transition that follows it, so the on-screen timeline still tiles the
narration precisely.

**Renders resume.** Normalised per-scene clips are content-addressed and cached
per project, so a retried render re-encodes only what changed.

**API keys fail over.** Every Gemini call goes through a key pool that walks keys
in priority order (or round-robin in load-balance mode), classifies each failure,
benches rate-limited keys on a cooldown, and disables genuinely invalid ones.

**AI never edits without approval.** The Improve Script action returns a diff for
review. Nothing is written until the user accepts it.

---

## Removing it again

Docker and its WSL virtual disk take 8-20 GB.  covers how to back
up your projects, remove everything cleanly, and reclaim the space - or keep
Docker but stop it reserving memory when idle.

## Requirements

- Node.js 20.10+ (22 recommended)
- PostgreSQL 14+
- Redis 6+
- FFmpeg 5+ with `libx264`, `libvpx-vp9`, `aac`, `libopus` and `libass`
  (`libass` is required — captions are burned in via the `subtitles` filter)
- At least one Gemini API key

Check your FFmpeg build:

```bash
ffmpeg -filters | grep -E 'xfade|zoompan|subtitles'
```

---

## Quick start (GitHub Codespaces)

Runs entirely in the browser — nothing to install, no port conflicts with
anything on your own machine.

1. On the repository page: **Code ▸ Codespaces ▸ Create codespace on
   `claude/ai-auto-video-editor-sgr2ff`**
2. Wait for it to build, then run:

   ```bash
   docker compose up --build
   ```

3. Open the **Ports** tab, set port **4000** to **Public**
   (right-click ▸ Port Visibility ▸ Public), then click the globe next to port
   **3000**.

The dev container writes the Codespace's own URLs into `.env` for you, so the
app is reachable at `https://<codespace>-3000.app.github.dev` rather than
localhost.

Port 4000 has to be public because the browser calls the API directly from the
web app's origin; a private forwarded port answers with a GitHub auth redirect
instead of JSON.

Two caveats worth knowing: Codespaces bills against your monthly free hours
(the default 2-core machine works but renders slowly — 4 cores is much better),
and a Codespace is a development environment, not somewhere to host this for
real users.

## Quick start (Docker)

> **Just want to try it on your own machine?** Read
> [`PORTABLE-SETUP.md`](PORTABLE-SETUP.md) instead — double-click
> `START-WINDOWS.bat` (Windows) or run `./start.sh` (macOS/Linux) and it
> configures itself.

```bash
cp .env.example .env

# Fill in the two required secrets:
openssl rand -base64 48   # → JWT_SECRET
openssl rand -hex 32      # → ENCRYPTION_KEY

docker compose up --build
```

Then open <http://localhost:3000>. The first account you create becomes the
administrator. Add a Gemini API key under **API management** before creating a
project.

### Something not reachable?

```bash
./doctor.sh                 # macOS and Linux
DOCTOR-WINDOWS.bat          # Windows
```

It checks whether the checkout is current, whether `.env` is being read, what
the containers actually published, and whether the app answers — then prints the
one command that fixes what it found.

### Running on different ports

If something already uses 3000/4000/5432/6379, set these in `.env` — only the
host side moves, containers keep talking to each other on the standard ports:

```bash
WEB_PORT=3100
API_PORT=4100
POSTGRES_PORT=5433
REDIS_PORT=6380

# These must match, or sign-in and uploads fail on CORS.
API_PUBLIC_URL=http://localhost:4100
WEB_PUBLIC_URL=http://localhost:3100
CORS_ORIGINS=http://localhost:3100
```

Then `docker compose up --build`, and open <http://localhost:3100>.

`NEXT_PUBLIC_API_URL` is baked into the browser bundle at build time, so after
changing the API port rebuild the web image rather than just restarting it:
`docker compose up --build web`.

## Quick start (local)

```bash
npm install
npm run build:shared

createdb aiedit
cp .env.example .env      # set DATABASE_URL, REDIS_URL, ENCRYPTION_KEY
npm run migrate
npm run seed              # optional: demo account and starter templates

npm run dev               # API :4000, worker, web :3000
```

`npm run dev` runs the API, a worker and the web app together.

To use different ports locally, set `PORT` (API) and `WEB_PORT` (web) in `.env`
alongside `DATABASE_URL`, `REDIS_URL`, `API_PUBLIC_URL`, `WEB_PUBLIC_URL`,
`CORS_ORIGINS` and `NEXT_PUBLIC_API_URL`.

---

## Configuration

Every setting lives in `.env`; see `.env.example` for the annotated list. The
ones that matter most:

| Variable | Purpose |
| --- | --- |
| `ENCRYPTION_KEY` | 32 bytes, hex or base64. Encrypts stored Gemini keys (AES-256-GCM). **Required in production.** |
| `JWT_SECRET` | Signs access tokens. **Required in production.** |
| `STORAGE_DRIVER` | `local` or `s3`. `s3` also covers Cloudflare R2 and any S3-compatible store. |
| `GEMINI_IMAGE_MODEL` | Image generation model. |
| `GEMINI_VIDEO_MODEL` | Image-to-video model. |
| `GENERATION_CONCURRENCY` | Parallel scene generations per worker. |
| `RENDER_CONCURRENCY` | Parallel renders per worker. Each render is CPU-heavy. |
| `GEMINI_FALLBACK_API_KEY` | Optional single-tenant fallback used only when a user has no keys of their own. |

### Scaling

- **More throughput:** raise `WORKER_REPLICAS`, and switch the key pool to
  load-balance mode with several keys.
- **Faster rendering:** raise `RENDER_CONCURRENCY` only as far as your CPU
  allows — FFmpeg saturates cores quickly.
- **Cheaper output:** turn off *Generate motion clips* in project settings. Ken
  Burns moves on the stills cost nothing and render far faster.

---

## Performance characteristics

| Capability | How it is handled |
| --- | --- |
| 2+ hour audio | Transcribed in 10-minute overlapping windows, merged on the seams |
| 100,000+ word transcripts | Story analysis chunks at ~3,500 words, carrying character continuity forward |
| 500+ scenes | Rendering batches 40 scenes per intermediate file; batch boundaries prefer existing hard cuts |
| Interrupted renders | Per-scene clips are content-addressed and cached per project |
| Crashed workers | Stranded jobs are reclaimed and re-queued at worker boot |
| Real-time progress | Redis pub/sub fans out to per-project SSE streams |

---

## API surface

All routes are under `/api`. Authentication is a bearer token; refresh tokens are
httpOnly cookies (also returned in the body for non-browser clients).

| Area | Routes |
| --- | --- |
| Auth | `POST /auth/register`, `/auth/login`, `/auth/google`, `/auth/refresh`, `/auth/logout`, `GET /auth/me` |
| Projects | `GET|POST /projects`, `GET|PATCH|DELETE /projects/:id` |
| Uploads | `POST /projects/:id/voiceover`, `/style-references`, `/competitor-videos`, `/competitor-urls` |
| Transcript | `GET|PUT /projects/:id/transcript`, `/transcript/enhance`, `/transcript/search-replace`, `/transcript/restore/:version`, `/transcript/approve` |
| Storyboard | `GET /projects/:id/scenes`, `PATCH /scenes/:sceneId`, `/split`, `/merge`, `/retime`, `/regenerate-prompt`, `POST /scenes/reorder` |
| Characters | `GET /projects/:id/characters`, `PATCH|DELETE /characters/:characterId` |
| Style | `GET|PATCH /projects/:id/style-dna` |
| Generation | `POST /projects/:id/generate`, `/render`, `GET /renders`, `/quality`, `/captions` |
| Progress | `GET /projects/:id/progress` (SSE) |
| Jobs | `GET /jobs`, `POST /jobs/:id/cancel`, `/retry`, `/pause`, `/resume` |
| API keys | `GET|POST /api-keys`, `PATCH|DELETE /api-keys/:id`, `POST /api-keys/:id/test`, `/test-all`, `/reorder`, `GET|PUT /api-keys/settings` |
| Templates | `GET|POST /templates`, `PATCH|DELETE /templates/:id`, `POST /templates/:id/apply`, `/from-project` |
| Admin | `GET /admin/stats`, `/usage`, `/users`, `/failures`, `/health`, `/queues` |

`GET /health` and `GET /ready` sit outside `/api` for load balancers.

---

## Testing

```bash
npm test                    # all workspaces
npm test --workspace @aiedit/api
```

The suite covers the parts where a subtle bug is expensive and invisible:
transcript re-alignment, caption cue grouping and ASS generation, transition
resolution and Ken Burns filter construction, LLM JSON repair, and secret
encryption.

---

## Known limitations

These are deliberate, and worth knowing before you deploy:

- **Duration targets are guidance.** The finished video always matches the
  voiceover. If the requested duration differs by more than 10%, the quality
  report says so rather than silently retiming the narration.
- **Reference video URLs must point at a media file.** Platform watch pages
  (YouTube, TikTok, …) serve HTML, and extracting streams from them is a
  licensing decision rather than a technical one. Download and upload the file.
- **Transitions at a render batch boundary become hard cuts.** Boundaries are
  chosen to land on existing hard cuts where possible, and any downgrade is
  reported in the quality report.
- **The typewriter caption animation is approximated.** A true per-character
  typewriter needs one subtitle event per character, which is unusable at
  transcript length.
- **Revenue metrics read the `users.plan` and `users.monthly_price_usd` columns.**
  There is no billing integration; wire your payment provider to those fields.
- **Generated clips carry no audio.** The user's voiceover is the only audio
  source, by design.

---

## Security notes

- Gemini API keys are encrypted at rest with AES-256-GCM and are never returned
  to the browser — only a masked form is.
- Refresh tokens are stored hashed and rotate on every use.
- Google ID tokens are verified locally against Google's JWKS, checking
  signature, issuer, audience and expiry.
- Reference-video URLs are fetched with DNS resolution checks on every redirect
  hop, rejecting private address ranges (SSRF protection), with size and time
  budgets.
- The SSE progress stream is the one route that accepts a token as a query
  parameter, because `EventSource` cannot set headers. Its URLs are excluded
  from request logging.
