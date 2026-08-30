'use client';

import { useMemo, useRef, useState } from 'react';
import { formatTimestamp, type Scene } from '@aiedit/shared';
import { ApiError, api } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { clock, cn } from '@/lib/utils';
import type { ProjectBundle } from '@/lib/use-project';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/primitives';

type SceneWithMedia = Scene & { imageUrl?: string | null; clipUrl?: string | null };

/**
 * Timeline editor.
 *
 * Scenes are laid out proportionally to their duration against the narration,
 * which makes drift immediately visible. Reordering is drag-and-drop; retiming
 * is a drag on the right edge of a clip.
 */
export function TimelineEditor({
  bundle,
  onChanged,
}: {
  bundle: ProjectBundle;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [scenes, setScenes] = useState<SceneWithMedia[]>(bundle.scenes);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  useMemo(() => setScenes(bundle.scenes), [bundle.scenes]);

  const totalDuration = useMemo(
    () => scenes.reduce((sum, scene) => sum + (scene.endSec - scene.startSec), 0),
    [scenes],
  );
  const narrationDuration = bundle.transcript?.durationSec ?? totalDuration;
  const drift = totalDuration - narrationDuration;

  async function commitOrder(next: SceneWithMedia[]) {
    setScenes(next);
    setBusy(true);
    try {
      const { scenes: updated } = await api.post<{ scenes: SceneWithMedia[] }>(
        `/api/projects/${bundle.project.id}/scenes/reorder`,
        { sceneIds: next.map((s) => s.id) },
      );
      setScenes(updated);
      toast.success('Timeline reordered');
      onChanged();
    } catch (err) {
      setScenes(bundle.scenes);
      toast.error('Reorder failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  async function retime(scene: SceneWithMedia, durationSec: number) {
    setBusy(true);
    try {
      const { scenes: updated } = await api.post<{ scenes: SceneWithMedia[] }>(
        `/api/projects/${bundle.project.id}/scenes/${scene.id}/retime`,
        { durationSec: Number(durationSec.toFixed(2)) },
      );
      setScenes(updated);
      onChanged();
    } catch (err) {
      toast.error('Could not retime that scene', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  if (scenes.length === 0) {
    return <EmptyState title="Nothing on the timeline" description="Plan a storyboard first." />;
  }

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">Timeline</h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            Drag to reorder, drag a clip's right edge to retime. The narration length is fixed.
          </p>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wide text-ink-faint">Timeline</p>
            <p className="font-mono text-ink">{clock(totalDuration)}</p>
          </div>
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wide text-ink-faint">Narration</p>
            <p className="font-mono text-ink">{clock(narrationDuration)}</p>
          </div>
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wide text-ink-faint">Drift</p>
            <p
              className={cn(
                'font-mono',
                Math.abs(drift) < 0.15 ? 'text-ok' : Math.abs(drift) < 1 ? 'text-warn' : 'text-danger',
              )}
            >
              {drift >= 0 ? '+' : ''}
              {drift.toFixed(2)}s
            </p>
          </div>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="border-b border-line px-4 py-2">
          <Ruler durationSec={totalDuration} />
        </div>

        <div ref={trackRef} className="flex gap-0.5 overflow-x-auto p-4">
          {scenes.map((scene, index) => {
            const duration = scene.endSec - scene.startSec;
            const share = totalDuration > 0 ? duration / totalDuration : 1 / scenes.length;

            return (
              <div
                key={scene.id}
                draggable={!busy}
                onDragStart={() => setDragIndex(index)}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOverIndex(index);
                }}
                onDragEnd={() => {
                  setDragIndex(null);
                  setOverIndex(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragIndex === null || dragIndex === index) return;
                  const next = [...scenes];
                  const [moved] = next.splice(dragIndex, 1);
                  next.splice(index, 0, moved!);
                  setDragIndex(null);
                  setOverIndex(null);
                  void commitOrder(next);
                }}
                onClick={() => setSelected(scene.id === selected ? null : scene.id)}
                style={{ flex: `${Math.max(0.02, share)} 1 0%`, minWidth: 56 }}
                className={cn(
                  'group relative h-24 cursor-grab overflow-hidden rounded-md border transition-colors active:cursor-grabbing',
                  selected === scene.id ? 'border-brand' : 'border-line hover:border-line-strong',
                  overIndex === index && dragIndex !== index ? 'ring-2 ring-brand' : '',
                  dragIndex === index ? 'opacity-40' : '',
                )}
              >
                {scene.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={scene.imageUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                ) : (
                  <div className="h-full w-full bg-surface-raised" />
                )}

                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-1.5 pb-1 pt-4">
                  <p className="truncate font-mono text-[9px] text-white/80">
                    {String(scene.index + 1).padStart(2, '0')} · {duration.toFixed(1)}s
                  </p>
                </div>

                {/* Right-edge handle: drag horizontally to change duration. */}
                <div
                  role="separator"
                  aria-label={`Resize scene ${scene.index + 1}`}
                  onMouseDown={(event) => {
                    event.stopPropagation();
                    event.preventDefault();
                    const startX = event.clientX;
                    const trackWidth = trackRef.current?.clientWidth ?? 800;
                    const secondsPerPixel = totalDuration / Math.max(1, trackWidth);

                    const onMove = (move: MouseEvent) => {
                      const delta = (move.clientX - startX) * secondsPerPixel;
                      const next = Math.max(0.5, duration + delta);
                      const label = event.currentTarget as HTMLElement | null;
                      if (label) label.dataset['preview'] = next.toFixed(1);
                    };
                    const onUp = (up: MouseEvent) => {
                      document.removeEventListener('mousemove', onMove);
                      document.removeEventListener('mouseup', onUp);
                      const delta = (up.clientX - startX) * secondsPerPixel;
                      if (Math.abs(delta) > 0.1) void retime(scene, Math.max(0.5, duration + delta));
                    };
                    document.addEventListener('mousemove', onMove);
                    document.addEventListener('mouseup', onUp);
                  }}
                  className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize bg-brand/0 transition-colors hover:bg-brand/70"
                />
              </div>
            );
          })}
        </div>
      </div>

      {selected ? (
        <SelectedScenePanel
          scene={scenes.find((s) => s.id === selected)!}
          projectId={bundle.project.id}
          busy={busy}
          onClose={() => setSelected(null)}
          onChanged={onChanged}
        />
      ) : null}
    </div>
  );
}

function Ruler({ durationSec }: { durationSec: number }) {
  // Pick a tick spacing that yields roughly ten labels at any length.
  const step = durationSec <= 30 ? 5 : durationSec <= 120 ? 15 : durationSec <= 600 ? 60 : 300;
  const ticks = Math.floor(durationSec / step) + 1;

  return (
    <div className="flex text-[10px] text-ink-faint">
      {Array.from({ length: ticks }).map((_, i) => (
        <div key={i} className="flex-1 border-l border-line pl-1 font-mono first:border-l-0 first:pl-0">
          {formatTimestamp(i * step)}
        </div>
      ))}
    </div>
  );
}

function SelectedScenePanel({
  scene,
  projectId,
  busy,
  onClose,
  onChanged,
}: {
  scene: SceneWithMedia;
  projectId: string;
  busy: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [regenerating, setRegenerating] = useState(false);

  async function regenerate() {
    setRegenerating(true);
    try {
      await api.post(`/api/projects/${projectId}/generate`, { sceneIds: [scene.id], force: true });
      toast.success('Scene queued for regeneration');
      onChanged();
    } catch (err) {
      toast.error('Could not queue that scene', err instanceof ApiError ? err.message : undefined);
    } finally {
      setRegenerating(false);
    }
  }

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-ink">
            Scene {scene.index + 1} · {formatTimestamp(scene.startSec)} → {formatTimestamp(scene.endSec)}
          </p>
          <p className="mt-1 line-clamp-2 text-xs text-ink-muted">{scene.narration}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" loading={regenerating} disabled={busy} onClick={() => void regenerate()}>
            Regenerate scene
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
