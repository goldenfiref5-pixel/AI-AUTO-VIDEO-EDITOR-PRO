'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CharacterProfile } from '@aiedit/shared';
import { ApiError, api } from '@/lib/api';
import { useToast } from '@/lib/toast';
import type { ProjectBundle } from '@/lib/use-project';
import { Button } from '../ui/button';
import { Modal } from '../ui/modal';
import { Badge, EmptyState, Field, Input, Textarea, Toggle } from '../ui/primitives';

type CharacterWithSheet = CharacterProfile & { referenceUrl?: string | null };

export function CharactersPanel({
  bundle,
  onChanged,
}: {
  bundle: ProjectBundle;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [characters, setCharacters] = useState<CharacterWithSheet[]>(bundle.characters);
  const [editing, setEditing] = useState<CharacterWithSheet | null>(null);

  const load = useCallback(async () => {
    try {
      const { characters: found } = await api.get<{ characters: CharacterWithSheet[] }>(
        `/api/projects/${bundle.project.id}/characters`,
      );
      setCharacters(found);
    } catch {
      // Fall back to the bundle's copy, which has everything but the sheet URL.
      setCharacters(bundle.characters);
    }
  }, [bundle.project.id, bundle.characters]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleLock(character: CharacterWithSheet, locked: boolean) {
    try {
      await api.patch(`/api/projects/${bundle.project.id}/characters/${character.id}`, { locked });
      toast.success(locked ? `${character.name} locked` : `${character.name} unlocked`);
      await load();
      onChanged();
    } catch (err) {
      toast.error('Could not update the character', err instanceof ApiError ? err.message : undefined);
    }
  }

  if (characters.length === 0) {
    return (
      <EmptyState
        title="No characters yet"
        description="Characters are extracted from the narration during story analysis."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <h2 className="text-sm font-semibold text-ink">Character consistency</h2>
        <p className="mt-0.5 text-xs text-ink-muted">
          Each character gets a reference sheet that is fed into every scene featuring them. That image —
          not the text description — is what keeps a face identical across hundreds of shots.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {characters.map((character) => (
          <article key={character.id} className="card overflow-hidden">
            <div className="flex gap-3 p-3">
              <div className="h-24 w-24 shrink-0 overflow-hidden rounded-lg bg-canvas">
                {character.referenceUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={character.referenceUrl}
                    alt={`${character.name} reference sheet`}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-[10px] text-ink-faint">
                    No sheet yet
                  </div>
                )}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="truncate text-sm font-medium text-ink">{character.name}</h3>
                  {character.locked ? <Badge tone="ok">Locked</Badge> : null}
                </div>
                <p className="text-[11px] text-ink-faint">{character.role}</p>
                <p className="mt-1.5 line-clamp-3 text-[11px] text-ink-muted">
                  {character.canonicalPrompt}
                </p>
              </div>
            </div>

            <div className="border-t border-line px-3 py-2">
              <Toggle
                checked={character.locked}
                onChange={(value) => void toggleLock(character, value)}
                label="Character lock"
                description="Freeze this appearance across every scene and re-plan."
              />
              <Button variant="ghost" size="sm" className="mt-1 w-full" onClick={() => setEditing(character)}>
                Edit appearance
              </Button>
            </div>
          </article>
        ))}
      </div>

      <CharacterEditor
        character={editing}
        projectId={bundle.project.id}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
          onChanged();
        }}
      />
    </div>
  );
}

function CharacterEditor({
  character,
  projectId,
  onClose,
  onSaved,
}: {
  character: CharacterWithSheet | null;
  projectId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<CharacterWithSheet | null>(character);
  const [busy, setBusy] = useState(false);

  useEffect(() => setDraft(character), [character]);

  if (!character || !draft) return null;

  async function save() {
    setBusy(true);
    try {
      await api.patch(`/api/projects/${projectId}/characters/${character!.id}`, {
        name: draft!.name,
        age: draft!.age,
        gender: draft!.gender,
        skinTone: draft!.skinTone,
        hair: draft!.hair,
        face: draft!.face,
        bodyShape: draft!.bodyShape,
        clothing: draft!.clothing,
        accessories: draft!.accessories,
        canonicalPrompt: draft!.canonicalPrompt,
      });
      toast.success('Character updated');
      onSaved();
    } catch (err) {
      toast.error('Could not save the character', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  const fields: Array<[keyof CharacterProfile, string]> = [
    ['age', 'Age'],
    ['gender', 'Gender'],
    ['skinTone', 'Skin tone'],
    ['hair', 'Hair'],
    ['bodyShape', 'Build'],
    ['accessories', 'Accessories'],
  ];

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit ${character.name}`}
      description="These details are injected into every prompt featuring this character."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={busy}>
            Save character
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name">
          <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          {fields.map(([key, label]) => (
            <Field key={key} label={label}>
              <Input
                value={String(draft[key] ?? '')}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
              />
            </Field>
          ))}
        </div>

        <Field label="Face">
          <Textarea value={draft.face} onChange={(e) => setDraft({ ...draft, face: e.target.value })} rows={2} />
        </Field>

        <Field label="Clothing">
          <Textarea
            value={draft.clothing}
            onChange={(e) => setDraft({ ...draft, clothing: e.target.value })}
            rows={2}
          />
        </Field>

        <Field
          label="Canonical prompt"
          hint="The exact text used in every image prompt. Edit it directly for the finest control."
        >
          <Textarea
            value={draft.canonicalPrompt}
            onChange={(e) => setDraft({ ...draft, canonicalPrompt: e.target.value })}
            rows={4}
          />
        </Field>
      </div>
    </Modal>
  );
}
