'use client';

import { useState } from 'react';
import {
  EXPORT_FORMATS,
  EXPORT_RESOLUTIONS,
  FRAME_RATES,
  type QualityReport,
  type RenderRecord,
} from '@aiedit/shared';
import { ApiError, api, BASE_URL } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { clock, cn, formatBytes, formatRelative } from '@/lib/utils';
import type { ProjectBundle } from '@/lib/use-project';
import { Button } from '../ui/button';
import { JobStatusBadge } from '../status-badge';
import { Badge, EmptyState, Field, ProgressBar, Select } from '../ui/primitives';

export function ExportPanel({
  bundle,
  onChanged,
}: {
  bundle: ProjectBundle;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [format, setFormat] = useState(bundle.project.settings.export.format);
  const [resolution, setResolution] = useState(bundle.project.settings.export.resolution);
  const [fps, setFps] = useState(bundle.project.settings.export.fps);
  const [rendering, setRendering] = useState(false);
  const [quality, setQuality] = useState<QualityReport | null>(bundle.project.qualityReport);
  const [checking, setChecking] = useState(false);

  const latest = bundle.renders.find((r) => r.status === 'completed') ?? null;
  const active = bundle.renders.find((r) => ['pending', 'processing', 'rendering'].includes(r.status));
  const renderJob = bundle.jobs.find((j) => j.type === 'render' && ['pending', 'processing', 'rendering'].includes(j.status));

  const scenesWithMedia = bundle.scenes.filter((s) => s.imageAssetId || s.clipAssetId).length;
  const canRender = scenesWithMedia > 0;

  async function startRender() {
    setRendering(true);
    try {
      await api.post(`/api/projects/${bundle.project.id}/render`, { format, resolution, fps });
      toast.success('Render queued', 'Progress appears here as it encodes.');
      onChanged();
    } catch (err) {
      toast.error('Could not start the render', err instanceof ApiError ? err.message : undefined);
    } finally {
      setRendering(false);
    }
  }

  async function runQualityCheck() {
    setChecking(true);
    try {
      const { report } = await api.get<{ report: QualityReport }>(
        `/api/projects/${bundle.project.id}/quality`,
      );
      setQuality(report);
    } catch (err) {
      toast.error('Quality check failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="space-y-4">
      {latest ? (
        <section className="card overflow-hidden">
          <div className="border-b border-line px-4 py-3">
            <h3 className="text-sm font-semibold text-ink">Latest export</h3>
          </div>
          <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_260px]">
            <div
              className={cn(
                'mx-auto w-full overflow-hidden rounded-lg bg-black',
                bundle.project.aspectRatio === '9:16' ? 'max-w-[280px]' : 'max-w-full',
              )}
            >
              {latest.downloadUrl ? (
                <video src={latest.downloadUrl} controls className="h-full w-full" preload="metadata" />
              ) : null}
            </div>

            <div className="space-y-3 text-xs">
              <dl className="space-y-1.5">
                <Row label="Format" value={latest.format.toUpperCase()} />
                <Row label="Resolution" value={latest.resolution.toUpperCase()} />
                <Row label="Frame rate" value={`${latest.fps} fps`} />
                <Row label="Duration" value={latest.durationSec ? clock(latest.durationSec) : '—'} />
                <Row label="Size" value={latest.bytes ? formatBytes(latest.bytes) : '—'} />
                <Row label="Rendered" value={formatRelative(latest.finishedAt)} />
              </dl>

              {latest.assetId ? (
                <a
                  href={`${BASE_URL}/api/assets/${latest.assetId}/download`}
                  className="block"
                  target="_blank"
                  rel="noreferrer"
                >
                  <Button className="w-full">Download video</Button>
                </a>
              ) : null}

              <div className="flex gap-2">
                {(['srt', 'vtt'] as const).map((captionFormat) => (
                  <a
                    key={captionFormat}
                    href={`${BASE_URL}/api/projects/${bundle.project.id}/captions?format=${captionFormat}`}
                    className="flex-1"
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Button variant="secondary" size="sm" className="w-full">
                      .{captionFormat}
                    </Button>
                  </a>
                ))}
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {active || renderJob ? (
        <section className="card p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink">Rendering</h3>
            {renderJob ? <JobStatusBadge status={renderJob.status} /> : null}
          </div>
          <ProgressBar value={renderJob?.progress ?? 0} />
          <p className="mt-2 text-xs text-ink-muted">{renderJob?.message ?? 'Preparing…'}</p>
          {renderJob ? (
            <Button
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() =>
                void api
                  .post(`/api/jobs/${renderJob.id}/cancel`)
                  .then(() => {
                    toast.info('Render cancelled');
                    onChanged();
                  })
                  .catch((err) => toast.error('Cancel failed', err instanceof ApiError ? err.message : undefined))
              }
            >
              Cancel render
            </Button>
          ) : null}
        </section>
      ) : null}

      <section className="card p-4">
        <h3 className="mb-3 text-sm font-semibold text-ink">New export</h3>

        {!canRender ? (
          <EmptyState
            title="Nothing to render yet"
            description="Generate scene imagery before exporting."
          />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Format">
                <Select value={format} onChange={(e) => setFormat(e.target.value as never)}>
                  {EXPORT_FORMATS.map((value) => (
                    <option key={value} value={value}>
                      {value.toUpperCase()}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Resolution">
                <Select value={resolution} onChange={(e) => setResolution(e.target.value as never)}>
                  {EXPORT_RESOLUTIONS.map((value) => (
                    <option key={value} value={value}>
                      {value.toUpperCase()}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Frame rate">
                <Select value={String(fps)} onChange={(e) => setFps(Number(e.target.value) as never)}>
                  {FRAME_RATES.map((value) => (
                    <option key={value} value={value}>
                      {value} fps
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button loading={rendering} disabled={Boolean(active)} onClick={() => void startRender()}>
                Render {resolution.toUpperCase()} {format.toUpperCase()}
              </Button>
              <Button variant="secondary" loading={checking} onClick={() => void runQualityCheck()}>
                Run quality check
              </Button>
              <span className="text-xs text-ink-faint">
                {scenesWithMedia}/{bundle.scenes.length} scenes have media
              </span>
            </div>
          </>
        )}
      </section>

      {quality ? <QualityReportCard report={quality} /> : null}

      {bundle.renders.length > 0 ? (
        <section className="card overflow-hidden">
          <div className="border-b border-line px-4 py-3">
            <h3 className="text-sm font-semibold text-ink">Export history</h3>
          </div>
          <ul className="divide-y divide-line">
            {bundle.renders.map((render) => (
              <RenderRow key={render.id} render={render} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function RenderRow({ render }: { render: RenderRecord }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-xs">
      <div className="flex items-center gap-2">
        <JobStatusBadge status={render.status} />
        <span className="font-mono text-ink">
          {render.resolution.toUpperCase()} · {render.format.toUpperCase()} · {render.fps}fps
        </span>
      </div>
      <div className="flex items-center gap-3 text-ink-faint">
        {render.bytes ? <span>{formatBytes(render.bytes)}</span> : null}
        {render.qualityReport ? (
          <span className="font-mono">QC {render.qualityReport.overall}</span>
        ) : null}
        <span>{formatRelative(render.finishedAt ?? render.createdAt)}</span>
        {render.downloadUrl ? (
          <a href={render.downloadUrl} target="_blank" rel="noreferrer" className="text-brand hover:underline">
            Download
          </a>
        ) : null}
      </div>
    </li>
  );
}

export function QualityReportCard({ report }: { report: QualityReport }) {
  const tone =
    report.overall >= 85 ? 'text-ok' : report.overall >= 70 ? 'text-warn' : 'text-danger';

  return (
    <section className="card p-4">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">Quality report</h3>
        <div className="flex items-baseline gap-2">
          <span className={cn('font-mono text-2xl font-semibold', tone)}>{report.overall}</span>
          <Badge tone={report.overall >= 85 ? 'ok' : report.overall >= 70 ? 'warn' : 'danger'}>
            Grade {report.grade}
          </Badge>
        </div>
      </div>

      <div className="space-y-2.5">
        {report.metrics.map((metric) => (
          <div key={metric.key}>
            <div className="mb-1 flex items-baseline justify-between text-xs">
              <span className="text-ink">{metric.label}</span>
              <span className="font-mono text-ink-muted">{metric.score}</span>
            </div>
            <ProgressBar
              value={metric.score}
              tone={metric.score >= 80 ? 'ok' : metric.score >= 60 ? 'brand' : 'danger'}
            />
            {metric.notes ? <p className="mt-1 text-[11px] text-ink-faint">{metric.notes}</p> : null}
          </div>
        ))}
      </div>

      {report.warnings.length > 0 ? (
        <div className="mt-4 rounded-lg border border-warn/40 bg-warn/10 p-3">
          <p className="mb-1.5 text-xs font-medium text-warn">Before you publish</p>
          <ul className="space-y-1 text-[11px] text-ink-muted">
            {report.warnings.map((warning) => (
              <li key={warning} className="flex gap-1.5">
                <span className="text-warn">•</span>
                {warning}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="font-mono text-ink">{value}</dd>
    </div>
  );
}
