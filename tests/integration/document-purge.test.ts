import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type RunSourceSnapshot, type TenantContext } from '@/types/domain';
import { type DbTx, getSetupDb } from '@/db/client';
import { agents, auditLogs, documentChunks, documentDisclosureGrants, documentJobs, documentPurgeOperations, documentVersionTombstones, documentVersions, documents, knowledgeItems, knowledgeSources, memberships, objectCleanupOperations, organizations, profiles, projectMembers, projects, runDocumentVersions, runs, tasks } from '@/db/schema';
import { chunkText } from '@/domain/documents/documents';
import { backfillProject } from '@/domain/documents/backfill';
import { ingestDocumentVersion } from '@/domain/documents/versions';
import { LocalObjectStore } from '@/domain/documents/local-object-store';
import { type ObjectStore, tenantObjectKey } from '@/domain/documents/object-store';
import { assessDocumentPurge, authorizeDocumentPurge, cancelDocumentPurge, executeDocumentPurge, proposeDocumentPurge } from '@/domain/documents/purge';
import { retrieveRelevantVersioned } from '@/domain/documents/retrieval-versioned';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[document-purge.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

let storeDir = '';
let store: LocalObjectStore;
let orgId = '';
let userId = '';
const db = () => getSetupDb();
const shaOf = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const tx = <T>(fn: (t: DbTx) => Promise<T>): Promise<T> => db().transaction((t) => fn(t as unknown as DbTx));
const runTx = <T>(fn: (t: DbTx) => Promise<T>): Promise<T> => db().transaction((t) => fn(t as unknown as DbTx));

async function makeWorkspace(role: 'admin' | 'member' = 'admin'): Promise<TenantContext> {
  const p = await db().insert(projects).values({ orgId, key: fixtureKey('pg'), name: 'PG WS' }).returning({ id: projects.id });
  await db().insert(projectMembers).values({ orgId, projectId: p[0]!.id, userId, role });
  return { userId, orgId, projectId: p[0]!.id, orgRole: role === 'admin' ? 'owner' : 'member', projectRole: role };
}
async function runBackfill(ctx: TenantContext) {
  return db().transaction((t) => backfillProject(t as unknown as DbTx, ctx, store, { operationId: randomUUID() }));
}
async function byteExactDoc(ctx: TenantContext, relPath: string, body: string, disclosure: 'workspace_internal' | 'restricted' = 'workspace_internal') {
  const sha = shaOf(body);
  const key = tenantObjectKey({ orgId: ctx.orgId, projectId: ctx.projectId, sourceId: relPath, versionHash: sha });
  await store.put(key, Buffer.from(body, 'utf8'), 'text/markdown');
  const ins = await db().insert(documents).values({ orgId: ctx.orgId, projectId: ctx.projectId, source: 'cloud_upload', sourceId: relPath, relativePath: relPath, kind: 'markdown', sha256: sha, sizeBytes: Buffer.byteLength(body, 'utf8'), status: 'active', objectKey: key, mimeType: 'text/markdown', disclosure }).returning({ id: documents.id });
  const docId = ins[0]!.id;
  await db().insert(documentChunks).values(chunkText(body).map((content, i) => ({ orgId: ctx.orgId, projectId: ctx.projectId, documentId: docId, chunkIndex: i, content })));
  await db().update(documents).set({ chunkCount: chunkText(body).length, indexedAt: new Date() }).where(eq(documents.id, docId));
  await runBackfill(ctx);
  const v = (await db().select({ id: documentVersions.id, objectKey: documentVersions.objectKey }).from(documentVersions).where(and(eq(documentVersions.documentId, docId), eq(documentVersions.contentFidelity, 'byte_exact'))))[0]!;
  return { docId, versionId: v.id, versionKey: v.objectKey! };
}
async function newVersion(ctx: TenantContext, docId: string, body: string): Promise<string> {
  return db().transaction((t) => ingestDocumentVersion(t as never, ctx, store, { documentId: docId, bytes: Buffer.from(body, 'utf8'), text: body, mimeType: 'text/markdown', disclosure: 'workspace_internal', chunk: chunkText }).then((r) => r.versionId));
}
async function makeAgent(ctx: TenantContext): Promise<string> {
  const a = await db().insert(agents).values({ orgId: ctx.orgId, projectId: ctx.projectId, name: `a-${randomUUID().slice(0, 8)}`, role: 'primary', provider: 'openai', model: 'm', systemPrompt: 'x' }).returning({ id: agents.id });
  return a[0]!.id;
}
async function makeRunSnapshot(ctx: TenantContext, snapshot: RunSourceSnapshot[]): Promise<string> {
  const aId = await makeAgent(ctx);
  const t = await db().insert(tasks).values({ orgId: ctx.orgId, projectId: ctx.projectId, title: 't', input: 'x', providerSelection: 'openai', status: 'completed', createdBy: ctx.userId }).returning({ id: tasks.id });
  const r = await db().insert(runs).values({ orgId: ctx.orgId, projectId: ctx.projectId, taskId: t[0]!.id, status: 'completed', primaryAgentId: aId, retrievedSources: snapshot }).returning({ id: runs.id });
  return r[0]!.id;
}
async function bindKnowledge(ctx: TenantContext, versionId: string, hash: string) {
  const ki = await db().insert(knowledgeItems).values({ orgId: ctx.orgId, projectId: ctx.projectId, title: 'k', body: 'b', createdBy: ctx.userId }).returning({ id: knowledgeItems.id });
  await db().insert(knowledgeSources).values({ orgId: ctx.orgId, projectId: ctx.projectId, knowledgeItemId: ki[0]!.id, knowledgeVersion: 1, sourceType: 'document', sourceRef: 'r', sourceLabel: 'r', sourceVersionHash: hash, transformation: 'quoted', documentVersionId: versionId });
}
async function addRunRef(ctx: TenantContext, versionId: string) {
  const r = await makeRunSnapshot(ctx, []);
  await db().insert(runDocumentVersions).values({ orgId: ctx.orgId, projectId: ctx.projectId, runId: r, documentVersionId: versionId, chunkIndex: -1, disclosureSnapshot: 'workspace_internal' });
}
async function addDisclosureGrant(ctx: TenantContext, docId: string) {
  const aId = await makeAgent(ctx);
  await db().insert(documentDisclosureGrants).values({ orgId: ctx.orgId, projectId: ctx.projectId, documentId: docId, agentId: aId, agentExecutionFingerprint: shaOf(`grant-${docId}`), purpose: 'test', grantedBy: ctx.userId, expiresAt: new Date('2027-01-01T00:00:00Z') });
}

const opRow = async (id: string) => (await db().select().from(documentPurgeOperations).where(eq(documentPurgeOperations.id, id)))[0]!;
const docRow = async (id: string) => (await db().select().from(documents).where(eq(documents.id, id)))[0];
const inventory = async (ctx: TenantContext) => ({
  docs: (await db().select({ id: documents.id }).from(documents).where(eq(documents.projectId, ctx.projectId))).length,
  versions: (await db().select({ id: documentVersions.id }).from(documentVersions).where(eq(documentVersions.projectId, ctx.projectId))).length,
  chunks: (await db().select({ id: documentChunks.id }).from(documentChunks).where(eq(documentChunks.projectId, ctx.projectId))).length,
  grants: (await db().select({ id: documentDisclosureGrants.id }).from(documentDisclosureGrants).where(eq(documentDisclosureGrants.projectId, ctx.projectId))).length,
  jobs: (await db().select({ id: documentJobs.id }).from(documentJobs).where(eq(documentJobs.projectId, ctx.projectId))).length,
  tombstones: (await db().select({ id: documentVersionTombstones.id }).from(documentVersionTombstones).where(eq(documentVersionTombstones.projectId, ctx.projectId))).length,
});
const purgeEvents = (ctx: TenantContext, docId: string) =>
  db().select({ action: auditLogs.action, detail: auditLogs.detail }).from(auditLogs).where(and(eq(auditLogs.projectId, ctx.projectId), eq(auditLogs.entityId, docId)));

/** A runTx that throws on its Nth invocation (to simulate a crash after the DB purge commit, before objects). */
function runTxFailingOn(n: number): <T>(fn: (t: DbTx) => Promise<T>) => Promise<T> {
  let calls = 0;
  return <T>(fn: (t: DbTx) => Promise<T>): Promise<T> => {
    calls += 1;
    if (calls === n) return Promise.reject(new Error('injected: crash after DB purge commit, before object cleanup'));
    return db().transaction((t) => fn(t as unknown as DbTx));
  };
}
/** A store whose delete + head both fail — an ambiguous external-deletion response. */
function brokenObjectStore(): ObjectStore {
  return new Proxy(store as object, {
    get(target, prop, receiver) {
      if (prop === 'delete') return async () => { throw new Error('injected: object delete failed'); };
      if (prop === 'head') return async () => { throw new Error('injected: object head failed'); };
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as unknown as ObjectStore;
}

beforeAll(async () => {
  if (!available) return;
  storeDir = await mkdtemp(join(tmpdir(), 'pg-store-'));
  process.env.LOCAL_OBJECT_STORE_DIR = storeDir;
  store = new LocalObjectStore(storeDir);
  userId = randomUUID();
  await db().insert(profiles).values({ id: userId, email: `pg-${randomUUID().slice(0, 8)}@t.local`, displayName: 'PG' });
  const org = await db().insert(organizations).values({ name: 'PG Org', slug: `pg-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
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

describe.skipIf(!available)('Documents Purge — staged, admin-authorized, reference-blocked', () => {
  it('P.1 assess enumerates the EXACT scope and permits when nothing references the document', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId } = await byteExactDoc(ctx, 'p1.md', 'body one');
    const v2 = await newVersion(ctx, docId, 'body two'); // a second version → scope covers ALL versions
    await addDisclosureGrant(ctx, docId);
    const a = (await tx((t) => assessDocumentPurge(t, ctx, docId)))!;
    expect(a.decision).toBe('purge_permitted');
    expect(a.scope.versions.map((v) => v.versionId).sort()).toEqual([versionId, v2].sort());
    expect(a.scope.disclosureGrantCount).toBe(1);
    expect(a.scope.chunkCount).toBeGreaterThan(0);
    expect(a.scope.objectKeys.length).toBeGreaterThan(0);
    expect(a.scope.tombstonesToCreate).toBe(2);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('P.2 assess is BLOCKED (fail closed) by a Knowledge citation', async () => {
    const ctx = await makeWorkspace();
    const k = await byteExactDoc(ctx, 'p2-k.md', 'cited body');
    await bindKnowledge(ctx, k.versionId, shaOf('cited body'));
    const a = (await tx((t) => assessDocumentPurge(t, ctx, k.docId)))!;
    expect(a.decision).toBe('purge_blocked');
    expect(a.blockers.some((b) => b.category === 'knowledge_reference')).toBe(true);
  });

  it('P.3 assess is BLOCKED by a normalized run reference', async () => {
    const ctx = await makeWorkspace();
    const r = await byteExactDoc(ctx, 'p3-r.md', 'run body');
    await addRunRef(ctx, r.versionId);
    expect((await tx((t) => assessDocumentPurge(t, ctx, r.docId)))!.blockers.some((b) => b.category === 'run_reference')).toBe(true);
  });

  it('P.4 assess is BLOCKED by an immutable run snapshot', async () => {
    const ctx = await makeWorkspace();
    const s = await byteExactDoc(ctx, 'p4-s.md', 'snap body');
    await makeRunSnapshot(ctx, [{ documentVersionId: s.versionId, sourceRef: 'x', chunkIndices: [0], rank: 1, disclosure: 'workspace_internal' } as unknown as RunSourceSnapshot]);
    expect((await tx((t) => assessDocumentPurge(t, ctx, s.docId)))!.blockers.some((b) => b.category === 'run_snapshot')).toBe(true);
  });

  it('P.5 assess is BLOCKED by a live object-cleanup operation on one of the document\'s objects', async () => {
    const ctx = await makeWorkspace();
    const c = await byteExactDoc(ctx, 'p5-c.md', 'cleanup body');
    await db().insert(objectCleanupOperations).values({ orgId: ctx.orgId, projectId: ctx.projectId, objectKey: c.versionKey, fingerprint: 'fp', status: 'proposed' });
    expect((await tx((t) => assessDocumentPurge(t, ctx, c.docId)))!.blockers.some((b) => b.category === 'unresolved_cleanup')).toBe(true);
  });

  it('P.6 propose records a proposed op idempotently; a non-admin is refused; a blocked doc records no op', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await byteExactDoc(ctx, 'p6.md', 'body');
    const p1 = (await tx((t) => proposeDocumentPurge(t, ctx, docId)))!;
    expect(p1.operationId).not.toBeNull();
    const p2 = (await tx((t) => proposeDocumentPurge(t, ctx, docId)))!;
    expect(p2.operationId).toBe(p1.operationId);
    const member: TenantContext = { ...ctx, orgRole: 'member', projectRole: 'member' };
    await expect(tx((t) => proposeDocumentPurge(t, member, docId))).rejects.toThrow();
    const blocked = await byteExactDoc(ctx, 'p6-b.md', 'cited');
    await bindKnowledge(ctx, blocked.versionId, shaOf('cited'));
    const pb = (await tx((t) => proposeDocumentPurge(t, ctx, blocked.docId)))!;
    expect(pb.operationId).toBeNull();
  });

  it('P.7 authorize quarantines the document (retrieval-excluded), sets the retention deadline', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await byteExactDoc(ctx, 'p7.md', 'body');
    const p = (await tx((t) => proposeDocumentPurge(t, ctx, docId)))!;
    const r = await tx((t) => authorizeDocumentPurge(t, ctx, p.operationId!, { retentionMs: 60_000 }));
    expect(r.outcome).toBe('quarantined');
    expect((await docRow(docId))!.status).toBe('purge_quarantined');
    expect((await opRow(p.operationId!)).status).toBe('quarantined');
    expect((await opRow(p.operationId!)).retentionUntil).not.toBeNull();
  });

  it('P.8 cancel during quarantine restores the document; nothing was deleted', async () => {
    const ctx = await makeWorkspace();
    const inv0 = await inventory(ctx);
    const { docId } = await byteExactDoc(ctx, 'p8.md', 'body');
    const p = (await tx((t) => proposeDocumentPurge(t, ctx, docId)))!;
    await tx((t) => authorizeDocumentPurge(t, ctx, p.operationId!, { retentionMs: 60_000 }));
    const c = await tx((t) => cancelDocumentPurge(t, ctx, p.operationId!, 'changed my mind'));
    expect(c.outcome).toBe('cancelled');
    expect((await docRow(docId))!.status).toBe('active'); // restored
    expect((await opRow(p.operationId!)).status).toBe('cancelled');
    // The document, its version, chunks all still exist (nothing deleted): inventory grew by exactly this doc.
    const inv1 = await inventory(ctx);
    expect(inv1.docs).toBe(inv0.docs + 1);
    expect(inv1.versions).toBe(inv0.versions + 1);
  });

  it('P.9 execute before the retention window elapses is refused; nothing is deleted', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await byteExactDoc(ctx, 'p9.md', 'body');
    const p = (await tx((t) => proposeDocumentPurge(t, ctx, docId)))!;
    await tx((t) => authorizeDocumentPurge(t, ctx, p.operationId!, { retentionMs: 60_000 }));
    const r = await executeDocumentPurge(runTx, ctx, store, p.operationId!);
    expect(r.outcome).toBe('refused_retention_not_elapsed');
    expect(await docRow(docId)).toBeDefined(); // still present
    expect((await opRow(p.operationId!)).status).toBe('quarantined');
  });

  it('P.10 completed purge — exact rows deleted/tombstoned, objects HEAD-confirmed absent, a sibling doc untouched', async () => {
    const ctx = await makeWorkspace();
    const keep = await byteExactDoc(ctx, 'p10-keep.md', 'a document that must survive');
    const { docId, versionKey } = await byteExactDoc(ctx, 'p10.md', 'purge me one paragraph');
    const v2 = await newVersion(ctx, docId, 'purge me two paragraphs');
    await addDisclosureGrant(ctx, docId);
    const v2Key = (await db().select({ k: documentVersions.objectKey }).from(documentVersions).where(eq(documentVersions.id, v2)))[0]!.k!;
    const p = (await tx((t) => proposeDocumentPurge(t, ctx, docId)))!;
    await tx((t) => authorizeDocumentPurge(t, ctx, p.operationId!, { retentionMs: 0 })); // window already elapsed
    const r = await executeDocumentPurge(runTx, ctx, store, p.operationId!);
    expect(r.outcome).toBe('completed');
    expect(r.deleted).toMatchObject({ documents: 1, versions: 2 });
    expect(r.deleted!.disclosureGrants).toBe(1);
    expect(r.deleted!.tombstonesCreated).toBe(2);
    expect(r.objectsAllConfirmedAbsent).toBe(true);
    // The document, its versions, chunks, grants are gone.
    expect(await docRow(docId)).toBeUndefined();
    expect((await db().select({ id: documentVersions.id }).from(documentVersions).where(eq(documentVersions.documentId, docId))).length).toBe(0);
    // Objects are confirmed absent from storage.
    expect(await store.head(versionKey)).toBeNull();
    expect(await store.head(v2Key)).toBeNull();
    // A metadata-only tombstone survives per version (never any content).
    const tombs = await db().select().from(documentVersionTombstones).where(eq(documentVersionTombstones.documentId, docId));
    expect(tombs.length).toBe(2);
    expect(JSON.stringify(tombs)).not.toContain('purge me');
    // The sibling document is entirely untouched.
    expect((await docRow(keep.docId))!.status).toBe('active');
    expect(await store.head(keep.versionKey)).not.toBeNull();
    // Events are metadata-only.
    expect(JSON.stringify(await purgeEvents(ctx, docId))).not.toContain('purge me');
  });

  it('P.11 exact-state binding — a new version after authorization refuses execution; nothing is deleted', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await byteExactDoc(ctx, 'p11.md', 'body');
    const p = (await tx((t) => proposeDocumentPurge(t, ctx, docId)))!;
    await tx((t) => authorizeDocumentPurge(t, ctx, p.operationId!, { retentionMs: 0 }));
    await newVersion(ctx, docId, 'a brand new version changes the fingerprint'); // state changed after authorization
    const r = await executeDocumentPurge(runTx, ctx, store, p.operationId!);
    expect(r.outcome).toBe('refused_state_changed');
    expect(await docRow(docId)).toBeDefined();
  });

  it('P.12 a reference appearing after authorization refuses execution (fail closed); nothing is deleted', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId } = await byteExactDoc(ctx, 'p12.md', 'body');
    const p = (await tx((t) => proposeDocumentPurge(t, ctx, docId)))!;
    await tx((t) => authorizeDocumentPurge(t, ctx, p.operationId!, { retentionMs: 0 }));
    await addRunRef(ctx, versionId); // a run now relies on this version
    const r = await executeDocumentPurge(runTx, ctx, store, p.operationId!);
    expect(['refused_blocked', 'refused_state_changed']).toContain(r.outcome);
    expect(await docRow(docId)).toBeDefined();
  });

  it('P.13 crash AFTER the DB purge commits but BEFORE object cleanup → DB purge stands; a retry reconciles', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionKey } = await byteExactDoc(ctx, 'p13.md', 'body');
    const p = (await tx((t) => proposeDocumentPurge(t, ctx, docId)))!;
    await tx((t) => authorizeDocumentPurge(t, ctx, p.operationId!, { retentionMs: 0 }));
    // Phase A is runTx call #1 (commits the DB purge); fail on call #2 (the phase-B status flip) → crash after commit.
    await expect(executeDocumentPurge(runTxFailingOn(2), ctx, store, p.operationId!)).rejects.toThrow('crash after DB purge commit');
    // The DB purge is authoritative and committed: the document/version are gone; the op is database_purged.
    expect(await docRow(docId)).toBeUndefined();
    expect((await opRow(p.operationId!)).status).toBe('database_purged');
    expect(await store.head(versionKey)).not.toBeNull(); // the object was NOT yet deleted
    // A retry resumes the object cleanup → completed, object confirmed absent. DB content is never restored.
    const r2 = await executeDocumentPurge(runTx, ctx, store, p.operationId!);
    expect(r2.outcome).toBe('completed');
    expect(await store.head(versionKey)).toBeNull();
    expect((await opRow(p.operationId!)).status).toBe('completed');
  });

  it('P.14 ambiguous object deletion → operation stays object_cleanup_pending (retryable), never claims completion', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await byteExactDoc(ctx, 'p14.md', 'body');
    const p = (await tx((t) => proposeDocumentPurge(t, ctx, docId)))!;
    await tx((t) => authorizeDocumentPurge(t, ctx, p.operationId!, { retentionMs: 0 }));
    const r = await executeDocumentPurge(runTx, ctx, brokenObjectStore(), p.operationId!);
    expect(r.outcome).toBe('database_purged_objects_pending');
    expect(r.objectsAllConfirmedAbsent).toBe(false);
    expect(await docRow(docId)).toBeUndefined(); // DB purge is authoritative regardless
    expect(['object_cleanup_pending']).toContain((await opRow(p.operationId!)).status);
  });

  it('P.15 idempotency — re-executing a completed purge is harmless', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await byteExactDoc(ctx, 'p15.md', 'body');
    const p = (await tx((t) => proposeDocumentPurge(t, ctx, docId)))!;
    await tx((t) => authorizeDocumentPurge(t, ctx, p.operationId!, { retentionMs: 0 }));
    await executeDocumentPurge(runTx, ctx, store, p.operationId!);
    const again = await executeDocumentPurge(runTx, ctx, store, p.operationId!);
    expect(again.outcome).toBe('already_completed');
  });

  it('P.16 cross-workspace + non-admin execution is refused; the other workspace document is untouched', async () => {
    const a = await makeWorkspace();
    const b = await makeWorkspace();
    const { docId } = await byteExactDoc(b, 'p16.md', 'b body');
    const p = (await tx((t) => proposeDocumentPurge(t, b, docId)))!;
    await tx((t) => authorizeDocumentPurge(t, b, p.operationId!, { retentionMs: 0 }));
    // Workspace A cannot execute B's operation (existence-neutral).
    const r = await executeDocumentPurge(runTx, a, store, p.operationId!);
    expect(r.outcome).toBe('refused_not_ready');
    expect(await docRow(docId)).toBeDefined();
    // A non-admin in B cannot execute either.
    const bMember: TenantContext = { ...b, orgRole: 'member', projectRole: 'member' };
    await expect(executeDocumentPurge(runTx, bMember, store, p.operationId!)).rejects.toThrow();
    expect(await docRow(docId)).toBeDefined();
  });

  it('P.17 no hidden cascade — run snapshots and audit history are RETAINED across a purge', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await byteExactDoc(ctx, 'p17.md', 'body');
    // An unrelated run snapshot (references a DIFFERENT version) must survive the purge untouched.
    const other = await byteExactDoc(ctx, 'p17-other.md', 'other');
    const runId = await makeRunSnapshot(ctx, [{ documentVersionId: other.versionId, sourceRef: 'x', chunkIndices: [0], rank: 1, disclosure: 'workspace_internal' } as unknown as RunSourceSnapshot]);
    const auditBefore = (await db().select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.projectId, ctx.projectId))).length;
    const p = (await tx((t) => proposeDocumentPurge(t, ctx, docId)))!;
    await tx((t) => authorizeDocumentPurge(t, ctx, p.operationId!, { retentionMs: 0 }));
    await executeDocumentPurge(runTx, ctx, store, p.operationId!);
    // The run + its snapshot are retained; audit history only GREW (append-only, never deleted).
    expect((await db().select({ id: runs.id }).from(runs).where(eq(runs.id, runId))).length).toBe(1);
    const auditAfter = (await db().select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.projectId, ctx.projectId))).length;
    expect(auditAfter).toBeGreaterThan(auditBefore);
  });

  it('P.18 a quarantined document is EXCLUDED from retrieval, and cancel restores it', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await byteExactDoc(ctx, 'p18.md', 'the zebraquux marker paragraph for retrieval');
    const hit = () => tx((t) => retrieveRelevantVersioned(t, ctx, 'zebraquux'));
    expect((await hit()).length).toBeGreaterThan(0); // retrievable while active

    const p = (await tx((t) => proposeDocumentPurge(t, ctx, docId)))!;
    await tx((t) => authorizeDocumentPurge(t, ctx, p.operationId!, { retentionMs: 60_000 }));
    expect(await hit()).toHaveLength(0); // quarantined → retrieval-excluded (new use blocked)

    await tx((t) => cancelDocumentPurge(t, ctx, p.operationId!));
    expect((await hit()).length).toBeGreaterThan(0); // cancel restores retrievability
  });
});
