'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { LIMITS, type Asset, type StyleDna } from '@aiedit/shared';
import { ApiError, api, uploadWithProgress } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { cn, formatBytes } from '@/lib/utils';
import type { ProjectBundle } from '@/lib/use-project';
import { Button } from '../ui/button';
import { Badge, EmptyState, Field, Input, ProgressBar, Toggle } from '../ui/primitives';

type AssetWithUrl = Asset & { url: string };

export function ReferencesPanel({
  bundle,
  onChanged,
}: {
  bundle: ProjectBundle;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [assets, setAssets] = useState<AssetWithUrl[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const { assets: found } = await api.get<{ assets: AssetWithUrl[] }>(
        `/api/projects/${bundle.project.id}/assets`,
      );
      setAssets(found);
    } catch (err) {
      if (err instanceof ApiError) toast.error('Could not load references', err.message);
    } finally {
      setLoading(false);
    }
  }, [bundle.project.id, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const styleAssets = assets.filter((a) => a.kind === 'style_reference');
  const videoAssets = assets.filter((a) => a.kind === 'competitor_video');

  async function remove(assetId: string) {
    try {
      await api.delete(`/api/projects/${bundle.project.id}/assets/${assetId}`);
      await load();
      onChanged();
    } catch (err) {
      toast.error('Could not remove that reference', err instanceof ApiError ? err.message : undefined);
    }
  }

  return (
    <div className="space-y-4">
      <StyleReferences
        projectId={bundle.project.id}
        assets={styleAssets}
        loading={loading}
        onUploaded={() => {
          void load();
          onChanged();
        }}
        onRemove={remove}
      />

      <StyleDnaCard styleDna={bundle.styleDna} projectId={bundle.project.id} onChanged={onChanged} />

      <CompetitorReferences
        projectId={bundle.project.id}
        assets={videoAssets}
        insights={bundle.competitorInsights}
        onChanged={() => {
          void load();
          onChanged();
        }}
        onRemove={remove}
      />
    </div>
  );
}

function StyleReferences({
  projectId,
  assets,
  loading,
  onUploaded,
  onRemove,
}: {
  projectId: string;
  assets: AssetWithUrl[];
  loading: boolean;
  onUploaded: () => void;
  onRemove: (id: string) => void;
}) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dragging, setDragging] = useState(false);

  async function upload(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;

    const remaining = LIMITS.maxStyleReferences - assets.length;
    if (list.length > remaining) {
      toast.error(
        'Too many images',
        `You can add ${remaining} more (the limit is ${LIMITS.maxStyleReferences}).`,
      );
      return;
    }

    const form = new FormData();
    for (const file of list) form.append('files', file);

    setUploading(true);
    setProgress(0);
    try {
      await uploadWithProgress(`/api/projects/${projectId}/style-references`, form, (f) =>
        setProgress(f * 100),
      ).promise;
      toast.success(`Added ${list.length} style reference${list.length === 1 ? '' : 's'}`);
      onUploaded();
    } catch (err) {
      toast.error('Upload failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setUploading(false);
    }
  }

  const belowMinimum = assets.length > 0 && assets.length < LIMITS.minStyleReferences;

  return (
    <section className="card p-4">
      <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-ink">Style reference images</h3>
          <p className="mt-0.5 text-xs text-ink-muted">
            {LIMITS.minStyleReferences}–{LIMITS.maxStyleReferences} frames that define the look. Every
            generated scene inherits their lighting, grade, composition and camera language.
          </p>
        </div>
        <Badge tone={assets.length >= LIMITS.minStyleReferences ? 'ok' : 'neutral'}>
          {assets.length}/{LIMITS.maxStyleReferences}
        </Badge>
      </header>

      {belowMinimum ? (
        <p className="mb-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
          Add at least {LIMITS.minStyleReferences} images — a single frame is not enough to characterise
          a style reliably.
        </p>
      ) : null}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void upload(e.dataTransfer.files);
        }}
        className={cn(
          'grid grid-cols-3 gap-2 rounded-lg border border-dashed p-2 transition-colors sm:grid-cols-5 lg:grid-cols-8',
          dragging ? 'border-brand bg-brand-subtle' : 'border-line',
        )}
      >
        {loading
          ? Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton aspect-square" />)
          : assets.map((asset) => (
              <figure key={asset.id} className="group relative aspect-square overflow-hidden rounded-md bg-canvas">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={asset.url}
                  alt={asset.filename}
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
                <button
                  type="button"
                  onClick={() => onRemove(asset.id)}
                  aria-label={`Remove ${asset.filename}`}
                  className="absolute right-1 top-1 rounded-md bg-black/70 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                    <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                  </svg>
                </button>
              </figure>
            ))}

        {assets.length < LIMITS.maxStyleReferences ? (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="flex aspect-square items-center justify-center rounded-md border border-line text-ink-faint transition-colors hover:border-brand hover:text-brand"
            aria-label="Add style reference images"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12h14" strokeLinecap="round" />
            </svg>
          </button>
        ) : null}
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,image/heic"
        className="sr-only"
        onChange={(e) => {
          if (e.target.files) void upload(e.target.files);
          e.target.value = '';
        }}
      />

      {uploading ? <ProgressBar value={progress} className="mt-3" /> : null}

      <p className="mt-2 text-[11px] text-ink-faint">
        Images up to {formatBytes(LIMITS.maxImageBytes)} each. Drag and drop works too.
      </p>
    </section>
  );
}

function StyleDnaCard({
  styleDna,
  projectId,
  onChanged,
}: {
  styleDna: StyleDna | null;
  projectId: string;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);

  if (!styleDna) {
    return (
      <section className="card p-4">
        <h3 className="text-sm font-semibold text-ink">Style DNA</h3>
        <p className="mt-1 text-xs text-ink-muted">
          Derived automatically from your reference images once you approve the transcript.
        </p>
      </section>
    );
  }

  async function toggleLock(locked: boolean) {
    setSaving(true);
    try {
      await api.patch(`/api/projects/${projectId}/style-dna`, { locked });
      toast.success(locked ? 'Style locked' : 'Style unlocked');
      onChanged();
    } catch (err) {
      toast.error('Could not update the style lock', err instanceof ApiError ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card p-4">
      <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-ink">
            Style DNA · <span className="text-brand">{styleDna.name}</span>
          </h3>
          <p className="mt-0.5 text-xs text-ink-muted">{styleDna.summary}</p>
        </div>
        {styleDna.colorPalette.length > 0 ? (
          <div className="flex gap-1" aria-label="Colour palette">
            {styleDna.colorPalette.map((color) => (
              <span
                key={color}
                title={color}
                className="h-6 w-6 rounded-md border border-line"
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
        ) : null}
      </header>

      <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
        {[
          ['Grade', styleDna.colorGrading],
          ['Lighting', styleDna.lighting],
          ['Composition', styleDna.composition],
          ['Lens', styleDna.cameraLens],
          ['Camera', styleDna.cameraStyle],
          ['Realism', styleDna.realismLevel],
        ]
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label}>
              <dt className="text-ink-faint">{label}</dt>
              <dd className="text-ink-muted">{value}</dd>
            </div>
          ))}
      </dl>

      <div className="mt-3 border-t border-line pt-3">
        <Toggle
          checked={styleDna.locked}
          disabled={saving}
          onChange={(value) => void toggleLock(value)}
          label="Style lock"
          description="Keep this exact look across every future generation, and never re-derive it."
        />
      </div>
    </section>
  );
}

function CompetitorReferences({
  projectId,
  assets,
  insights,
  onChanged,
  onRemove,
}: {
  projectId: string;
  assets: AssetWithUrl[];
  insights: ProjectBundle['competitorInsights'];
  onChanged: () => void;
  onRemove: (id: string) => void;
}) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);

  async function uploadFile(file: File) {
    const form = new FormData();
    form.append('file', file);
    setBusy(true);
    setProgress(0);
    try {
      await uploadWithProgress(`/api/projects/${projectId}/competitor-videos`, form, (f) =>
        setProgress(f * 100),
      ).promise;
      toast.success('Reference video added');
      onChanged();
    } catch (err) {
      toast.error('Upload failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  async function addUrl() {
    if (!url.trim()) return;
    setBusy(true);
    try {
      await api.post(`/api/projects/${projectId}/competitor-urls`, { url: url.trim() });
      toast.success('Reference fetched');
      setUrl('');
      onChanged();
    } catch (err) {
      toast.error('Could not fetch that URL', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card p-4">
      <header className="mb-3">
        <h3 className="text-sm font-semibold text-ink">Competitor reference videos</h3>
        <p className="mt-0.5 text-xs text-ink-muted">
          Up to {LIMITS.maxCompetitorVideos} videos. Only editing technique is learned — pacing, structure,
          caption and transition style. Content is never copied.
        </p>
      </header>

      <div className="mb-3 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => inputRef.current?.click()}
          disabled={busy || assets.length >= LIMITS.maxCompetitorVideos}
        >
          Upload video
        </Button>
        <div className="flex min-w-[240px] flex-1 gap-2">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/reference.mp4"
            aria-label="Reference video URL"
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void addUrl()}
            loading={busy}
            disabled={!url.trim() || assets.length >= LIMITS.maxCompetitorVideos}
          >
            Add URL
          </Button>
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="video/mp4,video/quicktime,video/webm"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void uploadFile(file);
          e.target.value = '';
        }}
      />

      {busy && progress > 0 ? <ProgressBar value={progress} className="mb-3" /> : null}

      {assets.length === 0 ? (
        <EmptyState
          title="No reference videos"
          description="Optional. With none supplied, the planner uses a standard short-form rhythm."
        />
      ) : (
        <ul className="space-y-2">
          {assets.map((asset) => {
            const insight = insights.find((i) => i.assetId === asset.id);
            return (
              <li key={asset.id} className="rounded-lg border border-line p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-ink">{asset.filename}</p>
                    <p className="text-[11px] text-ink-faint">
                      {formatBytes(asset.bytes)}
                      {asset.durationSec ? ` · ${Math.round(asset.durationSec)}s` : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemove(asset.id)}
                    className="shrink-0 text-[11px] text-ink-faint hover:text-danger"
                  >
                    Remove
                  </button>
                </div>

                {insight ? (
                  <div className="mt-2 border-t border-line pt-2">
                    <div className="flex flex-wrap gap-1.5">
                      <Badge tone="brand">{insight.editingPace.split(',')[0]}</Badge>
                      <Badge>{insight.avgSceneDurationSec.toFixed(1)}s avg shot</Badge>
                    </div>
                    {insight.recommendations.length > 0 ? (
                      <ul className="mt-2 space-y-1 text-[11px] text-ink-muted">
                        {insight.recommendations.slice(0, 3).map((rec) => (
                          <li key={rec} className="flex gap-1.5">
                            <span className="text-accent">→</span>
                            {rec}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : (
                  <p className="mt-2 text-[11px] text-ink-faint">
                    Analysed when you approve the transcript.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
