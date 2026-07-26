import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { artifacts, documents, memberships, organizations, profiles, projectMembers, projects } from '@/db/schema';
import {
  assessKnowledgeProvenance,
  attachKnowledgeSource,
  createKnowledge,
  getKnowledgeVerificationHistory,
  listKnowledge,
  recordSupportJudgment,
} from '@/domain/knowledge/knowledge';

/**
 * Inspectable provenance: sources are version-specific, resolved to their exact cited version, and
 * `source_supported` requires a recorded support judgment over resolved sources. Historical judgments
 * survive later resolution failures; the current provenance assessment reflects present inspectability.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[knowledge-provenance.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

const userId = randomUUID();
let ctx: TenantContext;
let orgId = '';

async function mkDoc(relativePath: string, sha256: string): Promise<void> {
  await getSetupDb().insert(documents).values({ orgId, projectId: ctx.projectId, relativePath, kind: 'markdown', sha256, sizeBytes: 100 });
}

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  await db.insert(profiles).values({ id: userId, email: `prov-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Prov Tester' });
  const org = await db.insert(organizations).values({ name: 'Prov Org', slug: `prov-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  const p = await db.insert(projects).values({ orgId, key: fixtureKey('prov'), name: 'Prov Project' }).returning({ id: projects.id });
  await db.insert(projectMembers).values({ orgId, projectId: p[0]!.id, userId, role: 'admin' });
  ctx = { userId, orgId, projectId: p[0]!.id, orgRole: 'owner', projectRole: 'admin' };
});

afterAll(async () => {
  if (!available) return;
  await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});

describe.skipIf(!available)('inspectable provenance', () => {
  it('a manual assertion may have no source and remains unverified (no provenance defect)', async () => {
    const id = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Assertion', body: 'b', kind: 'fact' }));
    const prov = await withTenant(ctx, (tx) => assessKnowledgeProvenance(tx, ctx, id, 1));
    expect(prov.state).toBe('no_source');
    const item = (await withTenant(ctx, (tx) => listKnowledge(tx, ctx))).find((k) => k.id === id)!;
    expect(item.status).toBe('draft');
  });

  it('attaching a source does not change verification; support_supported needs a judgment over resolved sources', async () => {
    await mkDoc('canon/pricing.md', 'HASH_V1');
    const id = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Priced', body: 'b', kind: 'fact', epistemicBasis: 'extracted' }));
    const srcId = await withTenant(ctx, (tx) => attachKnowledgeSource(tx, ctx, id, { sourceType: 'document', sourceRef: 'canon/pricing.md', sourceLabel: 'Pricing.md', sourceVersionHash: 'HASH_V1', transformation: 'extracted' }));
    // Attaching did NOT verify.
    expect(await withTenant(ctx, (tx) => getKnowledgeVerificationHistory(tx, ctx, id))).toHaveLength(0);
    // Attached-but-not-reviewed: resolves, but no judgment yet.
    expect((await withTenant(ctx, (tx) => assessKnowledgeProvenance(tx, ctx, id, 1))).state).toBe('attached_not_reviewed');
    // A judgment must name relied sources.
    await expect(withTenant(ctx, (tx) => recordSupportJudgment(tx, ctx, id, { reliedOnSourceIds: [] }))).rejects.toThrow(/must identify/i);
    // Recording a judgment over the resolved source establishes source_supported.
    await withTenant(ctx, (tx) => recordSupportJudgment(tx, ctx, id, { reliedOnSourceIds: [srcId], rationale: 'the doc states the price' }));
    expect((await withTenant(ctx, (tx) => listKnowledge(tx, ctx))).find((k) => k.id === id)!.verification).toBe('source_supported');
    expect((await withTenant(ctx, (tx) => assessKnowledgeProvenance(tx, ctx, id, 1))).state).toBe('inspectable_support');
  });

  it('source_supported fails when a relied-upon source is missing or the cited version mismatches', async () => {
    // Missing source ref.
    const idA = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Missing src', body: 'b', kind: 'fact', epistemicBasis: 'extracted' }));
    const missId = await withTenant(ctx, (tx) => attachKnowledgeSource(tx, ctx, idA, { sourceType: 'document', sourceRef: 'canon/does-not-exist.md', sourceLabel: 'Ghost.md', sourceVersionHash: 'X', transformation: 'extracted' }));
    await expect(withTenant(ctx, (tx) => recordSupportJudgment(tx, ctx, idA, { reliedOnSourceIds: [missId] }))).rejects.toThrow(/exact cited version/i);
    expect((await withTenant(ctx, (tx) => assessKnowledgeProvenance(tx, ctx, idA, 1))).state).toBe('broken');

    // Version mismatch: doc exists but at a different hash — never falls back to latest.
    await mkDoc('canon/spec.md', 'CURRENT_HASH');
    const idB = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Stale cite', body: 'b', kind: 'fact', epistemicBasis: 'summarized' }));
    const vmId = await withTenant(ctx, (tx) => attachKnowledgeSource(tx, ctx, idB, { sourceType: 'document', sourceRef: 'canon/spec.md', sourceLabel: 'Spec.md', sourceVersionHash: 'OLD_HASH', transformation: 'summarized' }));
    await expect(withTenant(ctx, (tx) => recordSupportJudgment(tx, ctx, idB, { reliedOnSourceIds: [vmId] }))).rejects.toThrow(/exact cited version/i);
    const provB = await withTenant(ctx, (tx) => assessKnowledgeProvenance(tx, ctx, idB, 1));
    expect(provB.resolutions[0]!.outcome).toBe('version_mismatch');
  });

  it('multiple sources resolve independently → partial provenance when one breaks', async () => {
    await mkDoc('canon/a.md', 'HA');
    const id = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Two sources', body: 'b', kind: 'fact', epistemicBasis: 'summarized' }));
    await withTenant(ctx, (tx) => attachKnowledgeSource(tx, ctx, id, { sourceType: 'document', sourceRef: 'canon/a.md', sourceLabel: 'A', sourceVersionHash: 'HA', transformation: 'summarized' }));
    await withTenant(ctx, (tx) => attachKnowledgeSource(tx, ctx, id, { sourceType: 'document', sourceRef: 'canon/missing-b.md', sourceLabel: 'B', sourceVersionHash: 'HB', transformation: 'summarized' }));
    const prov = await withTenant(ctx, (tx) => assessKnowledgeProvenance(tx, ctx, id, 1));
    expect(prov.state).toBe('partial');
    expect(prov.resolutions.map((r) => r.outcome).sort()).toEqual(['missing', 'resolved']);
  });

  it('a historical support judgment survives a later resolution failure; current provenance reflects the break', async () => {
    await mkDoc('canon/rate.md', 'RATE_V1');
    const id = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Rate', body: 'b', kind: 'fact', epistemicBasis: 'extracted' }));
    const srcId = await withTenant(ctx, (tx) => attachKnowledgeSource(tx, ctx, id, { sourceType: 'document', sourceRef: 'canon/rate.md', sourceLabel: 'Rate.md', sourceVersionHash: 'RATE_V1', transformation: 'extracted' }));
    await withTenant(ctx, (tx) => recordSupportJudgment(tx, ctx, id, { reliedOnSourceIds: [srcId] }));
    // The cited version becomes unavailable (document changes).
    await getSetupDb().update(documents).set({ sha256: 'RATE_V2' }).where(eq(documents.relativePath, 'canon/rate.md'));
    // Verification (the historical judgment) is unchanged; current provenance is broken.
    expect((await withTenant(ctx, (tx) => listKnowledge(tx, ctx))).find((k) => k.id === id)!.verification).toBe('source_supported');
    expect((await withTenant(ctx, (tx) => assessKnowledgeProvenance(tx, ctx, id, 1))).state).toBe('broken');
  });

  it('artifact provenance resolves to the exact original representation, never modified content', async () => {
    const art = await getSetupDb().insert(artifacts).values({ orgId, projectId: ctx.projectId, name: 'out.md', kind: 'markdown', content: 'v1', sha256: 'ART_V1', sizeBytes: 2 }).returning({ id: artifacts.id });
    const id = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'From artifact', body: 'b', kind: 'fact', epistemicBasis: 'extracted' }));
    const srcId = await withTenant(ctx, (tx) => attachKnowledgeSource(tx, ctx, id, { sourceType: 'artifact', sourceRef: art[0]!.id, sourceLabel: 'out.md', sourceVersionHash: 'ART_V1', transformation: 'extracted' }));
    // Resolves at the cited version → judgment succeeds.
    await withTenant(ctx, (tx) => recordSupportJudgment(tx, ctx, id, { reliedOnSourceIds: [srcId] }));
    expect((await withTenant(ctx, (tx) => assessKnowledgeProvenance(tx, ctx, id, 1))).state).toBe('inspectable_support');
    // The artifact content changes → the old citation must NOT silently resolve to it.
    await getSetupDb().update(artifacts).set({ sha256: 'ART_V2' }).where(eq(artifacts.id, art[0]!.id));
    const prov = await withTenant(ctx, (tx) => assessKnowledgeProvenance(tx, ctx, id, 1));
    expect(prov.resolutions[0]!.outcome).toBe('version_mismatch');
    expect(prov.reliedBroken).toBe(true);
  });

  it('a broken supplemental source does not invalidate resolved relied-upon support; a broken relied source does', async () => {
    await mkDoc('canon/relied.md', 'RELIED_V1');
    await mkDoc('canon/supp.md', 'SUPP_V1');
    const id = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Relied vs supp', body: 'b', kind: 'fact', epistemicBasis: 'summarized' }));
    const reliedId = await withTenant(ctx, (tx) => attachKnowledgeSource(tx, ctx, id, { sourceType: 'document', sourceRef: 'canon/relied.md', sourceLabel: 'Relied', sourceVersionHash: 'RELIED_V1', transformation: 'summarized' }));
    await withTenant(ctx, (tx) => attachKnowledgeSource(tx, ctx, id, { sourceType: 'document', sourceRef: 'canon/supp.md', sourceLabel: 'Supplemental', sourceVersionHash: 'SUPP_V1', transformation: 'summarized' }));
    // Judgment relies ONLY on the relied source.
    await withTenant(ctx, (tx) => recordSupportJudgment(tx, ctx, id, { reliedOnSourceIds: [reliedId] }));

    // Break the SUPPLEMENTAL source → overall partial, but relied-upon support intact → usable.
    await getSetupDb().update(documents).set({ sha256: 'SUPP_V2' }).where(eq(documents.relativePath, 'canon/supp.md'));
    let prov = await withTenant(ctx, (tx) => assessKnowledgeProvenance(tx, ctx, id, 1));
    expect(prov.state).toBe('partial');
    expect(prov.reliedBroken).toBe(false);
    expect(prov.brokenForCurrentUse).toBe(false);

    // Now break the RELIED-upon source → present reliance is limited.
    await getSetupDb().update(documents).set({ sha256: 'RELIED_V2' }).where(eq(documents.relativePath, 'canon/relied.md'));
    prov = await withTenant(ctx, (tx) => assessKnowledgeProvenance(tx, ctx, id, 1));
    expect(prov.reliedBroken).toBe(true);
    expect(prov.brokenForCurrentUse).toBe(true);
    // The judgment still identifies exactly which relationships govern verification.
    expect(prov.reliedOnSourceIds).toEqual([reliedId]);
  });

  it('provenance is immutable after activation — a source change requires a new version', async () => {
    const id = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Immutable', body: 'b', kind: 'fact', activate: true }));
    await expect(
      withTenant(ctx, (tx) => attachKnowledgeSource(tx, ctx, id, { sourceType: 'document', sourceRef: 'canon/a.md', sourceLabel: 'A', sourceVersionHash: 'HA', transformation: 'extracted' })),
    ).rejects.toThrow(/only be attached to a draft|new version/i);
  });
});
