'use client';

import { useRef, useState } from 'react';
import { LIMITS } from '@aiedit/shared';
import { ApiError, api, uploadWithProgress } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { clock, cn, formatBytes } from '@/lib/utils';
import type { ProjectBundle } from '@/lib/use-project';
import { Button } from '../ui/button';
import { EmptyState, ProgressBar } from '../ui/primitives';

const ACCEPTED = '.mp3,.wav,.aac,.m4a,.flac,audio/*';

export function UploadStep({ bundle, onChanged }: { bundle: ProjectBundle; onChanged: () => void }) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<(() => void) | null>(null);

  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [file, setFile] = useState<File | null>(null);

  const transcribing = bundle.project.status === 'transcribing';

  async function upload(selected: File) {
    if (selected.size > LIMITS.maxAudioBytes) {
      toast.error('That file is too large', `The limit is ${formatBytes(LIMITS.maxAudioBytes)}.`);
      return;
    }

    setFile(selected);
    setUploading(true);
    setProgress(0);

    const form = new FormData();
    form.append('file', selected);

    const { promise, abort } = uploadWithProgress(
      `/api/projects/${bundle.project.id}/voiceover`,
      form,
      (fraction) => setProgress(fraction * 100),
    );
    abortRef.current = abort;

    try {
      await promise;
      toast.success('Voiceover uploaded', 'Transcription has started.');
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.code !== 'aborted') {
        toast.error('Upload failed', err.message);
      }
    } finally {
      setUploading(false);
      abortRef.current = null;
    }
  }

  if (transcribing) {
    return (
      <div className="card p-6">
        <h2 className="text-sm font-semibold text-ink">Transcribing your voiceover</h2>
        <p className="mt-1 text-sm text-ink-muted">
          The narration is being converted to a timed transcript. Long files are processed in windows,
          so a two-hour recording keeps working in the background.
        </p>
        <ProgressBar value={bundle.project.progress} className="mt-4" />
        <p className="mt-2 text-xs text-ink-faint">{Math.round(bundle.project.progress)}% complete</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const dropped = e.dataTransfer.files[0];
          if (dropped) void upload(dropped);
        }}
        className={cn(
          'rounded-xl border-2 border-dashed p-10 text-center transition-colors',
          dragging ? 'border-brand bg-brand-subtle' : 'border-line hover:border-line-strong',
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED}
          className="sr-only"
          onChange={(e) => {
            const selected = e.target.files?.[0];
            if (selected) void upload(selected);
            e.target.value = '';
          }}
        />

        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-surface-raised text-ink-muted">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 18V6m0 0-4 4m4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4 20h16" strokeLinecap="round" />
          </svg>
        </div>

        <h2 className="text-sm font-semibold text-ink">Upload your voiceover</h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-ink-muted">
          This single file is the script, the story, the timeline and the caption source. Drop it here
          or browse — MP3, WAV, AAC, M4A and FLAC up to {formatBytes(LIMITS.maxAudioBytes)}.
        </p>

        {uploading ? (
          <div className="mx-auto mt-5 max-w-sm">
            <ProgressBar value={progress} />
            <div className="mt-2 flex items-center justify-between text-xs text-ink-faint">
              <span className="truncate">{file?.name}</span>
              <span>{Math.round(progress)}%</span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() => {
                abortRef.current?.();
                setUploading(false);
              }}
            >
              Cancel upload
            </Button>
          </div>
        ) : (
          <Button className="mt-5" onClick={() => inputRef.current?.click()}>
            Choose audio file
          </Button>
        )}
      </div>

      {bundle.project.status === 'failed' && bundle.project.errorMessage ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 p-3">
          <p className="text-xs font-medium text-danger">Transcription failed</p>
          <p className="mt-1 text-xs text-ink-muted">{bundle.project.errorMessage}</p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={() => {
              const job = bundle.jobs.find((j) => j.type === 'transcribe' && j.status === 'failed');
              if (!job) return;
              void api
                .post(`/api/jobs/${job.id}/retry`)
                .then(() => {
                  toast.info('Retrying transcription');
                  onChanged();
                })
                .catch((err) => toast.error('Retry failed', err instanceof ApiError ? err.message : undefined));
            }}
          >
            Retry transcription
          </Button>
        </div>
      ) : null}

      <div className="card p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">What happens next</h3>
        <ol className="mt-3 space-y-2 text-sm text-ink-muted">
          {[
            'The audio is transcribed with word-level timings.',
            'You review and edit the script — nothing is generated until you approve it.',
            'The story is analysed into scenes, characters and locations.',
            'Scenes are generated, animated, captioned and rendered.',
          ].map((line, index) => (
            <li key={line} className="flex gap-2.5">
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-surface-raised text-[10px] text-ink-faint">
                {index + 1}
              </span>
              {line}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export function VoiceoverSummary({ durationSec, name }: { durationSec: number; name: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-ink-muted">
      <span className="truncate">{name}</span>
      <span className="text-ink-faint">·</span>
      <span className="font-mono">{clock(durationSec)}</span>
    </div>
  );
}

export function NoVoiceover({ onUpload }: { onUpload: () => void }) {
  return (
    <EmptyState
      title="No voiceover uploaded"
      description="Every step of the pipeline is driven by the narration audio."
      action={<Button onClick={onUpload}>Upload voiceover</Button>}
    />
  );
}
