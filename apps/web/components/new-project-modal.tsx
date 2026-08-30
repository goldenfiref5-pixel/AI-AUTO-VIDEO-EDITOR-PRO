'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ASPECT_RATIOS,
  DURATION_PRESETS,
  SUPPORTED_LANGUAGES,
  type AspectRatio,
  type Project,
} from '@aiedit/shared';
import { ApiError, api } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Modal } from './ui/modal';
import { Field, Input, Select } from './ui/primitives';

const RATIO_LABELS: Record<AspectRatio, { label: string; hint: string; box: string }> = {
  '9:16': { label: 'Vertical', hint: 'Reels, Shorts, TikTok', box: 'h-12 w-7' },
  '16:9': { label: 'Horizontal', hint: 'YouTube, landscape', box: 'h-7 w-12' },
  '1:1': { label: 'Square', hint: 'Feed posts', box: 'h-10 w-10' },
};

export function NewProjectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();

  const [name, setName] = useState('');
  const [videoTitle, setVideoTitle] = useState('');
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('9:16');
  const [durationChoice, setDurationChoice] = useState<string>('60');
  const [customDuration, setCustomDuration] = useState('');
  const [language, setLanguage] = useState('auto');
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;

    const targetDurationSec =
      durationChoice === 'auto'
        ? null
        : durationChoice === 'custom'
          ? Number(customDuration) || null
          : Number(durationChoice);

    setBusy(true);
    try {
      const { project } = await api.post<{ project: Project }>('/api/projects', {
        name: name.trim(),
        videoTitle: videoTitle.trim() || null,
        aspectRatio,
        targetDurationSec,
        language,
      });
      toast.success('Project created', 'Upload a voiceover to start the pipeline.');
      onClose();
      router.push(`/projects/${project.id}`);
    } catch (err) {
      toast.error('Could not create the project', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New project"
      description="Set the format now — the voiceover you upload next drives everything else."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button form="new-project-form" type="submit" loading={busy} disabled={!name.trim()}>
            Create project
          </Button>
        </>
      }
    >
      <form id="new-project-form" onSubmit={onSubmit} className="space-y-4">
        <Field label="Project name" htmlFor="project-name">
          <Input
            id="project-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Village Treasure Story"
            required
            autoFocus
          />
        </Field>

        <Field label="Video title" htmlFor="video-title" hint="Optional — the story analyser suggests one if you leave it blank.">
          <Input
            id="video-title"
            value={videoTitle}
            onChange={(e) => setVideoTitle(e.target.value)}
            placeholder="The Treasure Map"
          />
        </Field>

        <div>
          <span className="label">Aspect ratio</span>
          <div className="grid grid-cols-3 gap-2">
            {ASPECT_RATIOS.map((ratio) => {
              const meta = RATIO_LABELS[ratio];
              const active = aspectRatio === ratio;
              return (
                <button
                  key={ratio}
                  type="button"
                  onClick={() => setAspectRatio(ratio)}
                  aria-pressed={active}
                  className={cn(
                    'flex flex-col items-center gap-2 rounded-lg border p-3 transition-colors',
                    active ? 'border-brand bg-brand-subtle' : 'border-line hover:border-line-strong',
                  )}
                >
                  <span
                    className={cn(
                      'rounded-sm border-2',
                      meta.box,
                      active ? 'border-brand' : 'border-line-strong',
                    )}
                  />
                  <span className="text-xs font-medium text-ink">{meta.label}</span>
                  <span className="text-[10px] text-ink-faint">{meta.hint}</span>
                </button>
              );
            })}
          </div>
        </div>

        <Field
          label="Desired duration"
          htmlFor="duration"
          hint="Guidance for scene pacing. The finished video always matches the length of your voiceover."
        >
          <Select id="duration" value={durationChoice} onChange={(e) => setDurationChoice(e.target.value)}>
            <option value="auto">Match the voiceover exactly</option>
            {DURATION_PRESETS.map((seconds) => (
              <option key={seconds} value={String(seconds)}>
                {seconds < 60 ? `${seconds} seconds` : `${seconds / 60} minute${seconds === 60 ? '' : 's'}`}
              </option>
            ))}
            <option value="custom">Custom…</option>
          </Select>
        </Field>

        {durationChoice === 'custom' ? (
          <Field label="Custom duration (seconds)" htmlFor="custom-duration">
            <Input
              id="custom-duration"
              type="number"
              min={5}
              max={7200}
              value={customDuration}
              onChange={(e) => setCustomDuration(e.target.value)}
              placeholder="90"
            />
          </Field>
        ) : null}

        <Field label="Narration language" htmlFor="language" hint="Auto-detect handles mixed-language narration.">
          <Select id="language" value={language} onChange={(e) => setLanguage(e.target.value)}>
            {SUPPORTED_LANGUAGES.map((entry) => (
              <option key={entry.code} value={entry.code}>
                {entry.label}
              </option>
            ))}
          </Select>
        </Field>
      </form>
    </Modal>
  );
}
