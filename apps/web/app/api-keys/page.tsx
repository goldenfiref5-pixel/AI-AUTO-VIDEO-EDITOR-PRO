'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  KEY_STRATEGIES,
  type ApiKeyRecord,
  type ApiKeyTestResult,
  type KeyPoolSettings,
} from '@aiedit/shared';
import { ApiError, api } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { cn, formatNumber, formatRelative } from '@/lib/utils';
import { AppShell } from '@/components/app-shell';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { ConfirmModal, Modal } from '@/components/ui/modal';
import { Badge, EmptyState, Field, Input, Select, Skeleton, type BadgeTone } from '@/components/ui/primitives';

interface KeysResponse {
  keys: ApiKeyRecord[];
  settings: KeyPoolSettings;
  health: { total: number; enabled: number; usable: number; coolingDown: number; invalid: number };
}

const STATUS_TONES: Record<ApiKeyRecord['status'], BadgeTone> = {
  untested: 'neutral',
  valid: 'ok',
  invalid: 'danger',
  expired: 'danger',
  blocked: 'danger',
  quota_exceeded: 'warn',
  rate_limited: 'warn',
  error: 'danger',
};

const STATUS_LABELS: Record<ApiKeyRecord['status'], string> = {
  untested: 'Untested',
  valid: 'Valid',
  invalid: 'Invalid',
  expired: 'Expired',
  blocked: 'Blocked',
  quota_exceeded: 'Quota exceeded',
  rate_limited: 'Rate limited',
  error: 'Error',
};

export default function ApiKeysPage() {
  return (
    <AppShell>
      <ApiKeys />
    </AppShell>
  );
}

function ApiKeys() {
  const toast = useToast();
  const [data, setData] = useState<KeysResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<ApiKeyRecord | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testingAll, setTestingAll] = useState(false);
  const [results, setResults] = useState<Record<string, ApiKeyTestResult>>({});
  const [dragId, setDragId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<KeysResponse>('/api/api-keys'));
    } catch (err) {
      if (err instanceof ApiError) toast.error('Could not load API keys', err.message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function testKey(key: ApiKeyRecord) {
    setTestingId(key.id);
    try {
      const { result } = await api.post<{ result: ApiKeyTestResult }>(`/api/api-keys/${key.id}/test`);
      setResults((current) => ({ ...current, [key.id]: result }));
      if (result.ok) toast.success(`${key.name} is valid`, result.message);
      else toast.error(`${key.name} failed`, result.message);
      await load();
    } catch (err) {
      toast.error('Test failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setTestingId(null);
    }
  }

  async function testAll() {
    setTestingAll(true);
    try {
      const { results: all } = await api.post<{ results: ApiKeyTestResult[] }>('/api/api-keys/test-all');
      setResults(Object.fromEntries(all.map((r) => [r.keyId, r])));
      const ok = all.filter((r) => r.ok).length;
      toast.info(`${ok}/${all.length} keys are healthy`);
      await load();
    } catch (err) {
      toast.error('Bulk test failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setTestingAll(false);
    }
  }

  async function toggleEnabled(key: ApiKeyRecord) {
    try {
      await api.patch(`/api/api-keys/${key.id}`, { enabled: !key.enabled });
      await load();
    } catch (err) {
      toast.error('Could not update the key', err instanceof ApiError ? err.message : undefined);
    }
  }

  async function rename(key: ApiKeyRecord, name: string) {
    try {
      await api.patch(`/api/api-keys/${key.id}`, { name });
      await load();
    } catch (err) {
      toast.error('Rename failed', err instanceof ApiError ? err.message : undefined);
    }
  }

  async function reorder(orderedIds: string[]) {
    try {
      await api.post('/api/api-keys/reorder', { keyIds: orderedIds });
      await load();
    } catch (err) {
      toast.error('Reorder failed', err instanceof ApiError ? err.message : undefined);
      await load();
    }
  }

  async function saveSettings(settings: KeyPoolSettings) {
    try {
      await api.put('/api/api-keys/settings', settings);
      toast.success('Pool settings saved');
      await load();
    } catch (err) {
      toast.error('Could not save pool settings', err instanceof ApiError ? err.message : undefined);
    }
  }

  return (
    <>
      <PageHeader
        title="API management"
        description="Add as many Gemini keys as you like. Requests fail over automatically, or spread across every healthy key."
        actions={
          <>
            <Button variant="secondary" loading={testingAll} onClick={() => void testAll()}>
              Test all keys
            </Button>
            <Button onClick={() => setAdding(true)}>Add key</Button>
          </>
        }
      />

      <div className="space-y-4 p-6">
        {data ? <HealthStrip health={data.health} /> : null}

        {data ? <PoolSettingsCard settings={data.settings} onSave={saveSettings} /> : null}

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
        ) : data && data.keys.length > 0 ? (
          <div className="card overflow-hidden">
            <div className="border-b border-line px-4 py-2.5">
              <h3 className="text-sm font-semibold text-ink">Failover order</h3>
              <p className="mt-0.5 text-xs text-ink-muted">
                Drag to reorder. In failover mode the topmost healthy key serves every request.
              </p>
            </div>

            <ul className="divide-y divide-line">
              {data.keys.map((key, index) => (
                <li
                  key={key.id}
                  draggable
                  onDragStart={() => setDragId(key.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (!dragId || dragId === key.id) return;
                    const ids = data.keys.map((k) => k.id);
                    const from = ids.indexOf(dragId);
                    const to = ids.indexOf(key.id);
                    ids.splice(to, 0, ...ids.splice(from, 1));
                    setDragId(null);
                    void reorder(ids);
                  }}
                  onDragEnd={() => setDragId(null)}
                  className={cn(
                    'flex cursor-grab flex-wrap items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-hover active:cursor-grabbing',
                    dragId === key.id && 'opacity-40',
                    !key.enabled && 'opacity-60',
                  )}
                >
                  <span className="w-6 shrink-0 text-center font-mono text-xs text-ink-faint">
                    {index + 1}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <EditableName name={key.name} onSave={(name) => void rename(key, name)} />
                      <Badge tone={STATUS_TONES[key.status]}>{STATUS_LABELS[key.status]}</Badge>
                      {key.cooldownUntil && Date.parse(key.cooldownUntil) > Date.now() ? (
                        <Badge tone="warn">Cooling down</Badge>
                      ) : null}
                    </div>
                    <p className="mt-0.5 font-mono text-[11px] text-ink-faint">{key.maskedKey}</p>
                    {(results[key.id]?.message ?? key.statusMessage) ? (
                      <p className="mt-1 line-clamp-2 text-[11px] text-ink-muted">
                        {results[key.id]?.message ?? key.statusMessage}
                      </p>
                    ) : null}
                  </div>

                  <dl className="flex shrink-0 gap-4 text-[11px]">
                    <Metric label="Requests" value={formatNumber(key.requestCount)} />
                    <Metric
                      label="Latency"
                      value={key.responseTimeMs ? `${key.responseTimeMs}ms` : '—'}
                    />
                    <Metric label="Models" value={key.availableModels.length ? String(key.availableModels.length) : '—'} />
                    <Metric label="Tested" value={formatRelative(key.lastTestedAt)} />
                  </dl>

                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={testingId === key.id}
                      onClick={() => void testKey(key)}
                    >
                      Test API
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void toggleEnabled(key)}>
                      {key.enabled ? 'Disable' : 'Enable'}
                    </Button>
                    <Button variant="ghost" size="sm" className="text-danger" onClick={() => setDeleting(key)}>
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <EmptyState
            title="No API keys yet"
            description="Add at least one Gemini API key so the pipeline can transcribe, plan and generate."
            action={<Button onClick={() => setAdding(true)}>Add your first key</Button>}
          />
        )}
      </div>

      <AddKeyModal
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={() => {
          setAdding(false);
          void load();
        }}
      />

      <ConfirmModal
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          void api
            .delete(`/api/api-keys/${deleting.id}`)
            .then(() => {
              toast.success('Key deleted');
              setDeleting(null);
              return load();
            })
            .catch((err) => toast.error('Delete failed', err instanceof ApiError ? err.message : undefined));
        }}
        title="Delete this API key?"
        description={`"${deleting?.name}" will be removed from the pool. Jobs already running on it will fail over to the next key.`}
        confirmLabel="Delete key"
        destructive
      />
    </>
  );
}

function HealthStrip({ health }: { health: KeysResponse['health'] }) {
  const items = [
    { label: 'Total keys', value: health.total, tone: 'text-ink' },
    { label: 'Enabled', value: health.enabled, tone: 'text-ink' },
    { label: 'Usable now', value: health.usable, tone: health.usable > 0 ? 'text-ok' : 'text-danger' },
    { label: 'Cooling down', value: health.coolingDown, tone: health.coolingDown ? 'text-warn' : 'text-ink-muted' },
    { label: 'Invalid', value: health.invalid, tone: health.invalid ? 'text-danger' : 'text-ink-muted' },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      {items.map((item) => (
        <div key={item.label} className="card p-3">
          <p className="text-[10px] uppercase tracking-wide text-ink-faint">{item.label}</p>
          <p className={cn('mt-0.5 font-mono text-xl', item.tone)}>{item.value}</p>
        </div>
      ))}
    </div>
  );
}

function PoolSettingsCard({
  settings,
  onSave,
}: {
  settings: KeyPoolSettings;
  onSave: (settings: KeyPoolSettings) => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  useEffect(() => setDraft(settings), [settings]);

  return (
    <section className="card p-4">
      <h3 className="mb-3 text-sm font-semibold text-ink">Pool behaviour</h3>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field
          label="Strategy"
          hint={
            draft.strategy === 'failover'
              ? 'Use the highest-priority healthy key; move on only when it fails.'
              : 'Spread requests across every healthy key for more throughput.'
          }
        >
          <Select
            value={draft.strategy}
            onChange={(e) => setDraft({ ...draft, strategy: e.target.value as KeyPoolSettings['strategy'] })}
          >
            {KEY_STRATEGIES.map((strategy) => (
              <option key={strategy} value={strategy}>
                {strategy === 'failover' ? 'Failover (priority order)' : 'Load balance'}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Max concurrent per key">
          <Input
            type="number"
            min={1}
            max={64}
            value={draft.maxConcurrentPerKey}
            onChange={(e) => setDraft({ ...draft, maxConcurrentPerKey: Number(e.target.value) })}
          />
        </Field>

        <Field label="Cooldown (seconds)" hint="How long a rate-limited key is benched.">
          <Input
            type="number"
            min={5}
            max={3600}
            value={draft.cooldownSeconds}
            onChange={(e) => setDraft({ ...draft, cooldownSeconds: Number(e.target.value) })}
          />
        </Field>

        <Field label="Max retries per key">
          <Input
            type="number"
            min={1}
            max={20}
            value={draft.maxRetries}
            onChange={(e) => setDraft({ ...draft, maxRetries: Number(e.target.value) })}
          />
        </Field>
      </div>

      {dirty ? (
        <div className="mt-3 flex justify-end">
          <Button
            size="sm"
            loading={saving}
            onClick={() => {
              setSaving(true);
              void onSave(draft).finally(() => setSaving(false));
            }}
          >
            Save pool settings
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function AddKeyModal({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const { test } = await api.post<{ test: ApiKeyTestResult | null }>('/api/api-keys', {
        name: name.trim(),
        key: key.trim(),
      });
      if (test && !test.ok) toast.error('Key saved but failed its test', test.message);
      else toast.success('Key added and verified');
      setName('');
      setKey('');
      onAdded();
    } catch (err) {
      toast.error('Could not add the key', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a Gemini API key"
      description="Keys are encrypted at rest and tested immediately."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={busy} disabled={!name.trim() || key.trim().length < 20}>
            Add and test
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Label" htmlFor="key-name" hint="Something you will recognise later, like “Studio account 1”.">
          <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="API key" htmlFor="key-value">
          <Input
            id="key-value"
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="AIza…"
            className="font-mono"
            autoComplete="off"
          />
        </Field>
        <p className="text-[11px] text-ink-faint">
          Get a key from Google AI Studio. It is stored encrypted with AES-256-GCM and never returned to
          the browser again.
        </p>
      </div>
    </Modal>
  );
}

function EditableName({ name, onSave }: { name: string; onSave: (value: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);

  useEffect(() => setValue(name), [name]);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="text-sm font-medium text-ink hover:text-brand"
        title="Rename"
      >
        {name}
      </button>
    );
  }

  return (
    <input
      value={value}
      autoFocus
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (value.trim() && value !== name) onSave(value.trim());
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setValue(name);
          setEditing(false);
        }
      }}
      className="w-40 rounded border border-brand bg-canvas px-1.5 py-0.5 text-sm text-ink"
    />
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-right">
      <dt className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</dt>
      <dd className="font-mono text-ink-muted">{value}</dd>
    </div>
  );
}
