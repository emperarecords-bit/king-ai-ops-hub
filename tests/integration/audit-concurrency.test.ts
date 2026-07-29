import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { auditLogs, memberships, organizations, profiles, projectMembers, projects } from '@/db/schema';
import { writeAudit, verifyAuditChain } from '@/domain/audit/audit';

/**
 * Concurrency-safe audit writes (per-org advisory lock) + the fork-aware chain validator.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try { await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1); available = true; }
catch (err) { console.warn(`[audit-concurrency.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`); }

let userId = '';
const orgIds: string[] = [];
const ctxs: TenantContext[] = [];

async function seedOrg(): Promise<TenantContext> {
  const db = getSetupDb();
  const org = (await db.insert(organizations).values({ name: 'Org', slug: `ac-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id }))[0]!;
  await db.insert(memberships).values({ orgId: org.id, userId, role: 'owner' });
  const p = (await db.insert(projects).values({ orgId: org.id, key: fixtureKey('ac'), name: 'W' }).returning({ id: projects.id }))[0]!;
  await db.insert(projectMembers).values({ orgId: org.id, projectId: p.id, userId, role: 'admin' });
  orgIds.push(org.id);
  return { userId, orgId: org.id, projectId: p.id, orgRole: 'owner', projectRole: 'admin' };
}

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `ac-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Admin' });
  ctxs.push(await seedOrg(), await seedOrg());
});

afterAll(async () => {
  if (!available || orgIds.length === 0) return;
  const db = getSetupDb();
  await db.execute(sql`alter table audit_logs disable trigger audit_logs_append_only`);
  for (const o of orgIds) await db.delete(auditLogs).where(eq(auditLogs.orgId, o));
  await db.execute(sql`alter table audit_logs enable trigger audit_logs_append_only`);
  for (const o of orgIds) {
    await db.delete(projectMembers).where(eq(projectMembers.orgId, o));
    await db.delete(projects).where(eq(projects.orgId, o));
    await db.delete(memberships).where(eq(memberships.orgId, o));
    await db.delete(organizations).where(eq(organizations.id, o));
  }
  await db.delete(profiles).where(eq(profiles.id, userId));
});

const wa = (ctx: TenantContext, tx: Parameters<Parameters<ReturnType<typeof getSetupDb>['transaction']>[0]>[0]) =>
  writeAudit(tx, ctx, { action: 'test.event', entityType: 'test', entityId: randomUUID(), detail: { n: 1 } });

describe('per-org advisory lock serializes audit writes', () => {
  it('two concurrent writes for the SAME org do not share a predecessor → one linear chain', async () => {
    if (!available) return;
    const db = getSetupDb();
    const ctx = ctxs[0]!;
    await db.transaction((tx) => wa(ctx, tx)); // establish a head
    for (let i = 0; i < 2; i++) {
      await Promise.all([
        db.transaction(async (tx) => { await wa(ctx, tx); await tx.execute(sql`select pg_sleep(0.4)`); }), // holds lock
        db.transaction(async (tx) => { await tx.execute(sql`select pg_sleep(0.05)`); await wa(ctx, tx); }), // must wait
      ]);
    }
    const rows = await db.select({ prevHash: auditLogs.prevHash, rowHash: auditLogs.rowHash }).from(auditLogs).where(eq(auditLogs.orgId, ctx.orgId)).orderBy(auditLogs.seq);
    let breaks = 0; const preds = new Set<string>(); let shared = 0;
    for (let i = 1; i < rows.length; i++) { if (rows[i]!.prevHash !== rows[i - 1]!.rowHash) breaks++; if (preds.has(rows[i]!.prevHash)) shared++; preds.add(rows[i]!.prevHash); }
    expect(breaks).toBe(0);
    expect(shared).toBe(0); // no two rows share a predecessor
    const v = await db.transaction((tx) => verifyAuditChain(tx, ctx));
    expect(v.overallStatus).toBe('clean');
    expect(v.unknownDivergences).toBe(0);
  });

  it('two different orgs write independently, each a valid linear chain', async () => {
    if (!available) return;
    const db = getSetupDb();
    const [a, b] = [ctxs[0]!, ctxs[1]!];
    await Promise.all([db.transaction((tx) => wa(a, tx)), db.transaction((tx) => wa(b, tx))]);
    expect((await db.transaction((tx) => verifyAuditChain(tx, a))).overallStatus).toBe('clean');
    expect((await db.transaction((tx) => verifyAuditChain(tx, b))).overallStatus).toBe('clean');
  });

  it('a failed transaction releases the advisory lock (a later write succeeds)', async () => {
    if (!available) return;
    const db = getSetupDb();
    const ctx = ctxs[1]!;
    const before = (await db.select({ n: sql<string>`count(*)` }).from(auditLogs).where(eq(auditLogs.orgId, ctx.orgId)))[0]!.n;
    await expect(db.transaction(async (tx) => { await wa(ctx, tx); throw new Error('boom'); })).rejects.toThrow('boom');
    await db.transaction((tx) => wa(ctx, tx)); // lock was released → this proceeds
    const after = (await db.select({ n: sql<string>`count(*)` }).from(auditLogs).where(eq(auditLogs.orgId, ctx.orgId)))[0]!.n;
    expect(Number(after)).toBe(Number(before) + 1); // failed one rolled back; only the second persisted
  });

  it('multiple writes inside one transaction remain ordered (linear)', async () => {
    if (!available) return;
    const db = getSetupDb();
    const ctx = ctxs[0]!;
    await db.transaction(async (tx) => { await wa(ctx, tx); await wa(ctx, tx); await wa(ctx, tx); });
    const v = await db.transaction((tx) => verifyAuditChain(tx, ctx));
    expect(v.overallStatus).toBe('clean');
    expect(v.linearLinkFailures).toBe(0);
  });
});

describe('verifyAuditChain overall status (crafted rows; the 4 historical rows are never touched)', () => {
  // Distinct KNOWN fork ids per test — the audit_logs PK is a globally-unique uuid, so each id inserts once.
  const KNOWN = ['6b48a209-229c-4b75-ab6f-638e9fcb8345', '8cfcd362-971f-47a9-ad7a-92974826ded1'];
  const insFn = (ctx: TenantContext) => (id: string | undefined, prev: string, row: string) =>
    getSetupDb().insert(auditLogs).values({
      ...(id ? { id } : {}), orgId: ctx.orgId, projectId: ctx.projectId, actorId: userId, action: 'crafted', entityType: 'x', entityId: null, detail: {}, prevHash: prev, rowHash: row,
    } as never);
  const verify = (ctx: TenantContext) => getSetupDb().transaction((tx) => verifyAuditChain(tx, ctx));

  it('a fully linear chain → clean', async () => {
    if (!available) return;
    const ctx = await seedOrg(); ctxs.push(ctx); const ins = insFn(ctx);
    await ins(undefined, 'G', 'H1'); await ins(undefined, 'H1', 'H2');
    const v = await verify(ctx);
    expect(v.overallStatus).toBe('clean');
    expect(v.linearLinkFailures).toBe(0);
  });

  it('ONLY approved historical forks → recognized_historical_forks (not clean, not tampering)', async () => {
    if (!available) return;
    const ctx = await seedOrg(); ctxs.push(ctx); const ins = insFn(ctx);
    await ins(undefined, 'G', 'H1'); await ins(undefined, 'H1', 'H2'); await ins(KNOWN[0], 'H1', 'H3');
    const v = await verify(ctx);
    expect(v.overallStatus).toBe('recognized_historical_forks');
    expect(v.recognizedHistoricalForks).toBe(1);
    expect(v.affectedRowIds.recognizedHistoricalForks).toContain(KNOWN[0]);
    expect(v.missingPredecessors).toBe(0);
    expect(v.unknownDivergences).toBe(0);
  });

  it('a new (unknown) fork → anomalies', async () => {
    if (!available) return;
    const ctx = await seedOrg(); ctxs.push(ctx); const ins = insFn(ctx);
    await ins(undefined, 'G', 'H1'); await ins(undefined, 'H1', 'H2'); await ins(undefined, 'H1', 'H3');
    const v = await verify(ctx);
    expect(v.overallStatus).toBe('anomalies');
    expect(v.unknownDivergences).toBe(1);
    expect(v.recognizedHistoricalForks).toBe(0);
  });

  it('a missing predecessor → anomalies', async () => {
    if (!available) return;
    const ctx = await seedOrg(); ctxs.push(ctx); const ins = insFn(ctx);
    await ins(undefined, 'G', 'H1'); await ins(undefined, 'NO-SUCH-HASH', 'H2');
    const v = await verify(ctx);
    expect(v.overallStatus).toBe('anomalies');
    expect(v.missingPredecessors).toBe(1);
    expect(v.hashVerification).toBe('not_performed_jsonb_key_order');
  });

  it('recognized + unknown together → anomalies', async () => {
    if (!available) return;
    const ctx = await seedOrg(); ctxs.push(ctx); const ins = insFn(ctx);
    await ins(undefined, 'G', 'H1'); await ins(undefined, 'H1', 'H2'); await ins(KNOWN[1], 'H1', 'H3'); await ins(undefined, 'H2', 'H4');
    const v = await verify(ctx);
    expect(v.overallStatus).toBe('anomalies');
    expect(v.recognizedHistoricalForks).toBe(1);
    expect(v.unknownDivergences).toBe(1);
  });
});
