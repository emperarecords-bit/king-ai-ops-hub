import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getSetupDb } from '../src/db/client';
import { withTenant } from '../src/db/tenant';
import { agents, documents, knowledgeItems, projectMembers, projects, runs, tasks } from '../src/db/schema';
import type { RunSourceSnapshot, TenantContext } from '../src/types/domain';
import {
  activateKnowledge,
  attachKnowledgeSource,
  createKnowledge,
  logKnowledgeApplications,
  recordSupportJudgment,
  reviseKnowledge,
  setKnowledgeVerification,
} from '../src/domain/knowledge/knowledge';
import { createDisclosureGrant } from '../src/domain/knowledge/disclosure';
import { extractKnowledgeForRun, rejectKnowledgeProposal, splitKnowledgeProposal, listKnowledgeProposals, type ExtractFn } from '../src/domain/knowledge/extraction';

/**
 * Seeds the 15-state Knowledge matrix for AUTHENTICATED VISUAL ACCEPTANCE of the Portfolio & Detail.
 * Creates each state through the REAL domain functions (not raw inserts), so the surfaces render exactly
 * what production would. All titles are prefixed "[demo]" for easy identification. Safe to re-run
 * (it appends a fresh batch each time; delete "[demo]" items when done).
 *
 *   SEED_PROJECT_KEY=<key> npx tsx scripts/seed-knowledge-states.ts   (default: king-ai-ops-hub)
 */

const DAY = 86_400_000;
const future = () => new Date(Date.now() + 30 * DAY);
const past = () => new Date(Date.now() - DAY);

async function main() {
  const db = getSetupDb();
  const projectKey = process.env.SEED_PROJECT_KEY ?? 'king-ai-ops-hub';

  const project = (await db.select().from(projects).where(eq(projects.key, projectKey)).limit(1))[0];
  if (!project) throw new Error(`Project '${projectKey}' not found — run npm run db:seed first.`);
  const member = (await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, project.id))).limit(1))[0];
  if (!member) throw new Error(`No project member for '${projectKey}'.`);
  const ctx: TenantContext = { userId: member.userId, orgId: project.orgId, projectId: project.id, orgRole: 'owner', projectRole: 'admin' };

  let agent = (await db.select().from(agents).where(and(eq(agents.projectId, project.id), eq(agents.role, 'primary'))).limit(1))[0];
  if (!agent) {
    agent = (await db.insert(agents).values({ orgId: ctx.orgId, projectId: ctx.projectId, name: `[demo] Agent ${randomUUID().slice(0, 4)}`, role: 'primary', provider: 'openai', model: 'gpt-5.4-mini', systemPrompt: 'x' }).returning())[0]!;
  }
  const tag = randomUUID().slice(0, 4);
  const mkDoc = async (path: string, sha: string, disclosure: 'workspace_internal' | 'restricted' = 'workspace_internal') => {
    await db.insert(documents).values({ orgId: ctx.orgId, projectId: ctx.projectId, relativePath: path, kind: 'markdown', sha256: sha, sizeBytes: 100, disclosure });
  };
  const seededRun = async (snapshot: RunSourceSnapshot[]): Promise<string> => {
    const t = (await db.insert(tasks).values({ orgId: ctx.orgId, projectId: ctx.projectId, title: `[demo] extract task ${tag}`, input: 'x', providerSelection: 'openai', status: 'completed', createdBy: ctx.userId }).returning({ id: tasks.id }))[0]!;
    const r = (await db.insert(runs).values({ orgId: ctx.orgId, projectId: ctx.projectId, taskId: t.id, status: 'completed', primaryAgentId: agent!.id, consolidatedResult: 'demo output', retrievedSources: snapshot }).returning({ id: runs.id }))[0]!;
    return r.id;
  };
  const cand = (over: Record<string, unknown>): ExtractFn => async () =>
    JSON.stringify({ candidates: [{ title: `[demo] extracted claim ${tag}`, claim: 'Extracted demo claim.', transformation: 'extracted', supportingRefs: [{ path: `demo/extract-${tag}.md` }], suggestedScope: 'workspace', confidence: 'medium', ...over }] });

  const log = (msg: string) => console.log(`  ✓ ${msg}`);
  console.log(`Seeding [demo] Knowledge states into '${projectKey}' (tag ${tag})…`);

  // 1. Active, source-supported, current.
  await mkDoc(`demo/price-${tag}.md`, 'PRICE_V1');
  const supported = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: `[demo] Source-supported current price ${tag}`, body: 'The current pilot price is $125/month.', kind: 'fact', epistemicBasis: 'extracted', expiresAt: future() }));
  const sSrc = await withTenant(ctx, (tx) => attachKnowledgeSource(tx, ctx, supported, { sourceType: 'document', sourceRef: `demo/price-${tag}.md`, sourceLabel: 'Pricing.md', sourceVersionHash: 'PRICE_V1', transformation: 'extracted' }));
  await withTenant(ctx, (tx) => recordSupportJudgment(tx, ctx, supported, { reliedOnSourceIds: [sSrc], rationale: 'the doc states the price' }));
  await withTenant(ctx, (tx) => activateKnowledge(tx, ctx, supported));
  log('1 source-supported current');

  // 2. Human assertion without a source.
  await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: `[demo] Human assertion ${tag}`, body: 'Contractors prefer monthly pricing.', kind: 'fact', activate: true }));
  log('2 human assertion');

  // 3. Review-due.
  await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: `[demo] Review-due ${tag}`, body: 'Standard SLA is 99.9%.', kind: 'fact', reviewAfter: past(), expiresAt: future(), activate: true }));
  log('3 review-due');

  // 4. Stale, historical.
  await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: `[demo] Stale price ${tag}`, body: 'The price was $99/month.', kind: 'fact', expiresAt: past(), activate: true }));
  log('4 stale');

  // 5. Disputed.
  const disputed = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: `[demo] Disputed rate ${tag}`, body: 'The contractor rate is $125.', kind: 'fact', activate: true }));
  await withTenant(ctx, (tx) => setKnowledgeVerification(tx, ctx, disputed, 'disputed', 'two active records disagree'));
  log('5 disputed');

  // 6. Broken relied-upon provenance.
  await mkDoc(`demo/rate-${tag}.md`, 'RATE_V1');
  const brokenRelied = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: `[demo] Broken relied provenance ${tag}`, body: 'Extracted rate figure.', kind: 'fact', epistemicBasis: 'extracted', expiresAt: future() }));
  const brSrc = await withTenant(ctx, (tx) => attachKnowledgeSource(tx, ctx, brokenRelied, { sourceType: 'document', sourceRef: `demo/rate-${tag}.md`, sourceLabel: 'Rate.md', sourceVersionHash: 'RATE_V1', transformation: 'extracted' }));
  await withTenant(ctx, (tx) => recordSupportJudgment(tx, ctx, brokenRelied, { reliedOnSourceIds: [brSrc] }));
  await withTenant(ctx, (tx) => activateKnowledge(tx, ctx, brokenRelied));
  await db.update(documents).set({ sha256: 'RATE_V2' }).where(eq(documents.relativePath, `demo/rate-${tag}.md`)); // break
  log('6 broken relied-upon provenance');

  // 7. Broken supplemental provenance (relied intact).
  await mkDoc(`demo/relied-${tag}.md`, 'REL_V1');
  await mkDoc(`demo/supp-${tag}.md`, 'SUP_V1');
  const brokenSupp = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: `[demo] Broken supplemental provenance ${tag}`, body: 'Summarized figure with two sources.', kind: 'fact', epistemicBasis: 'summarized', expiresAt: future() }));
  const relSrc = await withTenant(ctx, (tx) => attachKnowledgeSource(tx, ctx, brokenSupp, { sourceType: 'document', sourceRef: `demo/relied-${tag}.md`, sourceLabel: 'Relied.md', sourceVersionHash: 'REL_V1', transformation: 'summarized' }));
  await withTenant(ctx, (tx) => attachKnowledgeSource(tx, ctx, brokenSupp, { sourceType: 'document', sourceRef: `demo/supp-${tag}.md`, sourceLabel: 'Supplemental.md', sourceVersionHash: 'SUP_V1', transformation: 'summarized' }));
  await withTenant(ctx, (tx) => recordSupportJudgment(tx, ctx, brokenSupp, { reliedOnSourceIds: [relSrc] }));
  await withTenant(ctx, (tx) => activateKnowledge(tx, ctx, brokenSupp));
  await db.update(documents).set({ sha256: 'SUP_V2' }).where(eq(documents.relativePath, `demo/supp-${tag}.md`)); // break supplemental only
  log('7 broken supplemental provenance');

  // 8. Restricted and permitted (a grant for the agent).
  const restrictedOk = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: `[demo] Restricted permitted ${tag}`, body: 'Confidential — granted to the agent.', kind: 'fact', disclosure: 'restricted', activate: true }));
  await withTenant(ctx, (tx) => createDisclosureGrant(tx, ctx, { knowledgeItemId: restrictedOk, agentId: agent!.id, purpose: 'current_operational_fact', expiresAt: future(), rationale: 'demo grant' }));
  log('8 restricted permitted');

  // 9. Restricted and withheld (no grant).
  await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: `[demo] Restricted withheld ${tag}`, body: 'Confidential — no grant.', kind: 'fact', disclosure: 'restricted', activate: true }));
  log('9 restricted withheld');

  // 10. AI-extracted draft (pending proposal).
  await mkDoc(`demo/extract-${tag}.md`, 'EX1');
  const snapshot: RunSourceSnapshot[] = [{ relativePath: `demo/extract-${tag}.md`, sha256: 'EX1', disclosure: 'workspace_internal', chunkIndex: 0, rank: 1, excerpt: 'Extracted demo claim evidence.' }];
  const aiRun = await seededRun(snapshot);
  await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, aiRun, cand({ title: `[demo] AI proposal ${tag}` }), { provider: 'openai', model: 'gpt-5.4-mini' }));
  log('10 AI-extracted draft');

  // 11. Split proposal (parent retired, children pending).
  const splitRun = await seededRun(snapshot);
  await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, splitRun, cand({ title: `[demo] Split parent ${tag}` }), { provider: 'openai', model: 'gpt-5.4-mini' }));
  const splitParent = (await withTenant(ctx, (tx) => listKnowledgeProposals(tx, ctx, 'pending'))).find((p) => p.title === `[demo] Split parent ${tag}`);
  if (splitParent) {
    await withTenant(ctx, (tx) => splitKnowledgeProposal(tx, ctx, splitParent.id, { reason: 'two independent claims', children: [{ title: `[demo] Split child A ${tag}`, claim: 'First claim.' }, { title: `[demo] Split child B ${tag}`, claim: 'Second claim.' }] }));
    log('11 split proposal (parent + children)');
  }

  // 12. Rejected proposal.
  const rejRun = await seededRun(snapshot);
  await withTenant(ctx, (tx) => extractKnowledgeForRun(tx, ctx, rejRun, cand({ title: `[demo] Rejected proposal ${tag}` }), { provider: 'openai', model: 'gpt-5.4-mini' }));
  const rejProp = (await withTenant(ctx, (tx) => listKnowledgeProposals(tx, ctx, 'pending'))).find((p) => p.title === `[demo] Rejected proposal ${tag}`);
  if (rejProp) {
    await withTenant(ctx, (tx) => rejectKnowledgeProposal(tx, ctx, rejProp.id, 'not worth remembering'));
    log('12 rejected proposal');
  }

  // 13. Superseded version.
  const superseded = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: `[demo] Runtime ${tag}`, body: 'Runtime is 22 minutes.', kind: 'fact', activate: true }));
  await withTenant(ctx, (tx) => reviseKnowledge(tx, ctx, superseded, { body: 'Runtime is 24 minutes.', activate: true }));
  log('13 superseded version');

  // 14. Invalid / closed scope (task-scoped to a completed task).
  const closedTask = (await db.insert(tasks).values({ orgId: ctx.orgId, projectId: ctx.projectId, title: `[demo] closed task ${tag}`, input: 'x', providerSelection: 'openai', status: 'completed', createdBy: ctx.userId }).returning({ id: tasks.id }))[0]!;
  await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: `[demo] Closed-scope note ${tag}`, body: 'Only relevant to a finished task.', kind: 'fact', scopeKind: 'task', scopeTaskId: closedTask.id, activate: true }));
  log('14 closed scope');

  // 15. Several recorded applications.
  const applied = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: `[demo] Widely-supplied fact ${tag}`, body: 'Supplied to several operations.', kind: 'fact', activate: true }));
  const snap = { epistemicBasis: 'human_asserted' as const, verification: 'unverified' as const, freshness: 'unknown' as const, provenanceState: 'no_source' as const, useState: 'usable_with_qualification' as const, scopeKind: 'workspace' as const, disclosure: 'workspace_internal' as const, disclosureDecision: 'permitted' as const, intendedUse: 'current_operational_fact' as const, reliedOnSourceIds: [], supplementalSourceIds: [], resolutions: [], supportJudgmentId: null, disclosureGrants: [], renderingVersion: 'kv1' };
  for (let i = 0; i < 3; i++) {
    await withTenant(ctx, (tx) => logKnowledgeApplications(tx, ctx, { consumerType: 'objective_suggestion', consumerId: randomUUID(), injected: [{ id: applied, version: 1, title: `[demo] Widely-supplied fact ${tag}`, body: 'x', reason: 'subject: demo', memoryText: 'demo', trustSnapshot: snap }] }));
  }
  log('15 several applications');

  const count = (await withTenant(ctx, (tx) => tx.select({ id: knowledgeItems.id }).from(knowledgeItems).where(and(eq(knowledgeItems.projectId, ctx.projectId), eq(knowledgeItems.orgId, ctx.orgId))))).length;
  console.log(`\nDone. Open /p/${projectKey}/knowledge and walk the checklist. ('[demo]' titles, tag ${tag}). Project now has ${count} knowledge items total.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
