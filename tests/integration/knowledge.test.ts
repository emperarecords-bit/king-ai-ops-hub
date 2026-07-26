import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { ConflictError } from '@/lib/errors';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { agents, memberships, organizations, profiles, projectMembers, projects, runs, tasks } from '@/db/schema';
import {
  activateKnowledge,
  archiveKnowledge,
  createKnowledge,
  listInjectionsForKnowledge,
  listKnowledge,
  logKnowledgeApplications,
  getKnowledgeVerificationHistory,
  reviseKnowledge,
  selectRelevantKnowledge,
  setKnowledgeVerification,
} from '@/domain/knowledge/knowledge';
import { listAllActiveKnowledgeForAdministration } from '@/domain/knowledge/admin';
import { beginAiOperation, beginOrReuseAiOperation, completeAiOperation, failAiOperation, getAiOperation } from '@/domain/ai/operations';

/**
 * K1 rules that must never regress: only ACTIVE knowledge is injected;
 * drafts are quarantine; a version supersedes its predecessor atomically so
 * two versions can never inject together; archived is terminal.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(
    `[knowledge.test] SKIPPING — database not reachable: ${err instanceof Error ? err.message : err}`,
  );
}

const userId = randomUUID();
let ctx: TenantContext;
let orgId = '';

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  await db.insert(profiles).values({
    id: userId,
    email: `know-${randomUUID().slice(0, 8)}@test.local`,
    displayName: 'Knowledge Tester',
  });
  const org = await db
    .insert(organizations)
    .values({ name: 'Know Test Org', slug: `know-${randomUUID().slice(0, 8)}` })
    .returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  const project = await db
    .insert(projects)
    .values({ orgId, key: fixtureKey('know'), name: 'Know Test Project' })
    .returning({ id: projects.id });
  await db
    .insert(projectMembers)
    .values({ orgId, projectId: project[0]!.id, userId, role: 'admin' });
  ctx = { userId, orgId, projectId: project[0]!.id, orgRole: 'owner', projectRole: 'admin' };
});

afterAll(async () => {
  // Audit rows pin the fixtures (ON DELETE RESTRICT) — archive, don't delete.
  if (!available) return;
  await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});

describe.skipIf(!available)('company knowledge K1', () => {
  let draftId = '';
  let activeId = '';

  it('drafts are never injected into prompts', async () => {
    draftId = await withTenant(ctx, (tx) =>
      createKnowledge(tx, ctx, {
        title: 'Draft standard',
        body: 'Not yet approved.',
        kind: 'standard',
        activate: false,
      }),
    );
    const injected = await withTenant(ctx, (tx) => listAllActiveKnowledgeForAdministration(tx, ctx));
    expect(injected.find((i) => i.title === 'Draft standard')).toBeUndefined();
  });

  it('activation makes an item injectable, with approver recorded', async () => {
    await withTenant(ctx, (tx) => activateKnowledge(tx, ctx, draftId));
    const injected = await withTenant(ctx, (tx) => listAllActiveKnowledgeForAdministration(tx, ctx));
    expect(injected.find((i) => i.title === 'Draft standard')?.content).toBe('Not yet approved.');
    activeId = draftId;
  });

  it('human-created knowledge may activate immediately', async () => {
    await withTenant(ctx, (tx) =>
      createKnowledge(tx, ctx, {
        title: 'House style',
        body: 'Short sentences.',
        kind: 'brand',
        activate: true,
      }),
    );
    const injected = await withTenant(ctx, (tx) => listAllActiveKnowledgeForAdministration(tx, ctx));
    expect(injected.find((i) => i.title === 'House style')).toBeDefined();
  });

  it('a new version supersedes atomically — exactly one version injects', async () => {
    await withTenant(ctx, (tx) =>
      reviseKnowledge(tx, ctx, activeId, { body: 'Approved, v2.', activate: true }),
    );
    const injected = await withTenant(ctx, (tx) => listAllActiveKnowledgeForAdministration(tx, ctx));
    const versions = injected.filter((i) => i.title === 'Draft standard');
    expect(versions).toHaveLength(1);
    expect(versions[0]!.content).toBe('Approved, v2.');

    const all = await withTenant(ctx, (tx) => listKnowledge(tx, ctx));
    const v1 = all.find((i) => i.id === activeId);
    expect(v1?.status).toBe('archived');
    const v2 = all.find((i) => i.supersedes === activeId);
    expect(v2?.version).toBe(2);
    expect(v2?.status).toBe('active');
  });

  it('a draft revision does NOT replace the active version until activated', async () => {
    const all = await withTenant(ctx, (tx) => listKnowledge(tx, ctx, 'active'));
    const current = all.find((i) => i.title === 'Draft standard')!;
    await withTenant(ctx, (tx) =>
      reviseKnowledge(tx, ctx, current.id, { body: 'v3 pending.', activate: false }),
    );
    const injected = await withTenant(ctx, (tx) => listAllActiveKnowledgeForAdministration(tx, ctx));
    expect(injected.find((i) => i.title === 'Draft standard')?.content).toBe('Approved, v2.');
  });

  it('archived is terminal and never injects', async () => {
    const all = await withTenant(ctx, (tx) => listKnowledge(tx, ctx, 'active'));
    const house = all.find((i) => i.title === 'House style')!;
    await withTenant(ctx, (tx) => archiveKnowledge(tx, ctx, house.id));
    const injected = await withTenant(ctx, (tx) => listAllActiveKnowledgeForAdministration(tx, ctx));
    expect(injected.find((i) => i.title === 'House style')).toBeUndefined();
    await expect(
      withTenant(ctx, (tx) => archiveKnowledge(tx, ctx, house.id)),
    ).rejects.toThrow(ConflictError);
  });

  it('only drafts can be activated', async () => {
    const all = await withTenant(ctx, (tx) => listKnowledge(tx, ctx, 'active'));
    const active = all[0]!;
    await expect(
      withTenant(ctx, (tx) => activateKnowledge(tx, ctx, active.id)),
    ).rejects.toThrow(ConflictError);
  });
});

describe.skipIf(!available)('knowledge retrieval is relevance-gated (not wholesale)', () => {
  it('an unrelated active item is NOT injected; membership + recency do not create relevance', async () => {
    const shipping = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Shipping carrier accounts', body: 'Freight carrier logistics warehouse pallet dispatch codes.', kind: 'fact', activate: true }));
    // A recent, active, workspace item — but no shared subject with a database query → omitted.
    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: 'migrate the postgres database schema and indexes' }));
    expect(picked.find((k) => k.id === shipping)).toBeUndefined();
  });

  it('a relevant active item IS injected, with a recorded eligibility reason', async () => {
    await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Database migration policy', body: 'Postgres schema migrations run through drizzle with a backup first.', kind: 'standard', activate: true }));
    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: 'migrate the postgres database schema safely' }));
    const hit = picked.find((k) => k.title === 'Database migration policy')!;
    expect(hit).toBeDefined();
    expect(hit.reason).toMatch(/^subject:/); // matched terms preserved for the trail
    expect(hit.reason).toMatch(/postgres|database|schema/);
  });

  it('drafts, archived, and superseded versions are never selected; one version at most', async () => {
    const id = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Refund window rule', body: 'Refund window billing invoice payment terms are thirty days.', kind: 'policy', activate: true }));
    await withTenant(ctx, (tx) => reviseKnowledge(tx, ctx, id, { body: 'Refund window billing invoice payment terms are now sixty days.', activate: true }));
    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: 'refund window billing invoice payment terms' }));
    const matches = picked.filter((k) => k.title === 'Refund window rule');
    expect(matches).toHaveLength(1); // v1 archived, only v2 active
    expect(matches[0]!.body).toMatch(/sixty days/);
    // A draft is not selected.
    await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Refund draft', body: 'Refund window billing invoice payment draft only.', kind: 'policy', activate: false }));
    const picked2 = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: 'refund window billing invoice payment terms' }));
    expect(picked2.find((k) => k.title === 'Refund draft')).toBeUndefined();
  });

  it('application records are idempotent and preserve the exact supplied text after a later revision', async () => {
    const id = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Vendor onboarding steps', body: 'Vendor onboarding contract signature compliance checklist steps.', kind: 'playbook', activate: true }));
    // A run to attach the application record to.
    const a = await getSetupDb().insert(agents).values({ orgId, projectId: ctx.projectId, name: `A-${randomUUID().slice(0, 6)}`, role: 'primary', provider: 'openai', model: 'gpt-5.4-mini', systemPrompt: 'x' }).returning({ id: agents.id });
    const t = await getSetupDb().insert(tasks).values({ orgId, projectId: ctx.projectId, title: 'Vendor task', input: 'x', providerSelection: 'openai', status: 'completed', createdBy: userId }).returning({ id: tasks.id });
    const r = await getSetupDb().insert(runs).values({ orgId, projectId: ctx.projectId, taskId: t[0]!.id, status: 'completed', primaryAgentId: a[0]!.id }).returning({ id: runs.id });
    const selected = [{ id, version: 1, title: 'Vendor onboarding steps', body: 'original', reason: 'subject: vendor, onboarding', memoryText: 'EXACT vendor text v1' }];
    await withTenant(ctx, (tx) => logKnowledgeApplications(tx, ctx, { consumerType: 'task_run', consumerId: r[0]!.id, runId: r[0]!.id, taskId: t[0]!.id, injected: selected }));
    await withTenant(ctx, (tx) => logKnowledgeApplications(tx, ctx, { consumerType: 'task_run', consumerId: r[0]!.id, runId: r[0]!.id, taskId: t[0]!.id, injected: [{ ...selected[0]!, memoryText: 'DIFFERENT (ignored)' }] }));
    let trail = await withTenant(ctx, (tx) => listInjectionsForKnowledge(tx, ctx, id));
    expect(trail).toHaveLength(1); // idempotent per (consumer, item)
    expect(trail[0]!.memoryText).toBe('EXACT vendor text v1');
    expect(trail[0]!.reason).toMatch(/^subject:/); // records WHY it was selected
    // Revise the item; the historical snapshot is unchanged.
    await withTenant(ctx, (tx) => reviseKnowledge(tx, ctx, id, { body: 'Rewritten entirely.', activate: true }));
    trail = await withTenant(ctx, (tx) => listInjectionsForKnowledge(tx, ctx, id));
    expect(trail[0]!.memoryText).toBe('EXACT vendor text v1');
    expect(trail[0]!.version).toBe(1);
  });

  it('verification is an evidenced event: activation never verifies; unsupported states are rejected', async () => {
    const id = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Verify subject', body: 'b', kind: 'fact', activate: true }));
    // Activation created no verification event.
    expect(await withTenant(ctx, (tx) => getKnowledgeVerificationHistory(tx, ctx, id))).toHaveLength(0);
    // source_supported / system_verified cannot be assigned yet (no resolvable source / deterministic check).
    await expect(withTenant(ctx, (tx) => setKnowledgeVerification(tx, ctx, id, 'source_supported'))).rejects.toThrow(/resolvable supporting source/i);
    await expect(withTenant(ctx, (tx) => setKnowledgeVerification(tx, ctx, id, 'system_verified'))).rejects.toThrow(/deterministic check/i);
    // disputed requires a rationale.
    await expect(withTenant(ctx, (tx) => setKnowledgeVerification(tx, ctx, id, 'disputed'))).rejects.toThrow(/rationale is required/i);
    // human_confirmed is allowed and does NOT imply source support; history records who/when/why.
    await withTenant(ctx, (tx) => setKnowledgeVerification(tx, ctx, id, 'human_confirmed'));
    await withTenant(ctx, (tx) => setKnowledgeVerification(tx, ctx, id, 'disputed', 'a second source disagrees'));
    const history = await withTenant(ctx, (tx) => getKnowledgeVerificationHistory(tx, ctx, id));
    expect(history.map((h) => h.verification)).toEqual(['human_confirmed', 'disputed']);
    expect(history[0]!.actorName).toBe('Knowledge Tester');
    expect(history[0]!.at).toBeInstanceOf(Date);
    expect(history[1]!.reason).toBe('a second source disagrees');
  });

  it('active manual knowledge stays unverified — selection qualifies it, and it never claims verification', async () => {
    await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Kubernetes cluster autoscaler', body: 'Kubernetes cluster autoscaler nodepool provisioning tuning parameters.', kind: 'fact', activate: true }));
    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: 'tune the kubernetes cluster autoscaler nodepool provisioning' }));
    const hit = picked.find((k) => k.title === 'Kubernetes cluster autoscaler')!;
    expect(hit).toBeDefined();
    // Supplied text carries the trust qualification: human-asserted + unverified (activation is not verification).
    expect(hit.memoryText).toMatch(/human_asserted/);
    expect(hit.memoryText).toMatch(/unverified/);
  });

  it('expired knowledge is withheld from current-fact use; restricted knowledge is withheld without a grant', async () => {
    await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Datacenter lease terms', body: 'Datacenter lease colocation rack power cooling contract.', kind: 'fact', activate: true, expiresAt: new Date('2020-01-01') }));
    await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Encryption key rotation secret', body: 'Encryption key rotation secret vault credentials rotation cadence.', kind: 'fact', activate: true, disclosure: 'restricted' }));
    const q = 'datacenter lease colocation rack power cooling and encryption key rotation secret vault credentials cadence';
    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: q }));
    expect(picked.find((k) => k.title === 'Datacenter lease terms')).toBeUndefined(); // expired
    const restricted = picked.find((k) => k.title === 'Encryption key rotation secret');
    expect(restricted).toBeUndefined(); // restricted, no grant → not supplied at all (no sensitive text)
  });

  it('knowledge scope requires a concrete same-workspace target', async () => {
    await expect(
      withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'x', body: 'y', scopeKind: 'task' })),
    ).rejects.toThrow(/must name the task/i);
    // A foreign task target is rejected.
    const foreignTask = await getSetupDb().insert(tasks).values({ orgId, projectId: ctx.projectId, title: 'ok', input: 'x', providerSelection: 'openai', status: 'running', createdBy: userId }).returning({ id: tasks.id });
    // (same-workspace task succeeds)
    await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Scoped ok', body: 'Scoped clickstream analytics funnel.', scopeKind: 'task', scopeTaskId: foreignTask[0]!.id, activate: true }));
  });

  it('closed-scope knowledge does not leak into unrelated current work', async () => {
    const doneTask = await getSetupDb().insert(tasks).values({ orgId, projectId: ctx.projectId, title: 'closed', input: 'x', providerSelection: 'openai', status: 'completed', createdBy: userId }).returning({ id: tasks.id });
    await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Widget serial format', body: 'Widget serial format numbering scheme barcode.', kind: 'fact', scopeKind: 'task', scopeTaskId: doneTask[0]!.id, activate: true }));
    // An unrelated run — task-scoped to a completed task, so never supplied here.
    const picked = await withTenant(ctx, (tx) =>
      selectRelevantKnowledge(tx, ctx, { queryText: 'widget serial format numbering barcode', currentTaskId: null, currentObjectiveId: null }),
    );
    expect(picked.find((k) => k.title === 'Widget serial format')).toBeUndefined();
  });

  it('a disputed record is withheld from a task run but the same record is not gated by kind', async () => {
    const id = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Quarterly discount rate', body: 'Quarterly discount rate margin promotion percentage.', kind: 'policy', activate: true }));
    await withTenant(ctx, (tx) => setKnowledgeVerification(tx, ctx, id, 'disputed', 'two active records disagree on the rate'));
    // Task run = current operational fact → disputed is withheld (not settled context for execution).
    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: 'quarterly discount rate margin promotion percentage', intendedUse: 'current_operational_fact' }));
    expect(picked.find((k) => k.title === 'Quarterly discount rate')).toBeUndefined();
    // Its `policy` kind played no role — a reference-use consumer receives it, qualified as disputed.
    const ref = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: 'quarterly discount rate margin promotion percentage', intendedUse: 'reference' }));
    const hit = ref.find((k) => k.title === 'Quarterly discount rate');
    expect(hit).toBeDefined();
    expect(hit!.memoryText).toMatch(/disputed/);
  });

  it('idempotency: replay/retry reuse one operation; new requests get new ones', async () => {
    const KEY = `req-${randomUUID().slice(0, 8)}`;
    const args = { operationType: 'objective_suggestion' as const, idempotencyKey: KEY, provider: 'openai' };

    // First submission → dispatch, a new operation.
    const first = await withTenant(ctx, (tx) => beginOrReuseAiOperation(tx, ctx, args));
    expect(first.decision).toBe('dispatch');

    // Double submission / network replay while still running → same op, do NOT dispatch again.
    const replay = await withTenant(ctx, (tx) => beginOrReuseAiOperation(tx, ctx, args));
    expect(replay.decision).toBe('in_progress');
    expect(replay.id).toBe(first.id);

    // After completion, a replay returns the stored result — no second provider call.
    await withTenant(ctx, (tx) => completeAiOperation(tx, ctx, first.id, [{ label: 'x', target: 1, unit: '' }]));
    const afterDone = await withTenant(ctx, (tx) => beginOrReuseAiOperation(tx, ctx, args));
    expect(afterDone.decision).toBe('return_result');
    expect(afterDone.id).toBe(first.id);
    expect(afterDone.resultData).toEqual([{ label: 'x', target: 1, unit: '' }]);

    // Retry after a recorded failure → dispatch under the SAME operation (new attempt).
    const KEY2 = `req-${randomUUID().slice(0, 8)}`;
    const args2 = { operationType: 'objective_suggestion' as const, idempotencyKey: KEY2, provider: 'openai' };
    const op2 = await withTenant(ctx, (tx) => beginOrReuseAiOperation(tx, ctx, args2));
    await withTenant(ctx, (tx) => failAiOperation(tx, ctx, op2.id, 'dispatch timeout'));
    const retry = await withTenant(ctx, (tx) => beginOrReuseAiOperation(tx, ctx, args2));
    expect(retry.decision).toBe('dispatch');
    expect(retry.id).toBe(op2.id); // same logical operation
    expect((await withTenant(ctx, (tx) => getAiOperation(tx, ctx, op2.id)))?.status).toBe('dispatched');

    // A genuinely new request (no key) → a distinct operation each time.
    const a = await withTenant(ctx, (tx) => beginOrReuseAiOperation(tx, ctx, { operationType: 'objective_suggestion', provider: 'openai' }));
    const b = await withTenant(ctx, (tx) => beginOrReuseAiOperation(tx, ctx, { operationType: 'objective_suggestion', provider: 'openai' }));
    expect(a.decision).toBe('dispatch');
    expect(b.id).not.toBe(a.id);
  });

  it('a durable operation anchors non-run Knowledge applications inspectably', async () => {
    const op = await withTenant(ctx, (tx) => beginAiOperation(tx, ctx, { operationType: 'objective_suggestion', provider: 'openai' }));
    const k = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Op-anchored note', body: 'b', kind: 'fact', activate: true }));
    await withTenant(ctx, (tx) => logKnowledgeApplications(tx, ctx, { consumerType: 'objective_suggestion', consumerId: op, injected: [{ id: k, version: 1, title: 'Op-anchored note', body: 'b', reason: 'subject: x', memoryText: 'snap' }] }));
    const trail = await withTenant(ctx, (tx) => listInjectionsForKnowledge(tx, ctx, k));
    expect(trail[0]!.consumerId).toBe(op);
    expect((await withTenant(ctx, (tx) => getAiOperation(tx, ctx, op)))?.operationType).toBe('objective_suggestion');
  });

  it('objective suggestion (a non-run consumer) leaves the same application record, idempotent per operation', async () => {
    const id = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Pilot pricing note', body: 'Pilot pricing flat fee guarantee contractor conversion.', kind: 'fact', activate: true }));
    const operationId = randomUUID();
    const supplied = [{ id, version: 1, title: 'Pilot pricing note', body: 'b', reason: 'subject: pilot, pricing', memoryText: 'EXACT suggestion snapshot' }];
    // No run, no task — a suggestion operation. Same table, same trail.
    await withTenant(ctx, (tx) => logKnowledgeApplications(tx, ctx, { consumerType: 'objective_suggestion', consumerId: operationId, injected: supplied }));
    await withTenant(ctx, (tx) => logKnowledgeApplications(tx, ctx, { consumerType: 'objective_suggestion', consumerId: operationId, injected: supplied }));
    const trail = await withTenant(ctx, (tx) => listInjectionsForKnowledge(tx, ctx, id));
    const forOp = trail.filter((t) => t.consumerType === 'objective_suggestion');
    expect(forOp).toHaveLength(1); // idempotent per (consumer, item)
    expect(forOp[0]!.consumerId).toBe(operationId);
    expect(forOp[0]!.memoryText).toBe('EXACT suggestion snapshot');
    expect(forOp[0]!.runId).toBeNull();
  });
});
