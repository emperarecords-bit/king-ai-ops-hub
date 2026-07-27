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
  selectRelevantKnowledge,
  setKnowledgeVerification,
} from '@/domain/knowledge/knowledge';
import { buildKnowledgePortfolio, buildKnowledgeReference, type KnowledgePortfolioGroup } from '@/domain/knowledge/portfolio';

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

  it('the selector injects Available/Qualified relevant records and never a Needs-Review one, matching the Portfolio', async () => {
    // A clearly-available relevant record and a disputed (needs-review) one sharing query vocabulary.
    await getSetupDb().insert(documents).values({ orgId, projectId: ctx.projectId, relativePath: 'pf/omega.md', kind: 'markdown', sha256: 'OMEGA_V1', sizeBytes: 10, disclosure: 'workspace_internal' });
    const good = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Omega throughput policy', body: 'Omega throughput burst policy limit configuration.', kind: 'fact', epistemicBasis: 'extracted', expiresAt: future() }));
    const gsrc = await withTenant(ctx, (tx) => attachKnowledgeSource(tx, ctx, good, { sourceType: 'document', sourceRef: 'pf/omega.md', sourceLabel: 'Omega.md', sourceVersionHash: 'OMEGA_V1', transformation: 'extracted' }));
    await withTenant(ctx, (tx) => recordSupportJudgment(tx, ctx, good, { reliedOnSourceIds: [gsrc] }));
    await withTenant(ctx, (tx) => activateKnowledge(tx, ctx, good));
    const bad = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Omega throughput disputed', body: 'Omega throughput burst policy limit configuration.', kind: 'fact', activate: true }));
    await withTenant(ctx, (tx) => setKnowledgeVerification(tx, ctx, bad, 'disputed', 'conflicting limits'));

    const query = 'omega throughput burst policy limit configuration';
    const injected = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: query, consumerType: 'task_run', consumerAgentIds: [agentId] }));
    const injectedIds = injected.map((k) => k.id);
    const pf = await withTenant(ctx, (tx) => buildKnowledgePortfolio(tx, ctx));

    // The good record: injected by the selector AND in Available in the Portfolio.
    expect(injectedIds).toContain(good);
    expect(groupFor(pf, good)).toBe('available');
    // The disputed record: NOT injected AND in Needs-Review — no contradiction across surfaces.
    expect(injectedIds).not.toContain(bad);
    expect(groupFor(pf, bad)).toBe('needs_review');
  });
});
