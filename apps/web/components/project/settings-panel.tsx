'use client';

import { useMemo, useState } from 'react';
import {
  CAPTION_ANIMATIONS,
  CAPTION_MODES,
  CAPTION_POSITIONS,
  CAPTION_STYLES,
  EXPORT_FORMATS,
  EXPORT_RESOLUTIONS,
  FRAME_RATES,
  TRANSITIONS,
  captionPreset,
  type CaptionSettings,
  type ProjectSettings,
} from '@aiedit/shared';
import { ApiError, api } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { ProjectBundle } from '@/lib/use-project';
import { Button } from '../ui/button';
import { Field, Input, Select, Toggle } from '../ui/primitives';

/**
 * Caption, transition and export configuration, with a live preview of the
 * caption treatment so the choice is visual rather than a list of numbers.
 */
export function SettingsPanel({
  bundle,
  onChanged,
}: {
  bundle: ProjectBundle;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [settings, setSettings] = useState<ProjectSettings>(bundle.project.settings);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  function update(patch: Partial<ProjectSettings>) {
    setSettings((current) => ({ ...current, ...patch }));
    setDirty(true);
  }

  function updateCaption(patch: Partial<CaptionSettings>) {
    setSettings((current) => ({ ...current, caption: { ...current.caption, ...patch } }));
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/api/projects/${bundle.project.id}`, { settings });
      toast.success('Settings saved');
      setDirty(false);
      onChanged();
    } catch (err) {
      toast.error('Could not save settings', err instanceof ApiError ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <section className="card p-4">
        <h3 className="mb-3 text-sm font-semibold text-ink">Captions</h3>

        <Toggle
          checked={settings.caption.enabled}
          onChange={(enabled) => updateCaption({ enabled })}
          label="Burn captions into the video"
          description="Word-level timings come straight from the approved transcript."
        />

        {settings.caption.enabled ? (
          <>
            <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-6">
              {CAPTION_STYLES.map((style) => (
                <button
                  key={style}
                  type="button"
                  onClick={() => {
                    // Preset swaps everything except the user's own keywords.
                    updateCaption({ ...captionPreset(style), keywords: settings.caption.keywords });
                  }}
                  className={cn(
                    'rounded-lg border px-2 py-2 text-xs capitalize transition-colors',
                    settings.caption.style === style
                      ? 'border-brand bg-brand-subtle text-ink'
                      : 'border-line text-ink-muted hover:border-line-strong',
                  )}
                >
                  {style}
                </button>
              ))}
            </div>

            <CaptionPreview settings={settings.caption} aspectRatio={bundle.project.aspectRatio} />

            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Sync mode">
                <Select
                  value={settings.caption.mode}
                  onChange={(e) => updateCaption({ mode: e.target.value as CaptionSettings['mode'] })}
                >
                  {CAPTION_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {mode === 'word' ? 'Word by word' : mode === 'karaoke' ? 'Karaoke' : 'Sentence'}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Position">
                <Select
                  value={settings.caption.position}
                  onChange={(e) => updateCaption({ position: e.target.value as CaptionSettings['position'] })}
                >
                  {CAPTION_POSITIONS.map((position) => (
                    <option key={position} value={position}>
                      {position}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Animation">
                <Select
                  value={settings.caption.animation}
                  onChange={(e) => updateCaption({ animation: e.target.value as CaptionSettings['animation'] })}
                >
                  {CAPTION_ANIMATIONS.map((animation) => (
                    <option key={animation} value={animation}>
                      {animation}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Font family">
                <Input
                  value={settings.caption.fontFamily}
                  onChange={(e) => updateCaption({ fontFamily: e.target.value })}
                />
              </Field>

              <Field label="Font size" hint="Relative to a 1080px canvas.">
                <Input
                  type="number"
                  min={8}
                  max={200}
                  value={settings.caption.fontSize}
                  onChange={(e) => updateCaption({ fontSize: Number(e.target.value) })}
                />
              </Field>

              <Field label="Words per cue">
                <Input
                  type="number"
                  min={1}
                  max={24}
                  value={settings.caption.maxWordsPerCue}
                  onChange={(e) => updateCaption({ maxWordsPerCue: Number(e.target.value) })}
                />
              </Field>

              <ColorField
                label="Text colour"
                value={settings.caption.primaryColor}
                onChange={(primaryColor) => updateCaption({ primaryColor })}
              />
              <ColorField
                label="Highlight colour"
                value={settings.caption.highlightColor}
                onChange={(highlightColor) => updateCaption({ highlightColor })}
              />
              <ColorField
                label="Outline colour"
                value={settings.caption.outlineColor}
                onChange={(outlineColor) => updateCaption({ outlineColor })}
              />

              <Field label="Outline width">
                <Input
                  type="number"
                  min={0}
                  max={20}
                  step={0.5}
                  value={settings.caption.outlineWidth}
                  onChange={(e) => updateCaption({ outlineWidth: Number(e.target.value) })}
                />
              </Field>

              <Field label="Shadow depth">
                <Input
                  type="number"
                  min={0}
                  max={20}
                  step={0.5}
                  value={settings.caption.shadowDepth}
                  onChange={(e) => updateCaption({ shadowDepth: Number(e.target.value) })}
                />
              </Field>

              <Field label="Vertical margin">
                <Input
                  type="number"
                  min={0}
                  max={1000}
                  value={settings.caption.marginVertical}
                  onChange={(e) => updateCaption({ marginVertical: Number(e.target.value) })}
                />
              </Field>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field
                label="Highlighted keywords"
                hint="Comma separated. These words are painted in the highlight colour."
              >
                <Input
                  value={settings.caption.keywords.join(', ')}
                  onChange={(e) =>
                    updateCaption({
                      keywords: e.target.value
                        .split(',')
                        .map((k) => k.trim().toLowerCase())
                        .filter(Boolean),
                    })
                  }
                  placeholder="treasure, adventure, secret"
                />
              </Field>

              <div className="space-y-1 self-end">
                <Toggle
                  checked={settings.caption.uppercase}
                  onChange={(uppercase) => updateCaption({ uppercase })}
                  label="Uppercase"
                />
                <Toggle
                  checked={settings.caption.emoji}
                  onChange={(emoji) => updateCaption({ emoji })}
                  label="Allow emoji"
                />
              </div>
            </div>
          </>
        ) : null}
      </section>

      <section className="card p-4">
        <h3 className="mb-3 text-sm font-semibold text-ink">Transitions</h3>

        <Toggle
          checked={settings.transition.enabled}
          onChange={(enabled) => update({ transition: { ...settings.transition, enabled } })}
          label="Automatic transitions"
          description="Beat changes get the expressive treatment; cuts inside a beat stay quiet."
        />

        {settings.transition.enabled ? (
          <div className="mt-4 space-y-4">
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="label mb-0">Intensity</span>
                <span className="font-mono text-xs text-ink-muted">
                  {Math.round(settings.transition.intensity * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={settings.transition.intensity}
                onChange={(e) =>
                  update({ transition: { ...settings.transition, intensity: Number(e.target.value) } })
                }
                className="w-full accent-brand"
              />
              <div className="mt-1 flex justify-between text-[10px] text-ink-faint">
                <span>All hard cuts</span>
                <span>Every cut stylised</span>
              </div>
            </div>

            <Field label="Transition duration (seconds)">
              <Input
                type="number"
                min={0.05}
                max={3}
                step={0.05}
                value={settings.transition.durationSec}
                onChange={(e) =>
                  update({ transition: { ...settings.transition, durationSec: Number(e.target.value) } })
                }
              />
            </Field>

            <div>
              <span className="label">Allowed transitions</span>
              <p className="mb-2 text-[11px] text-ink-faint">
                Select none to let the engine pick per cut.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {TRANSITIONS.map((transition) => {
                  const active = settings.transition.types.includes(transition);
                  return (
                    <button
                      key={transition}
                      type="button"
                      onClick={() =>
                        update({
                          transition: {
                            ...settings.transition,
                            types: active
                              ? settings.transition.types.filter((t) => t !== transition)
                              : [...settings.transition.types, transition],
                          },
                        })
                      }
                      className={cn(
                        'rounded-full border px-2.5 py-1 text-xs transition-colors',
                        active
                          ? 'border-brand bg-brand-subtle text-ink'
                          : 'border-line text-ink-muted hover:border-line-strong',
                      )}
                    >
                      {transition.replace(/_/g, ' ')}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ) : null}
      </section>

      <section className="card p-4">
        <h3 className="mb-3 text-sm font-semibold text-ink">Generation and export</h3>

        <div className="space-y-1">
          <Toggle
            checked={settings.motionEnabled}
            onChange={(motionEnabled) => update({ motionEnabled })}
            label="Generate motion clips"
            description="Animate each still with the video model. Disable to use Ken Burns camera moves only — much faster and far cheaper."
          />
          <Toggle
            checked={settings.characterLock}
            onChange={(characterLock) => update({ characterLock })}
            label="Character lock"
            description="Anchor every scene to each character's reference sheet."
          />
          <Toggle
            checked={settings.styleLock}
            onChange={(styleLock) => update({ styleLock })}
            label="Style lock"
            description="Pass your style references into every generation."
          />
          <Toggle
            checked={settings.broll.enabled}
            onChange={(enabled) => update({ broll: { ...settings.broll, enabled } })}
            label="Automatic B-roll"
            description="Generate supporting shots when narration mentions objects, places or concepts."
          />
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Field label="Format">
            <Select
              value={settings.export.format}
              onChange={(e) =>
                update({ export: { ...settings.export, format: e.target.value as never } })
              }
            >
              {EXPORT_FORMATS.map((format) => (
                <option key={format} value={format}>
                  {format.toUpperCase()}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Resolution">
            <Select
              value={settings.export.resolution}
              onChange={(e) =>
                update({ export: { ...settings.export, resolution: e.target.value as never } })
              }
            >
              {EXPORT_RESOLUTIONS.map((resolution) => (
                <option key={resolution} value={resolution}>
                  {resolution.toUpperCase()}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Frame rate">
            <Select
              value={String(settings.export.fps)}
              onChange={(e) =>
                update({ export: { ...settings.export, fps: Number(e.target.value) as never } })
              }
            >
              {FRAME_RATES.map((fps) => (
                <option key={fps} value={fps}>
                  {fps} fps
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </section>

      <div className="sticky bottom-4 flex justify-end">
        <Button loading={saving} disabled={!dirty} onClick={() => void save()}>
          {dirty ? 'Save settings' : 'Saved'}
        </Button>
      </div>
    </div>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <div className="flex gap-2">
        <input
          type="color"
          value={value.slice(0, 7)}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="h-9 w-12 shrink-0 cursor-pointer rounded-lg border border-line bg-canvas p-1"
          aria-label={label}
        />
        <Input value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} className="font-mono" />
      </div>
    </Field>
  );
}

/** Approximate the burned-in caption look so choices can be judged visually. */
function CaptionPreview({
  settings,
  aspectRatio,
}: {
  settings: CaptionSettings;
  aspectRatio: string;
}) {
  const sample = useMemo(() => (settings.uppercase ? 'THE TREASURE MAP' : 'The treasure map'), [
    settings.uppercase,
  ]);
  const words = sample.split(' ');

  const align =
    settings.position === 'top' ? 'items-start' : settings.position === 'center' ? 'items-center' : 'items-end';

  return (
    <div
      className={cn(
        'mt-4 flex justify-center overflow-hidden rounded-lg bg-gradient-to-br from-[#1a2332] to-[#0d1117] p-6',
        align,
        aspectRatio === '9:16' ? 'h-52' : 'h-40',
      )}
    >
      <p
        className="text-center leading-tight"
        style={{
          fontFamily: `${settings.fontFamily}, system-ui, sans-serif`,
          // The real render scales against a 1080px canvas; the preview box is
          // ~360px wide, hence the third.
          fontSize: `${Math.max(12, settings.fontSize / 3)}px`,
          fontWeight: 800,
          color: settings.primaryColor,
          WebkitTextStroke: `${settings.outlineWidth / 3}px ${settings.outlineColor}`,
          paintOrder: 'stroke fill',
          textShadow: settings.shadowDepth
            ? `${settings.shadowDepth / 3}px ${settings.shadowDepth / 3}px 0 ${settings.shadowColor}`
            : undefined,
        }}
      >
        {words.map((word, index) => (
          <span
            key={`${word}-${index}`}
            style={{
              color:
                settings.mode !== 'sentence' && index === 1 ? settings.highlightColor : settings.primaryColor,
            }}
          >
            {word}{' '}
          </span>
        ))}
      </p>
    </div>
  );
}
