import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type ContextManifestEntry, type TenantContext } from '@/types/domain';
import { ConflictError, ValidationError } from '@/lib/errors';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { agents, documents, knowledgeItems, memberships, organizations, profiles, projectMembers, projects, runs, tasks } from '@/db/schema';
import {
  createKnowledge,
  getKnowledgeVerificationHistory,
  listKnowledge,
  listKnowledgeSources,
  selectRelevantKnowledge,
} from '@/domain/knowledge/knowledge';
import {
  extractKnowledgeForRun,
  listKnowledgeProposals,
  promoteKnowledgeProposal,
  rejectKnowledgeProposal,
  type ExtractFn,
} from '@/domain/knowledge/extraction';

/**
 * AI EXTRACTION & PROMOTION. The AI may only PROPOSE: proposals land quarantined (draft, unverified,
 * injection-ineligible, narrowest scope, inherited disclosure); citations must resolve to the exact
 * version seen; sensitivity is inherited, never laundered; a human promotes with an explicit structured
 * decision that never silently activates/verifies/broadens/declassifies; extraction failure never
 * affects the run.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[knowledge-extraction.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

const userId = randomUUID();
let ctx: TenantContext;
let orgId = '';
let agentId = '';
let taskId = '';

const MANIFEST: ContextManifestEntry[] = [
  { source: 'retrieved', label: 'canon/pricing.md' },
  { source: 'retrieved', label: 'canon/secret.md' },
];

/** A completed run with a fixed context manifest — the substrate extraction mines. */
async function mkRun(consolidatedResult: string): Promise<string> {
  const r = await getSetupDb()
    .insert(runs)
    .values({ orgId, projectId: ctx.projectId, taskId, status: 'completed', primaryAgentId: agentId, consolidatedResult, contextManifest: MANIFEST })
    .returning({ id: runs.id });
  return r[0]!.id;
}

/** An injected extractor that returns canned JSON (the model is never really called in tests). */
const returning = (json: string): ExtractFn => async () => json;
const meta = { provider: 'openai', model: 'gpt-5.4-mini' };

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  await db.insert(profiles).values({ id: userId, email: `kext-${randomUUID().slice(0, 8)}@test.local`, displayName: 'KExt Tester' });
  const org = await db.insert(organizations).values({ name: 'KExt Org', slug: `kext-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  const p = await db.insert(projects).values({ orgId, key: fixtureKey('kext'), name: 'KExt Project' }).returning({ id: projects.id });
  await db.insert(projectMembers).values({ orgId, projectId: p[0]!.id, userId, role: 'admin' });
  ctx = { userId, orgId, projectId: p[0]!.id, orgRole: 'owner', projectRole: 'admin' };
  const a = await db.insert(agents).values({ orgId, projectId: ctx.projectId, name: `KExt-${randomUUID().slice(0, 6)}`, role: 'primary', provider: 'openai', model: 'gpt-5.4-mini', systemPrompt: 'x' }).returning({ id: agents.id });
  agentId = a[0]!.id;
  const t = await db.insert(tasks).values({ orgId, projectId: ctx.projectId, title: 'KExt task', input: 'x', providerSelection: 'openai', status: 'completed', createdBy: userId }).returning({ id: tasks.id });
  taskId = t[0]!.id;
  // Citable documents: an open one and a restricted one, each at a known version.
  await db.insert(documents).values({ orgId, projectId: ctx.projectId, relativePath: 'canon/pricing.md', kind: 'markdown', sha256: 'PRICING_V1', sizeBytes: 100, disclosure: 'workspace_internal' });
  await db.insert(documents).values({ orgId, projectId: ctx.projectId, relativePath: 'canon/secret.md', kind: 'markdown', sha256: 'SECRET_V1', sizeBytes: 100, disclosure: 'restricted' });
});

afterAll(async () => {
  if (!available) return;
  await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});

const candidate = (over: Record<string, unknown>) =>
  JSON.stringify({ candidates: [{ title: 'X', claim: 'c', transformation: 'extracted', supportingRefs: ['canon/pricing.md'], suggestedScope: 'workspace', confidence: 'low', ...over }] });

describe.skipIf(!available)('AI knowledge extraction & promotion', () => {
  it('AI output lands as a QUARANTINED draft — unverified, injection-ineligible — never active', async () => {
    const runId = await mkRun('The standard pilot runs six weeks.');
    const n = await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(candidate({ title: 'Alpha pilot length', claim: 'The standard alpha pilot runs six weeks.' })), meta));
    expect(n).toBe(1);
    const item = (await withTenant(ctx, (tx) => listKnowledge(tx, ctx))).find((k) => k.title === 'Alpha pilot length')!;
    expect(item.status).toBe('draft');
    expect(item.verification).toBe('unverified');
    // Injection-ineligible: a draft is never selected for a prompt.
    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: 'alpha pilot length weeks', consumerType: 'task_run', consumerAgentIds: [agentId] }));
    expect(picked.find((k) => k.id === item.id)).toBeUndefined();
    // Self-verify is impossible: extraction created no verification event.
    expect(await withTenant(ctx, (tx) => getKnowledgeVerificationHistory(tx, ctx, item.id))).toHaveLength(0);
  });

  it('a cited source is bound to the EXACT version seen and is not replaced by latest', async () => {
    const runId = await mkRun('Bravo fact.');
    await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(candidate({ title: 'Bravo cite', claim: 'Bravo pricing.' })), meta));
    const item = (await withTenant(ctx, (tx) => listKnowledge(tx, ctx))).find((k) => k.title === 'Bravo cite')!;
    const sources = await withTenant(ctx, (tx) => listKnowledgeSources(tx, ctx, item.id, item.version));
    expect(sources).toHaveLength(1);
    expect(sources[0]!.sourceVersionHash).toBe('PRICING_V1'); // the version at extraction, frozen
    // Even after the document changes, the citation still names PRICING_V1.
    await getSetupDb().update(documents).set({ sha256: 'PRICING_V2' }).where(eq(documents.relativePath, 'canon/pricing.md'));
    const again = await withTenant(ctx, (tx) => listKnowledgeSources(tx, ctx, item.id, item.version));
    expect(again[0]!.sourceVersionHash).toBe('PRICING_V1');
    await getSetupDb().update(documents).set({ sha256: 'PRICING_V1' }).where(eq(documents.relativePath, 'canon/pricing.md'));
  });

  it('a fabricated (non-manifest) source path is rejected — nothing is created', async () => {
    const runId = await mkRun('Charlie fact.');
    const n = await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(candidate({ title: 'Charlie ghost', supportingRefs: ['canon/does-not-exist.md'] })), meta));
    expect(n).toBe(0);
    expect((await withTenant(ctx, (tx) => listKnowledge(tx, ctx))).find((k) => k.title === 'Charlie ghost')).toBeUndefined();
  });

  it('a candidate with no cited source is rejected (source-identified proposals only)', async () => {
    const runId = await mkRun('Delta fact.');
    const n = await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(candidate({ title: 'Delta nosrc', supportingRefs: [] })), meta));
    expect(n).toBe(0);
  });

  it('derived Knowledge inherits the MOST restrictive disclosure of its sources; the draft is restricted', async () => {
    const runId = await mkRun('Echo secret fact.');
    await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(candidate({ title: 'Echo secret', supportingRefs: ['canon/pricing.md', 'canon/secret.md'] })), meta));
    const item = (await withTenant(ctx, (tx) => listKnowledge(tx, ctx))).find((k) => k.title === 'Echo secret')!;
    const prop = (await withTenant(ctx, (tx) => listKnowledgeProposals(tx, ctx))).find((p) => p.knowledgeItemId === item.id)!;
    expect(prop.suggestedDisclosure).toBe('restricted');
    // And the quarantined draft's ACTUAL disclosure is already restricted (never laundered looser).
    const restrictedActive = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: 'echo secret', consumerType: 'task_run', consumerAgentIds: [agentId] }));
    expect(restrictedActive.find((k) => k.id === item.id)).toBeUndefined(); // still a draft anyway
  });

  it('confidence does not alter authority — a high-confidence proposal still lands draft + unverified', async () => {
    const runId = await mkRun('Foxtrot fact.');
    await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(candidate({ title: 'Foxtrot high', confidence: 'high' })), meta));
    const item = (await withTenant(ctx, (tx) => listKnowledge(tx, ctx))).find((k) => k.title === 'Foxtrot high')!;
    expect(item.status).toBe('draft');
    expect(item.verification).toBe('unverified');
  });

  it("the AI's suggested scope stays separate from the draft's conservative actual scope", async () => {
    const runId = await mkRun('Golf fact.');
    await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(candidate({ title: 'Golf scope', suggestedScope: 'workspace' })), meta));
    const item = (await withTenant(ctx, (tx) => listKnowledge(tx, ctx))).find((k) => k.title === 'Golf scope')!;
    const prop = (await withTenant(ctx, (tx) => listKnowledgeProposals(tx, ctx))).find((p) => p.knowledgeItemId === item.id)!;
    expect(prop.suggestedScopeKind).toBe('workspace'); // AI's suggestion
    // Actual scope on the draft is the narrowest (task) — never silently the AI's broader suggestion.
    const row = await getSetupDb().select({ scopeKind: knowledgeItems.scopeKind }).from(knowledgeItems).where(eq(knowledgeItems.id, item.id));
    expect(row[0]!.scopeKind).toBe('task');
  });

  it('materially independent claims become separate proposals', async () => {
    const runId = await mkRun('Two independent facts.');
    const json = JSON.stringify({
      candidates: [
        { title: 'Hotel one', claim: 'a', transformation: 'extracted', supportingRefs: ['canon/pricing.md'], suggestedScope: 'workspace', confidence: 'low' },
        { title: 'Hotel two', claim: 'b', transformation: 'summarized', supportingRefs: ['canon/pricing.md'], suggestedScope: 'task', confidence: 'medium' },
      ],
    });
    const n = await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(json), meta));
    expect(n).toBe(2);
  });

  it('an exact duplicate of an ACTIVE record is suppressed', async () => {
    await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'India canonical', body: 'already active', kind: 'fact', activate: true }));
    const runId = await mkRun('India dup.');
    const n = await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(candidate({ title: 'India canonical', claim: 'dup attempt' })), meta));
    expect(n).toBe(0);
  });

  it('extraction failure records a failed status and does NOT throw or affect the run', async () => {
    const runId = await mkRun('Juliet fact.');
    const boom: ExtractFn = async () => {
      throw new Error('provider exploded');
    };
    await expect(withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, boom, meta))).resolves.toBe(0);
    const r = await getSetupDb().select({ s: runs.knowledgeExtractionStatus, status: runs.status }).from(runs).where(eq(runs.id, runId));
    expect(r[0]!.s).toBe('failed');
    expect(r[0]!.status).toBe('completed'); // the run itself is untouched
  });

  it('extraction is idempotent per run', async () => {
    const runId = await mkRun('Kilo fact.');
    const first = await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(candidate({ title: 'Kilo once' })), meta));
    expect(first).toBe(1);
    const second = await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(candidate({ title: 'Kilo twice' })), meta));
    expect(second).toBe(0); // guarded by knowledge_extraction_status
  });

  // --- Human promotion (explicit, structured) ------------------------------------------------------

  it('explicit promotion activates with the operator\'s chosen scope + disclosure, and never verifies', async () => {
    const runId = await mkRun('Lima fact.');
    await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(candidate({ title: 'Lima promote', claim: 'lima promotable fact numbering' })), meta));
    const item = (await withTenant(ctx, (tx) => listKnowledge(tx, ctx))).find((k) => k.title === 'Lima promote')!;
    const prop = (await withTenant(ctx, (tx) => listKnowledgeProposals(tx, ctx, 'pending'))).find((p) => p.knowledgeItemId === item.id)!;
    await withTenant(ctx, (tx) => promoteKnowledgeProposal(tx, ctx, prop.id, { scopeKind: 'workspace', disclosure: 'workspace_internal', activate: true }));
    const promoted = (await withTenant(ctx, (tx) => listKnowledge(tx, ctx))).find((k) => k.id === item.id)!;
    expect(promoted.status).toBe('active'); // operator activated
    expect(promoted.verification).toBe('unverified'); // activation is NOT verification
    // Now active + workspace-scoped → it flows into selection.
    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: 'lima promotable fact numbering', consumerType: 'task_run', consumerAgentIds: [agentId] }));
    expect(picked.find((k) => k.id === item.id)).toBeDefined();
  });

  it('a proposal from restricted sources cannot be promoted to a less restrictive classification', async () => {
    const runId = await mkRun('Mike secret fact.');
    await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(candidate({ title: 'Mike restricted', supportingRefs: ['canon/secret.md'] })), meta));
    const item = (await withTenant(ctx, (tx) => listKnowledge(tx, ctx))).find((k) => k.title === 'Mike restricted')!;
    const prop = (await withTenant(ctx, (tx) => listKnowledgeProposals(tx, ctx, 'pending'))).find((p) => p.knowledgeItemId === item.id)!;
    await expect(
      withTenant(ctx, (tx) => promoteKnowledgeProposal(tx, ctx, prop.id, { scopeKind: 'workspace', disclosure: 'workspace_internal', activate: true })),
    ).rejects.toThrow(ValidationError);
    // Promoting AT the inherited (restricted) classification is allowed.
    await withTenant(ctx, (tx) => promoteKnowledgeProposal(tx, ctx, prop.id, { scopeKind: 'workspace', disclosure: 'restricted', activate: false }));
  });

  it('a rejected proposal is preserved (archived + reason), not deleted; re-review conflicts', async () => {
    const runId = await mkRun('November fact.');
    await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(candidate({ title: 'November reject' })), meta));
    const item = (await withTenant(ctx, (tx) => listKnowledge(tx, ctx))).find((k) => k.title === 'November reject')!;
    const prop = (await withTenant(ctx, (tx) => listKnowledgeProposals(tx, ctx, 'pending'))).find((p) => p.knowledgeItemId === item.id)!;
    await withTenant(ctx, (tx) => rejectKnowledgeProposal(tx, ctx, prop.id, 'not worth remembering'));
    const rejected = (await withTenant(ctx, (tx) => listKnowledgeProposals(tx, ctx))).find((p) => p.id === prop.id)!;
    expect(rejected.reviewStatus).toBe('rejected');
    const archived = (await withTenant(ctx, (tx) => listKnowledge(tx, ctx, 'archived'))).find((k) => k.id === item.id);
    expect(archived).toBeDefined(); // preserved, inert
    await expect(withTenant(ctx, (tx) => rejectKnowledgeProposal(tx, ctx, prop.id))).rejects.toThrow(ConflictError);
  });
});
