import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { documents, memberships, organizations, profiles, projectMembers, projects } from '@/db/schema';
import {
  activateKnowledge,
  attachKnowledgeSource,
  createKnowledge,
  listConsumerKnowledgeApplications,
  listInjectionsForKnowledge,
  logKnowledgeApplications,
  recordSupportJudgment,
  selectRelevantKnowledge,
} from '@/domain/knowledge/knowledge';

/**
 * PROVENANCE PART B — provenance resolved into LIVE selection + an immutable per-application trust
 * snapshot. What must hold: a source-dependent claim whose relied evidence can't be inspected at its
 * cited version is withheld from current-operational use but usable (qualified) for historical/reference
 * use; resolved relied evidence is named in the prompt while broken/missing evidence never leaks its
 * label; every application freezes the trust facts used at dispatch; a retry repeats the frozen snapshot
 * rather than re-resolving against records that may have changed.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[knowledge-provenance-selection.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

const userId = randomUUID();
let ctx: TenantContext;
let orgId = '';

async function mkDoc(relativePath: string, sha256: string): Promise<void> {
  await getSetupDb().insert(documents).values({ orgId, projectId: ctx.projectId, relativePath, kind: 'markdown', sha256, sizeBytes: 100 });
}

/** Create a source-supported, activated item relying on a single resolvable document source. */
async function makeSupported(opts: { title: string; body: string; docPath: string; hash: string; label: string }): Promise<{ id: string; srcId: string }> {
  await mkDoc(opts.docPath, opts.hash);
  const id = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: opts.title, body: opts.body, kind: 'fact', epistemicBasis: 'extracted' }));
  const srcId = await withTenant(ctx, (tx) =>
    attachKnowledgeSource(tx, ctx, id, { sourceType: 'document', sourceRef: opts.docPath, sourceLabel: opts.label, sourceVersionHash: opts.hash, transformation: 'extracted' }),
  );
  await withTenant(ctx, (tx) => recordSupportJudgment(tx, ctx, id, { reliedOnSourceIds: [srcId], rationale: 'the doc states it' }));
  await withTenant(ctx, (tx) => activateKnowledge(tx, ctx, id));
  return { id, srcId };
}

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  await db.insert(profiles).values({ id: userId, email: `provsel-${randomUUID().slice(0, 8)}@test.local`, displayName: 'ProvSel Tester' });
  const org = await db.insert(organizations).values({ name: 'ProvSel Org', slug: `provsel-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  const p = await db.insert(projects).values({ orgId, key: fixtureKey('provsel'), name: 'ProvSel Project' }).returning({ id: projects.id });
  await db.insert(projectMembers).values({ orgId, projectId: p[0]!.id, userId, role: 'admin' });
  ctx = { userId, orgId, projectId: p[0]!.id, orgRole: 'owner', projectRole: 'admin' };
});

afterAll(async () => {
  if (!available) return;
  await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});

describe.skipIf(!available)('provenance in live selection + application trust snapshot', () => {
  it('inspectable source-supported record is selected for current use and names its resolved evidence', async () => {
    await makeSupported({ title: 'Zephyr tariff', body: 'Zephyr tariff schedule for wholesale accounts.', docPath: 'canon/zephyr.md', hash: 'ZEP_V1', label: 'Zephyr.md' });
    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: 'zephyr tariff wholesale schedule', intendedUse: 'current_operational_fact' }));
    const hit = picked.find((k) => k.title === 'Zephyr tariff');
    expect(hit).toBeDefined();
    expect(hit!.memoryText).toContain('source-supported');
    expect(hit!.memoryText).toContain('Supported by: Zephyr.md');
    expect(hit!.trustSnapshot.provenanceState).toBe('inspectable_support');
    expect(hit!.trustSnapshot.renderingVersion).toBe('kv1');
  });

  it('a source-dependent claim with a broken relied source is WITHHELD from current operational use', async () => {
    const { id } = await makeSupported({ title: 'Quill rate', body: 'Quill rate card for premium partners.', docPath: 'canon/quill.md', hash: 'QUILL_V1', label: 'Quill.md' });
    // The cited version becomes unavailable after dispatch-era verification.
    await getSetupDb().update(documents).set({ sha256: 'QUILL_V2' }).where(eq(documents.relativePath, 'canon/quill.md'));
    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: 'quill rate premium partners card', intendedUse: 'current_operational_fact' }));
    expect(picked.find((k) => k.id === id)).toBeUndefined();
  });

  it('the same broken-provenance record IS usable (qualified) for historical analysis, without leaking the source label', async () => {
    const { id } = await makeSupported({ title: 'Marlin fee', body: 'Marlin fee ledger for archived cohorts.', docPath: 'canon/marlin.md', hash: 'MARLIN_V1', label: 'Marlin-secret.md' });
    await getSetupDb().update(documents).set({ sha256: 'MARLIN_V2' }).where(eq(documents.relativePath, 'canon/marlin.md'));
    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: 'marlin fee ledger archived cohorts', intendedUse: 'historical_analysis' }));
    const hit = picked.find((k) => k.id === id);
    expect(hit).toBeDefined();
    expect(hit!.memoryText).toContain('cited source version unavailable');
    // SENSITIVE-METADATA GUARD: the unresolvable source's label must never reach the prompt.
    expect(hit!.memoryText).not.toContain('Marlin-secret.md');
    expect(hit!.trustSnapshot.provenanceState).toBe('broken');
    expect(hit!.trustSnapshot.useState).toBe('usable_with_qualification');
  });

  it('a broken SUPPLEMENTAL source keeps the record usable for current facts, naming only resolved relied evidence', async () => {
    await mkDoc('canon/orbit-relied.md', 'OR_V1');
    await mkDoc('canon/orbit-supp.md', 'OS_V1');
    const id = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Orbit policy', body: 'Orbit policy for reconciliation windows.', kind: 'fact', epistemicBasis: 'summarized' }));
    const reliedId = await withTenant(ctx, (tx) => attachKnowledgeSource(tx, ctx, id, { sourceType: 'document', sourceRef: 'canon/orbit-relied.md', sourceLabel: 'Orbit-relied.md', sourceVersionHash: 'OR_V1', transformation: 'summarized' }));
    await withTenant(ctx, (tx) => attachKnowledgeSource(tx, ctx, id, { sourceType: 'document', sourceRef: 'canon/orbit-supp.md', sourceLabel: 'Orbit-supp-secret.md', sourceVersionHash: 'OS_V1', transformation: 'summarized' }));
    await withTenant(ctx, (tx) => recordSupportJudgment(tx, ctx, id, { reliedOnSourceIds: [reliedId] }));
    await withTenant(ctx, (tx) => activateKnowledge(tx, ctx, id));
    // Break only the supplemental source.
    await getSetupDb().update(documents).set({ sha256: 'OS_V2' }).where(eq(documents.relativePath, 'canon/orbit-supp.md'));

    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: 'orbit policy reconciliation windows', intendedUse: 'current_operational_fact' }));
    const hit = picked.find((k) => k.id === id);
    expect(hit).toBeDefined(); // relied-upon support intact → not withheld
    expect(hit!.memoryText).toContain('Supported by: Orbit-relied.md');
    expect(hit!.memoryText).not.toContain('Orbit-supp-secret.md'); // broken supplemental never leaks
    expect(hit!.trustSnapshot.provenanceState).toBe('partial');
    expect(hit!.trustSnapshot.reliedOnSourceIds).toEqual([reliedId]);
  });

  it('a manual assertion with no source is selected clean — no provenance phrase, no source line', async () => {
    const id = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Nimbus convention', body: 'Nimbus convention: greet partners by workspace handle.', kind: 'fact', activate: true }));
    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: 'nimbus convention greet partners handle', intendedUse: 'current_operational_fact' }));
    const hit = picked.find((k) => k.id === id);
    expect(hit).toBeDefined();
    expect(hit!.memoryText).not.toContain('source-supported');
    expect(hit!.memoryText).not.toContain('Supported by:');
    expect(hit!.trustSnapshot.provenanceState).toBe('no_source');
  });

  it('the application snapshot freezes the trust facts used at dispatch (resolutions, relied ids, support judgment)', async () => {
    const { id, srcId } = await makeSupported({ title: 'Cobalt terms', body: 'Cobalt terms for renewal notices.', docPath: 'canon/cobalt.md', hash: 'COB_V1', label: 'Cobalt.md' });
    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: 'cobalt terms renewal notices', intendedUse: 'current_operational_fact' }));
    const chosen = picked.filter((k) => k.id === id);
    const op = randomUUID();
    await withTenant(ctx, (tx) => logKnowledgeApplications(tx, ctx, { consumerType: 'objective_suggestion', consumerId: op, injected: chosen }));

    const frozen = await withTenant(ctx, (tx) => listConsumerKnowledgeApplications(tx, ctx, 'objective_suggestion', op));
    expect(frozen).toHaveLength(1);
    const snap = frozen[0]!.trustSnapshot!;
    expect(snap.provenanceState).toBe('inspectable_support');
    expect(snap.reliedOnSourceIds).toEqual([srcId]);
    expect(snap.resolutions).toEqual([{ sourceId: srcId, outcome: 'resolved', relied: true }]);
    expect(snap.supportJudgmentId).not.toBeNull();
    expect(snap.intendedUse).toBe('current_operational_fact');
    expect(snap.renderingVersion).toBe('kv1');
  });

  it('a retry repeats the frozen snapshot — a source breaking after dispatch does not re-resolve', async () => {
    const { id } = await makeSupported({ title: 'Vesper limit', body: 'Vesper limit for concurrent sessions.', docPath: 'canon/vesper.md', hash: 'VES_V1', label: 'Vesper.md' });
    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: 'vesper limit concurrent sessions', intendedUse: 'current_operational_fact' }));
    const chosen = picked.filter((k) => k.id === id);
    const op = randomUUID();
    await withTenant(ctx, (tx) => logKnowledgeApplications(tx, ctx, { consumerType: 'objective_suggestion', consumerId: op, injected: chosen }));
    const frozenText = chosen[0]!.memoryText;

    // The cited source breaks between attempts.
    await getSetupDb().update(documents).set({ sha256: 'VES_V2' }).where(eq(documents.relativePath, 'canon/vesper.md'));

    // The retry path reads the frozen application — unchanged text, unchanged provenance state.
    const frozen = await withTenant(ctx, (tx) => listConsumerKnowledgeApplications(tx, ctx, 'objective_suggestion', op));
    expect(frozen[0]!.memoryText).toBe(frozenText);
    expect(frozen[0]!.trustSnapshot!.provenanceState).toBe('inspectable_support');
  });

  it('the frozen snapshot is inspectable from the knowledge item side (reverse trail carries the version)', async () => {
    const { id } = await makeSupported({ title: 'Halcyon cap', body: 'Halcyon cap for burst throughput.', docPath: 'canon/halcyon.md', hash: 'HAL_V1', label: 'Halcyon.md' });
    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: 'halcyon cap burst throughput', intendedUse: 'current_operational_fact' }));
    const op = randomUUID();
    await withTenant(ctx, (tx) => logKnowledgeApplications(tx, ctx, { consumerType: 'objective_suggestion', consumerId: op, injected: picked.filter((k) => k.id === id) }));
    const trail = await withTenant(ctx, (tx) => listInjectionsForKnowledge(tx, ctx, id));
    const row = trail.find((t) => t.consumerId === op)!;
    expect(row.version).toBe(1);
    expect(row.memoryText).toContain('source-supported');
  });
});
