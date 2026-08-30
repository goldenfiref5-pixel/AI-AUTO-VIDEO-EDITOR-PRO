'use client';

import { useMemo, useState } from 'react';
import { CAMERA_MOTIONS, TRANSITIONS, formatTimestamp, type Scene } from '@aiedit/shared';
import { ApiError, api } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { ProjectBundle } from '@/lib/use-project';
import { Button } from '../ui/button';
import { ConfirmModal, Modal } from '../ui/modal';
import { Badge, EmptyState, Field, Input, Select, Textarea } from '../ui/primitives';

type SceneWithMedia = Scene & { imageUrl?: string | null; clipUrl?: string | null };

export function Storyboard({
  bundle,
  onChanged,
}: {
  bundle: ProjectBundle;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [scenes, setScenes] = useState<SceneWithMedia[]>(bundle.scenes);
  const [editing, setEditing] = useState<SceneWithMedia | null>(null);
  const [deleting, setDeleting] = useState<SceneWithMedia | null>(null);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);

  // Server data wins whenever the bundle refreshes.
  useMemo(() => setScenes(bundle.scenes), [bundle.scenes]);

  const characterNames = useMemo(
    () => new Map(bundle.characters.map((c) => [c.id, c.name])),
    [bundle.characters],
  );

  const analysing = bundle.project.status === 'analyzing';

  async function mutate(request: Promise<{ scenes: SceneWithMedia[] }>, successMessage: string) {
    setBusy(true);
    try {
      const { scenes: updated } = await request;
      setScenes(updated);
      toast.success(successMessage);
      onChanged();
    } catch (err) {
      toast.error('That change did not apply', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  async function startGeneration(force: boolean) {
    setGenerating(true);
    try {
      await api.post(`/api/projects/${bundle.project.id}/generate`, { force });
      toast.success('Generation queued', 'Images first, then motion clips.');
      onChanged();
    } catch (err) {
      toast.error('Could not start generation', err instanceof ApiError ? err.message : undefined);
    } finally {
      setGenerating(false);
    }
  }

  if (analysing) {
    return (
      <div className="card p-6 text-center">
        <h2 className="text-sm font-semibold text-ink">Analysing your story</h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-ink-muted">
          Extracting characters, locations and emotional beats, then breaking the narration into scenes
          aligned to the audio.
        </p>
      </div>
    );
  }

  if (scenes.length === 0) {
    return (
      <EmptyState
        title="No storyboard yet"
        description="Approve the transcript to plan scenes from the narration."
      />
    );
  }

  const ready = scenes.filter((s) => s.imageAssetId).length;
  const animated = scenes.filter((s) => s.clipAssetId).length;
  const failed = scenes.filter((s) => s.status === 'failed').length;

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">Storyboard</h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            {scenes.length} scenes · {ready} with imagery · {animated} animated
            {failed > 0 ? ` · ${failed} failed` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {ready > 0 ? (
            <Button variant="secondary" loading={generating} onClick={() => void startGeneration(true)}>
              Regenerate all
            </Button>
          ) : null}
          <Button loading={generating} onClick={() => void startGeneration(false)}>
            {ready > 0 ? 'Generate missing scenes' : 'Generate video'}
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {scenes.map((scene) => (
          <SceneCard
            key={scene.id}
            scene={scene}
            characterNames={characterNames}
            aspectRatio={bundle.project.aspectRatio}
            onEdit={() => setEditing(scene)}
            onDelete={() => setDeleting(scene)}
            onSplit={() =>
              void mutate(
                api.post(`/api/projects/${bundle.project.id}/scenes/${scene.id}/split`, {
                  atSec: (scene.startSec + scene.endSec) / 2,
                }),
                'Scene split',
              )
            }
            onMerge={() =>
              void mutate(
                api.post(`/api/projects/${bundle.project.id}/scenes/${scene.id}/merge`),
                'Scene merged',
              )
            }
            disabled={busy}
          />
        ))}
      </div>

      <SceneEditor
        scene={editing}
        projectId={bundle.project.id}
        characters={bundle.characters}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          onChanged();
        }}
      />

      <ConfirmModal
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          void mutate(
            api.delete(`/api/projects/${bundle.project.id}/scenes/${deleting.id}`),
            'Scene deleted',
          ).then(() => setDeleting(null));
        }}
        title="Delete this scene?"
        description="Its screen time is absorbed by the previous scene so the timeline stays locked to the narration."
        confirmLabel="Delete scene"
        destructive
        loading={busy}
      />
    </div>
  );
}

function SceneCard({
  scene,
  characterNames,
  aspectRatio,
  onEdit,
  onDelete,
  onSplit,
  onMerge,
  disabled,
}: {
  scene: SceneWithMedia;
  characterNames: Map<string, string>;
  aspectRatio: string;
  onEdit: () => void;
  onDelete: () => void;
  onSplit: () => void;
  onMerge: () => void;
  disabled: boolean;
}) {
  const duration = scene.endSec - scene.startSec;
  const aspect = aspectRatio === '9:16' ? 'aspect-[9/16]' : aspectRatio === '1:1' ? 'aspect-square' : 'aspect-video';

  return (
    <article className="card group overflow-hidden">
      <div className={cn('relative bg-canvas', aspect, aspectRatio === '9:16' && 'max-h-72')}>
        {scene.clipUrl ? (
          <video
            src={scene.clipUrl}
            className="h-full w-full object-cover"
            muted
            loop
            playsInline
            onMouseEnter={(e) => void e.currentTarget.play().catch(() => undefined)}
            onMouseLeave={(e) => {
              e.currentTarget.pause();
              e.currentTarget.currentTime = 0;
            }}
          />
        ) : scene.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={scene.imageUrl} alt={`Scene ${scene.index + 1}`} className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <div className="flex h-full items-center justify-center text-ink-faint">
            <span className="text-xs">{scene.status === 'failed' ? 'Generation failed' : 'Not generated'}</span>
          </div>
        )}

        <div className="absolute left-2 top-2 flex gap-1">
          <span className="rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white">
            {String(scene.index + 1).padStart(2, '0')}
          </span>
          {scene.isBroll ? (
            <span className="rounded bg-accent/90 px-1.5 py-0.5 text-[10px] font-medium text-black">
              B-roll
            </span>
          ) : null}
        </div>

        <span className="absolute right-2 top-2 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white">
          {duration.toFixed(1)}s
        </span>

        {scene.clipAssetId ? (
          <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-accent">
            Motion
          </span>
        ) : null}
      </div>

      <div className="p-3">
        <p className="mb-1 font-mono text-[10px] text-brand">
          [{formatTimestamp(scene.startSec)} → {formatTimestamp(scene.endSec)}]
        </p>
        <p className="line-clamp-2 text-xs text-ink">{scene.narration || '—'}</p>
        <p className="mt-1.5 line-clamp-2 text-[11px] text-ink-muted">{scene.visualPrompt}</p>

        <div className="mt-2 flex flex-wrap gap-1">
          {scene.emotion ? <Badge>{scene.emotion}</Badge> : null}
          {scene.location ? <Badge tone="neutral">{scene.location}</Badge> : null}
          {scene.characterIds.map((id) => (
            <Badge key={id} tone="brand">
              {characterNames.get(id) ?? 'Unknown'}
            </Badge>
          ))}
        </div>

        {scene.errorMessage ? (
          <p className="mt-2 line-clamp-2 rounded bg-danger/10 px-2 py-1 text-[10px] text-danger">
            {scene.errorMessage}
          </p>
        ) : null}

        <div className="mt-3 flex flex-wrap gap-1 border-t border-line pt-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <Button variant="ghost" size="sm" onClick={onEdit} disabled={disabled}>
            Edit
          </Button>
          <Button variant="ghost" size="sm" onClick={onSplit} disabled={disabled}>
            Split
          </Button>
          {scene.index > 0 ? (
            <Button variant="ghost" size="sm" onClick={onMerge} disabled={disabled}>
              Merge up
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" className="text-danger" onClick={onDelete} disabled={disabled}>
            Delete
          </Button>
        </div>
      </div>
    </article>
  );
}

function SceneEditor({
  scene,
  projectId,
  characters,
  onClose,
  onSaved,
}: {
  scene: SceneWithMedia | null;
  projectId: string;
  characters: ProjectBundle['characters'];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<SceneWithMedia | null>(scene);
  const [busy, setBusy] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  useMemo(() => setDraft(scene), [scene]);

  if (!scene || !draft) return null;

  async function save() {
    setBusy(true);
    try {
      await api.patch(`/api/projects/${projectId}/scenes/${scene!.id}`, {
        narration: draft!.narration,
        visualPrompt: draft!.visualPrompt,
        emotion: draft!.emotion,
        location: draft!.location,
        cameraMotion: draft!.cameraMotion,
        motionPrompt: draft!.motionPrompt,
        transitionIn: draft!.transitionIn,
        characterIds: draft!.characterIds,
        isBroll: draft!.isBroll,
        brollSubject: draft!.brollSubject,
      });
      toast.success('Scene updated', 'Its imagery will be regenerated on the next pass.');
      onSaved();
    } catch (err) {
      toast.error('Could not save the scene', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  async function regeneratePrompt() {
    setRegenerating(true);
    try {
      const { scene: updated } = await api.post<{ scene: Scene }>(
        `/api/projects/${projectId}/scenes/${scene!.id}/regenerate-prompt`,
      );
      setDraft((current) => (current ? { ...current, visualPrompt: updated.visualPrompt } : current));
      toast.success('New prompt generated');
    } catch (err) {
      toast.error('Could not regenerate the prompt', err instanceof ApiError ? err.message : undefined);
    } finally {
      setRegenerating(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Scene ${scene.index + 1}`}
      description={`${formatTimestamp(scene.startSec)} → ${formatTimestamp(scene.endSec)} · ${(
        scene.endSec - scene.startSec
      ).toFixed(2)}s`}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={busy}>
            Save scene
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field
          label="Narration"
          hint="Editing this does not change the audio — it only affects how the scene is described to the model."
        >
          <Textarea
            value={draft.narration}
            onChange={(e) => setDraft({ ...draft, narration: e.target.value })}
            rows={2}
          />
        </Field>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="label mb-0">Visual prompt</span>
            <Button variant="ghost" size="sm" loading={regenerating} onClick={() => void regeneratePrompt()}>
              Regenerate prompt
            </Button>
          </div>
          <Textarea
            value={draft.visualPrompt}
            onChange={(e) => setDraft({ ...draft, visualPrompt: e.target.value })}
            rows={4}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Emotion">
            <Input value={draft.emotion} onChange={(e) => setDraft({ ...draft, emotion: e.target.value })} />
          </Field>
          <Field label="Location">
            <Input value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} />
          </Field>
          <Field label="Camera motion">
            <Select
              value={draft.cameraMotion}
              onChange={(e) => setDraft({ ...draft, cameraMotion: e.target.value as Scene['cameraMotion'] })}
            >
              {CAMERA_MOTIONS.map((motion) => (
                <option key={motion} value={motion}>
                  {motion.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Transition in" hint="Leave on Auto to let the transition engine choose.">
            <Select
              value={draft.transitionIn ?? ''}
              onChange={(e) =>
                setDraft({ ...draft, transitionIn: (e.target.value || null) as Scene['transitionIn'] })
              }
            >
              <option value="">Auto</option>
              {TRANSITIONS.map((transition) => (
                <option key={transition} value={transition}>
                  {transition.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Motion prompt" hint="What moves in this shot over its duration.">
          <Textarea
            value={draft.motionPrompt ?? ''}
            onChange={(e) => setDraft({ ...draft, motionPrompt: e.target.value || null })}
            rows={2}
            placeholder="The boy turns toward the camera as the wind lifts the map."
          />
        </Field>

        {characters.length > 0 ? (
          <div>
            <span className="label">Characters in this scene</span>
            <div className="flex flex-wrap gap-1.5">
              {characters.map((character) => {
                const active = draft.characterIds.includes(character.id);
                return (
                  <button
                    key={character.id}
                    type="button"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        characterIds: active
                          ? draft.characterIds.filter((id) => id !== character.id)
                          : [...draft.characterIds, character.id],
                      })
                    }
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-xs transition-colors',
                      active
                        ? 'border-brand bg-brand-subtle text-ink'
                        : 'border-line text-ink-muted hover:border-line-strong',
                    )}
                  >
                    {character.name}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
