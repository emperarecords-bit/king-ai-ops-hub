import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type KnowledgeDisclosure, type TenantContext } from '@/types/domain';
import { type DbTx, getSetupDb } from '@/db/client';
import { agents, documentChunks, documentVersions, documents, knowledgeItems, knowledgeSources, knowledgeVerificationEvents, memberships, organizations, profiles, projectMembers, projects, runDocumentVersions, runs, tasks } from '@/db/schema';
import { chunkText, declassifyDocument, restrictDocument } from '@/domain/documents/documents';
import { backfillProject } from '@/domain/documents/backfill';
import { ingestDocumentVersion } from '@/domain/documents/versions';
import { LocalObjectStore } from '@/domain/documents/local-object-store';
import { tenantObjectKey } from '@/domain/documents/object-store';
import { type DocumentDetail, loadDocumentDetail } from '@/domain/documents/detail';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[document-detail.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

let storeDir = '';
let store: LocalObjectStore;
let orgId = '';
let ownerId = '';
const db = () => getSetupDb();
const shaOf = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const detail = (ctx: TenantContext, docId: string) => db().transaction((t) => loadDocumentDetail(t as unknown as DbTx, ctx, docId));

async function makeWorkspace(): Promise<TenantContext> {
  const p = await db().insert(projects).values({ orgId, key: fixtureKey('dt'), name: 'DT WS' }).returning({ id: projects.id });
  await db().insert(projectMembers).values({ orgId, projectId: p[0]!.id, userId: ownerId, role: 'admin' });
  return { userId: ownerId, orgId, projectId: p[0]!.id, orgRole: 'owner', projectRole: 'admin' };
}
async function addMember(ctx: TenantContext, role: 'admin' | 'member'): Promise<TenantContext> {
  const u = randomUUID();
  await db().insert(profiles).values({ id: u, email: `dm-${u.slice(0, 8)}@t.local`, displayName: 'DM' });
  await db().insert(projectMembers).values({ orgId: ctx.orgId, projectId: ctx.projectId, userId: u, role });
  return { userId: u, orgId: ctx.orgId, projectId: ctx.projectId, orgRole: 'member', projectRole: role };
}
function nonMemberCtx(ctx: TenantContext): TenantContext {
  return { userId: randomUUID(), orgId: ctx.orgId, projectId: ctx.projectId, orgRole: 'member', projectRole: 'member' };
}
async function runBackfill(ctx: TenantContext) {
  return db().transaction((t) => backfillProject(t, ctx, store, { operationId: randomUUID() }));
}
async function byteExactDoc(ctx: TenantContext, relPath: string, body: string, disclosure: KnowledgeDisclosure = 'workspace_internal') {
  const sha = shaOf(body);
  const key = tenantObjectKey({ orgId: ctx.orgId, projectId: ctx.projectId, sourceId: relPath, versionHash: sha });
  await store.put(key, Buffer.from(body, 'utf8'), 'text/markdown');
  const ins = await db().insert(documents).values({ orgId: ctx.orgId, projectId: ctx.projectId, source: 'cloud_upload', sourceId: relPath, relativePath: relPath, kind: 'markdown', sha256: sha, sizeBytes: 10, status: 'active', objectKey: key, mimeType: 'text/markdown', disclosure }).returning({ id: documents.id });
  const docId = ins[0]!.id;
  await db().insert(documentChunks).values(chunkText(body).map((content, i) => ({ orgId: ctx.orgId, projectId: ctx.projectId, documentId: docId, chunkIndex: i, content })));
  await db().update(documents).set({ chunkCount: chunkText(body).length, indexedAt: new Date() }).where(eq(documents.id, docId));
  await runBackfill(ctx);
  const v = (await db().select({ id: documentVersions.id }).from(documentVersions).where(and(eq(documentVersions.documentId, docId), eq(documentVersions.contentFidelity, 'byte_exact'))))[0]!;
  return { docId, versionId: v.id };
}
async function newVersion(ctx: TenantContext, docId: string, body: string): Promise<string> {
  return db().transaction((t) => ingestDocumentVersion(t as never, ctx, store, { documentId: docId, bytes: Buffer.from(body, 'utf8'), text: body, mimeType: 'text/markdown', disclosure: 'workspace_internal', chunk: chunkText }).then((r) => r.versionId));
}
async function addFailedNewerVersion(ctx: TenantContext, docId: string) {
  await db().insert(documentVersions).values({ orgId: ctx.orgId, projectId: ctx.projectId, documentId: docId, sha256: shaOf(docId + 'nf'), sizeBytes: 1, contentFidelity: 'reconstructed_text', indexStatus: 'failed', parserVersion: 'chunk-v1', createdAt: new Date(Date.now() + 60000) });
}
async function bindKnowledge(ctx: TenantContext, versionId: string, title: string): Promise<{ itemId: string; sourceId: string }> {
  const ki = await db().insert(knowledgeItems).values({ orgId: ctx.orgId, projectId: ctx.projectId, title, body: 'b', createdBy: ctx.userId }).returning({ id: knowledgeItems.id });
  const ks = await db().insert(knowledgeSources).values({ orgId: ctx.orgId, projectId: ctx.projectId, knowledgeItemId: ki[0]!.id, knowledgeVersion: 1, sourceType: 'document', sourceRef: title, sourceLabel: title, sourceVersionHash: shaOf('h'), transformation: 'quoted', documentVersionId: versionId }).returning({ id: knowledgeSources.id });
  return { itemId: ki[0]!.id, sourceId: ks[0]!.id };
}
async function recordRelied(ctx: TenantContext, itemId: string, sourceIds: string[]) {
  await db().insert(knowledgeVerificationEvents).values({ orgId: ctx.orgId, projectId: ctx.projectId, knowledgeItemId: itemId, knowledgeVersion: 1, judgment: 'source_supported', verifier: ctx.userId, reliedOnSourceIds: sourceIds, resolutionSnapshot: {} });
}
async function supplyToRun(ctx: TenantContext, versionId: string, chunkIndexes: number[]) {
  const a = await db().insert(agents).values({ orgId: ctx.orgId, projectId: ctx.projectId, name: 'a', role: 'primary', provider: 'openai', model: 'gpt-x', systemPrompt: 'x' }).returning({ id: agents.id });
  const t = await db().insert(tasks).values({ orgId: ctx.orgId, projectId: ctx.projectId, title: 't', input: 'x', providerSelection: 'openai', status: 'completed', createdBy: ctx.userId }).returning({ id: tasks.id });
  const r = await db().insert(runs).values({ orgId: ctx.orgId, projectId: ctx.projectId, taskId: t[0]!.id, status: 'completed', primaryAgentId: a[0]!.id }).returning({ id: runs.id });
  for (const ci of chunkIndexes) await db().insert(runDocumentVersions).values({ orgId: ctx.orgId, projectId: ctx.projectId, runId: r[0]!.id, documentVersionId: versionId, chunkIndex: ci, disclosureSnapshot: 'workspace_internal' });
  return r[0]!.id;
}
function asDetail(v: unknown): DocumentDetail {
  expect((v as { found: boolean }).found).toBe(true);
  return v as DocumentDetail;
}

beforeAll(async () => {
  if (!available) return;
  storeDir = await mkdtemp(join(tmpdir(), 'dt-store-'));
  process.env.LOCAL_OBJECT_STORE_DIR = storeDir;
  store = new LocalObjectStore(storeDir);
  ownerId = randomUUID();
  await db().insert(profiles).values({ id: ownerId, email: `dt-${randomUUID().slice(0, 8)}@t.local`, displayName: 'DT' });
  const org = await db().insert(organizations).values({ name: 'DT Org', slug: `dt-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db().insert(memberships).values({ orgId, userId: ownerId, role: 'owner' });
});
afterAll(async () => {
  if (available && orgId) {
    await db().execute(sql`alter table audit_logs disable trigger audit_logs_append_only`);
    await db().execute(sql`delete from audit_logs where org_id = ${orgId}`);
    await db().execute(sql`alter table audit_logs enable trigger audit_logs_append_only`);
    // knowledge_verification_events is append-only too — disable its guard so the org cascade can clean up.
    await db().execute(sql`alter table knowledge_verification_events disable trigger knowledge_verification_events_append_only`);
    await db().delete(organizations).where(eq(organizations.id, orgId));
    await db().execute(sql`alter table knowledge_verification_events enable trigger knowledge_verification_events_append_only`);
  }
  if (storeDir) await rm(storeDir, { recursive: true, force: true });
  delete process.env.LOCAL_OBJECT_STORE_DIR;
});

describe.skipIf(!available)('Documents Detail — shared audience-safe loader (Part 1)', () => {
  it('1. an authorized member can open an internal Document', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await byteExactDoc(ctx, 'internal.md', 'internal body');
    const member = await addMember(ctx, 'member');
    const d = asDetail(await detail(member, docId));
    expect(d.identity.relativePath).toBe('internal.md');
    expect(d.identity.lifecycleGroup).toBe('available');
    expect(d.restricted).toBe(false);
  });

  it('2. an ordinary member cannot discover a restricted Document Detail', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await byteExactDoc(ctx, 'secret.md', 'secret body', 'restricted');
    const member = await addMember(ctx, 'member');
    const res = await detail(member, docId);
    expect(res.found).toBe(false);
    if (!res.found) expect(res.reason).toBe('restricted_not_permitted');
  });

  it('5. a non-member receives a bounded denial without source-existence leakage', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await byteExactDoc(ctx, 'private-title.md', 'body');
    const outsider = nonMemberCtx(ctx);
    const res = await detail(outsider, docId);
    expect(res.found).toBe(false);
    if (!res.found) expect(res.reason).toBe('not_a_member');
  });

  it('6. an AI disclosure snapshot at dispatch does not grant a human Detail access', async () => {
    // Detail access is role-based on the CURRENT logical disclosure — never derived from an AI grant or a
    // historical dispatch snapshot. A run that received the (then-internal) version does not open the source.
    const ctx = await makeWorkspace();
    const { docId, versionId } = await byteExactDoc(ctx, 'was-internal.md', 'body');
    await supplyToRun(ctx, versionId, [0]); // an AI operation consumed it while internal
    await db().transaction((t) => restrictDocument(t as unknown as DbTx, ctx, docId)); // now restricted
    const member = await addMember(ctx, 'member');
    const res = await detail(member, docId);
    expect(res.found).toBe(false); // the past AI consumption grants this human nothing now
  });

  it('7/8. current Document and historical versions are distinct; current is selected by default', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId: v1 } = await byteExactDoc(ctx, 'multi.md', 'v1 body');
    const v2 = await newVersion(ctx, docId, 'v2 body');
    const d = asDetail(await detail(ctx, docId));
    expect(d.current.versionId).toBe(v2); // latest indexed is current by default
    expect(d.versions).toHaveLength(2);
    const cur = d.versions.find((v) => v.isCurrent)!;
    expect(cur.id).toBe(v2);
    expect(d.versions.find((v) => v.id === v1)!.isCurrent).toBe(false);
    expect(cur.isLatestSuccessful).toBe(true);
    // Deterministic reading order: oldest first.
    expect(d.versions[0]!.ordinal).toBe(1);
    expect(d.versions[0]!.id).toBe(v1);
  });

  it('16. a newer failed version appears separately while the current remains usable', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId } = await byteExactDoc(ctx, 'newerfail.md', 'good body');
    await addFailedNewerVersion(ctx, docId);
    const d = asDetail(await detail(ctx, docId));
    expect(d.current.versionId).toBe(versionId); // current stays usable
    expect(d.current.newerVersion).toBe('failed');
    const failed = d.versions.find((v) => v.indexStatus === 'failed')!;
    expect(failed.newerThanCurrent).toBe(true);
    expect(failed.isCurrent).toBe(false);
  });

  it('17. classification snapshots remain historical when present policy changes', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await byteExactDoc(ctx, 'reclass.md', 'body', 'restricted');
    const beforeSnap = asDetail(await detail(ctx, docId)).versions[0]!.disclosureSnapshot;
    await db().transaction((t) => declassifyDocument(t as unknown as DbTx, ctx, docId, 'no longer sensitive'));
    const d = asDetail(await detail(ctx, docId));
    expect(d.classification.currentLogicalDisclosure).toBe('workspace_internal'); // present policy loosened
    expect(d.versions[0]!.disclosureSnapshot).toBe(beforeSnap); // ingest snapshot unchanged (history intact)
  });

  it('18. present restriction governs present access (a version internal at ingest is gated once restricted)', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await byteExactDoc(ctx, 'nowrestricted.md', 'body'); // ingested internal
    const member = await addMember(ctx, 'member');
    expect(asDetail(await detail(member, docId)).identity.relativePath).toBe('nowrestricted.md'); // visible while internal
    await db().transaction((t) => restrictDocument(t as unknown as DbTx, ctx, docId));
    expect((await detail(member, docId)).found).toBe(false); // gated now
    expect(asDetail(await detail(ctx, docId)).restricted).toBe(true); // admin still sees it, marked restricted
  });

  it('19/20. Knowledge relationships are explicit only; relied-upon and supplemental stay distinct', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId } = await byteExactDoc(ctx, 'cited.md', 'cited body');
    const relied = await bindKnowledge(ctx, versionId, 'Relied item');
    const supp = await bindKnowledge(ctx, versionId, 'Supplemental item');
    await recordRelied(ctx, relied.itemId, [relied.sourceId]); // only one is recorded as relied-upon
    const d = asDetail(await detail(ctx, docId));
    expect(d.knowledge).toHaveLength(2); // exactly the two explicit bindings, nothing implied
    expect(d.knowledge.find((k) => k.knowledgeSourceId === relied.sourceId)!.reliedUpon).toBe(true);
    expect(d.knowledge.find((k) => k.knowledgeSourceId === supp.sourceId)!.reliedUpon).toBe(false);
    expect(d.knowledge.every((k) => k.documentVersionId === versionId)).toBe(true);
  });

  it('21. AI operation relationships deduplicate by run', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId } = await byteExactDoc(ctx, 'supplied.md', 'body');
    await supplyToRun(ctx, versionId, [-1, 0, 1, 2]); // one run, a version-level sentinel + 3 chunk rows
    const d = asDetail(await detail(ctx, docId));
    expect(d.aiOperations).toHaveLength(1); // ONE AI operation, not four
    expect(d.aiOperationCount).toBe(1);
    const supplied = d.aiOperations[0]!.suppliedVersions[0]!;
    expect(supplied.suppliedChunkCount).toBe(3); // the -1 sentinel is not a supplied chunk
    expect(d.aiOperations[0]!.provider).toBe('openai');
  });

  it('24. the exact version hash is present for an authorized viewer (UI gates its display)', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await byteExactDoc(ctx, 'hash.md', 'hash body');
    const d = asDetail(await detail(ctx, docId));
    expect(d.current.versionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(d.versions[0]!.versionHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('31. Detail loading avoids N+1 — a bounded query count regardless of versions/relationships', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId } = await byteExactDoc(ctx, 'nplus1.md', 'body');
    for (let i = 0; i < 5; i += 1) await newVersion(ctx, docId, `rev ${i}`);
    await bindKnowledge(ctx, versionId, 'k');
    await supplyToRun(ctx, versionId, [0, 1]);
    const count = async () => {
      let selects = 0;
      await db().transaction((t) => {
        const proxied = new Proxy(t, {
          get(target, prop, recv) {
            const val = Reflect.get(target, prop, recv);
            if (prop === 'select' || prop === 'selectDistinct') return (...args: unknown[]) => { selects += 1; return (val as (...a: unknown[]) => unknown).apply(target, args); };
            return typeof val === 'function' ? (val as (...a: unknown[]) => unknown).bind(target) : val;
          },
        });
        return loadDocumentDetail(proxied as unknown as DbTx, ctx, docId);
      });
      return selects;
    };
    expect(await count()).toBeLessThanOrEqual(14);
  });

  it('32. a serialized unauthorized result contains no restricted identity or metadata', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await byteExactDoc(ctx, 'topsecret-projectname.md', 'confidential contents', 'restricted');
    const member = await addMember(ctx, 'member');
    const res = await detail(member, docId);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('topsecret-projectname');
    expect(serialized).not.toContain('confidential');
    expect(serialized).not.toContain(docId);
  });
});
