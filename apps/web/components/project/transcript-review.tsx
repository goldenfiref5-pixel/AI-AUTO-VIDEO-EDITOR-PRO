'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatTimestamp, type Transcript, type TranscriptSegment } from '@aiedit/shared';
import { ApiError, api } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { clock, cn, formatNumber } from '@/lib/utils';
import type { ProjectBundle } from '@/lib/use-project';
import { Button } from '../ui/button';
import { Modal } from '../ui/modal';
import { Badge, Field, Input, Textarea } from '../ui/primitives';

interface TranscriptResponse {
  transcript: Transcript;
  stats: { wordCount: number; durationSec: number; segmentCount: number; wordsPerMinute: number };
}

interface EnhancementProposal {
  text: string;
  segments: TranscriptSegment[];
  diffs: Array<{ index: number; before: string; after: string; changed: boolean }>;
  changedCount: number;
  wordCountBefore: number;
  wordCountAfter: number;
}

/** Local undo history, so an accidental edit is one keystroke away from undone. */
const HISTORY_LIMIT = 100;

export function TranscriptReview({
  bundle,
  onChanged,
}: {
  bundle: ProjectBundle;
  onChanged: () => void;
}) {
  const toast = useToast();
  const transcript = bundle.transcript!;

  const [mode, setMode] = useState<'review' | 'edit'>('review');
  const [draft, setDraft] = useState(transcript.text);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [proposal, setProposal] = useState<EnhancementProposal | null>(null);
  const [showReplace, setShowReplace] = useState(false);
  const [approving, setApproving] = useState(false);

  const history = useRef<string[]>([transcript.text]);
  const historyIndex = useRef(0);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A server-side change (re-transcription, restore) replaces the local draft.
  useEffect(() => {
    setDraft(transcript.text);
    history.current = [transcript.text];
    historyIndex.current = 0;
    setDirty(false);
  }, [transcript.text, transcript.version]);

  const save = useCallback(
    async (text: string, reason?: string) => {
      setSaving(true);
      try {
        const response = await api.put<TranscriptResponse>(
          `/api/projects/${bundle.project.id}/transcript`,
          { text },
        );
        setDirty(false);
        onChanged();
        return response;
      } catch (err) {
        toast.error('Could not save the transcript', err instanceof ApiError ? err.message : undefined);
        throw err;
      } finally {
        setSaving(false);
      }
    },
    [bundle.project.id, onChanged, toast],
  );

  // Auto-save two seconds after typing stops.
  useEffect(() => {
    if (!dirty || mode !== 'edit') return undefined;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      void save(draft).catch(() => undefined);
    }, 2000);

    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [draft, dirty, mode, save]);

  function pushHistory(next: string) {
    // Anything ahead of the cursor is discarded once a new edit is made.
    history.current = history.current.slice(0, historyIndex.current + 1);
    history.current.push(next);
    if (history.current.length > HISTORY_LIMIT) history.current.shift();
    historyIndex.current = history.current.length - 1;
  }

  function onDraftChange(next: string) {
    setDraft(next);
    setDirty(true);
    pushHistory(next);
  }

  function undo() {
    if (historyIndex.current <= 0) return;
    historyIndex.current -= 1;
    setDraft(history.current[historyIndex.current]!);
    setDirty(true);
  }

  function redo() {
    if (historyIndex.current >= history.current.length - 1) return;
    historyIndex.current += 1;
    setDraft(history.current[historyIndex.current]!);
    setDirty(true);
  }

  async function requestEnhancement() {
    setEnhancing(true);
    try {
      const result = await api.post<EnhancementProposal>(
        `/api/projects/${bundle.project.id}/transcript/enhance`,
        { fixGrammar: true, improvePunctuation: true, improveReadability: true },
      );
      if (result.changedCount === 0) {
        toast.info('Nothing to improve', 'The script already reads cleanly.');
      } else {
        setProposal(result);
      }
    } catch (err) {
      toast.error('Script improvement failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setEnhancing(false);
    }
  }

  async function acceptProposal() {
    if (!proposal) return;
    try {
      await api.put(`/api/projects/${bundle.project.id}/transcript`, { segments: proposal.segments });
      toast.success('Improvements applied', `${proposal.changedCount} segments updated.`);
      setProposal(null);
      onChanged();
    } catch (err) {
      toast.error('Could not apply the improvements', err instanceof ApiError ? err.message : undefined);
    }
  }

  async function approve() {
    if (dirty) {
      await save(draft).catch(() => undefined);
    }
    setApproving(true);
    try {
      await api.post(`/api/projects/${bundle.project.id}/transcript/approve`);
      toast.success('Transcript approved', 'Story analysis has started.');
      onChanged();
    } catch (err) {
      toast.error('Could not proceed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setApproving(false);
    }
  }

  const stats = bundle.transcriptStats;
  const paragraphs = useMemo(() => splitParagraphs(transcript), [transcript]);

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">Review generated script</h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            Nothing is generated until you approve this. Edits keep their original audio timing.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-xs text-ink-muted">
          <Stat label="Words" value={formatNumber(stats?.wordCount ?? transcript.wordCount)} />
          <Stat label="Duration" value={clock(transcript.durationSec)} />
          <Stat label="Segments" value={String(stats?.segmentCount ?? transcript.segments.length)} />
          <Stat label="Pace" value={`${stats?.wordsPerMinute ?? 0} wpm`} />
          <Stat label="Confidence" value={`${Math.round(transcript.confidence * 100)}%`} />
        </div>
      </div>

      <div className="card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
          <div className="flex gap-1 rounded-lg bg-canvas p-1">
            {(['review', 'edit'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                className={cn(
                  'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                  mode === value ? 'bg-surface-raised text-ink' : 'text-ink-muted hover:text-ink',
                )}
              >
                {value === 'review' ? 'Timestamped' : 'Editor'}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {mode === 'edit' ? (
              <>
                <Button variant="ghost" size="sm" onClick={undo} disabled={historyIndex.current <= 0}>
                  Undo
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={redo}
                  disabled={historyIndex.current >= history.current.length - 1}
                >
                  Redo
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowReplace(true)}>
                  Find & replace
                </Button>
              </>
            ) : null}
            <Button variant="secondary" size="sm" loading={enhancing} onClick={() => void requestEnhancement()}>
              Improve script
            </Button>
          </div>
        </div>

        {mode === 'review' ? (
          <div className="max-h-[55vh] overflow-y-auto px-4 py-4">
            {paragraphs.map((paragraph) => (
              <div key={paragraph.start} className="mb-5 last:mb-0">
                <p className="mb-1 font-mono text-[11px] text-brand">
                  [{formatTimestamp(paragraph.start)}]
                </p>
                <p className="text-sm leading-relaxed text-ink">{paragraph.text}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-4">
            <Textarea
              value={draft}
              onChange={(e) => onDraftChange(e.target.value)}
              rows={18}
              className="font-mono text-[13px] leading-relaxed"
              spellCheck
              aria-label="Transcript editor"
            />
            <div className="mt-2 flex items-center justify-between text-xs">
              <span className="text-ink-faint">
                {saving ? 'Saving…' : dirty ? 'Unsaved changes — auto-saving shortly' : 'All changes saved'}
              </span>
              <Button
                variant="secondary"
                size="sm"
                loading={saving}
                disabled={!dirty}
                onClick={() => void save(draft).catch(() => undefined)}
              >
                Save now
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <p className="text-sm font-medium text-ink">Happy with the script?</p>
          <p className="mt-0.5 text-xs text-ink-muted">
            Approving locks the narration and starts story analysis, character design and scene planning.
          </p>
        </div>
        <Button size="lg" loading={approving} onClick={() => void approve()}>
          Proceed to video generation
        </Button>
      </div>

      <SearchReplaceModal
        open={showReplace}
        onClose={() => setShowReplace(false)}
        projectId={bundle.project.id}
        onDone={onChanged}
      />

      <Modal
        open={Boolean(proposal)}
        onClose={() => setProposal(null)}
        title="Proposed script improvements"
        description={`${proposal?.changedCount ?? 0} segments would change. Nothing is applied until you accept.`}
        size="xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setProposal(null)}>
              Discard
            </Button>
            <Button onClick={() => void acceptProposal()}>Apply improvements</Button>
          </>
        }
      >
        <div className="space-y-3">
          {proposal?.diffs
            .filter((diff) => diff.changed)
            .map((diff) => (
              <div key={diff.index} className="rounded-lg border border-line p-3">
                <p className="mb-2 text-[11px] uppercase tracking-wide text-ink-faint">
                  Segment {diff.index + 1}
                </p>
                <p className="mb-1.5 rounded bg-danger/10 px-2 py-1 text-xs text-ink-muted line-through decoration-danger/60">
                  {diff.before}
                </p>
                <p className="rounded bg-ok/10 px-2 py-1 text-xs text-ink">{diff.after}</p>
              </div>
            ))}
        </div>
      </Modal>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-right">
      <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="font-mono text-sm text-ink">{value}</p>
    </div>
  );
}

function SearchReplaceModal({
  open,
  onClose,
  projectId,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  onDone: () => void;
}) {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [replace, setReplace] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const result = await api.post<{ replacements: number }>(
        `/api/projects/${projectId}/transcript/search-replace`,
        { search, replace, caseSensitive, wholeWord },
      );
      if (result.replacements === 0) toast.info('No matches found');
      else toast.success(`Replaced ${result.replacements} occurrence${result.replacements === 1 ? '' : 's'}`);
      onDone();
      onClose();
    } catch (err) {
      toast.error('Replace failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Find and replace"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void run()} loading={busy} disabled={!search}>
            Replace all
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Find" htmlFor="find">
          <Input id="find" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
        </Field>
        <Field label="Replace with" htmlFor="replace">
          <Input id="replace" value={replace} onChange={(e) => setReplace(e.target.value)} />
        </Field>
        <div className="flex gap-4 text-xs text-ink-muted">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(e) => setCaseSensitive(e.target.checked)}
              className="accent-brand"
            />
            Match case
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={wholeWord}
              onChange={(e) => setWholeWord(e.target.checked)}
              className="accent-brand"
            />
            Whole words only
          </label>
        </div>
      </div>
    </Modal>
  );
}

interface Paragraph {
  start: number;
  text: string;
}

/** Group segments into ~15s paragraphs, matching the server's own formatting. */
function splitParagraphs(transcript: Transcript): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let buffer: string[] = [];
  let start = transcript.segments[0]?.start ?? 0;

  for (const segment of transcript.segments) {
    buffer.push(segment.text.trim());
    if (segment.end - start >= 15 || buffer.length >= 3) {
      paragraphs.push({ start, text: buffer.join(' ') });
      buffer = [];
      start = segment.end;
    }
  }
  if (buffer.length) paragraphs.push({ start, text: buffer.join(' ') });

  return paragraphs;
}

export function TranscriptApprovedBanner({ transcript }: { transcript: Transcript }) {
  return (
    <Badge tone="ok">Approved · {formatTimestamp(transcript.durationSec)} of narration</Badge>
  );
}
