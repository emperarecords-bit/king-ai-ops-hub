import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { FakeProvider } from '@tests/support/fake-provider';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import {
  agents,
  auditLogs,
  decisions,
  memberships,
  organizations,
  profiles,
  projectMembers,
  projects,
  runs,
  runSteps,
  spendLimits,
  tasks,
} from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { createObjective, setObjectiveStatus } from '@/domain/objectives/objectives';
import { agentExecutionFingerprint, updateEmployeePrompt } from '@/domain/agents/agents';
import { setProviderOverrideForTests } from '@/providers/registry';
import { anchorReviewClaims } from '@/orchestration/prompts';
import { startRun } from '@/domain/tasks/runner';
import { ASSEMBLER_VERSION } from '@/orchestration/prompts';
import { sha256Hex } from '@/lib/crypto';

/**
 * HUB-008 verification — end-to-end, NON-BILLABLE. Drives the REAL production dispatch path
 * (`startRun` → `getProvider`) with a fake provider injected via the registry test seam, so no external
 * model call or spend occurs. Proves the run persists its full prompt-identity, the identity is immutable
 * against a later employee-prompt edit, layers appear once, Decision applicability is honored, retrieved
 * context stays inside the untrusted boundary, and no audit event fires merely for assembling/reading a
 * prompt.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
// serverEnv() validates these even though the injected fake provider makes NO external call or spend.
// Under NODE_ENV=test the production placeholder guard is skipped, so these test values are inert.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? 'test-openai-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'test-anthropic-key';
process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY ?? Buffer.alloc(32).toString('base64');

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[runner-persistence.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

const db = getSetupDb();
let orgId = '';
let baseCtx: TenantContext;

const PRIMARY_PROMPT_V1 = 'You are the primary engineer. Mission: reach the first 10 paying customers.';
const REVIEWER_PROMPT_V1 = 'You are the reviewer. Judge the response against the approved policies.';
const CRITERION_LABEL = 'Contractor independently sends one real quote using their own Stripe account';
const CRITERION_TARGET = 3;
const CRITERION_UNIT = 'contractors';
const OBJECTIVE_TITLE = 'Activate first 3 pilot contractors';
const TASK_INPUT = 'Draft a pilot activation checklist for contractor A.';

// Unique markers so we can prove included Decisions reach the prompt and excluded ones never do.
const WS_MARKER = 'WS_DECISION_MARKER_INCLUDED';
const OBJ_MARKER = 'OBJ_DECISION_MARKER_INCLUDED';
const TASK_MARKER = 'TASK_DECISION_MARKER_INCLUDED';
const UNRELATED_MARKER = 'UNRELATED_DECISION_MARKER_EXCLUDED';
const PROPOSED_MARKER = 'PROPOSED_DECISION_MARKER_EXCLUDED';

const REVIEWER_REVISE = `\`\`\`review-result\n${JSON.stringify({ verdict: 'revise', findings: [{ claimAnchor: anchorReviewClaims('Primary draft checklist.')[0]!.anchor, severity: 'minor', rationale: 'The checklist should require the contractor to connect their own Stripe account before activation.', requestedRevision: 'Add a Stripe-connection verification step.' }] })}\n\`\`\``;

async function freshWorkspace() {
  const pid = (await db.insert(projects).values({ orgId, key: fixtureKey('rp'), name: 'W' }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId: pid, userId: baseCtx.userId, role: 'admin' });
  await db.insert(spendLimits).values({ orgId, projectId: pid, monthlyLimitMicros: 100_000_000n });
  const ctx: TenantContext = { ...baseCtx, projectId: pid };

  const primaryId = (await db
    .insert(agents)
    .values({ orgId, projectId: pid, name: 'Lead Engineer', role: 'primary', provider: 'openai', model: 'gpt-x', systemPrompt: PRIMARY_PROMPT_V1, temperatureMilli: 700, maxOutputTokens: 4096 })
    .returning({ id: agents.id }))[0]!.id;
  const reviewerId = (await db
    .insert(agents)
    .values({ orgId, projectId: pid, name: 'Principal Reviewer', role: 'reviewer', provider: 'anthropic', model: 'claude-x', systemPrompt: REVIEWER_PROMPT_V1, temperatureMilli: 500, maxOutputTokens: 4096 })
    .returning({ id: agents.id }))[0]!.id;

  const objectiveId = await withTenant(ctx, (tx) =>
    createObjective(tx, ctx, {
      title: OBJECTIVE_TITLE,
      description: 'Controlled pilot activation.',
      successCriteria: [{ label: CRITERION_LABEL, metric: 'contractors_activated', target: CRITERION_TARGET, unit: CRITERION_UNIT }],
    }),
  );
  await withTenant(ctx, (tx) => setObjectiveStatus(tx, ctx, objectiveId, 'active'));

  // A second, CANCELLED objective so an objective-scoped Decision on it is out of scope.
  const otherObjectiveId = await withTenant(ctx, (tx) =>
    createObjective(tx, ctx, { title: 'Old goal', description: 'd', successCriteria: [{ label: 'x', metric: 'm', target: 1, unit: '' }] }),
  );
  await withTenant(ctx, (tx) => setObjectiveStatus(tx, ctx, otherObjectiveId, 'active'));
  await withTenant(ctx, (tx) => setObjectiveStatus(tx, ctx, otherObjectiveId, 'cancelled', 'pivot'));

  const taskId = (await db
    .insert(tasks)
    .values({ orgId, projectId: pid, title: 'Pilot activation checklist', input: TASK_INPUT, providerSelection: 'both', reviewEnabled: true, status: 'pending', createdBy: ctx.userId, objectiveId, assignedPrimaryAgentId: primaryId, assignedReviewerAgentId: reviewerId })
    .returning({ id: tasks.id }))[0]!.id;

  // Decisions: three applicable (workspace / matching-objective / this-task) + two inapplicable.
  const dec = (title: string, summary: string, scope: 'workspace' | 'objective' | 'task', status: 'accepted' | 'proposed', extra: Record<string, unknown> = {}) =>
    db.insert(decisions).values({ orgId, projectId: pid, title, summary, authorLabel: 'Founder', status, scope, ...extra }).returning({ id: decisions.id });
  const wsId = (await dec('WS standard', WS_MARKER, 'workspace', 'accepted'))[0]!.id;
  const objId = (await dec('Obj standard', OBJ_MARKER, 'objective', 'accepted', { scopeObjectiveId: objectiveId }))[0]!.id;
  const taskDecId = (await dec('Task standard', TASK_MARKER, 'task', 'accepted', { scopeTaskId: taskId }))[0]!.id;
  await dec('Cancelled-obj standard', UNRELATED_MARKER, 'objective', 'accepted', { scopeObjectiveId: otherObjectiveId });
  await dec('Proposed standard', PROPOSED_MARKER, 'workspace', 'proposed');

  return { ctx, primaryId, reviewerId, objectiveId, taskId, includedDecisionIds: [wsId, objId, taskDecId].sort() };
}

beforeAll(async () => {
  if (!available) return;
  const userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `rp-${randomUUID().slice(0, 8)}@t.local`, displayName: 'A' });
  orgId = (await db.insert(organizations).values({ name: 'O', slug: `rp-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  baseCtx = { userId, orgId, projectId: '', orgRole: 'owner', projectRole: 'admin' };
});
afterAll(async () => {
  if (available) await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});
afterEach(() => setProviderOverrideForTests(null));

describe.skipIf(!available)('HUB-008 end-to-end runner persistence (non-billable)', () => {
  it('the real dispatch path persists full prompt-identity; a later prompt edit cannot rewrite it', async () => {
    const { ctx, primaryId, reviewerId, taskId, includedDecisionIds } = await freshWorkspace();

    const openai = new FakeProvider('openai').reply('Primary draft checklist.').reply('Revised checklist with Stripe step.');
    const anthropic = new FakeProvider('anthropic').reply(REVIEWER_REVISE);
    setProviderOverrideForTests((id) => (id === 'openai' ? openai : id === 'anthropic' ? anthropic : undefined));

    // ---- Drive the REAL production path (no external call, no spend) --------------------------------
    const outcome = await startRun(ctx, taskId);
    expect(outcome.status).toBe('completed');

    // ---- Persisted run identity --------------------------------------------------------------------
    const run = (await db.select().from(runs).where(eq(runs.taskId, taskId)))[0]!;
    const expectedPrimaryCfg = agentExecutionFingerprint({ provider: 'openai', model: 'gpt-x', systemPrompt: PRIMARY_PROMPT_V1, temperatureMilli: 700, maxOutputTokens: 4096, role: 'primary' });
    const expectedReviewerCfg = agentExecutionFingerprint({ provider: 'anthropic', model: 'claude-x', systemPrompt: REVIEWER_PROMPT_V1, temperatureMilli: 500, maxOutputTokens: 4096, role: 'reviewer' });

    expect(run.primaryPromptHash).toBe(sha256Hex(PRIMARY_PROMPT_V1));
    expect(run.reviewerPromptHash).toBe(sha256Hex(REVIEWER_PROMPT_V1));
    expect(run.primaryConfigHash).toBe(expectedPrimaryCfg);
    expect(run.reviewerConfigHash).toBe(expectedReviewerCfg);
    expect(run.primaryEffectivePromptHash).toBeTruthy();
    expect(run.reviewerEffectivePromptHash).toBeTruthy();
    expect(run.assemblerVersion).toBe(ASSEMBLER_VERSION);
    expect(Array.isArray(run.sourceManifest)).toBe(true);

    // ---- Source manifest: content hashes (not just IDs) + deterministic order ----------------------
    const manifest = run.sourceManifest!;
    const kinds = manifest.map((m) => m.kind);
    // Deterministic order: objective first, then the applicable decisions, then the task, then contexts.
    expect(kinds[0]).toBe('objective');
    expect(kinds[kinds.length - 1]).toBe('task'); // no documents seeded → task is last
    const decisionEntries = manifest.filter((m) => m.kind === 'decision');
    expect(decisionEntries.map((m) => m.id).sort()).toEqual(includedDecisionIds); // ONLY applicable decisions
    expect(decisionEntries.every((m) => m.scope && m.hash)).toBe(true);
    // Objective entry hashes an immutable snapshot INCLUDING criterion label + target + unit.
    const objectiveEntry = manifest.find((m) => m.kind === 'objective')!;
    const expectedObjectiveHash = sha256Hex(
      JSON.stringify({ title: OBJECTIVE_TITLE, criteria: [{ label: CRITERION_LABEL, target: CRITERION_TARGET, unit: CRITERION_UNIT }] }),
    );
    expect(objectiveEntry.hash).toBe(expectedObjectiveHash);
    // Task entry hashes the task instructions.
    expect(manifest.find((m) => m.kind === 'task')!.hash).toBe(sha256Hex(TASK_INPUT));

    // ---- Per-step effective-prompt hashes (revision identity) --------------------------------------
    const steps = await db.select().from(runSteps).where(eq(runSteps.runId, run.id)).orderBy(asc(runSteps.stepNumber));
    expect(steps.map((s) => s.kind)).toEqual(['primary', 'review', 'revision', 'consolidate']);
    const [primaryStep, reviewStep, revisionStep, consolidateStep] = steps;
    expect(primaryStep!.effectivePromptHash).toBeTruthy();
    expect(reviewStep!.effectivePromptHash).toBeTruthy();
    expect(revisionStep!.effectivePromptHash).toBeTruthy();
    expect(consolidateStep!.effectivePromptHash).toBeNull(); // deterministic assembly, no model request
    // Each dispatched step has a DISTINCT identity — the revision is not the initial primary request…
    const distinct = new Set([primaryStep!.effectivePromptHash, reviewStep!.effectivePromptHash, revisionStep!.effectivePromptHash]);
    expect(distinct.size).toBe(3);
    // …and the run-level primaryEffectivePromptHash identifies the INITIAL primary request, NOT the revision.
    expect(run.primaryEffectivePromptHash).not.toBe(revisionStep!.effectivePromptHash);

    // ---- Layers appear exactly once; retrieved context stays inside the untrusted boundary ----------
    const primaryReq = openai.requests[0]!;
    const primaryTurn = primaryReq.turns.map((t) => t.content).join('\n');
    expect((primaryTurn.match(/CURRENT OPERATING PRIORITIES/g) ?? []).length).toBe(1); // priorities once
    expect(primaryReq.system).toContain(PRIMARY_PROMPT_V1); // employee authority once, in the system string
    expect(primaryTurn).toContain(OBJECTIVE_TITLE);
    expect(primaryTurn).toContain(CRITERION_LABEL);
    // The trusted objective criterion sits OUTSIDE any untrusted-context wrapper.
    const untrustedIdx = primaryTurn.indexOf('<untrusted-context>');
    if (untrustedIdx >= 0) expect(primaryTurn.indexOf(CRITERION_LABEL)).toBeLessThan(untrustedIdx);
    // Reviewer payload carries the same priorities exactly once (parity).
    const reviewerTurn = anthropic.requests[0]!.turns.map((t) => t.content).join('\n');
    expect((reviewerTurn.match(/CURRENT OPERATING PRIORITIES/g) ?? []).length).toBe(1);

    // ---- Applicable Decisions present; unrelated + non-accepted absent -----------------------------
    const primaryAll = primaryReq.system + '\n' + primaryTurn;
    expect(primaryAll).toContain(WS_MARKER);
    expect(primaryAll).toContain(OBJ_MARKER);
    expect(primaryAll).toContain(TASK_MARKER);
    expect(primaryAll).not.toContain(UNRELATED_MARKER);
    expect(primaryAll).not.toContain(PROPOSED_MARKER);

    // ---- No audit event fires merely for assembling/reading prompt identity ------------------------
    const actions = (await db.select({ a: auditLogs.action }).from(auditLogs).where(and(eq(auditLogs.projectId, ctx.projectId), eq(auditLogs.entityId, run.id)))).map((r) => r.a);
    expect(actions).toContain('run.started');
    expect(actions.some((a) => /prompt.*(assembl|read)/i.test(a))).toBe(false);
    expect(actions).not.toContain('employee.prompt_updated'); // running a task never edits a prompt

    // ---- IMMUTABILITY: edit BOTH employee prompts, then re-read the existing run --------------------
    const before = {
      primaryPromptHash: run.primaryPromptHash,
      reviewerPromptHash: run.reviewerPromptHash,
      primaryConfigHash: run.primaryConfigHash,
      reviewerConfigHash: run.reviewerConfigHash,
      primaryEffectivePromptHash: run.primaryEffectivePromptHash,
      reviewerEffectivePromptHash: run.reviewerEffectivePromptHash,
      assemblerVersion: run.assemblerVersion,
      sourceManifest: JSON.stringify(run.sourceManifest),
      stepHashes: steps.map((s) => s.effectivePromptHash),
    };
    const editedPrimary = await withTenant(ctx, (tx) => updateEmployeePrompt(tx, ctx, primaryId, { systemPrompt: 'EDITED primary prompt v2 — different.' }, 'align to active objective'));
    const editedReviewer = await withTenant(ctx, (tx) => updateEmployeePrompt(tx, ctx, reviewerId, { systemPrompt: 'EDITED reviewer prompt v2 — different.' }, 'sharpen review'));
    expect(editedPrimary).toBe(true);
    expect(editedReviewer).toBe(true);

    const runAfter = (await db.select().from(runs).where(eq(runs.id, run.id)))[0]!;
    const stepsAfter = await db.select().from(runSteps).where(eq(runSteps.runId, run.id)).orderBy(asc(runSteps.stepNumber));
    expect(runAfter.primaryPromptHash).toBe(before.primaryPromptHash);
    expect(runAfter.reviewerPromptHash).toBe(before.reviewerPromptHash);
    expect(runAfter.primaryConfigHash).toBe(before.primaryConfigHash);
    expect(runAfter.reviewerConfigHash).toBe(before.reviewerConfigHash);
    expect(runAfter.primaryEffectivePromptHash).toBe(before.primaryEffectivePromptHash);
    expect(runAfter.reviewerEffectivePromptHash).toBe(before.reviewerEffectivePromptHash);
    expect(runAfter.assemblerVersion).toBe(before.assemblerVersion);
    expect(JSON.stringify(runAfter.sourceManifest)).toBe(before.sourceManifest);
    expect(stepsAfter.map((s) => s.effectivePromptHash)).toEqual(before.stepHashes);
    // And the run's stored config hash no longer equals the agent's NEW fingerprint (proof it wasn't rewritten).
    const newPrimaryCfg = agentExecutionFingerprint({ provider: 'openai', model: 'gpt-x', systemPrompt: 'EDITED primary prompt v2 — different.', temperatureMilli: 700, maxOutputTokens: 4096, role: 'primary' });
    expect(runAfter.primaryConfigHash).not.toBe(newPrimaryCfg);
  });

  it('a run with review disabled records primary identity and null reviewer identity', async () => {
    const { ctx, primaryId } = await freshWorkspace();
    // A fresh single-provider task without review, pinned to the enabled openai primary (P1a).
    const soloTaskId = (await db
      .insert(tasks)
      .values({ orgId, projectId: ctx.projectId, title: 'Solo', input: 'Do a small thing.', providerSelection: 'openai', reviewEnabled: false, status: 'pending', createdBy: ctx.userId, assignedPrimaryAgentId: primaryId })
      .returning({ id: tasks.id }))[0]!.id;
    const openai = new FakeProvider('openai').reply('Solo answer.');
    setProviderOverrideForTests((id) => (id === 'openai' ? openai : undefined));

    const outcome = await startRun(ctx, soloTaskId);
    expect(outcome.status).toBe('completed');

    const run = (await db.select().from(runs).where(eq(runs.taskId, soloTaskId)))[0]!;
    expect(run.primaryEffectivePromptHash).toBeTruthy();
    expect(run.primaryConfigHash).toBeTruthy();
    expect(run.reviewerEffectivePromptHash).toBeNull();
    expect(run.reviewerConfigHash).toBeNull();
    expect(run.assemblerVersion).toBe(ASSEMBLER_VERSION);

    const steps = await db.select().from(runSteps).where(eq(runSteps.runId, run.id)).orderBy(asc(runSteps.stepNumber));
    expect(steps.map((s) => s.kind)).toEqual(['primary', 'consolidate']);
    expect(steps[0]!.effectivePromptHash).toBeTruthy();
    expect(steps[1]!.effectivePromptHash).toBeNull();
  });
});
