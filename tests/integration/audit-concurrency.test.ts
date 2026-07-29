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
    expect(v.overallStatus).toBe('ok');
    expect(v.unknownDivergences).toBe(0);
  });

  it('two different orgs write independently, each a valid linear chain', async () => {
    if (!available) return;
    const db = getSetupDb();
    const [a, b] = [ctxs[0]!, ctxs[1]!];
    await Promise.all([db.transaction((tx) => wa(a, tx)), db.transaction((tx) => wa(b, tx))]);
    expect((await db.transaction((tx) => verifyAuditChain(tx, a))).overallStatus).toBe('ok');
    expect((await db.transaction((tx) => verifyAuditChain(tx, b))).overallStatus).toBe('ok');
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
    expect(v.overallStatus).toBe('ok');
    expect(v.linearLinkFailures).toBe(0);
  });
});

describe('verifyAuditChain classification (crafted rows; historical rows untouched)', () => {
  const KNOWN = '6b48a209-229c-4b75-ab6f-638e9fcb8345';

  it('distinguishes recognized historical fork, unknown divergence, and missing predecessor', async () => {
    if (!available) return;
    const db = getSetupDb();
    const ctx = await seedOrg(); ctxs.push(ctx);
    const proj = ctx.projectId;
    const ins = (id: string | undefined, prev: string, row: string) => db.insert(auditLogs).values({
      ...(id ? { id } : {}), orgId: ctx.orgId, projectId: proj, actorId: userId, action: 'crafted', entityType: 'x', entityId: null, detail: {}, prevHash: prev, rowHash: row,
    } as never);
    // linear H1 → H2
    await ins(undefined, 'GENESIS', 'H1');
    await ins(undefined, 'H1', 'H2');
    // recognized historical fork: id ∈ KNOWN, prevHash 'H1' (a real earlier row, not H2)
    await ins(KNOWN, 'H1', 'H3');
    const v1 = await db.transaction((tx) => verifyAuditChain(tx, ctx));
    expect(v1.recognizedHistoricalForks).toBe(1);
    expect(v1.affectedRowIds.recognizedHistoricalForks).toContain(KNOWN);
    expect(v1.overallStatus).toBe('ok'); // recognized fork alone does not degrade

    // unknown divergence: random id, prevHash 'H2' (a real earlier row) — a NEW fork
    await ins(undefined, 'H2', 'H4');
    const v2 = await db.transaction((tx) => verifyAuditChain(tx, ctx));
    expect(v2.unknownDivergences).toBe(1);
    expect(v2.overallStatus).toBe('anomalies'); // NEW forks are flagged, never hidden

    // missing predecessor: prevHash matches no row
    await ins(undefined, 'NO-SUCH-HASH', 'H5');
    const v3 = await db.transaction((tx) => verifyAuditChain(tx, ctx));
    expect(v3.missingPredecessors).toBe(1);
    expect(v3.hashVerification).toBe('not_performed_jsonb_key_order');
  });
});
