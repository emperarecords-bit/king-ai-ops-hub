import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { type DbTx, getSetupDb } from '@/db/client';
import { auditLogs, documentChunks, documentJobs, documentVersionTombstones, documentVersions, documents, memberships, objectCleanupOperations, organizations, profiles, projectMembers, projects } from '@/db/schema';
import { chunkText } from '@/domain/documents/documents';
import { backfillProject } from '@/domain/documents/backfill';
import { LocalObjectStore } from '@/domain/documents/local-object-store';
import { type ObjectStore, tenantObjectKey } from '@/domain/documents/object-store';
import { assertObjectCleanupAuthority, assessObjectCleanup, executeObjectCleanup, proposeObjectCleanup } from '@/domain/documents/cleanup';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[document-cleanup.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
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
  const p = await db().insert(projects).values({ orgId, key: fixtureKey('cl'), name: 'CL WS' }).returning({ id: projects.id });
  await db().insert(projectMembers).values({ orgId, projectId: p[0]!.id, userId, role });
  return { userId, orgId, projectId: p[0]!.id, orgRole: role === 'admin' ? 'owner' : 'member', projectRole: role };
}
async function runBackfill(ctx: TenantContext) {
  return db().transaction((t) => backfillProject(t as unknown as DbTx, ctx, store, { operationId: randomUUID() }));
}
/** Cloud doc + retained object → a byte_exact current version (referenced by documents + version). */
async function byteExactDoc(ctx: TenantContext, relPath: string, body: string) {
  const sha = shaOf(body);
  const key = tenantObjectKey({ orgId: ctx.orgId, projectId: ctx.projectId, sourceId: relPath, versionHash: sha });
  await store.put(key, Buffer.from(body, 'utf8'), 'text/markdown');
  const ins = await db().insert(documents).values({ orgId: ctx.orgId, projectId: ctx.projectId, source: 'cloud_upload', sourceId: relPath, relativePath: relPath, kind: 'markdown', sha256: sha, sizeBytes: Buffer.byteLength(body, 'utf8'), status: 'active', objectKey: key, mimeType: 'text/markdown' }).returning({ id: documents.id });
  const docId = ins[0]!.id;
  await db().insert(documentChunks).values(chunkText(body).map((content, i) => ({ orgId: ctx.orgId, projectId: ctx.projectId, documentId: docId, chunkIndex: i, content })));
  await db().update(documents).set({ chunkCount: chunkText(body).length, indexedAt: new Date() }).where(eq(documents.id, docId));
  await runBackfill(ctx);
  const v = (await db().select({ id: documentVersions.id, objectKey: documentVersions.objectKey }).from(documentVersions).where(and(eq(documentVersions.documentId, docId), eq(documentVersions.contentFidelity, 'byte_exact'))))[0]!;
  return { docId, versionId: v.id, versionKey: v.objectKey!, legacyKey: key };
}
/** Put an object under the tenant prefix that is referenced by NO document, version, or tombstone. */
async function orphanObject(ctx: TenantContext, tag: string, body = `orphan ${tag}`) {
  const key = tenantObjectKey({ orgId: ctx.orgId, projectId: ctx.projectId, sourceId: `orphan-${tag}-${randomUUID().slice(0, 8)}`, versionHash: shaOf(body) });
  await store.put(key, Buffer.from(body, 'utf8'), 'text/markdown');
  return { key, body };
}
const opRow = async (id: string) => (await db().select().from(objectCleanupOperations).where(eq(objectCleanupOperations.id, id)))[0]!;
const liveOps = (ctx: TenantContext) => db().select().from(objectCleanupOperations).where(and(eq(objectCleanupOperations.orgId, ctx.orgId), eq(objectCleanupOperations.projectId, ctx.projectId)));
const rowCounts = async (ctx: TenantContext) => ({
  docs: (await db().select({ id: documents.id }).from(documents).where(eq(documents.projectId, ctx.projectId))).length,
  versions: (await db().select({ id: documentVersions.id }).from(documentVersions).where(eq(documentVersions.projectId, ctx.projectId))).length,
  tombstones: (await db().select({ id: documentVersionTombstones.id }).from(documentVersionTombstones).where(eq(documentVersionTombstones.projectId, ctx.projectId))).length,
});
const cleanupEvents = (ctx: TenantContext, opId: string) =>
  db().select({ action: auditLogs.action, detail: auditLogs.detail }).from(auditLogs).where(and(eq(auditLogs.projectId, ctx.projectId), eq(auditLogs.entityId, opId)));

/** A store wrapper whose delete (and optionally head) fail — for ambiguous/failed partial-failure tests. */
function brokenDeleteStore(opts: { headThrows: boolean }): ObjectStore {
  return new Proxy(store as object, {
    get(target, prop, receiver) {
      if (prop === 'delete') return async () => { throw new Error('injected: object store delete failed'); };
      if (prop === 'head' && opts.headThrows) return async () => { throw new Error('injected: object store head failed'); };
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as ObjectStore;
}

beforeAll(async () => {
  if (!available) return;
  storeDir = await mkdtemp(join(tmpdir(), 'cl-store-'));
  process.env.LOCAL_OBJECT_STORE_DIR = storeDir;
  store = new LocalObjectStore(storeDir);
  userId = randomUUID();
  await db().insert(profiles).values({ id: userId, email: `cl-${randomUUID().slice(0, 8)}@t.local`, displayName: 'CL' });
  const org = await db().insert(organizations).values({ name: 'CL Org', slug: `cl-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
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

describe.skipIf(!available)('Documents Legacy-Object Cleanup — bounded, unreferenced-only', () => {
  it('C.1 assess is READ-ONLY: an orphan is eligible, all 7 reference locations are checked (count 0), identity is captured, no row is written', async () => {
    const ctx = await makeWorkspace();
    const { key } = await orphanObject(ctx, 'c1');
    const before = (await liveOps(ctx)).length;
    const a = await tx((t) => assessObjectCleanup(t, ctx, store, key));
    expect(a.eligibility).toBe('eligible');
    expect(a.refusal).toBeUndefined();
    expect(a.referencesChecked.map((c) => c.location)).toEqual([
      'documents.object_key', 'document_versions.object_key', 'document_version_tombstones.object_key',
      'documents.current_version_id→version', 'knowledge_sources→version', 'run_document_versions→version', 'runs.retrieved_sources→version',
    ]);
    expect(a.referencesChecked.every((c) => c.count === 0)).toBe(true);
    expect(a.size).toBeGreaterThan(0);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect((await liveOps(ctx)).length).toBe(before); // preview mutated nothing
  });

  it('C.2 a still-referenced object is refused (referenced), reporting the non-zero reference', async () => {
    const ctx = await makeWorkspace();
    const { versionKey } = await byteExactDoc(ctx, 'c2.md', 'referenced body');
    const a = await tx((t) => assessObjectCleanup(t, ctx, store, versionKey));
    expect(a.eligibility).toBe('ineligible');
    expect(a.refusal).toBe('referenced');
    expect(a.referencesChecked.find((c) => c.location === 'document_versions.object_key')!.count).toBeGreaterThan(0);
  });

  it('C.3 an object owned by a purge tombstone is refused (tombstoned) — cleanup never overlaps purge', async () => {
    const ctx = await makeWorkspace();
    const { key } = await orphanObject(ctx, 'c3');
    await db().insert(documentVersionTombstones).values({ orgId: ctx.orgId, projectId: ctx.projectId, versionId: randomUUID(), documentId: randomUUID(), sha256: shaOf('x'), contentFidelity: 'byte_exact', objectKey: key, objectDeleted: false, status: 'object_cleanup_pending' });
    const a = await tx((t) => assessObjectCleanup(t, ctx, store, key));
    expect(a.eligibility).toBe('ineligible');
    expect(a.refusal).toBe('tombstoned');
  });

  it('C.4 a key outside this workspace prefix is refused (not_tenant_object)', async () => {
    const ctx = await makeWorkspace();
    const foreign = `org/${randomUUID()}/project/${randomUUID()}/doc/x/${shaOf('y')}`;
    const a = await tx((t) => assessObjectCleanup(t, ctx, store, foreign));
    expect(a.eligibility).toBe('ineligible');
    expect(a.refusal).toBe('not_tenant_object');
  });

  it('C.5 active ingestion (a queued job) refuses cleanup (ingestion_active)', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await byteExactDoc(ctx, 'c5.md', 'body');
    const { key } = await orphanObject(ctx, 'c5');
    await db().insert(documentJobs).values({ orgId: ctx.orgId, projectId: ctx.projectId, documentId: docId, status: 'queued' });
    const a = await tx((t) => assessObjectCleanup(t, ctx, store, key));
    expect(a.eligibility).toBe('ineligible');
    expect(a.refusal).toBe('ingestion_active');
    expect(a.ingestionActive).toBe(true);
  });

  it('C.6 an absent key, and an unreachable store, each refuse (object_absent / store_unreachable)', async () => {
    const ctx = await makeWorkspace();
    const absent = tenantObjectKey({ orgId: ctx.orgId, projectId: ctx.projectId, sourceId: 'never', versionHash: shaOf('never') });
    expect((await tx((t) => assessObjectCleanup(t, ctx, store, absent))).refusal).toBe('object_absent');
    const { key } = await orphanObject(ctx, 'c6');
    const unreachable = new Proxy(store as object, { get(target, prop, r) { if (prop === 'head') return async () => { throw new Error('down'); }; const v = Reflect.get(target, prop, r); return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v; } }) as unknown as ObjectStore;
    expect((await tx((t) => assessObjectCleanup(t, ctx, unreachable, key))).refusal).toBe('store_unreachable');
  });

  it('C.7 propose records a proposed op idempotently; non-admin authority is refused', async () => {
    const ctx = await makeWorkspace();
    const { key } = await orphanObject(ctx, 'c7');
    const p1 = await tx((t) => proposeObjectCleanup(t, ctx, store, key));
    expect(p1.operationId).not.toBeNull();
    expect((await opRow(p1.operationId!)).status).toBe('proposed');
    const p2 = await tx((t) => proposeObjectCleanup(t, ctx, store, key));
    expect(p2.operationId).toBe(p1.operationId); // idempotent — one live op per key
    // A non-admin/owner member cannot propose or assert authority.
    const member: TenantContext = { ...ctx, orgRole: 'member', projectRole: 'member' };
    expect(() => assertObjectCleanupAuthority(member)).toThrow();
    await expect(tx((t) => proposeObjectCleanup(t, member, store, key))).rejects.toThrow();
  });

  it('C.8 execute refuses before the quiet period elapses — nothing is deleted', async () => {
    const ctx = await makeWorkspace();
    const { key } = await orphanObject(ctx, 'c8');
    const p = await tx((t) => proposeObjectCleanup(t, ctx, store, key, { now: new Date() }));
    const r = await executeObjectCleanup(runTx, ctx, store, p.operationId!, { quietMs: 60_000 });
    expect(r.outcome).toBe('refused');
    expect(r.refusal).toBe('quiet_period_not_elapsed');
    expect(await store.head(key)).not.toBeNull(); // object still present
    expect((await opRow(p.operationId!)).status).toBe('proposed');
  });

  it('C.9 happy path: after the quiet period, the orphan is deleted and confirmed; NO document/version/tombstone row is deleted', async () => {
    const ctx = await makeWorkspace();
    await byteExactDoc(ctx, 'c9-keep.md', 'a real document that must survive');
    const { key } = await orphanObject(ctx, 'c9');
    const counts0 = await rowCounts(ctx);
    const p = await tx((t) => proposeObjectCleanup(t, ctx, store, key));
    const r = await executeObjectCleanup(runTx, ctx, store, p.operationId!, { quietMs: 0 });
    expect(r.outcome).toBe('deleted');
    expect(r.objectDeleted).toBe(true);
    expect(r.committed).toBe(true);
    expect(r.verified).toBe(true);
    expect(await store.head(key)).toBeNull(); // the object is gone
    expect((await opRow(p.operationId!)).status).toBe('deleted');
    expect(await rowCounts(ctx)).toEqual(counts0); // no doc/version/tombstone rows removed
    const evs = await cleanupEvents(ctx, p.operationId!);
    expect(evs.some((e) => e.action === 'document.object_cleanup_proposed')).toBe(true);
    expect(evs.some((e) => e.action === 'document.object_cleanup_deleted')).toBe(true);
    expect(JSON.stringify(evs)).not.toContain(key); // metadata-only — no raw object path in evidence
  });

  it('C.10 exact-state binding: if the object changes after proposal, execute refuses (identity_changed) and deletes nothing', async () => {
    const ctx = await makeWorkspace();
    const { key } = await orphanObject(ctx, 'c10');
    const p = await tx((t) => proposeObjectCleanup(t, ctx, store, key));
    await store.put(key, Buffer.from('the object was replaced after it was proposed', 'utf8'), 'text/markdown');
    const r = await executeObjectCleanup(runTx, ctx, store, p.operationId!, { quietMs: 0 });
    expect(r.outcome).toBe('refused');
    expect(r.refusal).toBe('identity_changed');
    expect(await store.head(key)).not.toBeNull();
    expect((await opRow(p.operationId!)).status).toBe('proposed');
  });

  it('C.11 if a reference appears after proposal, execute refuses (referenced) and deletes nothing', async () => {
    const ctx = await makeWorkspace();
    const { key } = await orphanObject(ctx, 'c11');
    const p = await tx((t) => proposeObjectCleanup(t, ctx, store, key));
    // A new document row now claims that object key (reference appeared after the proposal).
    await db().insert(documents).values({ orgId: ctx.orgId, projectId: ctx.projectId, source: 'cloud_upload', sourceId: `claim-${randomUUID().slice(0, 8)}`, relativePath: 'claim.md', kind: 'markdown', sha256: shaOf('claim'), sizeBytes: 5, status: 'active', objectKey: key, mimeType: 'text/markdown' });
    const r = await executeObjectCleanup(runTx, ctx, store, p.operationId!, { quietMs: 0 });
    expect(r.outcome).toBe('refused');
    expect(r.refusal).toBe('referenced');
    expect(await store.head(key)).not.toBeNull();
  });

  it('C.12 partial failure — ambiguous delete (delete + head both fail): authorized, verified=false, no DB row deleted', async () => {
    const ctx = await makeWorkspace();
    const { key } = await orphanObject(ctx, 'c12b');
    const counts0 = await rowCounts(ctx);
    const p = await tx((t) => proposeObjectCleanup(t, ctx, store, key));
    const broken = brokenDeleteStore({ headThrows: true });
    const r = await executeObjectCleanup(runTx, ctx, broken, p.operationId!, { quietMs: 0 });
    expect(r.outcome).toBe('ambiguous');
    expect(r.objectDeleted).toBe(false);
    expect(r.verified).toBe(false);
    expect((await opRow(p.operationId!)).status).toBe('authorized'); // retryable
    expect((await opRow(p.operationId!)).attempts).toBe(1);
    expect(await rowCounts(ctx)).toEqual(counts0);
  });

  it('C.13 partial failure — delete fails but head confirms still-present → failed, retryable, nothing lost', async () => {
    const ctx = await makeWorkspace();
    const { key } = await orphanObject(ctx, 'c13');
    const p = await tx((t) => proposeObjectCleanup(t, ctx, store, key));
    const broken = brokenDeleteStore({ headThrows: false }); // head still works → object present → 'failed'
    const r = await executeObjectCleanup(runTx, ctx, broken, p.operationId!, { quietMs: 0 });
    expect(r.outcome).toBe('failed');
    expect(await store.head(key)).not.toBeNull();
    expect((await opRow(p.operationId!)).status).toBe('authorized');
  });

  it('C.14 crash AFTER the object is deleted but BEFORE the DB finalize → a retry reconciles to completed (no blind re-delete)', async () => {
    const ctx = await makeWorkspace();
    const { key } = await orphanObject(ctx, 'c14');
    const counts0 = await rowCounts(ctx);
    const p = await tx((t) => proposeObjectCleanup(t, ctx, store, key));
    // A runTx that authorizes (call #1) but throws on the finalize commit (call #2), after phase B deleted the object.
    let calls = 0;
    const crashingRunTx = <T>(fn: (t: DbTx) => Promise<T>): Promise<T> => {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error('injected: DB finalize crashed after object delete'));
      return db().transaction((t) => fn(t as unknown as DbTx));
    };
    await expect(executeObjectCleanup(crashingRunTx, ctx, store, p.operationId!, { quietMs: 0 })).rejects.toThrow('DB finalize crashed');
    expect(await store.head(key)).toBeNull(); // the object WAS deleted by phase B
    expect((await opRow(p.operationId!)).status).toBe('authorized'); // finalize never committed
    // A retry reconciles: the object is already gone → completed without a second delete, no success invented.
    const r2 = await executeObjectCleanup(runTx, ctx, store, p.operationId!, { quietMs: 0 });
    expect(r2.outcome).toBe('reconciled_absent');
    expect(r2.objectDeleted).toBe(false);
    expect((await opRow(p.operationId!)).status).toBe('deleted');
    expect(await rowCounts(ctx)).toEqual(counts0);
  });

  it('C.15 idempotency: re-executing a completed cleanup is harmless (already_deleted)', async () => {
    const ctx = await makeWorkspace();
    const { key } = await orphanObject(ctx, 'c15');
    const p = await tx((t) => proposeObjectCleanup(t, ctx, store, key));
    await executeObjectCleanup(runTx, ctx, store, p.operationId!, { quietMs: 0 });
    const again = await executeObjectCleanup(runTx, ctx, store, p.operationId!, { quietMs: 0 });
    expect(again.outcome).toBe('already_deleted');
    expect((await opRow(p.operationId!)).status).toBe('deleted');
  });

  it('C.16 cross-workspace execute is existence-neutral: workspace A cannot act on B\'s operation, and B\'s object is untouched', async () => {
    const a = await makeWorkspace();
    const b = await makeWorkspace();
    const { key } = await orphanObject(b, 'c16');
    const pB = await tx((t) => proposeObjectCleanup(t, b, store, key));
    const r = await executeObjectCleanup(runTx, a, store, pB.operationId!, { quietMs: 0 });
    expect(r.outcome).toBe('refused');
    expect(r.refusal).toBe('not_proposed');
    expect(await store.head(key)).not.toBeNull(); // B's object is untouched
    expect((await opRow(pB.operationId!)).status).toBe('proposed');
  });
});
