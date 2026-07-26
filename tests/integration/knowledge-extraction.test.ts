import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type RunSourceSnapshot, type TenantContext } from '@/types/domain';
import { ConflictError, ValidationError } from '@/lib/errors';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { agents, auditLogs, documents, knowledgeItems, memberships, organizations, profiles, projectMembers, projects, runs, tasks } from '@/db/schema';
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
  reviseKnowledgeProposalDraft,
  type ExtractFn,
} from '@/domain/knowledge/extraction';
import { declassifyDocument, restrictDocument } from '@/domain/documents/documents';

/**
 * AI EXTRACTION & PROMOTION + SOURCE INTEGRITY. The AI may only PROPOSE (quarantined draft, unverified,
 * injection-ineligible, narrowest scope, inherited disclosure). Citations are validated against the
 * run's IMMUTABLE source snapshot — the exact version + classification + excerpt the run received —
 * never live documents. Excerpts are validated; unverifiable precision is dropped. A human promotes
 * with an explicit structured decision that never silently activates/verifies/broadens/declassifies.
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

/** The IMMUTABLE evidence supplied to the run — an open doc and a restricted doc, at known versions. */
const SNAPSHOT: RunSourceSnapshot[] = [
  { relativePath: 'canon/pricing.md', sha256: 'PRICING_V1', disclosure: 'workspace_internal', chunkIndex: 0, rank: 1, excerpt: 'The standard alpha pilot runs six weeks and then converts.' },
  { relativePath: 'canon/secret.md', sha256: 'SECRET_V1', disclosure: 'restricted', chunkIndex: 0, rank: 1, excerpt: 'Confidential margin figures are recorded here.' },
];

async function mkRun(consolidatedResult: string, snapshot: RunSourceSnapshot[] = SNAPSHOT): Promise<string> {
  const r = await getSetupDb()
    .insert(runs)
    .values({ orgId, projectId: ctx.projectId, taskId, status: 'completed', primaryAgentId: agentId, consolidatedResult, retrievedSources: snapshot })
    .returning({ id: runs.id });
  return r[0]!.id;
}

const returning = (json: string): ExtractFn => async () => json;
const meta = { provider: 'openai', model: 'gpt-5.4-mini' };
const candidate = (over: Record<string, unknown>) =>
  JSON.stringify({ candidates: [{ title: 'X', claim: 'c', transformation: 'extracted', supportingRefs: [{ path: 'canon/pricing.md' }], suggestedScope: 'workspace', confidence: 'low', ...over }] });

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
});

afterAll(async () => {
  if (!available) return;
  await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});

describe.skipIf(!available)('AI knowledge extraction & promotion', () => {
  it('AI output lands as a QUARANTINED draft — unverified, injection-ineligible — never active', async () => {
    const runId = await mkRun('The standard pilot runs six weeks.');
    const n = await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(candidate({ title: 'Alpha pilot length', claim: 'The standard alpha pilot runs six weeks.' })), meta));
    expect(n).toBe(1);
    const item = (await withTenant(ctx, (tx) => listKnowledge(tx, ctx))).find((k) => k.title === 'Alpha pilot length')!;
    expect(item.status).toBe('draft');
    expect(item.verification).toBe('unverified');
    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: 'alpha pilot length weeks', consumerType: 'task_run', consumerAgentIds: [agentId] }));
    expect(picked.find((k) => k.id === item.id)).toBeUndefined();
    expect(await withTenant(ctx, (tx) => getKnowledgeVerificationHistory(tx, ctx, item.id))).toHaveLength(0);
  });

  it('citations use the RUN-SNAPSHOT version, not live document state', async () => {
    // The live document is at V2, but the run snapshot recorded V1 — extraction must cite V1.
    await getSetupDb().insert(documents).values({ orgId, projectId: ctx.projectId, relativePath: 'canon/pricing.md', kind: 'markdown', sha256: 'PRICING_V2', sizeBytes: 100, disclosure: 'workspace_internal' });
    const runId = await mkRun('Bravo fact.');
    await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(candidate({ title: 'Bravo cite', claim: 'Bravo pricing.' })), meta));
    const item = (await withTenant(ctx, (tx) => listKnowledge(tx, ctx))).find((k) => k.title === 'Bravo cite')!;
    const sources = await withTenant(ctx, (tx) => listKnowledgeSources(tx, ctx, item.id, item.version));
    expect(sources).toHaveLength(1);
    expect(sources[0]!.sourceVersionHash).toBe('PRICING_V1'); // the version the RUN saw, not live V2
    await getSetupDb().delete(documents).where(eq(documents.relativePath, 'canon/pricing.md'));
  });

  it('a citation to a path NOT in the run snapshot (fabricated / artifact / output) is rejected', async () => {
    const runId = await mkRun('Charlie fact.');
    const fabricated = await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(candidate({ title: 'Charlie ghost', supportingRefs: [{ path: 'canon/does-not-exist.md' }] })), meta));
    expect(fabricated).toBe(0);
    const runId2 = await mkRun('Charlie artifact.');
    const artifactRef = await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId2, returning(candidate({ title: 'Charlie artifact', supportingRefs: [{ path: randomUUID() }] })), meta));
    expect(artifactRef).toBe(0); // v1 cites documents only — an artifact-like id is not in the snapshot
  });

  it('a candidate with no cited source is rejected (source-identified proposals only)', async () => {
    const runId = await mkRun('Delta fact.');
    const n = await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(candidate({ title: 'Delta nosrc', supportingRefs: [] })), meta));
    expect(n).toBe(0);
  });

  it('a valid verbatim quote is persisted as the locator; a fabricated quote is dropped but the source kept', async () => {
    const runId = await mkRun('Echo quotes.');
    const json = JSON.stringify({
      candidates: [
        { title: 'Echo good quote', claim: 'pilot length', transformation: 'extracted', supportingRefs: [{ path: 'canon/pricing.md', quote: 'runs six weeks' }], suggestedScope: 'workspace', confidence: 'low' },
        { title: 'Echo bad quote', claim: 'pilot length', transformation: 'extracted', supportingRefs: [{ path: 'canon/pricing.md', quote: 'runs eleven weeks' }], suggestedScope: 'workspace', confidence: 'low' },
      ],
    });
    const n = await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(json), meta));
    expect(n).toBe(2);
    const good = (await withTenant(ctx, (tx) => listKnowledge(tx, ctx))).find((k) => k.title === 'Echo good quote')!;
    const bad = (await withTenant(ctx, (tx) => listKnowledge(tx, ctx))).find((k) => k.title === 'Echo bad quote')!;
    const goodSrc = await withTenant(ctx, (tx) => listKnowledgeSources(tx, ctx, good.id, good.version));
    const badSrc = await withTenant(ctx, (tx) => listKnowledgeSources(tx, ctx, bad.id, bad.version));
    expect(goodSrc[0]!.locator).toBe('runs six weeks'); // validated verbatim excerpt persisted
    expect(badSrc).toHaveLength(1); // source relationship retained
    expect(badSrc[0]!.locator).toBeNull(); // fabricated precision dropped
  });

  it('derived Knowledge inherits the MOST restrictive disclosure of its snapshot sources', async () => {
    const runId = await mkRun('Foxtrot secret fact.');
    await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(candidate({ title: 'Foxtrot secret', supportingRefs: [{ path: 'canon/pricing.md' }, { path: 'canon/secret.md' }] })), meta));
    const item = (await withTenant(ctx, (tx) => listKnowledge(tx, ctx))).find((k) => k.title === 'Foxtrot secret')!;
    const prop = (await withTenant(ctx, (tx) => listKnowledgeProposals(tx, ctx))).find((p) => p.knowledgeItemId === item.id)!;
    expect(prop.suggestedDisclosure).toBe('restricted');
  });

  it('confidence does not alter authority — a high-confidence proposal still lands draft + unverified', async () => {
    const runId = await mkRun('Golf fact.');
    await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(candidate({ title: 'Golf high', confidence: 'high' })), meta));
    const item = (await withTenant(ctx, (tx) => listKnowledge(tx, ctx))).find((k) => k.title === 'Golf high')!;
    expect(item.status).toBe('draft');
    expect(item.verification).toBe('unverified');
  });

  it("the AI's suggested scope stays separate from the draft's conservative actual scope", async () => {
    const runId = await mkRun('Hotel fact.');
    await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(candidate({ title: 'Hotel scope', suggestedScope: 'workspace' })), meta));
    const item = (await withTenant(ctx, (tx) => listKnowledge(tx, ctx))).find((k) => k.title === 'Hotel scope')!;
    const prop = (await withTenant(ctx, (tx) => listKnowledgeProposals(tx, ctx))).find((p) => p.knowledgeItemId === item.id)!;
    expect(prop.suggestedScopeKind).toBe('workspace');
    const row = await getSetupDb().select({ scopeKind: knowledgeItems.scopeKind }).from(knowledgeItems).where(eq(knowledgeItems.id, item.id));
    expect(row[0]!.scopeKind).toBe('task'); // narrowest actual — never silently the AI's broader suggestion
  });

  it('materially independent claims become separate proposals', async () => {
    const runId = await mkRun('Two facts.');
    const json = JSON.stringify({
      candidates: [
        { title: 'India one', claim: 'a', transformation: 'extracted', supportingRefs: [{ path: 'canon/pricing.md' }], suggestedScope: 'workspace', confidence: 'low' },
        { title: 'India two', claim: 'b', transformation: 'summarized', supportingRefs: [{ path: 'canon/pricing.md' }], suggestedScope: 'task', confidence: 'medium' },
      ],
    });
    expect(await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(json), meta))).toBe(2);
  });

  it('an exact duplicate of an ACTIVE record is suppressed', async () => {
    await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Juliet canonical', body: 'already active', kind: 'fact', activate: true }));
    const runId = await mkRun('Juliet dup.');
    expect(await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(candidate({ title: 'Juliet canonical', claim: 'dup attempt' })), meta))).toBe(0);
  });

  it('extraction failure records a failed status and does NOT throw or affect the run', async () => {
    const runId = await mkRun('Kilo fact.');
    const boom: ExtractFn = async () => {
      throw new Error('provider exploded');
    };
    await expect(withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, boom, meta))).resolves.toBe(0);
    const r = await getSetupDb().select({ s: runs.knowledgeExtractionStatus, status: runs.status }).from(runs).where(eq(runs.id, runId));
    expect(r[0]!.s).toBe('failed');
    expect(r[0]!.status).toBe('completed');
  });

  it('extraction is idempotent per run', async () => {
    const runId = await mkRun('Lima fact.');
    expect(await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(candidate({ title: 'Lima once' })), meta))).toBe(1);
    expect(await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(candidate({ title: 'Lima twice' })), meta))).toBe(0);
  });

  // --- Human promotion (explicit, structured) ------------------------------------------------------

  it("explicit promotion activates with the operator's chosen scope + disclosure, and never verifies", async () => {
    const runId = await mkRun('Mike fact.');
    await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(candidate({ title: 'Mike promote', claim: 'Mike promotable pricing pilot conversion numbering scheme.' })), meta));
    const item = (await withTenant(ctx, (tx) => listKnowledge(tx, ctx))).find((k) => k.title === 'Mike promote')!;
    const prop = (await withTenant(ctx, (tx) => listKnowledgeProposals(tx, ctx, 'pending'))).find((p) => p.knowledgeItemId === item.id)!;
    await withTenant(ctx, (tx) => promoteKnowledgeProposal(tx, ctx, prop.id, { scopeKind: 'workspace', disclosure: 'workspace_internal', activate: true }));
    const promoted = (await withTenant(ctx, (tx) => listKnowledge(tx, ctx))).find((k) => k.id === item.id)!;
    expect(promoted.status).toBe('active');
    expect(promoted.verification).toBe('unverified'); // activation is NOT verification
    // It now flows into selection. (Its cited source has no live document here, so under a
    // current-fact purpose broken provenance would correctly withhold it; a non-current purpose
    // surfaces it qualified — either way it is now a live, selectable record, no longer a draft.)
    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: 'mike promotable pricing pilot conversion numbering', consumerType: 'objective_suggestion', consumerAgentIds: [agentId] }));
    expect(picked.find((k) => k.id === item.id)).toBeDefined();
  });

  it('a proposal from restricted sources cannot be promoted to a less restrictive classification', async () => {
    const runId = await mkRun('November secret fact.');
    await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(candidate({ title: 'November restricted', supportingRefs: [{ path: 'canon/secret.md' }] })), meta));
    const item = (await withTenant(ctx, (tx) => listKnowledge(tx, ctx))).find((k) => k.title === 'November restricted')!;
    const prop = (await withTenant(ctx, (tx) => listKnowledgeProposals(tx, ctx, 'pending'))).find((p) => p.knowledgeItemId === item.id)!;
    await expect(
      withTenant(ctx, (tx) => promoteKnowledgeProposal(tx, ctx, prop.id, { scopeKind: 'workspace', disclosure: 'workspace_internal', activate: true })),
    ).rejects.toThrow(ValidationError);
    await withTenant(ctx, (tx) => promoteKnowledgeProposal(tx, ctx, prop.id, { scopeKind: 'workspace', disclosure: 'restricted', activate: false }));
  });

  it('a pending proposal can be revised before promotion; a reviewed one cannot', async () => {
    const runId = await mkRun('Oscar fact.');
    await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(candidate({ title: 'Oscar draft', claim: 'original claim' })), meta));
    const item = (await withTenant(ctx, (tx) => listKnowledge(tx, ctx))).find((k) => k.title === 'Oscar draft')!;
    const prop = (await withTenant(ctx, (tx) => listKnowledgeProposals(tx, ctx, 'pending'))).find((p) => p.knowledgeItemId === item.id)!;
    await withTenant(ctx, (tx) => reviseKnowledgeProposalDraft(tx, ctx, prop.id, { title: 'Oscar refined', claim: 'refined narrower claim' }));
    const revised = (await withTenant(ctx, (tx) => listKnowledge(tx, ctx))).find((k) => k.id === item.id)!;
    expect(revised.title).toBe('Oscar refined');
    await withTenant(ctx, (tx) => promoteKnowledgeProposal(tx, ctx, prop.id, { scopeKind: 'workspace', disclosure: 'workspace_internal', activate: false }));
    await expect(withTenant(ctx, (tx) => reviseKnowledgeProposalDraft(tx, ctx, prop.id, { title: 'too late' }))).rejects.toThrow(ConflictError);
  });

  it('a rejected proposal is preserved (archived + reason), not deleted; re-review conflicts', async () => {
    const runId = await mkRun('Papa fact.');
    await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(candidate({ title: 'Papa reject' })), meta));
    const item = (await withTenant(ctx, (tx) => listKnowledge(tx, ctx))).find((k) => k.title === 'Papa reject')!;
    const prop = (await withTenant(ctx, (tx) => listKnowledgeProposals(tx, ctx, 'pending'))).find((p) => p.knowledgeItemId === item.id)!;
    await withTenant(ctx, (tx) => rejectKnowledgeProposal(tx, ctx, prop.id, 'not worth remembering'));
    const rejected = (await withTenant(ctx, (tx) => listKnowledgeProposals(tx, ctx))).find((p) => p.id === prop.id)!;
    expect(rejected.reviewStatus).toBe('rejected');
    expect((await withTenant(ctx, (tx) => listKnowledge(tx, ctx, 'archived'))).find((k) => k.id === item.id)).toBeDefined();
    await expect(withTenant(ctx, (tx) => rejectKnowledgeProposal(tx, ctx, prop.id))).rejects.toThrow(ConflictError);
  });
});

describe.skipIf(!available)('operational document classification', () => {
  async function mkDoc(disclosure: 'workspace_internal' | 'restricted'): Promise<string> {
    const r = await getSetupDb()
      .insert(documents)
      .values({ orgId, projectId: ctx.projectId, relativePath: `class/${randomUUID().slice(0, 8)}.md`, kind: 'markdown', sha256: randomUUID(), sizeBytes: 10, disclosure })
      .returning({ id: documents.id });
    return r[0]!.id;
  }
  const auditActions = async (docId: string): Promise<string[]> => {
    const rows = await getSetupDb().select({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.entityId, docId));
    return rows.map((r) => r.action);
  };

  it('restricting a document is audited; the restrict path refuses to loosen (no silent downgrade)', async () => {
    const id = await mkDoc('workspace_internal');
    await withTenant(ctx, (tx) => restrictDocument(tx, ctx, id, 'contains customer PII'));
    const doc = await getSetupDb().select({ d: documents.disclosure }).from(documents).where(eq(documents.id, id));
    expect(doc[0]!.d).toBe('restricted');
    expect(await auditActions(id)).toContain('document.restricted');
    // restrictDocument is idempotent and can never be used to downgrade — declassification is separate.
    await withTenant(ctx, (tx) => restrictDocument(tx, ctx, id));
    expect((await getSetupDb().select({ d: documents.disclosure }).from(documents).where(eq(documents.id, id)))[0]!.d).toBe('restricted');
  });

  it('declassification is an explicit, reason-bearing, audited action', async () => {
    const id = await mkDoc('restricted');
    await expect(withTenant(ctx, (tx) => declassifyDocument(tx, ctx, id, '   '))).rejects.toThrow(ValidationError); // reason required
    await withTenant(ctx, (tx) => declassifyDocument(tx, ctx, id, 'approved for general use by counsel'));
    expect((await getSetupDb().select({ d: documents.disclosure }).from(documents).where(eq(documents.id, id)))[0]!.d).toBe('workspace_internal');
    expect(await auditActions(id)).toContain('document.declassified');
    await expect(withTenant(ctx, (tx) => declassifyDocument(tx, ctx, id, 'again'))).rejects.toThrow(ConflictError); // already internal
  });

  it('a later classification change does NOT rewrite an existing proposal\'s inherited disclosure', async () => {
    // The snapshot recorded canon/secret.md as restricted; extraction inherited restricted.
    const runId = await mkRun('Quebec secret fact.');
    await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, runId, returning(candidate({ title: 'Quebec inherited', supportingRefs: [{ path: 'canon/secret.md' }] })), meta));
    const item = (await withTenant(ctx, (tx) => listKnowledge(tx, ctx))).find((k) => k.title === 'Quebec inherited')!;
    const prop = (await withTenant(ctx, (tx) => listKnowledgeProposals(tx, ctx))).find((p) => p.knowledgeItemId === item.id)!;
    expect(prop.suggestedDisclosure).toBe('restricted');
    // Even if a live document of the same path is later declassified, the frozen proposal is unchanged
    // (inheritance came from the run snapshot, not a live read).
    const liveId = await getSetupDb().insert(documents).values({ orgId, projectId: ctx.projectId, relativePath: 'canon/secret.md', kind: 'markdown', sha256: 'SECRET_V2', sizeBytes: 10, disclosure: 'restricted' }).returning({ id: documents.id });
    await withTenant(ctx, (tx) => declassifyDocument(tx, ctx, liveId[0]!.id, 'no longer sensitive'));
    const stillRestricted = (await withTenant(ctx, (tx) => listKnowledgeProposals(tx, ctx))).find((p) => p.id === prop.id)!;
    expect(stillRestricted.suggestedDisclosure).toBe('restricted');
    await getSetupDb().delete(documents).where(eq(documents.id, liveId[0]!.id));
  });
});
