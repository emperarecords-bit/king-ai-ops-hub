import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type ContextManifestEntry, type TenantContext } from '@/types/domain';
import { getDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { agents, decisions, memberships, organizations, profiles, projectMembers, projects, runs, tasks } from '@/db/schema';
import { acceptDecision, assembleDecisionMemory, listCandidatesForTask } from '@/domain/decisions/decisions';
import { extractCandidatesForRun } from '@/domain/decisions/extraction';

/**
 * Extraction orchestration (O-20): idempotency, fail-safe, isolation, and the
 * end-to-end "candidate → accept → Decision Memory" path — against real
 * Postgres with an injected fake extractor (no live provider).
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[decision-extraction.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

let orgId = '';
let userId = '';
let ctx: TenantContext;

async function completedRun(title: string, consolidated: string, manifest: ContextManifestEntry[] = []): Promise<{ taskId: string; runId: string }> {
  const db = getDb();
  const t = await db.insert(tasks).values({ orgId, projectId: ctx.projectId, title, input: 'x', providerSelection: 'openai', status: 'completed', createdBy: userId }).returning({ id: tasks.id });
  const r = await db
    .insert(runs)
    .values({ orgId, projectId: ctx.projectId, taskId: t[0]!.id, status: 'completed', primaryAgentId: agentId, consolidatedResult: consolidated, contextManifest: manifest })
    .returning({ id: runs.id });
  return { taskId: t[0]!.id, runId: r[0]!.id };
}

let agentId = '';

beforeAll(async () => {
  if (!available) return;
  const db = getDb();
  userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `ext-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Owner' });
  const org = await db.insert(organizations).values({ name: 'Ext Org', slug: `ext-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  const p = await db.insert(projects).values({ orgId, key: fixtureKey('ext'), name: 'Ext Project' }).returning({ id: projects.id });
  await db.insert(projectMembers).values({ orgId, projectId: p[0]!.id, userId, role: 'admin' });
  ctx = { userId, orgId, projectId: p[0]!.id, orgRole: 'owner', projectRole: 'admin' };
  const a = await db.insert(agents).values({ orgId, projectId: ctx.projectId, name: 'Primary', role: 'primary', provider: 'openai', model: 'gpt-5.4-mini', systemPrompt: 'x' }).returning({ id: agents.id });
  agentId = a[0]!.id;
});

afterAll(async () => {
  if (!available) return;
  await getDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});

const fakeExtract = (json: string) => async () => json;

describe.skipIf(!available)('decision extraction orchestration', () => {
  it('Test 1 — a clear decision → one proposed AI candidate; not in memory until accepted', async () => {
    const { taskId, runId } = await completedRun(
      'runtime run',
      'Conclusion: Episode 1 runtime is approved and locked at 22:00.',
    );
    const saved = await withTenant(ctx, (tx) =>
      extractCandidatesForRun(tx, ctx, runId, fakeExtract(JSON.stringify({ candidates: [
        { title: 'Episode 1 runtime locked at 22:00', summary: 'Runtime approved and locked at 22:00.', decisionType: 'creative', supportingRefs: [], confidence: 'high', evidence: 'explicit conclusion' },
      ] }))),
    );
    expect(saved).toBe(1);

    const cands = await withTenant(ctx, (tx) => listCandidatesForTask(tx, ctx, taskId));
    expect(cands).toHaveLength(1);
    expect(cands[0]!.suggestedByRunId).toBe(runId);

    // Not in Decision Memory yet (proposed, not accepted).
    const other = await completedRun('later run', 'unrelated');
    let mem = await withTenant(ctx, (tx) =>
      assembleDecisionMemory(tx, ctx, { currentTaskId: other.taskId, objectiveTaskIds: [], docPaths: new Set() }),
    );
    expect(mem.contextItem?.content ?? '').not.toContain('runtime locked at 22:00');

    // Accept → now it IS in Decision Memory.
    await withTenant(ctx, (tx) => acceptDecision(tx, ctx, cands[0]!.id));
    mem = await withTenant(ctx, (tx) =>
      assembleDecisionMemory(tx, ctx, { currentTaskId: other.taskId, objectiveTaskIds: [], docPaths: new Set() }),
    );
    expect(mem.contextItem?.content).toContain('runtime locked at 22:00');
  });

  it('idempotency — a second extraction on the same run adds nothing', async () => {
    const { taskId, runId } = await completedRun('idem run', 'Conclusion: Dialogue pass approved.');
    const one = JSON.stringify({ candidates: [{ title: 'Dialogue pass approved', summary: 'Approved.', decisionType: 'creative', supportingRefs: [], confidence: 'medium' }] });
    const first = await withTenant(ctx, (tx) => extractCandidatesForRun(tx, ctx, runId, fakeExtract(one)));
    const second = await withTenant(ctx, (tx) => extractCandidatesForRun(tx, ctx, runId, fakeExtract(one)));
    expect(first).toBe(1);
    expect(second).toBe(0); // guarded by candidate_extraction_status
    const cands = await withTenant(ctx, (tx) => listCandidatesForTask(tx, ctx, taskId));
    expect(cands).toHaveLength(1);
  });

  it('Test 6 — a failing extractor leaves the task completed, records failure, saves nothing', async () => {
    const { taskId, runId } = await completedRun('fail run', 'Conclusion: canon rule established.');
    const boom = async () => {
      throw new Error('provider exploded');
    };
    const saved = await withTenant(ctx, (tx) => extractCandidatesForRun(tx, ctx, runId, boom));
    expect(saved).toBe(0);

    const db = getDb();
    const run = (await db.select().from(runs).where(eq(runs.id, runId)).limit(1))[0]!;
    expect(run.status).toBe('completed'); // task/run untouched
    expect(run.consolidatedResult).toContain('canon rule established');
    expect(run.candidateExtractionStatus).toBe('failed');
    const cands = await withTenant(ctx, (tx) => listCandidatesForTask(tx, ctx, taskId));
    expect(cands).toEqual([]);
  });

  it('malformed extractor output records "failed" or empty and saves no candidate', async () => {
    const { taskId, runId } = await completedRun('malformed run', 'Conclusion: pipeline changed.');
    const saved = await withTenant(ctx, (tx) => extractCandidatesForRun(tx, ctx, runId, fakeExtract('garbage {not json')));
    expect(saved).toBe(0);
    const cands = await withTenant(ctx, (tx) => listCandidatesForTask(tx, ctx, taskId));
    expect(cands).toEqual([]);
  });

  it('the AI can never self-approve: a candidate is always saved as proposed', async () => {
    const { taskId, runId } = await completedRun('sneaky run', 'Conclusion: visual design frozen.');
    // Even if the model tries to claim status, extraction hardcodes proposed.
    await withTenant(ctx, (tx) =>
      extractCandidatesForRun(tx, ctx, runId, fakeExtract(JSON.stringify({ candidates: [
        { title: 'Visual design frozen', summary: 'Frozen.', decisionType: 'creative', supportingRefs: [], confidence: 'high' },
      ] }))),
    );
    const db = getDb();
    const rows = await db.select({ status: decisions.status, authorLabel: decisions.authorLabel }).from(decisions).where(and(eq(decisions.originatingTaskId, taskId)));
    expect(rows.every((r) => r.status === 'proposed')).toBe(true);
    expect(rows[0]!.authorLabel).toBe('AI suggestion');
  });
});
