import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { agents, documents, memberships, organizations, profiles, projectMembers, projects } from '@/db/schema';
import {
  activateKnowledge,
  archiveKnowledge,
  attachKnowledgeSource,
  createKnowledge,
  recordSupportJudgment,
  reviseKnowledge,
  selectRelevantKnowledge,
  setKnowledgeVerification,
} from '@/domain/knowledge/knowledge';
import { createDisclosureGrant } from '@/domain/knowledge/disclosure';
import { buildKnowledgePortfolio, buildKnowledgeReference, type KnowledgePortfolioGroup } from '@/domain/knowledge/portfolio';
import { loadKnowledgeDetail } from '@/domain/knowledge/detail';

/**
 * SHARED SURFACE INTEGRITY. The Portfolio, the Detail, and the selector must all read the same trust
 * assessment — a record cannot be Available in the Portfolio, Withheld in the Detail, and injected by
 * the selector under the same consumer + intended-use context.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[knowledge-portfolio.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

const userId = randomUUID();
let ctx: TenantContext;
let orgId = '';
let agentId = '';
const future = () => new Date(Date.now() + 30 * 86_400_000);
const past = () => new Date(Date.now() - 86_400_000);

/** Find the group a given item id landed in. */
function groupFor(pf: Awaited<ReturnType<typeof buildKnowledgePortfolio>>, id: string): KnowledgePortfolioGroup | null {
  for (const g of Object.keys(pf.groups) as KnowledgePortfolioGroup[]) if (pf.groups[g].some((r) => r.id === id)) return g;
  return null;
}

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  await db.insert(profiles).values({ id: userId, email: `pf-${randomUUID().slice(0, 8)}@test.local`, displayName: 'PF Tester' });
  const org = await db.insert(organizations).values({ name: 'PF Org', slug: `pf-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  const p = await db.insert(projects).values({ orgId, key: fixtureKey('pf'), name: 'PF Project' }).returning({ id: projects.id });
  await db.insert(projectMembers).values({ orgId, projectId: p[0]!.id, userId, role: 'admin' });
  ctx = { userId, orgId, projectId: p[0]!.id, orgRole: 'owner', projectRole: 'admin' };
  const a = await db.insert(agents).values({ orgId, projectId: ctx.projectId, name: `PF-${randomUUID().slice(0, 6)}`, role: 'primary', provider: 'openai', model: 'gpt-5.4-mini', systemPrompt: 'x' }).returning({ id: agents.id });
  agentId = a[0]!.id;
});

afterAll(async () => {
  if (!available) return;
  await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});

describe.skipIf(!available)('knowledge portfolio grouping + cross-surface integrity', () => {
  it('records land in the canonical group implied by their shared assessment', async () => {
    // Source-supported, current → available.
    await getSetupDb().insert(documents).values({ orgId, projectId: ctx.projectId, relativePath: 'pf/alpha.md', kind: 'markdown', sha256: 'ALPHA_V1', sizeBytes: 10, disclosure: 'workspace_internal' });
    const supported = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Alpha price', body: 'Alpha price is 125.', kind: 'fact', epistemicBasis: 'extracted', expiresAt: future() }));
    const srcId = await withTenant(ctx, (tx) => attachKnowledgeSource(tx, ctx, supported, { sourceType: 'document', sourceRef: 'pf/alpha.md', sourceLabel: 'Alpha.md', sourceVersionHash: 'ALPHA_V1', transformation: 'extracted' }));
    await withTenant(ctx, (tx) => recordSupportJudgment(tx, ctx, supported, { reliedOnSourceIds: [srcId] }));
    await withTenant(ctx, (tx) => activateKnowledge(tx, ctx, supported));

    const assertion = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Beta assertion', body: 'Beta preference stated by a person.', kind: 'fact', activate: true }));
    const reviewDue = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Gamma review', body: 'Gamma value.', kind: 'fact', reviewAfter: past(), expiresAt: future(), activate: true }));
    const stale = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Delta stale', body: 'Delta old price.', kind: 'fact', expiresAt: past(), activate: true }));
    const disputed = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Epsilon disputed', body: 'Epsilon rate.', kind: 'fact', activate: true }));
    await withTenant(ctx, (tx) => setKnowledgeVerification(tx, ctx, disputed, 'disputed', 'two records disagree'));
    const restricted = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Zeta restricted', body: 'Zeta secret.', kind: 'fact', disclosure: 'restricted', activate: true }));
    const draft = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Eta draft', body: 'Eta pending.', kind: 'fact', activate: false }));
    const archived = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Theta archived', body: 'Theta retired.', kind: 'fact', activate: true }));
    await withTenant(ctx, (tx) => archiveKnowledge(tx, ctx, archived));

    const pf = await withTenant(ctx, (tx) => buildKnowledgePortfolio(tx, ctx));
    expect(groupFor(pf, supported)).toBe('available');
    expect(groupFor(pf, assertion)).toBe('use_with_qualification'); // unverified + no window → qualified
    expect(groupFor(pf, reviewDue)).toBe('use_with_qualification');
    expect(groupFor(pf, stale)).toBe('historical');
    expect(groupFor(pf, disputed)).toBe('needs_review');
    expect(groupFor(pf, restricted)).toBe('needs_review');
    expect(groupFor(pf, draft)).toBe('awaiting_review');
    expect(groupFor(pf, archived)).toBe('historical');

    // The Needs-Review lens flags concerns and references canonical records.
    const lensIds = pf.needsReviewLens.map((r) => r.id);
    expect(lensIds).toContain(disputed);
    expect(lensIds).toContain(restricted);
    expect(pf.needsReviewLens.find((r) => r.id === restricted)!.concerns).toContain('restricted_no_disclosure_path');
    expect(pf.needsReviewLens.find((r) => r.id === disputed)!.concerns).toContain('disputed');
    expect(pf.needsReviewLens.find((r) => r.id === reviewDue)!.concerns).toContain('review_due');
  });

  it('a restricted record WITH a live grant is configured (granted), not a Needs-Review concern', async () => {
    const r = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Upsilon granted directive', body: 'Upsilon directive handled by a bounded agent.', kind: 'fact', disclosure: 'restricted', activate: true }));
    await withTenant(ctx, (tx) => createDisclosureGrant(tx, ctx, { knowledgeItemId: r, agentId, purpose: 'current_operational_fact', expiresAt: future() }));
    const pf = await withTenant(ctx, (tx) => buildKnowledgePortfolio(tx, ctx));
    const ref = Object.values(pf.groups).flat().find((x) => x.id === r)!;
    expect(ref.restrictedGrantState).toBe('granted');
    expect(ref.group).not.toBe('needs_review'); // a live grant means it is configured, not a defect
    expect(pf.needsReviewLens.map((x) => x.id)).not.toContain(r);
  });

  it('Historical records keep their specific institutional reason', async () => {
    const staleId = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Phi expired figure', body: 'Old figure.', kind: 'fact', expiresAt: past(), activate: true }));
    const v1 = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Chi runtime', body: 'Runtime is 22 minutes.', kind: 'fact', activate: true }));
    await withTenant(ctx, (tx) => reviseKnowledge(tx, ctx, v1, { body: 'Runtime is 24 minutes.', activate: true })); // supersedes v1
    const pf = await withTenant(ctx, (tx) => buildKnowledgePortfolio(tx, ctx));
    const historical = pf.groups.historical;
    expect(historical.find((x) => x.id === staleId)?.historicalReason).toBe('Expired for current use');
    expect(historical.find((x) => x.id === v1)?.historicalReason).toBe('Superseded by a newer version');
  });

  it('Detail verdict never contradicts the Portfolio group', async () => {
    const pf = await withTenant(ctx, (tx) => buildKnowledgePortfolio(tx, ctx));
    for (const group of ['available', 'use_with_qualification', 'needs_review'] as const) {
      for (const ref of pf.groups[group]) {
        const detail = await withTenant(ctx, (tx) => buildKnowledgeReference(tx, ctx, ref.id));
        expect(detail).not.toBeNull();
        const v = detail!.descriptor.currentUseVerdict.state;
        if (group === 'available') expect(v).toBe('usable');
        else if (group === 'use_with_qualification') expect(v).toBe('usable_with_qualification');
        else expect(v).toBe('withheld'); // needs_review active records are withheld for current use
        expect(detail!.group).toBe(group); // same aggregator, same group
      }
    }
  });

  it('selection is governed by the ASSESSMENT, not by Needs-Review membership', async () => {
    // A record with a NON-BLOCKING concern (review-due) — flagged in the lens, yet its assessment
    // permits qualified use, so it IS selected.
    const reviewDue = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Sigma cadence policy', body: 'Sigma cadence policy interval configuration threshold.', kind: 'fact', reviewAfter: past(), expiresAt: future(), activate: true }));
    // A record with a BLOCKING defect (disputed) — withheld by the assessment itself.
    const disputed = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Sigma cadence disputed', body: 'Sigma cadence policy interval configuration threshold.', kind: 'fact', activate: true }));
    await withTenant(ctx, (tx) => setKnowledgeVerification(tx, ctx, disputed, 'disputed', 'two records disagree'));

    const query = 'sigma cadence policy interval configuration threshold';
    const injected = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: query, consumerType: 'task_run', consumerAgentIds: [agentId] }));
    const injectedIds = injected.map((k) => k.id);
    const pf = await withTenant(ctx, (tx) => buildKnowledgePortfolio(tx, ctx));

    // Review-due: in the Needs-Review lens AND selected — lens membership did not prohibit it.
    expect(pf.needsReviewLens.map((r) => r.id)).toContain(reviewDue);
    expect(injectedIds).toContain(reviewDue);
    // Disputed: withheld — because the assessment withholds a disputed claim for current use, NOT
    // because it appears in the lens.
    expect(injectedIds).not.toContain(disputed);
    const disputedAssessed = await withTenant(ctx, (tx) => buildKnowledgeReference(tx, ctx, disputed));
    expect(disputedAssessed!.descriptor.currentUseVerdict.state).toBe('withheld');
  });

  it('a restricted record validly granted to the operation IS selected, though the Portfolio groups it Needs-Review', async () => {
    // The Portfolio has no consuming agent → this restricted record is Needs-Review (no disclosure path).
    const restricted = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Tau restricted directive', body: 'Tau restricted directive privileged handling procedure.', kind: 'fact', disclosure: 'restricted', activate: true }));
    const pf = await withTenant(ctx, (tx) => buildKnowledgePortfolio(tx, ctx));
    expect(groupFor(pf, restricted)).toBe('needs_review');

    // But a run whose consuming agent holds a live grant for this purpose receives it — selection is
    // driven by the assessment + grant, never by the Portfolio's page-oriented grouping.
    await withTenant(ctx, (tx) => createDisclosureGrant(tx, ctx, { knowledgeItemId: restricted, agentId, purpose: 'current_operational_fact', expiresAt: future() }));
    const injected = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: 'tau restricted directive privileged handling procedure', consumerType: 'task_run', consumerAgentIds: [agentId] }));
    expect(injected.map((k) => k.id)).toContain(restricted);
  });
});

describe.skipIf(!available)('viewer access is resolved from the authenticated request (filtered at retrieval)', () => {
  let memberCtx: TenantContext;
  let restrictedId = '';

  beforeAll(async () => {
    if (!available) return;
    // A non-privileged member of the SAME project.
    const memberId = randomUUID();
    await getSetupDb().insert(profiles).values({ id: memberId, email: `pf-mbr-${randomUUID().slice(0, 8)}@test.local`, displayName: 'PF Member' });
    await getSetupDb().insert(memberships).values({ orgId, userId: memberId, role: 'member' });
    await getSetupDb().insert(projectMembers).values({ orgId, projectId: ctx.projectId, userId: memberId, role: 'member' });
    memberCtx = { userId: memberId, orgId, projectId: ctx.projectId, orgRole: 'member', projectRole: 'member' };
    // A restricted record with a sensitive title + body, authored by the admin.
    restrictedId = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Phi secret codename', body: 'Phi confidential acquisition target valuation.', kind: 'fact', disclosure: 'restricted', activate: true }));
  });

  it('an authorized (admin) viewer receives the restricted record content', async () => {
    const ref = await withTenant(ctx, (tx) => buildKnowledgeReference(tx, ctx, restrictedId));
    expect(ref!.descriptor.visibility.operator).toBe('full');
    expect(ref!.descriptor.claim?.title).toBe('Phi secret codename');
  });

  it('an UNAUTHORIZED (member) viewer never receives restricted content or source metadata in the loader result', async () => {
    const ref = await withTenant(memberCtx, (tx) => buildKnowledgeReference(tx, memberCtx, restrictedId));
    expect(ref).not.toBeNull();
    expect(ref!.descriptor.visibility.operator).toBe('withholding_only');
    expect(ref!.descriptor.claim).toBeNull();
    // The redaction is at retrieval: the sensitive fields are absent from the returned object.
    const serialized = JSON.stringify(ref);
    expect(serialized).not.toContain('Phi secret codename');
    expect(serialized).not.toContain('confidential acquisition');
  });

  it('the Portfolio does not leak restricted titles to an unauthorized viewer', async () => {
    const pf = await withTenant(memberCtx, (tx) => buildKnowledgePortfolio(tx, memberCtx));
    const serialized = JSON.stringify(pf);
    expect(serialized).not.toContain('Phi secret codename');
    expect(serialized).not.toContain('confidential acquisition');
    // The record still appears (as a bounded, redacted reference) so the operator knows it exists.
    const allRefs = Object.values(pf.groups).flat();
    const redacted = allRefs.find((r) => r.id === restrictedId);
    expect(redacted).toBeDefined();
    expect(redacted!.descriptor.claim).toBeNull();
  });

  // The Detail ROUTE LOADER exercised with the real non-admin identity — direct navigation must not
  // return sensitive data in the payload, and the sensitive queries must not run.
  it('the Detail loader returns full content to an admin', async () => {
    const view = await withTenant(ctx, (tx) => loadKnowledgeDetail(tx, ctx, restrictedId));
    expect(view?.visible).toBe(true);
    if (view?.visible) expect(view.ref.descriptor.claim?.title).toBe('Phi secret codename');
  });

  it('the Detail loader returns ONLY a bounded notice to a non-admin — no content, no application/source data', async () => {
    const view = await withTenant(memberCtx, (tx) => loadKnowledgeDetail(tx, memberCtx, restrictedId));
    expect(view).not.toBeNull();
    expect(view!.visible).toBe(false);
    // The sensitive branch (ref/item/applications/sources) is absent entirely — not merely hidden.
    expect(view as { ref?: unknown }).not.toHaveProperty('ref');
    expect(view as { applications?: unknown }).not.toHaveProperty('applications');
    expect(view as { sources?: unknown }).not.toHaveProperty('sources');
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('Phi secret codename');
    expect(serialized).not.toContain('confidential acquisition');
  });

  it('a non-admin CAN see a non-restricted record through the Detail loader (access is per-record)', async () => {
    const openId = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Chi open note', body: 'Ordinary workspace fact.', kind: 'fact', activate: true }));
    const view = await withTenant(memberCtx, (tx) => loadKnowledgeDetail(tx, memberCtx, openId));
    expect(view?.visible).toBe(true);
    if (view?.visible) expect(view.ref.descriptor.claim?.title).toBe('Chi open note');
  });
});
