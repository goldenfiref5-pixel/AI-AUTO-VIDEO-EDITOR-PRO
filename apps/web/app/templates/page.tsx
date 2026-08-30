'use client';

import { useCallback, useEffect, useState } from 'react';
import { TEMPLATE_KINDS, type Template, type TemplateKind } from '@aiedit/shared';
import { ApiError, api } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { cn, formatRelative } from '@/lib/utils';
import { AppShell } from '@/components/app-shell';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { ConfirmModal } from '@/components/ui/modal';
import { EmptyState, Skeleton } from '@/components/ui/primitives';

const KIND_LABELS: Record<TemplateKind, string> = {
  style_dna: 'Style DNA',
  character: 'Character',
  caption_preset: 'Caption preset',
  export_preset: 'Export preset',
  video_template: 'Video template',
};

export default function TemplatesPage() {
  return (
    <AppShell>
      <Templates />
    </AppShell>
  );
}

function Templates() {
  const toast = useToast();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<TemplateKind | ''>('');
  const [deleting, setDeleting] = useState<Template | null>(null);

  const load = useCallback(async () => {
    try {
      const { templates: found } = await api.get<{ templates: Template[] }>('/api/templates', {
        query: { kind: kind || undefined },
      });
      setTemplates(found);
    } catch (err) {
      if (err instanceof ApiError) toast.error('Could not load templates', err.message);
    } finally {
      setLoading(false);
    }
  }, [kind, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHeader
        title="Templates"
        description="Reusable Style DNA profiles, caption presets and export specs. Save one from any project, then apply it to the next."
      />

      <div className="space-y-4 p-6">
        <div className="flex flex-wrap gap-1.5">
          <FilterChip active={kind === ''} onClick={() => setKind('')}>
            All
          </FilterChip>
          {TEMPLATE_KINDS.map((value) => (
            <FilterChip key={value} active={kind === value} onClick={() => setKind(value)}>
              {KIND_LABELS[value]}
            </FilterChip>
          ))}
        </div>

        {loading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-28" />
            ))}
          </div>
        ) : templates.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map((template) => (
              <article key={template.id} className="card p-4">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <h3 className="truncate text-sm font-medium text-ink">{template.name}</h3>
                  <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[10px] text-ink-muted">
                    {KIND_LABELS[template.kind]}
                  </span>
                </div>
                {template.description ? (
                  <p className="line-clamp-2 text-xs text-ink-muted">{template.description}</p>
                ) : null}
                <div className="mt-3 flex items-center justify-between border-t border-line pt-2">
                  <span className="text-[11px] text-ink-faint">
                    Updated {formatRelative(template.updatedAt)}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-danger"
                    onClick={() => setDeleting(template)}
                  >
                    Delete
                  </Button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No templates saved"
            description="Open a project's export settings and save its caption or export configuration to start a library."
          />
        )}
      </div>

      <ConfirmModal
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          void api
            .delete(`/api/templates/${deleting.id}`)
            .then(() => {
              toast.success('Template deleted');
              setDeleting(null);
              return load();
            })
            .catch((err) => toast.error('Delete failed', err instanceof ApiError ? err.message : undefined));
        }}
        title="Delete this template?"
        description={`"${deleting?.name}" will be removed. Projects already using it are unaffected.`}
        confirmLabel="Delete template"
        destructive
      />
    </>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border px-3 py-1 text-xs transition-colors',
        active ? 'border-brand bg-brand-subtle text-ink' : 'border-line text-ink-muted hover:border-line-strong',
      )}
    >
      {children}
    </button>
  );
}
