import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { FakeProvider } from '@tests/support/fake-provider';
import { assertDisposableDbForVerification } from '@tests/support/require-disposable-db';
import { type TenantContext } from '@/types/domain';
import type * as Guard from '@/domain/auth/guard';
import { getSetupDb } from '@/db/client';
import {
  agents,
  memberships,
  organizations,
  profiles,
  projectMembers,
  projects,
  spendLimits,
  taskSchedules,
  tasks,
} from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { setProviderOverrideForTests } from '@/providers/registry';
import { createObjective } from '@/domain/objectives/objectives';
import { listSchedules } from '@/domain/standing/standing';

/**
 * Hub Platform P1b — admin-only authorization for STANDING-WORK (schedule) mutations.
 *
 * The three schedule actions (`submitSchedule` → createSchedule, `editSchedule` → updateSchedule,
 * `toggleSchedule` → setScheduleEnabled) route through the shared `objectiveMutation` wrapper, which P1b
 * teaches an optional `requireAdmin` gate. These tests drive the REAL actions with `requireTenant` stubbed to
 * a chosen role; the gate fires AFTER requireTenant and BEFORE withTenant/the fn, so a denied non-admin makes
 * NO task, run, provider request, or schedule write — the schedule row is left byte-for-byte unchanged.
 *
 * The OTHER objectiveMutation callers (objective status, criteria, milestones) are intentionally NOT gated by
 * requireAdmin; only these three pass `requireAdmin: true`.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? 'test-openai-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'test-anthropic-key';
process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY ?? Buffer.alloc(32).toString('base64');

assertDisposableDbForVerification('standing-authorization.test');

const H = vi.hoisted(() => ({ ctx: null as TenantContext | null }));
vi.mock('@/domain/auth/guard', async (importActual) => {
  const actual = await importActual<typeof Guard>();
  return { ...actual, requireTenant: vi.fn(async () => H.ctx as TenantContext) };
});
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { submitSchedule, editSchedule, toggleSchedule } = await import('@/app/p/[projectKey]/objectives/actions');

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[standing-authorization.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

const db = getSetupDb();
let orgId = '';
let userId = '';
const KEY = 'W';

interface Seeded {
  ctx: TenantContext; // admin
  objectiveId: string;
  primary: string; // openai primary
  reviewer: string; // anthropic reviewer
  altPrimary: string; // a second openai primary (to attempt a pin change)
}

async function freshWorkspace(): Promise<Seeded> {
  const pid = (await db.insert(projects).values({ orgId, key: fixtureKey('sauthz'), name: 'W' }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId: pid, userId, role: 'admin' });
  await db.insert(spendLimits).values({ orgId, projectId: pid, monthlyLimitMicros: 100_000_000n });
  const ctx: TenantContext = { userId, orgId, projectId: pid, orgRole: 'owner', projectRole: 'admin' };
  const mk = async (name: string, role: 'primary' | 'reviewer', provider: 'openai' | 'anthropic') =>
    (await db.insert(agents).values({ orgId, projectId: pid, name, role, provider, model: 'gpt-x', systemPrompt: 'x', enabled: true }).returning({ id: agents.id }))[0]!.id;
  const primary = await mk('Standing Primary', 'primary', 'openai');
  const reviewer = await mk('Standing Reviewer', 'reviewer', 'anthropic');
  const altPrimary = await mk('Alt Primary', 'primary', 'openai');
  const objectiveId = await withTenant(ctx, (tx) => createObjective(tx, ctx, { title: 'Standing objective' }));
  return { ctx, objectiveId, primary, reviewer, altPrimary };
}

function fakeBoth() {
  const openai = new FakeProvider('openai').reply('primary answer').reply('revised answer');
  const anthropic = new FakeProvider('anthropic').reply('VERDICT: approve\n\nok.');
  setProviderOverrideForTests((id) => (id === 'openai' ? openai : id === 'anthropic' ? anthropic : undefined));
  return { openai, anthropic };
}

function createForm(w: Seeded, over: Partial<Record<string, string>> = {}): FormData {
  const fd = new FormData();
  fd.set('projectKey', KEY);
  fd.set('objectiveId', w.objectiveId);
  fd.set('title', over.title ?? 'Weekly brief');
  fd.set('input', over.input ?? 'Summarize the week.');
  fd.set('assigneeAgentId', over.assigneeAgentId ?? w.primary);
  fd.set('cadence', over.cadence ?? 'daily');
  fd.set('atHour', over.atHour ?? '6');
  if (over.weekday) fd.set('weekday', over.weekday);
  // reviewEnabled off by default (no reviewer needed) unless overridden.
  if (over.reviewEnabled === 'on') {
    fd.set('reviewEnabled', 'on');
    fd.set('reviewerAgentId', over.reviewerAgentId ?? w.reviewer);
  }
  return fd;
}

function editForm(w: Seeded, scheduleId: string, over: Partial<Record<string, string>> = {}): FormData {
  const fd = createForm(w, over);
  fd.set('scheduleId', scheduleId);
  return fd;
}

function toggleForm(w: Seeded, scheduleId: string, enabled: boolean): FormData {
  const fd = new FormData();
  fd.set('projectKey', KEY);
  fd.set('objectiveId', w.objectiveId);
  fd.set('scheduleId', scheduleId);
  fd.set('enabled', enabled ? 'true' : 'false');
  return fd;
}

const member = (w: Seeded): TenantContext => ({ ...w.ctx, projectRole: 'member' });
const viewer = (w: Seeded): TenantContext => ({ ...w.ctx, projectRole: 'viewer' });

async function run<T>(ctx: TenantContext, fn: () => Promise<T>): Promise<T> {
  H.ctx = ctx;
  return fn();
}
async function fullSchedule(id: string) {
  return (await db.select().from(taskSchedules).where(eq(taskSchedules.id, id)))[0]!;
}
async function schedulesForObjective(w: Seeded) {
  return db.select().from(taskSchedules).where(and(eq(taskSchedules.objectiveId, w.objectiveId), eq(taskSchedules.orgId, orgId)));
}
async function tasksForObjective(w: Seeded) {
  return db.select().from(tasks).where(and(eq(tasks.objectiveId, w.objectiveId), eq(tasks.orgId, orgId)));
}

/** Create a schedule as admin via the real submitSchedule action; return its id. */
async function adminCreateSchedule(w: Seeded, over: Partial<Record<string, string>> = {}): Promise<string> {
  const res = await run(w.ctx, () => submitSchedule({ error: null }, createForm(w, over)));
  expect(res.error).toBeNull();
  return (await schedulesForObjective(w)).find((s) => s.title === (over.title ?? 'Weekly brief'))!.id;
}

beforeAll(async () => {
  if (!available) return;
  userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `sauthz-${randomUUID().slice(0, 8)}@t.local`, displayName: 'A' });
  orgId = (await db.insert(organizations).values({ name: 'O', slug: `sauthz-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
});
afterAll(async () => {
  if (available) await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});
afterEach(() => setProviderOverrideForTests(null));

describe.skipIf(!available)('P1b standing-work authorization', () => {
  it('an admin CAN create and then edit a schedule', async () => {
    const w = await freshWorkspace();
    const id = await adminCreateSchedule(w);
    const created = await fullSchedule(id);
    expect(created.assignedPrimaryAgentId).toBe(w.primary);
    expect(created.cadence).toBe('daily');
    // Admin edit: switch to weekly + retitle.
    const res = await run(w.ctx, () => editSchedule({ error: null }, editForm(w, id, { title: 'Weekly brief', cadence: 'weekly', weekday: '1' })));
    expect(res.error).toBeNull();
    const edited = await fullSchedule(id);
    expect(edited.cadence).toBe('weekly');
  });

  it('a MEMBER cannot create standing work — no schedule row, no task/run, no provider call', async () => {
    const w = await freshWorkspace();
    const { openai, anthropic } = fakeBoth();
    const res = await run(member(w), () => submitSchedule({ error: null }, createForm(w)));
    expect(res.error).toMatch(/only workspace admins/i);
    expect((await schedulesForObjective(w)).length).toBe(0);
    expect((await tasksForObjective(w)).length).toBe(0);
    expect(openai.requests.length + anthropic.requests.length).toBe(0);
  });

  it('a VIEWER cannot create standing work', async () => {
    const w = await freshWorkspace();
    const res = await run(viewer(w), () => submitSchedule({ error: null }, createForm(w)));
    expect(res.error).toMatch(/only workspace admins/i);
    expect((await schedulesForObjective(w)).length).toBe(0);
  });

  it('a member cannot change cadence — the COMPLETE schedule row is unchanged', async () => {
    const w = await freshWorkspace();
    const id = await adminCreateSchedule(w);
    const before = await fullSchedule(id);
    const res = await run(member(w), () => editSchedule({ error: null }, editForm(w, id, { cadence: 'weekly', weekday: '3', title: 'HACKED' })));
    expect(res.error).toMatch(/only workspace admins/i);
    expect(await fullSchedule(id)).toEqual(before); // cadence, title, nextRunAt, updatedAt — all identical
  });

  it('a member cannot change the pinned primary/reviewer — row unchanged, no provider call', async () => {
    const w = await freshWorkspace();
    const id = await adminCreateSchedule(w, { reviewEnabled: 'on' });
    const before = await fullSchedule(id);
    expect(before.assignedPrimaryAgentId).toBe(w.primary);
    const { openai, anthropic } = fakeBoth();
    // Attempt to re-pin to the alternate primary (and flip reviewer off) as a member.
    const res = await run(member(w), () => editSchedule({ error: null }, editForm(w, id, { assigneeAgentId: w.altPrimary })));
    expect(res.error).toMatch(/only workspace admins/i);
    const after = await fullSchedule(id);
    expect(after).toEqual(before);
    expect(after.assignedPrimaryAgentId).toBe(w.primary); // still the ORIGINAL pin
    expect(openai.requests.length + anthropic.requests.length).toBe(0);
  });

  it('member and viewer cannot enable/disable (toggleSchedule) — enabled flag unchanged', async () => {
    const w = await freshWorkspace();
    const id = await adminCreateSchedule(w);
    expect((await fullSchedule(id)).enabled).toBe(true);
    const m = await run(member(w), () => toggleSchedule({ error: null }, toggleForm(w, id, false)));
    expect(m.error).toMatch(/only workspace admins/i);
    expect((await fullSchedule(id)).enabled).toBe(true);
    const v = await run(viewer(w), () => toggleSchedule({ error: null }, toggleForm(w, id, false)));
    expect(v.error).toMatch(/only workspace admins/i);
    expect((await fullSchedule(id)).enabled).toBe(true);
  });

  it('read-only schedule access still works for a member (listSchedules)', async () => {
    const w = await freshWorkspace();
    const id = await adminCreateSchedule(w);
    const rows = await withTenant(member(w), (tx) => listSchedules(tx, member(w), w.objectiveId));
    expect(rows.some((r) => r.id === id)).toBe(true);
  });
});
