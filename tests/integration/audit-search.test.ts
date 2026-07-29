import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { auditLogs, memberships, organizations, profiles, projectMembers, projects } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { getAuditEvent, searchAuditEvents } from '@/domain/audit/audit';

/**
 * HUB-006 — server-backed audit discovery. Read-only search over the FULL append-only history:
 * exact/prefix action, entity, free text, UTC range, keyset pagination on `seq`, redaction, permissions.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[audit-search.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

const db = getSetupDb();
let orgId = '';
let ctx: TenantContext; // workspace A, admin
let ctx2: TenantContext; // workspace B, admin

let seqCounter = 0;
async function seedAudit(project: TenantContext, e: {
  action: string; entityType: string; entityId?: string | null; detail?: Record<string, unknown>; createdAt?: Date;
}): Promise<void> {
  seqCounter += 1;
  await db.insert(auditLogs).values({
    orgId,
    projectId: project.projectId,
    actorId: project.userId,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId ?? null,
    detail: e.detail ?? {},
    prevHash: 'p'.repeat(64),
    rowHash: `h${seqCounter}`.padEnd(64, '0'),
    createdAt: e.createdAt ?? new Date(Date.UTC(2026, 0, 1, 0, 0, seqCounter)),
  });
}

beforeAll(async () => {
  if (!available) return;
  const userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `au-${randomUUID().slice(0, 8)}@t.local`, displayName: 'A' });
  orgId = (await db.insert(organizations).values({ name: 'O', slug: `au-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  const pid = (await db.insert(projects).values({ orgId, key: fixtureKey('au'), name: 'A' }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId: pid, userId, role: 'admin' });
  ctx = { userId, orgId, projectId: pid, orgRole: 'owner', projectRole: 'admin' };
  const pid2 = (await db.insert(projects).values({ orgId, key: fixtureKey('au2'), name: 'B' }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId: pid2, userId, role: 'admin' });
  ctx2 = { userId, orgId, projectId: pid2, orgRole: 'owner', projectRole: 'admin' };

  // Workspace A history: 4 approval decisions + 1 reconcile + a redaction case + a dated event.
  const taskId = randomUUID();
  for (let i = 0; i < 4; i++) await seedAudit(ctx, { action: 'approval.decided', entityType: 'approval', entityId: randomUUID(), detail: { taskId, decision: 'approved' } });
  await seedAudit(ctx, { action: 'task.authorization_reconciled', entityType: 'task', entityId: taskId, detail: { from: 'awaiting_approval', to: 'completed' } });
  await seedAudit(ctx, { action: 'approval.requested', entityType: 'approval', entityId: randomUUID(), detail: { note: 'PILOT launch kit' } });
  await seedAudit(ctx, { action: 'secret.upserted', entityType: 'integration_secret', detail: { apiKey: 'sk-supersecret', lastFour: '1234' } });
  await seedAudit(ctx, { action: 'objective.created', entityType: 'objective', entityId: randomUUID(), detail: {}, createdAt: new Date(Date.UTC(2026, 5, 15, 12, 0, 0)) });
  // Two events sharing an identical timestamp (keyset must not drop/duplicate).
  const ts = new Date(Date.UTC(2026, 2, 3, 4, 5, 6));
  await seedAudit(ctx, { action: 'run.completed', entityType: 'run', createdAt: ts });
  await seedAudit(ctx, { action: 'run.completed', entityType: 'run', createdAt: ts });
  // Workspace B — must never appear in A's results.
  await seedAudit(ctx2, { action: 'approval.decided', entityType: 'approval', entityId: randomUUID(), detail: { secretOfB: true } });
});

afterAll(async () => {
  if (!available) return;
  await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});

const search = (f = {}, o = {}) => withTenant(ctx, (tx) => searchAuditEvents(tx, ctx, f, o));

describe.skipIf(!available)('HUB-006 audit search', () => {
  it('exact action search returns only that action', async () => {
    const r = await search({ action: 'approval.decided' });
    expect(r.rows.length).toBe(4);
    expect(r.rows.every((x) => x.action === 'approval.decided')).toBe(true);
  });

  it('action-prefix search matches the family (server-side, not client wildcard)', async () => {
    const r = await search({ actionPrefix: 'approval.' });
    expect(r.totalCount).toBe(5); // 4 decided + 1 requested
    expect(r.rows.every((x) => x.action.startsWith('approval.'))).toBe(true);
  });

  it('entity type + entity ID search', async () => {
    const rec = await search({ action: 'task.authorization_reconciled' });
    const taskId = rec.rows[0]!.entityId!;
    const r = await search({ entityType: 'task', entityId: taskId });
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]!.action).toBe('task.authorization_reconciled');
  });

  it('free-text is a case-insensitive substring over detail + action', async () => {
    const lower = await search({ freeText: 'pilot' });
    const upper = await search({ freeText: 'PILOT' });
    expect(lower.totalCount).toBe(upper.totalCount);
    expect(lower.totalCount).toBeGreaterThanOrEqual(1);
    expect(lower.rows.some((x) => JSON.stringify(x.detail).toLowerCase().includes('pilot'))).toBe(true);
  });

  it('UTC start/end boundaries filter by created_at', async () => {
    const june = await search({ startUtc: new Date('2026-06-01T00:00:00Z'), endUtc: new Date('2026-06-30T23:59:59Z') });
    expect(june.rows.every((x) => x.createdAt >= new Date('2026-06-01T00:00:00Z') && x.createdAt <= new Date('2026-06-30T23:59:59Z'))).toBe(true);
    expect(june.rows.some((x) => x.action === 'objective.created')).toBe(true);
  });

  it('newest-first stable ordering on seq; identical timestamps neither dropped nor duplicated', async () => {
    const r = await search({ action: 'run.completed' });
    expect(r.rows.length).toBe(2); // both same-timestamp events present
    expect(r.rows[0]!.seq > r.rows[1]!.seq).toBe(true); // strictly descending seq
  });

  it('keyset pagination walks the FULL history with no duplicates or omissions (beyond one page)', async () => {
    // Seed enough to exceed a small page size, then page through all.
    for (let i = 0; i < 25; i++) await seedAudit(ctx, { action: 'run.started', entityType: 'run' });
    const seen = new Set<string>();
    let cursor: bigint | null = null;
    let pages = 0;
    for (;;) {
      const r: Awaited<ReturnType<typeof searchAuditEvents>> = await search({}, { cursorSeq: cursor, limit: 10 });
      for (const row of r.rows) {
        expect(seen.has(row.id)).toBe(false); // no duplicate across pages
        seen.add(row.id);
      }
      pages += 1;
      if (!r.nextCursor) break;
      cursor = BigInt(r.nextCursor);
      if (pages > 50) throw new Error('runaway pagination');
    }
    const total = (await search({})).totalCount;
    expect(seen.size).toBe(total); // every row retrieved exactly once — no omissions
    expect(pages).toBeGreaterThan(1); // genuinely multi-page
  });

  it('empty results for a non-matching filter', async () => {
    const r = await search({ action: 'nonexistent.action' });
    expect(r.rows.length).toBe(0);
    expect(r.totalCount).toBe(0);
    expect(r.nextCursor).toBeNull();
  });

  it('workspace isolation — workspace B events never appear in A', async () => {
    const r = await search({ freeText: 'secretOfB' });
    expect(r.totalCount).toBe(0);
    const all = await search({}, { limit: 100 });
    expect(all.rows.every((x) => x.projectId === ctx.projectId)).toBe(true);
  });

  it('permission rejection — a viewer cannot search the audit trail', async () => {
    const viewer = { ...ctx, projectRole: 'viewer' as const };
    await expect(withTenant(viewer, (tx) => searchAuditEvents(tx, viewer, {}))).rejects.toThrow(/cannot view/i);
  });

  it('redacts secret-bearing keys in detail but keeps the rest', async () => {
    const r = await search({ action: 'secret.upserted' });
    const d = r.rows[0]!.detail as Record<string, unknown>;
    expect(d.apiKey).toBe('[redacted]');
    expect(d.lastFour).toBe('1234');
  });

  it('event-detail retrieval returns one event with hash fields (redacted)', async () => {
    const list = await search({ action: 'secret.upserted' });
    const id = list.rows[0]!.id;
    const one = await withTenant(ctx, (tx) => getAuditEvent(tx, ctx, id));
    expect(one).not.toBeNull();
    expect(one!.rowHash).toBeTruthy();
    expect(one!.prevHash).toBeTruthy();
    expect((one!.detail as Record<string, unknown>).apiKey).toBe('[redacted]');
  });

  // --- HUB-006 correction 1: free-text must not expose secret VALUES (inference) -------------------
  it('a top-level secret value cannot be found by free-text search', async () => {
    await seedAudit(ctx, { action: 'secret.upserted', entityType: 'integration_secret', detail: { apiKey: 'TOPSECRET-AAAA', service: 'stripe' } });
    const bySecret = await search({ freeText: 'TOPSECRET-AAAA' });
    expect(bySecret.totalCount).toBe(0); // secret value never matches
    const bySibling = await search({ freeText: 'stripe' });
    expect(bySibling.totalCount).toBeGreaterThanOrEqual(1); // permitted sibling value still searchable
  });

  it('a NESTED secret value cannot be found by free-text search', async () => {
    await seedAudit(ctx, { action: 'integration.configured', entityType: 'integration_secret', detail: { config: { token: 'NESTED-SECRET-BBBB' }, label: 'nested-label-ok' } });
    expect((await search({ freeText: 'NESTED-SECRET-BBBB' })).totalCount).toBe(0);
    expect((await search({ freeText: 'nested-label-ok' })).totalCount).toBeGreaterThanOrEqual(1);
  });

  it('a differently CASED secret key still hides its value from search', async () => {
    await seedAudit(ctx, { action: 'secret.rotated', entityType: 'integration_secret', detail: { ApiKey: 'CASED-SECRET-CCCC', Client_Secret: 'CASED-SECRET-DDDD' } });
    expect((await search({ freeText: 'CASED-SECRET-CCCC' })).totalCount).toBe(0);
    expect((await search({ freeText: 'CASED-SECRET-DDDD' })).totalCount).toBe(0);
  });

  it('action and entity metadata remain searchable; counts never include secret-only matches', async () => {
    // This event's ONLY distinguishing text is the secret value — it must not inflate any count.
    await seedAudit(ctx, { action: 'secret.upserted', entityType: 'integration_secret', detail: { password: 'ONLYSECRET-EEEE' } });
    expect((await search({ freeText: 'ONLYSECRET-EEEE' })).totalCount).toBe(0);
    // action/entityType free-text still works.
    expect((await search({ freeText: 'secret.upserted' })).totalCount).toBeGreaterThanOrEqual(1);
    expect((await search({ freeText: 'integration_secret' })).totalCount).toBeGreaterThanOrEqual(1);
  });

  it('search is read-only — hash fields are unchanged afterward', async () => {
    const before = await db.select({ id: auditLogs.id, rowHash: auditLogs.rowHash, prevHash: auditLogs.prevHash })
      .from(auditLogs).where(and(eq(auditLogs.projectId, ctx.projectId), eq(auditLogs.action, 'task.authorization_reconciled')));
    await search({ freeText: 'reconcil' });
    await search({ actionPrefix: 'task.' });
    const after = await db.select({ id: auditLogs.id, rowHash: auditLogs.rowHash, prevHash: auditLogs.prevHash })
      .from(auditLogs).where(and(eq(auditLogs.projectId, ctx.projectId), eq(auditLogs.action, 'task.authorization_reconciled')));
    expect(after).toEqual(before);
  });
});
