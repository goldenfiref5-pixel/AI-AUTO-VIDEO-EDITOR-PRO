'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CharacterProfile,
  CompetitorInsight,
  Job,
  ProgressEvent,
  Project,
  RenderRecord,
  Scene,
  StyleDna,
  Transcript,
} from '@aiedit/shared';
import { ApiError, api, progressStreamUrl } from './api';

export interface ProjectBundle {
  project: Project;
  transcript: Transcript | null;
  transcriptStats: {
    wordCount: number;
    durationSec: number;
    segmentCount: number;
    wordsPerMinute: number;
  } | null;
  styleDna: StyleDna | null;
  characters: CharacterProfile[];
  scenes: Scene[];
  competitorInsights: CompetitorInsight[];
  jobs: Job[];
  renders: RenderRecord[];
}

interface State {
  data: ProjectBundle | null;
  loading: boolean;
  error: string | null;
  progress: ProgressEvent | null;
}

/**
 * Load a project and keep it live.
 *
 * Progress arrives over SSE; each event also triggers a debounced refetch so the
 * derived data (scene statuses, job rows, renders) stays in step without the
 * server having to push the whole bundle on every tick.
 */
export function useProject(projectId: string) {
  const [state, setState] = useState<State>({
    data: null,
    loading: true,
    error: null,
    progress: null,
  });
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (options: { quiet?: boolean } = {}) => {
      if (!options.quiet) setState((s) => ({ ...s, loading: true }));
      try {
        const data = await api.get<ProjectBundle>(`/api/projects/${projectId}`);
        setState((s) => ({ ...s, data, loading: false, error: null }));
      } catch (err) {
        setState((s) => ({
          ...s,
          loading: false,
          error: err instanceof ApiError ? err.message : 'Could not load this project.',
        }));
      }
    },
    [projectId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const source = new EventSource(progressStreamUrl(projectId));

    source.onmessage = (event) => {
      try {
        const progress = JSON.parse(event.data) as ProgressEvent;
        setState((s) => ({ ...s, progress }));

        // Coalesce bursts: a generation job emits an event per scene.
        if (refetchTimer.current) clearTimeout(refetchTimer.current);
        const isTerminal = ['completed', 'failed', 'cancelled'].includes(progress.status);
        refetchTimer.current = setTimeout(() => void load({ quiet: true }), isTerminal ? 200 : 2500);
      } catch {
        // Ignore malformed frames rather than tearing down the stream.
      }
    };

    // The browser reconnects automatically; nothing to do but let it.
    source.onerror = () => undefined;

    return () => {
      source.close();
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
    };
  }, [projectId, load]);

  return {
    ...state,
    reload: load,
    setData: (updater: (current: ProjectBundle) => ProjectBundle) =>
      setState((s) => (s.data ? { ...s, data: updater(s.data) } : s)),
  };
}

/** Which workflow step the project is currently sitting on. */
export type WorkflowStep = 'upload' | 'transcript' | 'references' | 'storyboard' | 'generate' | 'export';

export function currentStep(bundle: ProjectBundle | null): WorkflowStep {
  if (!bundle) return 'upload';
  const { project, transcript, scenes } = bundle;

  if (!transcript) return 'upload';
  if (!transcript.approvedAt) return 'transcript';
  if (scenes.length === 0) return 'storyboard';
  if (project.status === 'completed' || bundle.renders.some((r) => r.status === 'completed')) {
    return 'export';
  }
  if (scenes.some((scene) => scene.imageAssetId)) return 'export';
  return 'generate';
}
