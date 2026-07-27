import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type KnowledgeDisclosure, type RetrievalMode, type RunSourceSnapshot, type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { agents, documentChunks, documentVersions, documents, memberships, organizations, profiles, projectMembers, projects, runDocumentVersions, runs, tasks } from '@/db/schema';
import { retrieveRelevant } from '@/domain/documents/documents';
import { retrieveRelevantVersioned, selectCoreReferencesVersioned, selectProductionStatusVersioned } from '@/domain/documents/retrieval-versioned';
import { backfillProject } from '@/domain/documents/backfill';
import { assembleDocumentSources, getRetrievalMode, setRetrievalMode } from '@/domain/documents/retrieval-mode';
import { runShadowCorpus, shadowCompareQuery, buildDocMeta } from '@/domain/documents/shadow';
import { isVersionReferenced, runsReferencingVersion, writeRunVersionEvidence } from '@/domain/documents/references';
import { LocalObjectStore } from '@/domain/documents/local-object-store';

/**
 * Documents increment 1, Stage C2 — versioned retrieval, shadow comparison, controlled switch, evidence
 * writes, rollback. The 32 required C2 tests. Backfill runs through the migration-role connection; the
 * object store is the hermetic LocalObjectStore.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[document-c2.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

let storeDir = '';
let store: LocalObjectStore;
let orgId = '';
let userId = '';

const db = () => getSetupDb();
const shaOf = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

async function makeWorkspace(): Promise<TenantContext> {
  const p = await db().insert(projects).values({ orgId, key: fixtureKey('c2'), name: 'C2 WS' }).returning({ id: projects.id });
  await db().insert(projectMembers).values({ orgId, projectId: p[0]!.id, userId, role: 'admin' });
  return { userId, orgId, projectId: p[0]!.id, orgRole: 'owner', projectRole: 'admin' };
}

/** Create an active local doc with legacy chunks and backfill it → reconstructed current version + version
 *  chunks (copies). Returns { docId, versionId }. */
async function makeVersionedDoc(ctx: TenantContext, relPath: string, chunks: string[], disclosure: KnowledgeDisclosure = 'workspace_internal'): Promise<{ docId: string; versionId: string }> {
  const body = chunks.join('\n\n');
  const ins = await db()
    .insert(documents)
    .values({ orgId: ctx.orgId, projectId: ctx.projectId, source: 'local_folder', sourceId: relPath, relativePath: relPath, kind: 'markdown', sha256: shaOf(body), sizeBytes: Buffer.byteLength(body, 'utf8'), status: 'active', disclosure })
    .returning({ id: documents.id });
  const docId = ins[0]!.id;
  await db().insert(documentChunks).values(chunks.map((content, i) => ({ orgId: ctx.orgId, projectId: ctx.projectId, documentId: docId, chunkIndex: i, content })));
  await db().update(documents).set({ chunkCount: chunks.length, indexedAt: new Date() }).where(eq(documents.id, docId));
  await runBackfill(ctx);
  const v = (await db().select({ id: documentVersions.id }).from(documentVersions).where(and(eq(documentVersions.documentId, docId), eq(documentVersions.indexStatus, 'indexed'))))[0]!;
  return { docId, versionId: v.id };
}

async function runBackfill(ctx: TenantContext) {
  return db().transaction((t) => backfillProject(t, ctx, store, { operationId: randomUUID() }));
}

/** Insert a NON-current version (with its own chunks) directly, to prove exclusion. */
async function insertSideVersion(ctx: TenantContext, docId: string, fidelity: 'byte_exact' | 'unavailable', indexStatus: 'indexed' | 'failed', chunkText: string): Promise<string> {
  const sha = shaOf(`${docId}:${chunkText}:${fidelity}:${indexStatus}`);
  const v = await db()
    .insert(documentVersions)
    .values({ orgId: ctx.orgId, projectId: ctx.projectId, documentId: docId, sha256: sha, sizeBytes: 1, contentFidelity: fidelity, indexStatus, objectKey: fidelity === 'byte_exact' ? `org/${ctx.orgId}/project/${ctx.projectId}/doc/${docId}/${sha}` : null, parserVersion: 'chunk-v1' })
    .returning({ id: documentVersions.id });
  const vId = v[0]!.id;
  await db().insert(documentChunks).values({ orgId: ctx.orgId, projectId: ctx.projectId, documentId: docId, documentVersionId: vId, chunkIndex: 0, content: chunkText, parserVersion: 'chunk-v1', contentHash: shaOf(chunkText) });
  return vId;
}

async function setMode(ctx: TenantContext, mode: RetrievalMode) {
  await withTenant(ctx, (t) => setRetrievalMode(t, ctx, mode));
}

async function makeRun(ctx: TenantContext, snapshot: RunSourceSnapshot[]): Promise<string> {
  const a = await db().insert(agents).values({ orgId: ctx.orgId, projectId: ctx.projectId, name: 'a', role: 'primary', provider: 'openai', model: 'm', systemPrompt: 'x' }).returning({ id: agents.id });
  const t = await db().insert(tasks).values({ orgId: ctx.orgId, projectId: ctx.projectId, title: 't', input: 'x', providerSelection: 'openai', status: 'completed', createdBy: ctx.userId }).returning({ id: tasks.id });
  const r = await db().insert(runs).values({ orgId: ctx.orgId, projectId: ctx.projectId, taskId: t[0]!.id, status: 'completed', primaryAgentId: a[0]!.id, retrievedSources: snapshot }).returning({ id: runs.id });
  return r[0]!.id;
}

beforeAll(async () => {
  if (!available) return;
  storeDir = await mkdtemp(join(tmpdir(), 'c2-store-'));
  process.env.LOCAL_OBJECT_STORE_DIR = storeDir;
  store = new LocalObjectStore(storeDir);
  userId = randomUUID();
  await db().insert(profiles).values({ id: userId, email: `c2-${randomUUID().slice(0, 8)}@t.local`, displayName: 'C2' });
  const org = await db().insert(organizations).values({ name: 'C2 Org', slug: `c2-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db().insert(memberships).values({ orgId, userId, role: 'owner' });
});

afterAll(async () => {
  if (available && orgId) {
    await db().execute(sql`alter table audit_logs disable trigger audit_logs_append_only`);
    await db().execute(sql`delete from audit_logs where org_id = ${orgId}`);
    await db().execute(sql`alter table audit_logs enable trigger audit_logs_append_only`);
    await db().delete(organizations).where(eq(organizations.id, orgId));
  }
  if (storeDir) await rm(storeDir, { recursive: true, force: true });
  delete process.env.LOCAL_OBJECT_STORE_DIR;
});

const V = (ctx: TenantContext, q: string, limit = 5) => withTenant(ctx, (t) => retrieveRelevantVersioned(t, ctx, q, limit));
const L = (ctx: TenantContext, q: string, limit = 5) => withTenant(ctx, (t) => retrieveRelevant(t, ctx, q, limit));

describe.skipIf(!available)('Stage C2 — versioned retrieval, shadow, switch, evidence, rollback', () => {
  it('1. duplicate unavailable placeholders are rejected at the database boundary', async () => {
    const ctx = await makeWorkspace();
    const docId = (await db().insert(documents).values({ orgId: ctx.orgId, projectId: ctx.projectId, source: 'local_folder', relativePath: 'dup.md', kind: 'markdown', sha256: shaOf('h'), sizeBytes: 1, status: 'source_unavailable' }).returning({ id: documents.id }))[0]!.id;
    const sha = shaOf('expected-hash');
    await db().insert(documentVersions).values({ orgId: ctx.orgId, projectId: ctx.projectId, documentId: docId, sha256: sha, sizeBytes: 1, contentFidelity: 'unavailable', indexStatus: 'failed' });
    // A second unavailable placeholder with the same (document, hash) must be rejected by the partial index.
    let rejected = false;
    try {
      await db().insert(documentVersions).values({ orgId: ctx.orgId, projectId: ctx.projectId, documentId: docId, sha256: sha, sizeBytes: 1, contentFidelity: 'unavailable', indexStatus: 'failed' });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  it('2/3. versioned retrieval reads only currentVersionId; prior-version chunks are excluded', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await makeVersionedDoc(ctx, 'cur.md', ['kubernetes replicas run the cluster']);
    // An older indexed version with a unique term that is NOT current.
    await insertSideVersion(ctx, docId, 'byte_exact', 'indexed', 'zzpriorterm only in the old version');
    const hitsCur = await V(ctx, 'kubernetes replicas');
    expect(hitsCur.some((h) => h.relativePath === 'cur.md')).toBe(true);
    const hitsPrior = await V(ctx, 'zzpriorterm');
    expect(hitsPrior.length).toBe(0); // prior-version chunk never surfaces
  });

  it('4. failed-version chunks are excluded', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await makeVersionedDoc(ctx, 'fail.md', ['current indexed content']);
    await insertSideVersion(ctx, docId, 'byte_exact', 'failed', 'zzfailedterm inside a failed version');
    expect((await V(ctx, 'zzfailedterm')).length).toBe(0);
  });

  it('5. an unavailable-version chunk is never returned by versioned retrieval', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await makeVersionedDoc(ctx, 'sidefidelity.md', ['current indexed content here']);
    // A (defective) chunk attached to an unavailable, non-current version must never surface.
    await insertSideVersion(ctx, docId, 'unavailable', 'failed', 'zzunavailterm inside an unavailable version');
    expect((await V(ctx, 'zzunavailterm')).length).toBe(0);
  });

  it('6. source_unavailable Documents are excluded (no current version)', async () => {
    const ctx = await makeWorkspace();
    // No chunks + no folder → backfill classifies unavailable → the Document becomes source_unavailable.
    await db().insert(documents).values({ orgId: ctx.orgId, projectId: ctx.projectId, source: 'local_folder', relativePath: 'unav.md', kind: 'markdown', sha256: shaOf('zzgoneterm'), sizeBytes: 1, status: 'active' });
    await makeVersionedDoc(ctx, 'other.md', ['zzgoneterm also appears in a retrievable doc']); // control
    await runBackfill(ctx);
    const doc = (await db().select({ s: documents.status, c: documents.currentVersionId }).from(documents).where(and(eq(documents.projectId, ctx.projectId), eq(documents.relativePath, 'unav.md'))))[0]!;
    expect(doc.s).toBe('source_unavailable');
    expect(doc.c).toBeNull();
    // Retrieval finds the control doc but never the source_unavailable one.
    const hits = await V(ctx, 'zzgoneterm');
    expect(hits.some((h) => h.relativePath === 'other.md')).toBe(true);
    expect(hits.some((h) => h.relativePath === 'unav.md')).toBe(false);
  });

  it('7. archived Documents are excluded from versioned retrieval', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await makeVersionedDoc(ctx, 'arch.md', ['zzarchterm to be archived']);
    await db().update(documents).set({ status: 'archived' }).where(eq(documents.id, docId));
    expect((await V(ctx, 'zzarchterm')).length).toBe(0);
  });

  it('8/9/10/11. legacy and versioned agree on a byte_exact/reconstructed Document (content, order, hash, disclosure)', async () => {
    const ctx = await makeWorkspace();
    await makeVersionedDoc(ctx, 'agree.md', ['enterprise pricing is five hundred dollars per seat', 'discounts apply for annual billing']);
    const legacy = await L(ctx, 'enterprise pricing per seat');
    const versioned = await V(ctx, 'enterprise pricing per seat');
    expect(versioned.length).toBe(legacy.length);
    expect(versioned.length).toBeGreaterThan(0);
    for (let i = 0; i < legacy.length; i += 1) {
      expect(versioned[i]!.relativePath).toBe(legacy[i]!.relativePath); // ordering matches
      expect(versioned[i]!.chunkIndex).toBe(legacy[i]!.chunkIndex);
      expect(shaOf(versioned[i]!.content)).toBe(shaOf(legacy[i]!.content)); // content hashes match
      expect(versioned[i]!.disclosure).toBe(legacy[i]!.disclosure); // disclosure matches
      expect(versioned[i]!.documentVersionId).toBeTruthy(); // version-bound
    }
  });

  it('12. restricted content is withheld by the versioned path without a grant (legacy leaked it)', async () => {
    const ctx = await makeWorkspace();
    await makeVersionedDoc(ctx, 'restricted.md', ['zzrestrictedterm sensitive content'], 'restricted');
    // The versioned V() helper passes no access decision ⇒ restricted is withheld inside retrieval.
    const versioned = await V(ctx, 'zzrestrictedterm');
    expect(versioned.some((h) => h.relativePath === 'restricted.md')).toBe(false);
    // Legacy (being retired) still returns it tagged restricted — the divergence the switch corrects.
    const legacy = await L(ctx, 'zzrestrictedterm');
    expect(legacy[0]?.disclosure).toBe('restricted');
  });

  it('13/14. cross-workspace sources are absent; same terms in another tenant do not affect results', async () => {
    const a = await makeWorkspace();
    const b = await makeWorkspace();
    await makeVersionedDoc(a, 'a.md', ['zzsharedterm appears in workspace A']);
    await makeVersionedDoc(b, 'b.md', ['zzsharedterm appears in workspace B']);
    const inA = await V(a, 'zzsharedterm');
    expect(inA.every((h) => h.relativePath === 'a.md')).toBe(true);
    expect(inA.some((h) => h.relativePath === 'b.md')).toBe(false);
  });

  it('15. core-reference selection matches between paths', async () => {
    const ctx = await makeWorkspace();
    await makeVersionedDoc(ctx, 'Character_Bible.md', ['the cast and their canonical traits']);
    await makeVersionedDoc(ctx, 'Story_Bible.md', ['the season arc and world rules']);
    const legacy = await withTenant(ctx, (t) => import('@/domain/documents/documents').then((m) => m.selectCoreReferences(t, ctx, new Set(), 2)));
    const versioned = await withTenant(ctx, (t) => selectCoreReferencesVersioned(t, ctx, new Set(), 2));
    expect(versioned.map((c) => c.relativePath)).toEqual(legacy.map((c) => c.relativePath));
  });

  it('16. production-status selection matches between paths', async () => {
    const ctx = await makeWorkspace();
    await makeVersionedDoc(ctx, 'Season1_Production_Status.md', ['episodes 1-3 locked; 4 in review']);
    const legacy = await withTenant(ctx, (t) => import('@/domain/documents/documents').then((m) => m.selectProductionStatus(t, ctx, new Set())));
    const versioned = await withTenant(ctx, (t) => selectProductionStatusVersioned(t, ctx, new Set()));
    expect(versioned?.relativePath).toBe(legacy?.relativePath);
    expect(versioned?.documentVersionId).toBeTruthy();
  });

  it('17. no-result behavior matches', async () => {
    const ctx = await makeWorkspace();
    await makeVersionedDoc(ctx, 'nr.md', ['ordinary content']);
    expect(await V(ctx, 'zxqw plumbus frobnicate')).toEqual([]);
    expect(await L(ctx, 'zxqw plumbus frobnicate')).toEqual([]);
  });

  it('18. tied relevance scores use deterministic ordering on both paths', async () => {
    const ctx = await makeWorkspace();
    // Two docs with identical content → identical ts_rank → tie broken deterministically by path then chunk.
    await makeVersionedDoc(ctx, 'tie_b.md', ['zztieterm identical body text here']);
    await makeVersionedDoc(ctx, 'tie_a.md', ['zztieterm identical body text here']);
    const v1 = (await V(ctx, 'zztieterm')).map((h) => h.relativePath);
    const v2 = (await V(ctx, 'zztieterm')).map((h) => h.relativePath);
    expect(v1).toEqual(v2); // stable across runs
    expect(v1).toEqual([...v1].sort()); // deterministic by relativePath on ties
  });

  it('18b. REGRESSION: at the top-N limit, tied scores select the SAME deterministic set on both paths', async () => {
    const ctx = await makeWorkspace();
    // Three documents with identical content ⇒ identical ts_rank. With limit 2, a naive nondeterministic
    // order could truncate a DIFFERENT two. The stable tie-break (relativePath, chunkIndex) on both paths
    // makes the selected top-2 identical and repeatable.
    await makeVersionedDoc(ctx, 'boundary_c.md', ['zzboundterm identical tied body text']);
    await makeVersionedDoc(ctx, 'boundary_a.md', ['zzboundterm identical tied body text']);
    await makeVersionedDoc(ctx, 'boundary_b.md', ['zzboundterm identical tied body text']);
    const legacy = (await L(ctx, 'zzboundterm', 2)).map((h) => h.relativePath);
    const versioned = (await V(ctx, 'zzboundterm', 2)).map((h) => h.relativePath);
    expect(legacy.length).toBe(2);
    expect(versioned).toEqual(legacy); // same selected set + order across paths
    expect(versioned).toEqual(['boundary_a.md', 'boundary_b.md']); // deterministic by stable identity
    // Repeatable.
    expect((await L(ctx, 'zzboundterm', 2)).map((h) => h.relativePath)).toEqual(legacy);
  });

  it('19/20/21. shadow mode does not change the authoritative result, writes no evidence, and never throws', async () => {
    const ctx = await makeWorkspace();
    await makeVersionedDoc(ctx, 'shadow.md', ['shadow comparison content about pricing']);
    await setMode(ctx, 'shadow');
    const before = (await db().select({ id: runDocumentVersions.id }).from(runDocumentVersions).where(eq(runDocumentVersions.projectId, ctx.projectId))).length;
    const shadow = await withTenant(ctx, (t) => assembleDocumentSources(t, ctx, 'pricing', 5));
    const legacy = await L(ctx, 'pricing');
    expect(shadow.versioned).toBe(false); // legacy authoritative under shadow
    expect(shadow.retrieved.map((r) => r.relativePath)).toEqual(legacy.map((r) => r.relativePath));
    const after = (await db().select({ id: runDocumentVersions.id }).from(runDocumentVersions).where(eq(runDocumentVersions.projectId, ctx.projectId))).length;
    expect(after).toBe(before); // shadow wrote no evidence rows
  });

  it('22. versioned mode returns a documentVersionId in every Document result', async () => {
    const ctx = await makeWorkspace();
    await makeVersionedDoc(ctx, 'v1.md', ['versioned mode content one']);
    await makeVersionedDoc(ctx, 'Character_Bible.md', ['canon']);
    await setMode(ctx, 'versioned');
    const asm = await withTenant(ctx, (t) => assembleDocumentSources(t, ctx, 'versioned mode content', 5));
    expect(asm.versioned).toBe(true);
    for (const r of [...asm.retrieved, ...asm.coreRefs, ...(asm.productionStatus ? [asm.productionStatus] : [])]) {
      expect(r.documentVersionId).toBeTruthy();
    }
  });

  it('23/24/25/26. versioned dispatch writes the snapshot + normalized refs (idempotent, deduped)', async () => {
    const ctx = await makeWorkspace();
    const { versionId } = await makeVersionedDoc(ctx, 'ev.md', ['evidence content first chunk', 'evidence content second chunk']);
    await setMode(ctx, 'versioned');
    const asm = await withTenant(ctx, (t) => assembleDocumentSources(t, ctx, 'evidence content', 5));
    const supplied = [...asm.retrieved, ...asm.coreRefs, ...(asm.productionStatus ? [asm.productionStatus] : [])];
    // 23. Immutable snapshot carries version ids.
    const snapshot: RunSourceSnapshot[] = supplied.map((r) => ({ relativePath: r.relativePath, sha256: r.sha256, disclosure: r.disclosure, chunkIndex: r.chunkIndex, rank: r.rank, excerpt: r.content, documentVersionId: r.documentVersionId }));
    expect(snapshot.every((s) => !!s.documentVersionId)).toBe(true);
    const runId = await makeRun(ctx, snapshot);
    // 24. Normalized refs (version-level + chunk-level) written.
    const write1 = await withTenant(ctx, (t) => writeRunVersionEvidence(t, ctx, runId, supplied.filter((r) => r.documentVersionId).map((r) => ({ documentVersionId: r.documentVersionId!, chunkIndex: r.chunkIndex, rank: r.rank, disclosure: r.disclosure }))));
    expect(write1.versionLevel).toBeGreaterThanOrEqual(1);
    expect(write1.chunkLevel).toBeGreaterThanOrEqual(2);
    // 25. Repeated write is idempotent.
    const write2 = await withTenant(ctx, (t) => writeRunVersionEvidence(t, ctx, runId, supplied.filter((r) => r.documentVersionId).map((r) => ({ documentVersionId: r.documentVersionId!, chunkIndex: r.chunkIndex, rank: r.rank, disclosure: r.disclosure }))));
    expect(write2.versionLevel).toBe(0);
    expect(write2.chunkLevel).toBe(0);
    // 26. One run remains one run in the reverse trail despite multiple chunk rows.
    const runsRef = await withTenant(ctx, (t) => runsReferencingVersion(t, ctx, versionId));
    expect(runsRef).toEqual([runId]);
    expect(await withTenant(ctx, (t) => isVersionReferenced(t, ctx, versionId))).toBe(true);
  });

  it('27. the retrieval mode is server-authoritative and cannot be forged by a caller', async () => {
    const ctx = await makeWorkspace();
    // Default is legacy; getRetrievalMode reads ONLY the stored workspace value (no client-supplied input).
    expect(await withTenant(ctx, (t) => getRetrievalMode(t, ctx))).toBe('legacy');
    await setMode(ctx, 'versioned');
    expect(await withTenant(ctx, (t) => getRetrievalMode(t, ctx))).toBe('versioned');
    // assembleDocumentSources takes no mode argument — the caller cannot request a different mode.
    const asm = await withTenant(ctx, (t) => assembleDocumentSources(t, ctx, 'anything', 5));
    expect(asm.mode).toBe('versioned');
  });

  it('28. rollout is workspace-specific', async () => {
    const a = await makeWorkspace();
    const b = await makeWorkspace();
    await makeVersionedDoc(a, 'wa.md', ['workspace a rollout content']);
    await makeVersionedDoc(b, 'wb.md', ['workspace b rollout content']);
    await setMode(a, 'versioned');
    // b stays legacy
    const asmA = await withTenant(a, (t) => assembleDocumentSources(t, a, 'rollout content', 5));
    const asmB = await withTenant(b, (t) => assembleDocumentSources(t, b, 'rollout content', 5));
    expect(asmA.versioned).toBe(true);
    expect(asmB.versioned).toBe(false);
  });

  it('29. switching back to legacy preserves versioned historical evidence', async () => {
    const ctx = await makeWorkspace();
    const { versionId } = await makeVersionedDoc(ctx, 'roll.md', ['rollback evidence content']);
    await setMode(ctx, 'versioned');
    const asm = await withTenant(ctx, (t) => assembleDocumentSources(t, ctx, 'rollback evidence', 5));
    const supplied = [...asm.retrieved].filter((r) => r.documentVersionId);
    const snapshot: RunSourceSnapshot[] = supplied.map((r) => ({ relativePath: r.relativePath, sha256: r.sha256, disclosure: r.disclosure, chunkIndex: r.chunkIndex, rank: r.rank, excerpt: r.content, documentVersionId: r.documentVersionId }));
    const runId = await makeRun(ctx, snapshot);
    await withTenant(ctx, (t) => writeRunVersionEvidence(t, ctx, runId, supplied.map((r) => ({ documentVersionId: r.documentVersionId!, chunkIndex: r.chunkIndex, rank: r.rank, disclosure: r.disclosure }))));
    const snapBefore = JSON.stringify((await db().select({ s: runs.retrievedSources }).from(runs).where(eq(runs.id, runId)))[0]!.s);
    // Roll back to legacy.
    await setMode(ctx, 'legacy');
    expect(await withTenant(ctx, (t) => getRetrievalMode(t, ctx))).toBe('legacy');
    // Historical evidence + snapshot survive rollback unchanged.
    expect(await withTenant(ctx, (t) => isVersionReferenced(t, ctx, versionId))).toBe(true);
    const snapAfter = JSON.stringify((await db().select({ s: runs.retrievedSources }).from(runs).where(eq(runs.id, runId)))[0]!.s);
    expect(snapAfter).toBe(snapBefore);
    // Legacy chunks + columns remain intact (legacy retrieval still works).
    expect((await L(ctx, 'rollback evidence')).length).toBeGreaterThan(0);
  });

  it('30. source-unavailable Documents are reported as expected exclusions, not silent omissions', async () => {
    const ctx = await makeWorkspace();
    await makeVersionedDoc(ctx, 'present.md', ['retrievable content about deployment']);
    // A source-unavailable doc (no bytes, no chunks) — corrected by backfill.
    await db().insert(documents).values({ orgId: ctx.orgId, projectId: ctx.projectId, source: 'local_folder', relativePath: 'gone.md', kind: 'markdown', sha256: shaOf('gone'), sizeBytes: 1, status: 'active' });
    await runBackfill(ctx);
    const report = await withTenant(ctx, (t) => runShadowCorpus(t, ctx, ['deployment content'], 5));
    expect(report.expectedNonRetrievable.some((d) => d.relativePath === 'gone.md' && d.status === 'source_unavailable')).toBe(true);
    expect(report.retrievableDocuments).toBeGreaterThanOrEqual(1);
  });

  it('31. shadow comparison reports carry hashes/ids but no source text', async () => {
    const ctx = await makeWorkspace();
    const legacyText = 'zzsecretbodytext should never appear in a comparison report';
    const { docId } = await makeVersionedDoc(ctx, 'secret.md', [legacyText]);
    // Force a difference so the report populates a difference detail (where hashes live).
    const curV = (await db().select({ c: documents.currentVersionId }).from(documents).where(eq(documents.id, docId)))[0]!.c!;
    const tampered = 'zzsecretbodytext different privileged text that must also never leak';
    await db().update(documentChunks).set({ content: tampered }).where(and(eq(documentChunks.documentVersionId, curV), eq(documentChunks.chunkIndex, 0)));
    const docMeta = await withTenant(ctx, (t) => buildDocMeta(t, ctx));
    const cmp = await withTenant(ctx, (t) => shadowCompareQuery(t, ctx, 'zzsecretbodytext', docMeta, 5));
    const json = JSON.stringify(cmp);
    // No source text from EITHER side.
    expect(json).not.toContain('should never appear');
    expect(json).not.toContain('privileged text');
    // But the difference carries content hashes + ids.
    expect(cmp.differences.length).toBeGreaterThanOrEqual(1);
    expect(json).toContain(shaOf(legacyText)); // legacy chunk-content hash present
    expect(json).toContain(shaOf(tampered)); // versioned chunk-content hash present
  });

  it('32. an unexplained (versioned-defect) difference blocks the switch', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await makeVersionedDoc(ctx, 'defect.md', ['legacy has this chunk about migration']);
    // Simulate a versioned defect: the current version's chunk is corrupted so content hashes diverge from
    // the legacy null-version chunk (versioned returns different content than legacy for the same key).
    const curVersionId = (await db().select({ c: documents.currentVersionId }).from(documents).where(eq(documents.id, docId)))[0]!.c!;
    await db().update(documentChunks).set({ content: 'legacy has this chunk about migration TAMPERED' }).where(and(eq(documentChunks.documentVersionId, curVersionId), eq(documentChunks.chunkIndex, 0)));
    const report = await withTenant(ctx, (t) => runShadowCorpus(t, ctx, ['migration'], 5));
    expect(report.switchClear).toBe(false);
    expect(report.byCategory.versioned_defect).toBeGreaterThanOrEqual(1);
  });
});
