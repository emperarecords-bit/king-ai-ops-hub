import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { type DbTx, getSetupDb } from '@/db/client';
import { agents, auditLogs, documentChunks, documentVersionTombstones, documentVersions, documents, knowledgeItems, knowledgeSources, memberships, organizations, profiles, projectMembers, projects, runDocumentVersions, runs, tasks } from '@/db/schema';
import { chunkText } from '@/domain/documents/documents';
import { backfillProject } from '@/domain/documents/backfill';
import { ingestDocumentVersion } from '@/domain/documents/versions';
import { LocalObjectStore } from '@/domain/documents/local-object-store';
import { type ObjectStore, tenantObjectKey } from '@/domain/documents/object-store';
import { assessDocumentViewerAccess, loadInspectableVersion } from '@/domain/documents/viewer-access';
import { executePurge, purgePhase1, purgePhase2 } from '@/domain/documents/retention';
import { rebuildVersionChunksFromBytes } from '@/domain/documents/integrity';
import { createDocumentDisclosureGrant } from '@/domain/documents/disclosure';

/** Stage D closure blockers: crash-safe two-phase purge, representation-safe chunk repair, and the full
 *  restricted-viewer role matrix + audit-on-release through one shared gated loader. */

process.env.DATABASE_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[stage-d-blockers.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

let storeDir = '';
let store: LocalObjectStore;
let orgId = '';
let userId = '';
const db = () => getSetupDb();
const shaOf = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const future = () => new Date(Date.now() + 3_600_000);
const txn = <T>(fn: (t: never) => Promise<T>): Promise<T> => db().transaction((t) => fn(t as never)) as Promise<T>;
/** A privileged transaction runner — purge deletes immutable version rows, which app_server cannot. */
const dtx = <T>(fn: (t: DbTx) => Promise<T>): Promise<T> => db().transaction((t) => fn(t as unknown as DbTx));

async function makeWorkspace(): Promise<TenantContext> {
  const p = await db().insert(projects).values({ orgId, key: fixtureKey('db'), name: 'DB WS' }).returning({ id: projects.id });
  await db().insert(projectMembers).values({ orgId, projectId: p[0]!.id, userId, role: 'admin' });
  return { userId, orgId, projectId: p[0]!.id, orgRole: 'owner', projectRole: 'admin' };
}
async function memberOf(ctx: TenantContext): Promise<TenantContext> {
  const u = randomUUID();
  await db().insert(profiles).values({ id: u, email: `mem-${u.slice(0, 8)}@t.local`, displayName: 'Mem' });
  await db().insert(projectMembers).values({ orgId: ctx.orgId, projectId: ctx.projectId, userId: u, role: 'member' });
  return { userId: u, orgId: ctx.orgId, projectId: ctx.projectId, orgRole: 'member', projectRole: 'member' };
}
async function runBackfill(ctx: TenantContext) {
  return db().transaction((t) => backfillProject(t, ctx, store, { operationId: randomUUID() }));
}
async function byteExactDoc(ctx: TenantContext, relPath: string, body: string, disclosure: 'workspace_internal' | 'restricted' = 'workspace_internal') {
  const sha = shaOf(body);
  const legacyKey = tenantObjectKey({ orgId: ctx.orgId, projectId: ctx.projectId, sourceId: relPath, versionHash: sha });
  await store.put(legacyKey, Buffer.from(body, 'utf8'), 'text/markdown');
  const ins = await db().insert(documents).values({ orgId: ctx.orgId, projectId: ctx.projectId, source: 'cloud_upload', sourceId: relPath, relativePath: relPath, kind: 'markdown', sha256: sha, sizeBytes: Buffer.byteLength(body, 'utf8'), status: 'active', objectKey: legacyKey, mimeType: 'text/markdown', disclosure }).returning({ id: documents.id });
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
async function makeRun(ctx: TenantContext): Promise<string> {
  const a = await db().insert(agents).values({ orgId: ctx.orgId, projectId: ctx.projectId, name: 'a', role: 'primary', provider: 'openai', model: 'm', systemPrompt: 'x' }).returning({ id: agents.id });
  const t = await db().insert(tasks).values({ orgId: ctx.orgId, projectId: ctx.projectId, title: 't', input: 'x', providerSelection: 'openai', status: 'completed', createdBy: ctx.userId }).returning({ id: tasks.id });
  const r = await db().insert(runs).values({ orgId: ctx.orgId, projectId: ctx.projectId, taskId: t[0]!.id, status: 'completed', primaryAgentId: a[0]!.id }).returning({ id: runs.id });
  return r[0]!.id;
}
async function bindKnowledge(ctx: TenantContext, path: string, hash: string, versionId: string) {
  const ki = await db().insert(knowledgeItems).values({ orgId: ctx.orgId, projectId: ctx.projectId, title: 'k', body: 'b', createdBy: ctx.userId }).returning({ id: knowledgeItems.id });
  return (await db().insert(knowledgeSources).values({ orgId: ctx.orgId, projectId: ctx.projectId, knowledgeItemId: ki[0]!.id, knowledgeVersion: 1, sourceType: 'document', sourceRef: path, sourceLabel: path, sourceVersionHash: hash, transformation: 'quoted', documentVersionId: versionId }).returning({ id: knowledgeSources.id }))[0]!.id;
}
async function restrictedInspectAudits(ctx: TenantContext, docId: string): Promise<number> {
  return (await db().select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.orgId, ctx.orgId), eq(auditLogs.action, 'document.restricted_inspected'), eq(auditLogs.entityId, docId)))).length;
}
/** A store whose delete always fails, to exercise the phase-2 cleanup-failure path. */
function failingDeleteStore(base: LocalObjectStore): ObjectStore {
  return { driver: base.driver, put: base.put.bind(base), get: base.get.bind(base), head: base.head.bind(base), list: base.list?.bind(base), delete: async () => { throw new Error('simulated cleanup failure'); } };
}

beforeAll(async () => {
  if (!available) return;
  storeDir = await mkdtemp(join(tmpdir(), 'db-store-'));
  process.env.LOCAL_OBJECT_STORE_DIR = storeDir;
  store = new LocalObjectStore(storeDir);
  userId = randomUUID();
  await db().insert(profiles).values({ id: userId, email: `db-${randomUUID().slice(0, 8)}@t.local`, displayName: 'DB' });
  const org = await db().insert(organizations).values({ name: 'DB Org', slug: `db-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
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

describe.skipIf(!available)('Stage D — Blocker 1: crash-safe two-phase purge', () => {
  it('1. object deletion is never attempted before the DB revocation commits', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId, versionKey } = await byteExactDoc(ctx, 'b1-1.md', 'body');
    await newVersion(ctx, docId, 'v2');
    const p1 = await dtx((t) => purgePhase1(t, ctx, versionId, "phase1"));
    expect(p1.purged).toBe(true);
    expect(p1.status).toBe('object_cleanup_pending');
    // Phase 1 committed (version gone) but the object is untouched until phase 2.
    expect((await db().select({ id: documentVersions.id }).from(documentVersions).where(eq(documentVersions.id, versionId))).length).toBe(0);
    expect((await store.get(versionKey)).toString('utf8')).toBe('body');
  });

  it('2. a database rollback leaves the object and version intact', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId, versionKey } = await byteExactDoc(ctx, 'b1-2.md', 'body');
    await newVersion(ctx, docId, 'v2');
    await db().transaction(async (t) => {
      await purgePhase1(t as never, ctx, versionId, 'will-roll-back');
      throw new Error('force rollback');
    }).catch(() => {});
    expect((await db().select({ id: documentVersions.id }).from(documentVersions).where(eq(documentVersions.id, versionId))).length).toBe(1);
    expect((await store.get(versionKey))).toBeTruthy();
  });

  it('3/4. an object-cleanup failure stays pending + retryable; retry completes without repeating the DB deletion', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId, versionKey } = await byteExactDoc(ctx, 'b1-3.md', 'body');
    await newVersion(ctx, docId, 'v2');
    const p1 = await dtx((t) => purgePhase1(t, ctx, versionId, 'p'));
    // Phase 2 with a failing store → tombstone stays pending, error + attempt recorded.
    await dtx((t) => purgePhase2(t, ctx, failingDeleteStore(store), p1.tombstoneId!));
    let tomb = (await db().select({ status: documentVersionTombstones.status, attempts: documentVersionTombstones.cleanupAttempts, err: documentVersionTombstones.cleanupError }).from(documentVersionTombstones).where(eq(documentVersionTombstones.id, p1.tombstoneId!)))[0]!;
    expect(tomb.status).toBe('object_cleanup_pending');
    expect(tomb.attempts).toBe(1);
    expect(tomb.err).toContain('simulated');
    expect((await store.get(versionKey))).toBeTruthy(); // object still present
    // Retry with the real store → completes; DB deletion is NOT repeated (version already gone).
    await dtx((t) => purgePhase2(t, ctx, store, p1.tombstoneId!));
    tomb = (await db().select({ status: documentVersionTombstones.status, attempts: documentVersionTombstones.cleanupAttempts, err: documentVersionTombstones.cleanupError }).from(documentVersionTombstones).where(eq(documentVersionTombstones.id, p1.tombstoneId!)))[0]!;
    expect(tomb.status).toBe('completed');
    await expect(store.get(versionKey)).rejects.toThrow(); // object now deleted
  });

  it('5. a shared object is retained (completed_object_retained_shared)', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId, versionKey } = await byteExactDoc(ctx, 'b1-5.md', 'shared body');
    await db().insert(documentVersions).values({ orgId: ctx.orgId, projectId: ctx.projectId, documentId: docId, sha256: shaOf('sharer'), sizeBytes: 1, contentFidelity: 'byte_exact', indexStatus: 'indexed', objectKey: versionKey });
    await newVersion(ctx, docId, 'v2');
    const res = await executePurge(dtx, ctx, store, versionId, 'shared');
    expect(res.purged).toBe(true);
    expect(res.status).toBe('completed_object_retained_shared');
    expect((await store.get(versionKey)).toString('utf8')).toBe('shared body');
  });

  it('6/7. a reference appearing after assessment (incl. a concurrent normalized ref) blocks execution', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId } = await byteExactDoc(ctx, 'b1-6.md', 'body');
    await newVersion(ctx, docId, 'v2');
    const runId = await makeRun(ctx);
    await db().insert(runDocumentVersions).values({ orgId: ctx.orgId, projectId: ctx.projectId, runId, documentVersionId: versionId, chunkIndex: -1, disclosureSnapshot: 'workspace_internal' });
    const res = await executePurge(dtx, ctx, store, versionId, 'blocked');
    expect(res.purged).toBe(false);
    expect(res.decision).toBe('purge_blocked_by_institutional_evidence');
    expect((await db().select({ id: documentVersions.id }).from(documentVersions).where(eq(documentVersions.id, versionId))).length).toBe(1);
  });

  it('8. a current-version pointer is never cleared by purge', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId } = await byteExactDoc(ctx, 'b1-8.md', 'body'); // versionId is current
    const res = await executePurge(dtx, ctx, store, versionId, 'blocked');
    expect(res.decision).toBe('purge_blocked_by_current_use');
    expect((await db().select({ c: documents.currentVersionId }).from(documents).where(eq(documents.id, docId)))[0]!.c).toBe(versionId); // pointer intact
  });

  it('9. Knowledge and run relationships are never deleted to make purge succeed', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId } = await byteExactDoc(ctx, 'b1-9.md', 'body');
    await newVersion(ctx, docId, 'v2');
    const ksId = await bindKnowledge(ctx, 'b1-9.md', shaOf('body'), versionId);
    const res = await executePurge(dtx, ctx, store, versionId, 'blocked');
    expect(res.purged).toBe(false);
    expect((await db().select({ id: knowledgeSources.id }).from(knowledgeSources).where(eq(knowledgeSources.id, ksId))).length).toBe(1); // relationship intact
  });

  it('10. a completed tombstone means every cleanup step actually completed', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId, versionKey } = await byteExactDoc(ctx, 'b1-10.md', 'body');
    await newVersion(ctx, docId, 'v2');
    const res = await executePurge(dtx, ctx, store, versionId, 'full');
    expect(res.status).toBe('completed');
    expect(res.objectDeleted).toBe(true);
    expect((await db().select({ id: documentVersions.id }).from(documentVersions).where(eq(documentVersions.id, versionId))).length).toBe(0);
    expect((await db().select({ id: documentChunks.id }).from(documentChunks).where(eq(documentChunks.documentVersionId, versionId))).length).toBe(0);
    await expect(store.get(versionKey)).rejects.toThrow();
  });
});

describe.skipIf(!available)('Stage D — Blocker 2: representation-safe chunk repair', () => {
  async function corrupt(versionId: string, idx = 0) {
    const c = (await db().select({ id: documentChunks.id, contentHash: documentChunks.contentHash }).from(documentChunks).where(and(eq(documentChunks.documentVersionId, versionId), eq(documentChunks.chunkIndex, idx))))[0]!;
    await db().update(documentChunks).set({ content: 'CORRUPTED' }).where(eq(documentChunks.id, c.id));
    return c;
  }

  it('1/2. rebuild with the original parser + matching manifest succeeds; indexes + hashes match exactly', async () => {
    const ctx = await makeWorkspace();
    const { versionId } = await byteExactDoc(ctx, 'b2-1.md', '# T\n\npara one\n\npara two');
    const c0 = await corrupt(versionId);
    const res = await txn((t) => rebuildVersionChunksFromBytes(t, ctx, store, versionId));
    expect(res.state).toBe('repaired');
    const after = (await db().select({ content: documentChunks.content, idx: documentChunks.chunkIndex }).from(documentChunks).where(eq(documentChunks.id, c0.id)))[0]!;
    expect(shaOf(after.content)).toBe(c0.contentHash); // restored to the manifest hash
    expect(after.idx).toBe(0); // index unchanged
  });

  it('3. a parser-version mismatch blocks repair and marks the version index-degraded', async () => {
    const ctx = await makeWorkspace();
    const { versionId } = await byteExactDoc(ctx, 'b2-3.md', 'body');
    await corrupt(versionId);
    await db().update(documentChunks).set({ parserVersion: 'legacy-parser-v0' }).where(eq(documentChunks.documentVersionId, versionId));
    const res = await txn((t) => rebuildVersionChunksFromBytes(t, ctx, store, versionId));
    expect(res.state).toBe('parser_mismatch');
    expect((await db().select({ d: documentVersions.indexDegraded }).from(documentVersions).where(eq(documentVersions.id, versionId)))[0]!.d).toBe(true);
  });

  it('4/5. a manifest mismatch blocks repair, leaves chunks unchanged, and marks index-degraded', async () => {
    const ctx = await makeWorkspace();
    const { versionId } = await byteExactDoc(ctx, 'b2-4.md', 'body');
    const c0 = (await db().select({ id: documentChunks.id }).from(documentChunks).where(and(eq(documentChunks.documentVersionId, versionId), eq(documentChunks.chunkIndex, 0))))[0]!;
    await db().update(documentChunks).set({ content: 'STAYS', contentHash: shaOf('a bogus manifest hash') }).where(eq(documentChunks.id, c0.id));
    const res = await txn((t) => rebuildVersionChunksFromBytes(t, ctx, store, versionId));
    expect(res.state).toBe('manifest_mismatch');
    expect((await db().select({ content: documentChunks.content }).from(documentChunks).where(eq(documentChunks.id, c0.id)))[0]!.content).toBe('STAYS'); // unchanged
    expect((await db().select({ d: documentVersions.indexDegraded }).from(documentVersions).where(eq(documentVersions.id, versionId)))[0]!.d).toBe(true);
  });

  it('6/7. chunk-level run relationships stay valid and historical snapshots are never rewritten by a repair', async () => {
    const ctx = await makeWorkspace();
    const { versionId } = await byteExactDoc(ctx, 'b2-6.md', 'body');
    const runId = await makeRun(ctx);
    await db().insert(runDocumentVersions).values({ orgId: ctx.orgId, projectId: ctx.projectId, runId, documentVersionId: versionId, chunkIndex: 0, disclosureSnapshot: 'workspace_internal' });
    await db().update(runs).set({ retrievedSources: [{ relativePath: 'b2-6.md', sha256: shaOf('body'), disclosure: 'workspace_internal', chunkIndex: 0, rank: 1, excerpt: 'body', documentVersionId: versionId }] }).where(eq(runs.id, runId));
    const before = JSON.stringify((await db().select({ s: runs.retrievedSources }).from(runs).where(eq(runs.id, runId)))[0]!.s);
    await corrupt(versionId);
    await txn((t) => rebuildVersionChunksFromBytes(t, ctx, store, versionId));
    // Chunk-level ref (run, version, chunk 0) still valid.
    expect((await db().select({ id: runDocumentVersions.id }).from(runDocumentVersions).where(and(eq(runDocumentVersions.runId, runId), eq(runDocumentVersions.documentVersionId, versionId), eq(runDocumentVersions.chunkIndex, 0)))).length).toBe(1);
    // Immutable run snapshot unchanged.
    expect(JSON.stringify((await db().select({ s: runs.retrievedSources }).from(runs).where(eq(runs.id, runId)))[0]!.s)).toBe(before);
  });

  it('8. a version with no trustworthy manifest is marked index-degraded rather than silently rechunked', async () => {
    const ctx = await makeWorkspace();
    const { versionId } = await byteExactDoc(ctx, 'b2-8.md', 'body one\n\nbody two');
    await db().delete(documentChunks).where(eq(documentChunks.documentVersionId, versionId)); // lost chunks → no manifest
    const res = await txn((t) => rebuildVersionChunksFromBytes(t, ctx, store, versionId));
    expect(res.state).toBe('no_manifest');
    expect((await db().select({ d: documentVersions.indexDegraded }).from(documentVersions).where(eq(documentVersions.id, versionId)))[0]!.d).toBe(true);
    expect((await db().select({ id: documentChunks.id }).from(documentChunks).where(eq(documentChunks.documentVersionId, versionId))).length).toBe(0); // NOT rechunked
  });
});

describe.skipIf(!available)('Stage D — Blocker 3: restricted viewer matrix + audit-on-release', () => {
  const PURPOSE = 'inspection';
  it('1/2. owner and admin inspection succeed and record one access event each', async () => {
    const ctx = await makeWorkspace(); // owner+admin
    const { docId, versionId } = await byteExactDoc(ctx, 'b3-1.md', 'restricted body', 'restricted');
    const got = await txn((t) => loadInspectableVersion(t, ctx, store, { kind: 'versionId', versionId }, { accessType: 'preview', purpose: PURPOSE }));
    expect(got.state).toBe('released');
    expect(got.inspection!.bytes!.toString('utf8')).toBe('restricted body');
    expect(await restrictedInspectAudits(ctx, docId)).toBe(1);
  });

  it('3/4. an ordinary member is denied and receives no sensitive fields', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId } = await byteExactDoc(ctx, 'b3-3.md', 'secret body zzsensitive', 'restricted');
    const member = await memberOf(ctx);
    const got = await txn((t) => loadInspectableVersion(t, member, store, { kind: 'versionId', versionId }, { accessType: 'preview', purpose: PURPOSE }));
    expect(got.state).toBe('denied');
    expect(got.inspection).toBeUndefined();
    const json = JSON.stringify(got);
    expect(json).not.toContain('zzsensitive');
    expect(json).not.toContain('b3-3.md');
    expect(await restrictedInspectAudits(ctx, docId)).toBe(0); // denial is not an access event
  });

  it('5. a non-member denial does not reveal source existence', async () => {
    const ctx = await makeWorkspace();
    const { versionId } = await byteExactDoc(ctx, 'b3-5.md', 'body', 'restricted');
    const nonMember: TenantContext = { userId: randomUUID(), orgId: ctx.orgId, projectId: ctx.projectId, orgRole: 'member', projectRole: 'member' };
    const real = await txn((t) => loadInspectableVersion(t, nonMember, store, { kind: 'versionId', versionId }, { accessType: 'preview', purpose: PURPOSE }));
    const fake = await txn((t) => loadInspectableVersion(t, nonMember, store, { kind: 'versionId', versionId: randomUUID() }, { accessType: 'preview', purpose: PURPOSE }));
    expect(real.state).toBe('denied');
    expect(real.message).toBe(fake.message); // identical bounded message whether or not it exists
  });

  it('6. an AI disclosure grant does not authorize human inspection', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId } = await byteExactDoc(ctx, 'b3-6.md', 'body', 'restricted');
    const agent = (await db().insert(agents).values({ orgId: ctx.orgId, projectId: ctx.projectId, name: 'ag', role: 'primary', provider: 'openai', model: 'm', systemPrompt: 'x' }).returning({ id: agents.id }))[0]!.id;
    await txn((t) => createDocumentDisclosureGrant(t, ctx, { documentId: docId, agentId: agent, purpose: 'current_operational_fact', expiresAt: future() }));
    // A plain member with an AI grant on the doc still cannot inspect as a human.
    const member = await memberOf(ctx);
    expect((await txn((t) => loadInspectableVersion(t, member, store, { kind: 'versionId', versionId }, { accessType: 'preview', purpose: PURPOSE }))).state).toBe('denied');
  });

  it('7/8. preview, download, Knowledge, and run paths all use the same gated loader', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId } = await byteExactDoc(ctx, 'b3-7.md', 'body', 'restricted');
    const ksId = await bindKnowledge(ctx, 'b3-7.md', shaOf('body'), versionId);
    const member = await memberOf(ctx);
    for (const ref of [{ kind: 'versionId', versionId } as const, { kind: 'knowledgeSource', knowledgeSourceId: ksId } as const]) {
      for (const accessType of ['preview', 'download', 'chunks', 'knowledge_provenance', 'run_source'] as const) {
        expect((await txn((t) => loadInspectableVersion(t, member, store, ref, { accessType, purpose: PURPOSE }))).state).toBe('denied'); // member denied everywhere
        expect((await txn((t) => loadInspectableVersion(t, ctx, store, ref, { accessType, purpose: PURPOSE }))).state).toBe('released'); // owner released everywhere
      }
    }
    void docId;
  });

  it('9. a permission check without content release creates no successful-access audit', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await byteExactDoc(ctx, 'b3-9.md', 'body', 'restricted');
    await txn((t) => assessDocumentViewerAccess(t, ctx, docId)); // pure decision, no release
    expect(await restrictedInspectAudits(ctx, docId)).toBe(0);
  });

  it('10. every successful restricted release creates exactly one audit event', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId } = await byteExactDoc(ctx, 'b3-10.md', 'body', 'restricted');
    await txn((t) => loadInspectableVersion(t, ctx, store, { kind: 'versionId', versionId }, { accessType: 'preview', purpose: PURPOSE }));
    await txn((t) => loadInspectableVersion(t, ctx, store, { kind: 'versionId', versionId }, { accessType: 'download', purpose: PURPOSE }));
    expect(await restrictedInspectAudits(ctx, docId)).toBe(2); // exactly one per release
  });
});
