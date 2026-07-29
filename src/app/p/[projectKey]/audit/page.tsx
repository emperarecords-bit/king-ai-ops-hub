import Link from 'next/link';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { AppError } from '@/lib/errors';
import { searchAuditEvents, type AuditSearchFilters } from '@/domain/audit/audit';
import { Card, EmptyState, PageHeader } from '@/components/ui';

/**
 * Audit history (HUB-006). Server-backed search over the ENTIRE append-only trail — not a browser slice.
 * Read-only: nothing here writes a row or a hash. Keyset paginated on the monotonic `seq`.
 */
export default async function AuditLogPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectKey: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectKey } = await params;
  const sp = await searchParams;
  const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? '')).trim();

  const q = one(sp.q);
  const action = one(sp.action);
  const matchType = one(sp.match) === 'prefix' ? 'prefix' : 'exact';
  const entityType = one(sp.entityType);
  const entityId = one(sp.entityId);
  const start = one(sp.start);
  const end = one(sp.end);
  const cursor = one(sp.cursor);

  const filters: AuditSearchFilters = {
    action: action && matchType === 'exact' ? action : null,
    actionPrefix: action && matchType === 'prefix' ? action : null,
    entityType: entityType || null,
    entityId: /^[0-9a-f-]{36}$/i.test(entityId) ? entityId : null,
    freeText: q || null,
    startUtc: /^\d{4}-\d{2}-\d{2}$/.test(start) ? new Date(`${start}T00:00:00.000Z`) : null,
    endUtc: /^\d{4}-\d{2}-\d{2}$/.test(end) ? new Date(`${end}T23:59:59.999Z`) : null,
  };
  const hasFilters = !!(q || action || entityType || filters.entityId || filters.startUtc || filters.endUtc);
  const cursorSeq = /^\d+$/.test(cursor) ? BigInt(cursor) : null;

  const ctx = await requireTenant(projectKey);

  let restricted = false;
  let result: Awaited<ReturnType<typeof searchAuditEvents>> | null = null;
  try {
    result = await withTenant(ctx, (tx) => searchAuditEvents(tx, ctx, filters, { cursorSeq, limit: 50 }));
  } catch (err) {
    if (err instanceof AppError && err.code === 'forbidden') restricted = true;
    else throw err;
  }

  const base = `/p/${projectKey}/audit`;
  const olderHref = (): string => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (action) { p.set('action', action); p.set('match', matchType); }
    if (entityType) p.set('entityType', entityType);
    if (entityId) p.set('entityId', entityId);
    if (start) p.set('start', start);
    if (end) p.set('end', end);
    if (result?.nextCursor) p.set('cursor', result.nextCursor);
    return `${base}?${p.toString()}`;
  };
  const latestHref = (): string => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (action) { p.set('action', action); p.set('match', matchType); }
    if (entityType) p.set('entityType', entityType);
    if (entityId) p.set('entityId', entityId);
    if (start) p.set('start', start);
    if (end) p.set('end', end);
    return p.toString() ? `${base}?${p.toString()}` : base;
  };

  const inputClass = 'rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]';

  return (
    <div>
      <PageHeader
        title="Audit log"
        subtitle="Append-only and hash-chained. Rows cannot be edited or deleted — corrections are new events. Search covers the entire authorized history."
      />

      {restricted ? (
        <Card>
          <EmptyState>Access restricted — your role cannot view the audit history.</EmptyState>
        </Card>
      ) : (
        <>
          {/* Server-backed filters (GET). Apply submits; Clear resets. */}
          <Card className="mb-6">
            <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <label className="flex flex-col gap-1 text-xs text-[var(--muted)] lg:col-span-3">
                Free text (detail + action — case-insensitive substring)
                <input name="q" defaultValue={q} placeholder="e.g. pilot" className={inputClass} />
              </label>
              <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
                Action
                <div className="flex gap-2">
                  <input name="action" defaultValue={action} placeholder="approval.decided" className={`${inputClass} flex-1`} />
                  <select name="match" defaultValue={matchType} className={inputClass} aria-label="match type">
                    <option value="exact">exact</option>
                    <option value="prefix">prefix</option>
                  </select>
                </div>
              </label>
              <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
                Entity type
                <input name="entityType" defaultValue={entityType} placeholder="approval" className={inputClass} />
              </label>
              <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
                Entity ID
                <input name="entityId" defaultValue={entityId} placeholder="uuid" className={inputClass} />
              </label>
              <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
                From (UTC)
                <input type="date" name="start" defaultValue={start} className={inputClass} />
              </label>
              <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
                To (UTC)
                <input type="date" name="end" defaultValue={end} className={inputClass} />
              </label>
              <div className="flex items-end gap-2">
                <button type="submit" className="rounded-md bg-[var(--accent)] px-4 py-1.5 text-sm font-semibold text-[#0b0e14]">
                  Apply
                </button>
                <Link href={base} className="rounded-md border border-[var(--border)] px-4 py-1.5 text-sm text-[var(--muted)] hover:text-[var(--foreground)]">
                  Clear
                </Link>
              </div>
            </form>
          </Card>

          <Card>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--muted)]">
              <span>
                {result!.totalCount} {result!.totalCount === 1 ? 'event' : 'events'} match
                {hasFilters ? ' these filters' : ' in this workspace'}
                {cursorSeq != null ? ' · viewing an older page' : ''}
              </span>
              <span>Hash-chained · chain verification is not yet available (no unverified badge shown).</span>
            </div>

            {result!.rows.length === 0 ? (
              hasFilters ? (
                <EmptyState>No audit events match these filters.</EmptyState>
              ) : (
                <EmptyState>No audit events in this workspace yet.</EmptyState>
              )
            ) : (
              <>
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-xs uppercase text-[var(--muted)]">
                      <th className="py-2 pr-4">When (UTC)</th>
                      <th className="py-2 pr-4">Action</th>
                      <th className="py-2 pr-4">Entity</th>
                      <th className="py-2">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result!.rows.map((e) => (
                      <tr key={e.id} className="border-b border-[var(--border)] align-top">
                        <td className="whitespace-nowrap py-2 pr-4 text-[var(--muted)]">
                          {e.createdAt.toISOString().slice(0, 19).replace('T', ' ')}
                        </td>
                        <td className="py-2 pr-4 font-mono text-xs">{e.action}</td>
                        <td className="py-2 pr-4 text-xs text-[var(--muted)]">
                          {e.entityType}
                          {e.entityId ? ` ${e.entityId.slice(0, 8)}…` : ''}
                        </td>
                        <td className="max-w-md py-2">
                          <details>
                            <summary className="cursor-pointer text-xs text-[var(--muted)] hover:text-[var(--foreground)]">
                              Inspect event
                            </summary>
                            <dl className="mt-2 space-y-1 text-[11px]">
                              <Row k="Sequence" v={e.seq.toString()} />
                              <Row k="Action" v={e.action} />
                              <Row k="Entity" v={`${e.entityType}${e.entityId ? ` · ${e.entityId}` : ''}`} />
                              <Row k="Actor" v={e.actorId ?? 'system / not recorded'} />
                              <Row k="Workspace" v={e.projectId ?? 'org-level'} />
                              <Row k="Row hash" v={e.rowHash} mono />
                              <Row k="Prev hash" v={e.prevHash} mono />
                              <div>
                                <dt className="text-[var(--muted)]">Detail (secret-bearing keys redacted)</dt>
                                <dd>
                                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded bg-[var(--surface-raised)] p-2 font-mono text-[11px]">
                                    {JSON.stringify(e.detail, null, 2)}
                                  </pre>
                                </dd>
                              </div>
                            </dl>
                          </details>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div className="mt-4 flex items-center gap-3 text-sm">
                  {cursorSeq != null ? (
                    <Link href={latestHref()} className="text-[var(--accent)]">
                      ← Back to latest
                    </Link>
                  ) : null}
                  {result!.hasMore ? (
                    <Link href={olderHref()} className="text-[var(--accent)]">
                      Load older →
                    </Link>
                  ) : (
                    <span className="text-xs text-[var(--muted)]">End of history for this view.</span>
                  )}
                </div>
              </>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }): React.ReactElement {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 text-[var(--muted)]">{k}</dt>
      <dd className={`break-all ${mono ? 'font-mono' : ''}`}>{v}</dd>
    </div>
  );
}
