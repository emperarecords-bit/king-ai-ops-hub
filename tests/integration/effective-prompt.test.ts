import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { agents, auditLogs, decisions, memberships, organizations, profiles, projectMembers, projects, runs, tasks } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { createObjective, setObjectiveStatus, setObjectiveOwner } from '@/domain/objectives/objectives';
import { agentExecutionFingerprint, updateEmployeePrompt } from '@/domain/agents/agents';
import { assembleCurrentOperatingPriorities, classifyRunReproducibility, effectivePromptPreview } from '@/domain/prompts/effective-prompt';

/** HUB-008 — layered effective prompt, current operating priorities, reproducibility hashes, prompt audit. */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[effective-prompt.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

const db = getSetupDb();
let orgId = '';
let ctx: TenantContext;
let ctx2: TenantContext;

async function fresh(): Promise<TenantContext> {
  const pid = (await db.insert(projects).values({ orgId, key: fixtureKey('ep'), name: 'W' }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId: pid, userId: ctx.userId, role: 'admin' });
  return { ...ctx, projectId: pid };
}
async function mkAgent(c: TenantContext, name: string, systemPrompt: string, owner = false): Promise<string> {
  const id = (await db.insert(agents).values({ orgId, projectId: c.projectId, name, role: 'primary', provider: 'openai', model: 'gpt-x', systemPrompt, temperatureMilli: 700, maxOutputTokens: 4096 }).returning({ id: agents.id }))[0]!.id;
  void owner;
  return id;
}
async function activeObjective(c: TenantContext, title: string, unit = 'contractors', target = 3, owner?: string): Promise<string> {
  const id = await withTenant(c, (tx) => createObjective(tx, c, { title, description: 'd', successCriteria: [{ label: `${title} — independently send one real quote using their own Stripe account`, metric: 'm', target, unit }] }));
  await withTenant(c, (tx) => setObjectiveStatus(tx, c, id, 'active'));
  if (owner) await withTenant(c, (tx) => setObjectiveOwner(tx, c, id, owner));
  return id;
}

beforeAll(async () => {
  if (!available) return;
  const userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `ep-${randomUUID().slice(0, 8)}@t.local`, displayName: 'A' });
  orgId = (await db.insert(organizations).values({ name: 'O', slug: `ep-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  const pid = (await db.insert(projects).values({ orgId, key: fixtureKey('ep'), name: 'W' }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId: pid, userId, role: 'admin' });
  ctx = { userId, orgId, projectId: pid, orgRole: 'owner', projectRole: 'admin' };
  const p2 = (await db.insert(projects).values({ orgId, key: fixtureKey('ep2'), name: 'W2' }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId: p2, userId, role: 'admin' });
  ctx2 = { userId, orgId, projectId: p2, orgRole: 'owner', projectRole: 'admin' };
});
afterAll(async () => { if (available) await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId)); });

const priorities = (c: TenantContext) => withTenant(c, (tx) => assembleCurrentOperatingPriorities(tx, c));

describe.skipIf(!available)('HUB-008 current operating priorities', () => {
  it('includes the active objective, its criterion + target unit, and the owner', async () => {
    const c = await fresh();
    const owner = await mkAgent(c, 'Owner', 'x');
    await activeObjective(c, 'Activate first 3 pilot contractors', 'contractors', 3, owner);
    const p = await priorities(c);
    expect(p.hasActiveObjective).toBe(true);
    expect(p.objectives[0]!.title).toBe('Activate first 3 pilot contractors');
    expect(p.objectives[0]!.owner).toBe('Owner');
    expect(p.objectives[0]!.criteria[0]!.target).toBe(3);
    expect(p.objectives[0]!.criteria[0]!.unit).toBe('contractors');
    expect(p.text).toContain('target 0 of 3 contractors');
  });

  it('excludes cancelled and completed objectives from current priorities', async () => {
    const c = await fresh();
    const cancelled = await activeObjective(c, 'Old cancelled goal');
    await withTenant(c, (tx) => setObjectiveStatus(tx, c, cancelled, 'cancelled', 'pivot'));
    const p = await priorities(c);
    expect(p.hasActiveObjective).toBe(false);
    expect(p.objectives.some((o) => o.title === 'Old cancelled goal')).toBe(false);
    expect(p.text).toContain('no active objective');
  });

  it('multiple active objectives use the deterministic listObjectives order', async () => {
    const c = await fresh();
    await activeObjective(c, 'First objective');
    await activeObjective(c, 'Second objective');
    const p1 = await priorities(c);
    const p2 = await priorities(c);
    expect(p1.objectives.map((o) => o.title)).toEqual(p2.objectives.map((o) => o.title)); // deterministic
    expect(p1.objectives.length).toBe(2);
  });

  it('an applicable accepted Decision is included', async () => {
    const c = await fresh();
    await activeObjective(c, 'Pilot');
    await db.insert(decisions).values({ orgId, projectId: c.projectId, title: 'Activation evidence standard', summary: 'A contractor is activated only with own-Stripe, independent send, real quote, real customer, evidence.', authorLabel: 'Founder', status: 'accepted', scope: 'workspace' });
    const p = await priorities(c);
    expect(p.decisions.some((d) => d.title === 'Activation evidence standard')).toBe(true);
    expect(p.text).toContain('Activation evidence standard');
  });
});

describe.skipIf(!available)('HUB-008 effective prompt assembly', () => {
  it('a stale standing goal stays present but the active objective is injected at higher precedence', async () => {
    const c = await fresh();
    const tom = await mkAgent(c, 'Tom Brown', 'You are Tom Brown. Mission: reach the first 10 paying customers. You may not spend money or send external messages.');
    await activeObjective(c, 'Activate first 3 pilot contractors');
    const ep = (await withTenant(c, (tx) => effectivePromptPreview(tx, c, tom)))!;
    // stable role (stale 10-customer language) is still present…
    expect(ep.stableRolePrompt).toContain('first 10 paying customers');
    // …but the composed prompt injects the active pilot objective, and the precedence header puts
    // "Current operating priorities (active objectives)" ABOVE "Stable role strategy & long-term goals".
    expect(ep.composed).toContain('Activate first 3 pilot contractors');
    const prioIdx = ep.composed.indexOf('Current operating priorities (active objectives)');
    const roleStratIdx = ep.composed.indexOf('Stable role strategy & long-term goals');
    expect(prioIdx).toBeGreaterThan(-1);
    expect(prioIdx).toBeLessThan(roleStratIdx); // priorities precede (outrank) stable role strategy
    // authority restriction retained.
    expect(ep.composed).toContain('may not spend money or send external messages');
  });

  it('no active objective is stated explicitly (not invented)', async () => {
    const c = await fresh();
    const a = await mkAgent(c, 'A', 'You are A.');
    const ep = (await withTenant(c, (tx) => effectivePromptPreview(tx, c, a)))!;
    expect(ep.hasActiveObjective).toBe(false);
    expect(ep.composed).toContain('no active objective');
  });

  it('is deterministic (same hash) for identical state; configurationHash matches the fingerprint', async () => {
    const c = await fresh();
    const a = await mkAgent(c, 'A', 'You are A.');
    await activeObjective(c, 'Pilot');
    const e1 = (await withTenant(c, (tx) => effectivePromptPreview(tx, c, a)))!;
    const e2 = (await withTenant(c, (tx) => effectivePromptPreview(tx, c, a)))!;
    expect(e2.effectivePromptHash).toBe(e1.effectivePromptHash);
    expect(e1.configurationHash).toBe(agentExecutionFingerprint({ provider: 'openai', model: 'gpt-x', systemPrompt: 'You are A.', temperatureMilli: 700, maxOutputTokens: 4096, role: 'primary' }));
  });

  it('reviewer variant keeps reviewer policy but the same authoritative priorities', async () => {
    const c = await fresh();
    const a = await mkAgent(c, 'Rev', 'You are the reviewer.');
    await activeObjective(c, 'Pilot');
    const ep = (await withTenant(c, (tx) => effectivePromptPreview(tx, c, a, undefined, 'reviewer')))!;
    expect(ep.variant).toBe('reviewer');
    expect(ep.platformPolicy).toContain('reviewer');
    expect(ep.composed).toContain('Pilot'); // same objective priorities
  });

  it('workspace isolation — priorities do not leak across workspaces', async () => {
    const c = await fresh();
    await activeObjective(ctx2, 'Foreign objective');
    const p = await priorities(c);
    expect(p.objectives.some((o) => o.title === 'Foreign objective')).toBe(false);
  });
});

describe.skipIf(!available)('HUB-008 reproducibility + prompt audit', () => {
  it('a historical run preserves its config identity after a later employee-prompt edit', async () => {
    const c = await fresh();
    const agent = await mkAgent(c, 'Perf', 'Original prompt v1.');
    const original = agentExecutionFingerprint({ provider: 'openai', model: 'gpt-x', systemPrompt: 'Original prompt v1.', temperatureMilli: 700, maxOutputTokens: 4096, role: 'primary' });
    const t = (await db.insert(tasks).values({ orgId, projectId: c.projectId, title: 'T', input: 'x', providerSelection: 'openai', status: 'completed', createdBy: c.userId }).returning({ id: tasks.id }))[0]!.id;
    const runId = (await db.insert(runs).values({ classification: 'live', orgId, projectId: c.projectId, taskId: t, status: 'completed', primaryAgentId: agent, primaryConfigHash: original }).returning({ id: runs.id }))[0]!.id;
    // Edit the employee's prompt.
    const changed = await withTenant(c, (tx) => updateEmployeePrompt(tx, c, agent, { systemPrompt: 'Edited prompt v2.' }, 'sharpen mission'));
    expect(changed).toBe(true);
    // The run's stored hash is UNCHANGED and no longer equals the agent's new fingerprint.
    const run = (await db.select({ h: runs.primaryConfigHash }).from(runs).where(eq(runs.id, runId)))[0]!;
    const newFingerprint = agentExecutionFingerprint({ provider: 'openai', model: 'gpt-x', systemPrompt: 'Edited prompt v2.', temperatureMilli: 700, maxOutputTokens: 4096, role: 'primary' });
    expect(run.h).toBe(original);
    expect(run.h).not.toBe(newFingerprint);
  });

  it('Decision applicability: workspace + matching-objective + this-task included; other-objective + non-accepted excluded', async () => {
    const c = await fresh();
    const objId = await activeObjective(c, 'Pilot');
    const other = await activeObjective(c, 'Other');
    await withTenant(c, (tx) => setObjectiveStatus(tx, c, other, 'cancelled', 'x')); // cancelled → its decisions excluded
    const t = (await db.insert(tasks).values({ orgId, projectId: c.projectId, title: 'T', input: 'x', providerSelection: 'openai', status: 'pending', createdBy: c.userId, objectiveId: objId }).returning({ id: tasks.id }))[0]!.id;
    const dec = (title: string, scope: 'workspace' | 'objective' | 'task', status: 'accepted' | 'proposed' | 'rejected' | 'superseded', extra: Record<string, unknown> = {}) =>
      db.insert(decisions).values({ orgId, projectId: c.projectId, title, summary: 's', authorLabel: 'F', status, scope, ...extra });
    await dec('WS accepted', 'workspace', 'accepted');
    await dec('Obj active accepted', 'objective', 'accepted', { scopeObjectiveId: objId });
    await dec('Obj cancelled accepted', 'objective', 'accepted', { scopeObjectiveId: other });
    await dec('Task accepted', 'task', 'accepted', { scopeTaskId: t });
    await dec('WS proposed', 'workspace', 'proposed');
    await dec('WS rejected', 'workspace', 'rejected');
    await dec('WS superseded', 'workspace', 'superseded');
    const p = await withTenant(c, (tx) => assembleCurrentOperatingPriorities(tx, c, t));
    const titles = p.decisions.map((d) => d.title).sort();
    expect(titles).toEqual(['Obj active accepted', 'Task accepted', 'WS accepted']);
    // Every included decision carries an id + content hash for the source manifest.
    expect(p.decisions.every((d) => d.id && d.contentHash)).toBe(true);
  });

  it('classifyRunReproducibility distinguishes exact / partial / unavailable (pre-feature)', () => {
    expect(classifyRunReproducibility({ primaryEffectivePromptHash: 'e', primaryConfigHash: 'c', sourceManifest: [{ kind: 'task', hash: 'h' }] })).toBe('exact');
    expect(classifyRunReproducibility({ primaryConfigHash: 'c' })).toBe('partial');
    expect(classifyRunReproducibility({})).toBe('unavailable'); // a run created before the feature
  });

  it('applying a permanent-prompt diff preserves the authority prohibitions', async () => {
    const c = await fresh();
    const agent = await mkAgent(c, 'Tom', 'You are Tom.\n## Authority\nYou may not spend money or send external messages.\n## Mission\nreach the first 10 paying customers.');
    await withTenant(c, (tx) => updateEmployeePrompt(tx, c, agent, { systemPrompt: 'You are Tom.\n## Authority\nYou may not spend money or send external messages.\n## Mission\nExecute active objectives; the 10-paying-customers goal is secondary.' }, 'align to active objective'));
    const ep = (await withTenant(c, (tx) => effectivePromptPreview(tx, c, agent)))!;
    expect(ep.stableRolePrompt).toContain('You may not spend money or send external messages.'); // authority intact
    expect(ep.stableRolePrompt).not.toContain('reach the first 10 paying customers'); // stale goal removed
  });

  it('updateEmployeePrompt records prev/new prompt+config hashes + reason; no full prompt text; idempotent; admin+reason enforced', async () => {
    const c = await fresh();
    const agent = await mkAgent(c, 'P', 'Prompt A.');
    // admin + reason enforced
    const member = { ...c, projectRole: 'member' as const };
    await expect(withTenant(member, (tx) => updateEmployeePrompt(tx, member, agent, { systemPrompt: 'B' }, 'x'))).rejects.toThrow(/admin/i);
    await expect(withTenant(c, (tx) => updateEmployeePrompt(tx, c, agent, { systemPrompt: 'B' }, '  '))).rejects.toThrow(/reason is required/i);
    // real change → event with hashes
    await withTenant(c, (tx) => updateEmployeePrompt(tx, c, agent, { systemPrompt: 'Prompt B.' }, 'clarify'));
    const ev = (await db.select({ d: auditLogs.detail }).from(auditLogs).where(and(eq(auditLogs.entityId, agent), eq(auditLogs.action, 'employee.prompt_updated'))))[0]!;
    const d = ev.d as Record<string, unknown>;
    expect(d.prevPromptHash).toBeTruthy();
    expect(d.newPromptHash).toBeTruthy();
    expect(d.prevConfigHash).toBeTruthy();
    expect(d.newConfigHash).toBeTruthy();
    expect(d.reason).toBe('clarify');
    expect(JSON.stringify(d)).not.toContain('Prompt B.'); // no full prompt text
    // idempotent: re-applying the same prompt makes no change and emits no new event.
    const again = await withTenant(c, (tx) => updateEmployeePrompt(tx, c, agent, { systemPrompt: 'Prompt B.' }, 'noop'));
    expect(again).toBe(false);
    const count = (await db.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.entityId, agent), eq(auditLogs.action, 'employee.prompt_updated')))).length;
    expect(count).toBe(1);
  });
});
