import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TenantContext } from '@/types/domain';
import { getDb, getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import {
  approvals,
  instruments,
  killSwitches,
  memberships,
  organizations,
  paperFills,
  paperOrders,
  paperPortfolios,
  profiles,
  projectMembers,
  projects,
  tasks,
} from '@/db/schema';

/**
 * Stock Trading P1 — RLS + TENANT-BOUND RELATIONSHIP proof. Every trading→trading reference is a composite FK on
 * (org_id, project_id, id); Hub-table / circular references are constraint-triggered. A workspace can neither read
 * another workspace's trading rows (RLS) nor REFERENCE another workspace's rows (composite FK / trigger), and an
 * agent id can never be recorded as the human approver (approvals.decided_by → profiles).
 *
 * The RLS-ENFORCEMENT (read-isolation) cases require the non-superuser `app_server` role (run via `npm run test:rls`
 * or against the disposable trading DB); the composite-FK / trigger / CHECK cases hold under ANY role.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
let enforced = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  await getSetupDb().select({ one: instruments.id }).from(instruments).limit(1); // trading schema must be migrated in
  available = true;
  const who = await getDb().execute(sql`select current_user as u`);
  enforced = (who as unknown as { u?: string }[])[0]?.u === 'app_server';
  if (!enforced) console.warn('[trading-rls.test] RLS read-isolation gated OFF (not app_server); FK/trigger/CHECK cases still run.');
} catch (err) {
  console.warn(`[trading-rls.test] SKIPPING — db/trading schema not reachable: ${err instanceof Error ? err.message : err}`);
}

const mk = (orgId: string, projectId: string, userId: string): TenantContext => ({ orgId, projectId, userId, orgRole: 'owner', projectRole: 'admin' });

let userId = '';
const A = { orgId: '', projectId: '' };
const B = { orgId: '', projectId: '' };
let instrA = '';
let instrB = '';
let portA = '';
let portB = '';
let approvalA = '';
let taskA = '';

async function seedWorkspace() {
  const db = getSetupDb();
  const org = (await db.insert(organizations).values({ name: 'T', slug: `t-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id }))[0]!;
  await db.insert(memberships).values({ orgId: org.id, userId, role: 'owner' });
  const p = (await db.insert(projects).values({ orgId: org.id, key: `TRD${randomUUID().slice(0, 4)}`, name: 'Trading' }).returning({ id: projects.id }))[0]!;
  await db.insert(projectMembers).values({ orgId: org.id, projectId: p.id, userId, role: 'admin' });
  return { orgId: org.id, projectId: p.id };
}
async function seedTradingRows(ws: { orgId: string; projectId: string }) {
  return withTenant(mk(ws.orgId, ws.projectId, userId), async (tx) => {
    const ins = (await tx.insert(instruments).values({ orgId: ws.orgId, projectId: ws.projectId, symbol: `SYM${randomUUID().slice(0, 4)}`, kind: 'equity', exchange: 'XNAS', name: 'X' }).returning({ id: instruments.id }))[0]!;
    const port = (await tx.insert(paperPortfolios).values({ orgId: ws.orgId, projectId: ws.projectId, startingCashMicros: 100_000_000_000n, cashMicros: 100_000_000_000n }).returning({ id: paperPortfolios.id }))[0]!;
    await tx.insert(killSwitches).values({ orgId: ws.orgId, projectId: ws.projectId });
    return { instr: ins.id, port: port.id };
  });
}

beforeAll(async () => {
  if (!available) return;
  userId = randomUUID();
  await getSetupDb().insert(profiles).values({ id: userId, email: `trd-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Trader' });
  Object.assign(A, await seedWorkspace());
  Object.assign(B, await seedWorkspace());
  ({ instr: instrA, port: portA } = await seedTradingRows(A));
  ({ instr: instrB, port: portB } = await seedTradingRows(B));
  // A task + approval in workspace A (Hub approvals are task-scoped). The approval is financial + approved + a human
  // profile as decided_by — the trading approval boundary.
  taskA = (await getSetupDb().insert(tasks).values({ orgId: A.orgId, projectId: A.projectId, title: 'Paper order', input: 'x', providerSelection: 'openai', status: 'awaiting_approval', createdBy: userId }).returning({ id: tasks.id }))[0]!.id;
  approvalA = (
    await getSetupDb()
      .insert(approvals)
      .values({ orgId: A.orgId, projectId: A.projectId, taskId: taskA, actionType: 'financial', payload: {}, payloadSha256: `sha-${randomUUID()}`, summary: 'paper order', status: 'approved', decidedBy: userId, decidedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) })
      .returning({ id: approvals.id })
  )[0]!.id;
});

afterAll(async () => {
  if (!available || !A.orgId) return;
  await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, A.orgId));
  await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, B.orgId));
});

describe('Trading P1 RLS read-isolation (app_server only)', () => {
  it.runIf(enforced)('a workspace sees only its own instruments', async () => {
    const seenByB = await withTenant(mk(B.orgId, B.projectId, userId), (tx) => tx.select({ id: instruments.id }).from(instruments).where(eq(instruments.id, instrA)));
    expect(seenByB).toHaveLength(0);
  });
  it.runIf(enforced)('a workspace cannot READ another workspace paper order', async () => {
    let orderA = '';
    await withTenant(mk(A.orgId, A.projectId, userId), async (tx) => {
      orderA = (await tx.insert(paperOrders).values({ orgId: A.orgId, projectId: A.projectId, portfolioId: portA, instrumentId: instrA, side: 'buy', qty: 1, orderType: 'market' }).returning({ id: paperOrders.id }))[0]!.id;
    });
    const seenByB = await withTenant(mk(B.orgId, B.projectId, userId), (tx) => tx.select({ id: paperOrders.id }).from(paperOrders).where(eq(paperOrders.id, orderA)));
    expect(seenByB).toHaveLength(0);
  });
  it.runIf(enforced)('cross-workspace WRITE (stamping another tenant) is denied by RLS WITH CHECK', async () => {
    await expect(
      withTenant(mk(B.orgId, B.projectId, userId), (tx) => tx.insert(instruments).values({ orgId: A.orgId, projectId: A.projectId, symbol: 'MSFT', kind: 'equity', exchange: 'XNAS', name: 'MS' })),
    ).rejects.toThrow();
  });
});

describe('Trading P1 tenant-bound relationships (composite FK / trigger — any role)', () => {
  it.runIf(available)('a row in workspace A cannot reference a PORTFOLIO in workspace B', async () => {
    await expect(
      withTenant(mk(A.orgId, A.projectId, userId), (tx) => tx.insert(paperOrders).values({ orgId: A.orgId, projectId: A.projectId, portfolioId: portB, instrumentId: instrA, side: 'buy', qty: 1, orderType: 'market' })),
    ).rejects.toThrow(); // composite FK (A,A,portB) has no matching paper_portfolios row
  });
  it.runIf(available)('a row in workspace A cannot reference an INSTRUMENT in workspace B', async () => {
    await expect(
      withTenant(mk(A.orgId, A.projectId, userId), (tx) => tx.insert(paperOrders).values({ orgId: A.orgId, projectId: A.projectId, portfolioId: portA, instrumentId: instrB, side: 'buy', qty: 1, orderType: 'market' })),
    ).rejects.toThrow();
  });
  it.runIf(available)('a FILL cannot reference an ORDER in another workspace', async () => {
    let orderA = '';
    await withTenant(mk(A.orgId, A.projectId, userId), async (tx) => {
      orderA = (await tx.insert(paperOrders).values({ orgId: A.orgId, projectId: A.projectId, portfolioId: portA, instrumentId: instrA, side: 'buy', qty: 1, orderType: 'market' }).returning({ id: paperOrders.id }))[0]!.id;
    });
    await expect(
      withTenant(mk(B.orgId, B.projectId, userId), (tx) => tx.insert(paperFills).values({ orgId: B.orgId, projectId: B.projectId, orderId: orderA, portfolioId: portB, instrumentId: instrB, side: 'buy', qty: 1, fillPriceMicros: 1n, quoteAsOf: new Date(), simulatedAt: new Date(), model: 'x' })),
    ).rejects.toThrow(); // composite FK (B,B,orderA) has no matching paper_orders row
  });
  it.runIf(available)('an ORDER cannot reference an APPROVAL from another workspace', async () => {
    await expect(
      withTenant(mk(B.orgId, B.projectId, userId), (tx) => tx.insert(paperOrders).values({ orgId: B.orgId, projectId: B.projectId, portfolioId: portB, instrumentId: instrB, side: 'buy', qty: 1, orderType: 'market', approvalId: approvalA })),
    ).rejects.toThrow(); // trg_paper_orders_tenant: approval belongs to A, not B
  });
  it.runIf(available)('valid SAME-workspace references succeed (portfolio + instrument + own approval)', async () => {
    const id = await withTenant(mk(A.orgId, A.projectId, userId), async (tx) => {
      const r = await tx.insert(paperOrders).values({ orgId: A.orgId, projectId: A.projectId, portfolioId: portA, instrumentId: instrA, side: 'buy', qty: 5, orderType: 'market', approvalId: approvalA }).returning({ id: paperOrders.id });
      return r[0]!.id;
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it.runIf(available)('a non-human (agent) id cannot be recorded as an approver — approvals.decided_by → profiles', async () => {
    const agentLikeId = randomUUID(); // any id that is NOT a profile (e.g. an agent id)
    await expect(
      withTenant(mk(A.orgId, A.projectId, userId), (tx) =>
        tx.insert(approvals).values({ orgId: A.orgId, projectId: A.projectId, taskId: taskA, actionType: 'financial', payload: {}, payloadSha256: `sha-${randomUUID()}`, summary: 'p', status: 'approved', decidedBy: agentLikeId, decidedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) }),
      ),
    ).rejects.toThrow(); // FK violation: decided_by must be a real profile
  });
  it.runIf(available)('the database refuses a non-paper order destination (CHECK)', async () => {
    await expect(
      withTenant(mk(A.orgId, A.projectId, userId), (tx) =>
        tx.execute(sql`insert into paper_orders (org_id, project_id, portfolio_id, instrument_id, side, qty, order_type, destination)
              values (${A.orgId}::uuid, ${A.projectId}::uuid, ${portA}::uuid, ${instrA}::uuid, 'buy', 1, 'market', 'alpaca')`),
      ),
    ).rejects.toThrow();
  });
});
