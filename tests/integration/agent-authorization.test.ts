import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { FakeProvider } from '@tests/support/fake-provider';
import { assertDisposableDbForVerification } from '@tests/support/require-disposable-db';
import { type TenantContext } from '@/types/domain';
import type * as Guard from '@/domain/auth/guard';
import { getSetupDb } from '@/db/client';
import {
  agents,
  auditLogs,
  memberships,
  organizations,
  profiles,
  projectMembers,
  projects,
  runs,
  spendLimits,
} from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { setProviderOverrideForTests } from '@/providers/registry';
import { createTask } from '@/domain/tasks/tasks';
import { startRun } from '@/domain/tasks/runner';

/**
 * Hub Platform P1b — admin-only authorization for AGENT (employee) CONFIGURATION mutations.
 *
 * The hole this closes: `saveAgent` (the only user-facing route to `updateAgent` — model / systemPrompt /
 * temperature / maxOutputTokens / enabled) had NO projectRole gate, so any member or viewer could rewrite an
 * employee's execution profile. These tests drive the REAL server action with `requireTenant` stubbed to a
 * chosen role (the only thing a real request resolves that a test cannot), everything else — the gate,
 * withTenant/RLS, updateAgent, the agents table — running for real against the disposable DB.
 *
 * Proven here: an admin can update; a MEMBER and a VIEWER cannot change ANY field; a denied mutation leaves
 * the COMPLETE agent row byte-for-byte unchanged and writes no agent.updated audit; a denied member change to
 * an agent already PINNED to a task cannot alter what a subsequent pinned run executes; a cross-workspace
 * agent id stays rejected. A FakeProvider proves the denied path makes ZERO provider calls.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? 'test-openai-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'test-anthropic-key';
process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY ?? Buffer.alloc(32).toString('base64');

// Refuse DB-backed verification against the shared `king_ai_hub` when REQUIRE_DISPOSABLE_DB=1 (module-init).
assertDisposableDbForVerification('agent-authorization.test');

// The one request-resolved value a unit test cannot produce: the caller's TenantContext. Everything else in
// the action runs for real. `hoisted` so the vi.mock factory (hoisted above imports) can read it.
const H = vi.hoisted(() => ({ ctx: null as TenantContext | null }));
vi.mock('@/domain/auth/guard', async (importActual) => {
  const actual = await importActual<typeof Guard>();
  return { ...actual, requireTenant: vi.fn(async () => H.ctx as TenantContext) };
});
// revalidatePath is a no-op outside the Next request scope; the admin success path calls it.
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

// Imported AFTER the mocks are declared (vi.mock is hoisted, so this binds the mocked guard).
const { saveAgent } = await import('@/app/p/[projectKey]/agents/actions');

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[agent-authorization.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

const db = getSetupDb();
let orgId = '';
let userId = '';

const ORIGINAL_MODEL = 'gpt-5.4';
const CHANGED_MODEL = 'gpt-5.4-mini';
const ORIGINAL_PROMPT = 'ORIGINAL_SYSTEM_PROMPT_MARKER';
const KEY = 'W'; // projectKey is irrelevant — requireTenant is stubbed — but must be non-empty for the schema.

interface Seeded {
  ctx: TenantContext; // admin
  projectKey: string;
  tomBrown: string; // openai primary, pinnable
  reviewer: string; // anthropic reviewer
}

async function freshWorkspace(): Promise<Seeded> {
  const key = fixtureKey('authz');
  const pid = (await db.insert(projects).values({ orgId, key, name: 'W' }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId: pid, userId, role: 'admin' });
  await db.insert(spendLimits).values({ orgId, projectId: pid, monthlyLimitMicros: 100_000_000n });
  const ctx: TenantContext = { userId, orgId, projectId: pid, orgRole: 'owner', projectRole: 'admin' };
  const tomBrown = (
    await db
      .insert(agents)
      .values({ orgId, projectId: pid, name: 'Tom Brown', role: 'primary', provider: 'openai', model: ORIGINAL_MODEL, systemPrompt: ORIGINAL_PROMPT, temperatureMilli: 300, maxOutputTokens: 2048, enabled: true })
      .returning({ id: agents.id })
  )[0]!.id;
  const reviewer = (
    await db
      .insert(agents)
      .values({ orgId, projectId: pid, name: 'Principal Reviewer', role: 'reviewer', provider: 'anthropic', model: ORIGINAL_MODEL, systemPrompt: ORIGINAL_PROMPT, enabled: true })
      .returning({ id: agents.id })
  )[0]!.id;
  return { ctx, projectKey: key, tomBrown, reviewer };
}

function fakeBoth() {
  const openai = new FakeProvider('openai').reply('primary answer').reply('revised answer');
  const anthropic = new FakeProvider('anthropic').reply('VERDICT: approve\n\nlooks good.');
  setProviderOverrideForTests((id) => (id === 'openai' ? openai : id === 'anthropic' ? anthropic : undefined));
  return { openai, anthropic };
}

/** Full agent row (all columns) for byte-for-byte before/after comparison. */
async function fullAgent(id: string) {
  return (await db.select().from(agents).where(eq(agents.id, id)))[0]!;
}

function agentForm(agentId: string, over: Partial<Record<string, string>> = {}): FormData {
  const fd = new FormData();
  fd.set('projectKey', KEY);
  fd.set('agentId', agentId);
  fd.set('model', over.model ?? CHANGED_MODEL);
  fd.set('systemPrompt', over.systemPrompt ?? 'CHANGED_PROMPT');
  fd.set('temperatureMilli', over.temperatureMilli ?? '900');
  fd.set('maxOutputTokens', over.maxOutputTokens ?? '1024');
  if (over.reviewRubric !== undefined) fd.set('reviewRubric', over.reviewRubric);
  if (over.enabled !== 'unset') fd.set('enabled', over.enabled ?? 'on');
  return fd;
}

/** Invoke the real saveAgent action as `ctx`'s role. */
async function callSaveAgent(ctx: TenantContext, fd: FormData) {
  H.ctx = ctx;
  return saveAgent({ error: null, saved: false }, fd);
}

const member = (w: Seeded): TenantContext => ({ ...w.ctx, projectRole: 'member' });
const viewer = (w: Seeded): TenantContext => ({ ...w.ctx, projectRole: 'viewer' });

async function agentUpdateAudits(agentId: string) {
  return db.select({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.entityId, agentId));
}

beforeAll(async () => {
  if (!available) return;
  userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `authz-${randomUUID().slice(0, 8)}@t.local`, displayName: 'A' });
  orgId = (await db.insert(organizations).values({ name: 'O', slug: `authz-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
});
afterAll(async () => {
  if (available) await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});
afterEach(() => setProviderOverrideForTests(null));

describe.skipIf(!available)('P1b agent-config authorization', () => {
  it('an admin CAN update an employee (model + prompt + sampling + enabled)', async () => {
    const w = await freshWorkspace();
    const res = await callSaveAgent(w.ctx, agentForm(w.tomBrown, { enabled: 'unset' }));
    expect(res.error).toBeNull();
    expect(res.saved).toBe(true);
    const after = await fullAgent(w.tomBrown);
    expect(after.model).toBe(CHANGED_MODEL);
    expect(after.systemPrompt).toBe('CHANGED_PROMPT');
    expect(after.temperatureMilli).toBe(900);
    expect(after.enabled).toBe(false); // checkbox omitted => disabled
    // The admin path DID write the ordinary agent.updated audit.
    expect((await agentUpdateAudits(w.tomBrown)).some((a) => a.action === 'agent.updated')).toBe(true);
  });

  it('an admin can set a bounded rubric only on a reviewer employee', async () => {
    const w = await freshWorkspace();
    const res = await callSaveAgent(w.ctx, agentForm(w.reviewer, { reviewRubric: 'Require cited evidence.' }));
    expect(res).toEqual({ error: null, saved: true });
    expect((await fullAgent(w.reviewer)).reviewRubric).toBe('Require cited evidence.');
    const primary = await callSaveAgent(w.ctx, agentForm(w.tomBrown, { reviewRubric: 'Not allowed.' }));
    expect(primary.saved).toBe(false);
    expect(primary.error).toBe('Invalid input.');
    expect((await fullAgent(w.tomBrown)).reviewRubric).toBeNull();
  });

  it('a member cannot mutate a reviewer rubric and an oversized UTF-8 rubric is rejected', async () => {
    const w = await freshWorkspace();
    const before = await fullAgent(w.reviewer);
    const denied = await callSaveAgent(member(w), agentForm(w.reviewer, { reviewRubric: 'Bypass review.' }));
    expect(denied.saved).toBe(false);
    expect(await fullAgent(w.reviewer)).toEqual(before);
    const oversized = await callSaveAgent(w.ctx, agentForm(w.reviewer, { reviewRubric: 'é'.repeat(4097) }));
    expect(oversized.saved).toBe(false);
    expect(oversized.error).toBe('Invalid input.');
    expect((await fullAgent(w.reviewer)).reviewRubric).toBeNull();
  });

  it('a MEMBER cannot change model / prompt / temperature / enabled — row byte-unchanged, no audit', async () => {
    const w = await freshWorkspace();
    const before = await fullAgent(w.tomBrown);
    const { openai } = fakeBoth();
    const res = await callSaveAgent(member(w), agentForm(w.tomBrown));
    expect(res.saved).toBe(false);
    expect(res.error).toMatch(/only workspace admins/i);
    // The COMPLETE row is identical — nothing partially applied, updatedAt untouched.
    expect(await fullAgent(w.tomBrown)).toEqual(before);
    // No agent.updated audit was written for a denied user, and the denial made ZERO provider calls.
    expect((await agentUpdateAudits(w.tomBrown)).some((a) => a.action === 'agent.updated')).toBe(false);
    expect(openai.requests.length).toBe(0);
  });

  it('a VIEWER cannot perform any agent mutation — row byte-unchanged', async () => {
    const w = await freshWorkspace();
    const before = await fullAgent(w.tomBrown);
    const res = await callSaveAgent(viewer(w), agentForm(w.tomBrown, { model: ORIGINAL_MODEL, systemPrompt: 'X', enabled: 'unset' }));
    expect(res.saved).toBe(false);
    expect(res.error).toMatch(/only workspace admins/i);
    expect(await fullAgent(w.tomBrown)).toEqual(before);
  });

  it('a member enable/disable toggle is refused (enabled flag cannot be flipped by a non-admin)', async () => {
    const w = await freshWorkspace();
    const before = await fullAgent(w.tomBrown);
    expect(before.enabled).toBe(true);
    const res = await callSaveAgent(member(w), agentForm(w.tomBrown, { model: ORIGINAL_MODEL, systemPrompt: ORIGINAL_PROMPT, enabled: 'unset' }));
    expect(res.saved).toBe(false);
    expect((await fullAgent(w.tomBrown)).enabled).toBe(true);
  });

  it('a denied member change cannot alter what a PINNED task executes; the pinned run uses the original profile', async () => {
    const w = await freshWorkspace();
    const { openai } = fakeBoth();
    // Pin Tom Brown (original model + prompt) to a task as admin.
    const taskId = await withTenant(w.ctx, (tx) =>
      createTask(tx, w.ctx, { title: 'T', input: 'do it', providerSelection: 'openai', reviewEnabled: false, primaryAgentId: w.tomBrown }),
    );
    const before = await fullAgent(w.tomBrown);
    // A member tries to rewrite the pinned agent's model + prompt → refused, row unchanged, NO provider call.
    const denied = await callSaveAgent(member(w), agentForm(w.tomBrown));
    expect(denied.saved).toBe(false);
    expect(await fullAgent(w.tomBrown)).toEqual(before);
    expect(openai.requests.length).toBe(0);
    // The subsequent pinned run executes THAT exact agent's ORIGINAL execution profile.
    const outcome = await startRun(w.ctx, taskId);
    expect(outcome.status).toBe('completed');
    const run = (await db.select().from(runs).where(eq(runs.taskId, taskId)))[0]!;
    expect(run.primaryAgentId).toBe(w.tomBrown);
    // The provider actually received the original model + system prompt, not the member's attempted values.
    expect(openai.requests[0]!.model).toBe(ORIGINAL_MODEL);
    expect(openai.requests[0]!.system).toContain(ORIGINAL_PROMPT);
    expect(openai.requests.some((r) => r.model === CHANGED_MODEL)).toBe(false);
  });

  it('a cross-workspace agent id stays rejected even for an admin (updateAgent scopes by org+project)', async () => {
    const w = await freshWorkspace();
    const other = await freshWorkspace();
    const before = await fullAgent(other.tomBrown);
    // Admin of w tries to configure other's agent → not found in w's scope → error, other row untouched.
    const res = await callSaveAgent(w.ctx, agentForm(other.tomBrown, { model: ORIGINAL_MODEL, systemPrompt: ORIGINAL_PROMPT, enabled: 'unset' }));
    expect(res.saved).toBe(false);
    expect(res.error).toBeTruthy();
    expect(await fullAgent(other.tomBrown)).toEqual(before);
  });
});
