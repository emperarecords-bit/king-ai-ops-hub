import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { documentChunks, documentVersions, documents, memberships, organizations, profiles, projectMembers, projects } from '@/db/schema';
import { chunkText, linkFolder, refreshIndex, retrieveRelevant } from '@/domain/documents/documents';
import { ingestDocumentVersion, setCurrentVersion, versionObjectKey } from '@/domain/documents/versions';
import { LocalObjectStore } from '@/domain/documents/local-object-store';

/**
 * Documents increment 1, Stage B — the immutable-version model + dual-write ingestion.
 *
 * These are the Stage B invariant tests: exact bytes are retained and hash-verified, the same content
 * reuses the version, changed content forks a new immutable version, a failed parse keeps the evidence
 * but never becomes current, the current pointer only ever references an indexed version of the SAME
 * document + workspace, the DB trigger backstops immutability, and version chunks NEVER leak into legacy
 * retrieval (the retrieval switch is Stage C2). Object storage is the hermetic LocalObjectStore.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[document-versions.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

let storeDir = '';
let store: LocalObjectStore;
let orgId = '';
let ctx: TenantContext;
let otherCtx: TenantContext; // a second workspace, for cross-tenant rejection

const V1 = '# Continuity\n\nThe King departs at dawn. Sigil: the silver falcon.\n\nThe banner appears in every court scene.';
const V2 = '# Continuity (revised)\n\nThe King departs at dusk, not dawn. Sigil unchanged.\n\nAdd the dusk lighting note.';

function sha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Insert a bare logical document (local_folder) with no versions yet; returns its id. */
async function makeDoc(c: TenantContext, sourceId: string, relPath: string): Promise<string> {
  const inserted = await getSetupDb()
    .insert(documents)
    .values({
      orgId: c.orgId,
      projectId: c.projectId,
      source: 'local_folder',
      sourceId,
      relativePath: relPath,
      kind: 'markdown',
      sha256: 'seed',
      sizeBytes: 0,
      status: 'active',
      chunkCount: 0,
    })
    .returning({ id: documents.id });
  return inserted[0]!.id;
}

async function ingest(c: TenantContext, documentId: string, body: string, chunk: (t: string) => string[] = chunkText) {
  const bytes = Buffer.from(body, 'utf8');
  return withTenant(c, (tx) =>
    ingestDocumentVersion(tx, c, store, { documentId, bytes, text: body, mimeType: 'text/markdown', disclosure: 'workspace_internal', chunk }),
  );
}

async function versionRows(documentId: string) {
  return getSetupDb()
    .select({ id: documentVersions.id, sha: documentVersions.sha256, status: documentVersions.indexStatus, fidelity: documentVersions.contentFidelity, key: documentVersions.objectKey, size: documentVersions.sizeBytes })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, documentId));
}

async function versionChunkRows(versionId: string) {
  return getSetupDb()
    .select({ idx: documentChunks.chunkIndex, content: documentChunks.content, hash: documentChunks.contentHash, parser: documentChunks.parserVersion })
    .from(documentChunks)
    .where(eq(documentChunks.documentVersionId, versionId));
}

async function currentVersionId(documentId: string): Promise<string | null> {
  const r = await getSetupDb().select({ c: documents.currentVersionId }).from(documents).where(eq(documents.id, documentId));
  return r[0]!.c ?? null;
}

/** Run a raw statement expected to be rejected by a DB trigger/constraint, asserting the SERVER message
 *  (drizzle wraps it as "Failed query…" with the real Postgres message on `.cause`). */
async function expectDbReject(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected the statement to be rejected').toBeTruthy();
  const e = caught as { message?: string; cause?: { message?: string } };
  const combined = `${e.message ?? ''} ${e.cause?.message ?? ''}`;
  expect(combined).toMatch(pattern);
}

beforeAll(async () => {
  if (!available) return;
  storeDir = await mkdtemp(join(tmpdir(), 'docver-store-'));
  process.env.LOCAL_OBJECT_STORE_DIR = storeDir;
  store = new LocalObjectStore(storeDir);

  const db = getSetupDb();
  const userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `dv-${randomUUID().slice(0, 8)}@t.local`, displayName: 'DV' });
  const org = await db.insert(organizations).values({ name: 'DV Org', slug: `dv-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  const p = await db.insert(projects).values({ orgId, key: fixtureKey('dv'), name: 'DV Project' }).returning({ id: projects.id });
  await db.insert(projectMembers).values({ orgId, projectId: p[0]!.id, userId, role: 'admin' });
  ctx = { userId, orgId, projectId: p[0]!.id, orgRole: 'owner', projectRole: 'admin' };

  const p2 = await db.insert(projects).values({ orgId, key: fixtureKey('dv2'), name: 'DV Project 2' }).returning({ id: projects.id });
  await db.insert(projectMembers).values({ orgId, projectId: p2[0]!.id, userId, role: 'admin' });
  otherCtx = { userId, orgId, projectId: p2[0]!.id, orgRole: 'owner', projectRole: 'admin' };
});

afterAll(async () => {
  if (available && orgId) {
    const db = getSetupDb();
    await db.execute(sql`alter table audit_logs disable trigger audit_logs_append_only`);
    await db.execute(sql`delete from audit_logs where org_id = ${orgId}`);
    await db.execute(sql`alter table audit_logs enable trigger audit_logs_append_only`);
    await db.delete(organizations).where(eq(organizations.id, orgId));
  }
  if (storeDir) await rm(storeDir, { recursive: true, force: true });
  delete process.env.LOCAL_OBJECT_STORE_DIR;
});

describe.skipIf(!available)('Stage B — immutable versions + dual-write', () => {
  it('1. retains the EXACT bytes under a content-addressed key', async () => {
    const docId = await makeDoc(ctx, 'exact.md', 'exact.md');
    const res = await ingest(ctx, docId, V1);
    expect(res.indexStatus).toBe('indexed');
    expect(res.reused).toBe(false);
    const key = versionObjectKey(ctx, docId, sha(Buffer.from(V1, 'utf8')));
    const stored = await store.get(key);
    expect(stored.equals(Buffer.from(V1, 'utf8'))).toBe(true); // byte-for-byte
    const [v] = await versionRows(docId);
    expect(v!.key).toBe(key);
    expect(v!.size).toBe(Buffer.byteLength(V1, 'utf8'));
  });

  it('2. version chunks are hashes of the SAME bytes that were retained', async () => {
    const docId = await makeDoc(ctx, 'chunks.md', 'chunks.md');
    await ingest(ctx, docId, V1);
    const [v] = await versionRows(docId);
    const chunks = await versionChunkRows(v!.id);
    const expected = chunkText(V1);
    expect(chunks.length).toBe(expected.length);
    for (const c of chunks) {
      expect(c.parser).toBe('chunk-v1');
      expect(c.hash).toBe(sha(Buffer.from(c.content, 'utf8'))); // content hash matches stored content
    }
  });

  it('3. same content → reuse: no duplicate version, chunk, or object', async () => {
    const docId = await makeDoc(ctx, 'reuse.md', 'reuse.md');
    const first = await ingest(ctx, docId, V1);
    const before = await versionRows(docId);
    const beforeChunks = await versionChunkRows(before[0]!.id);
    const second = await ingest(ctx, docId, V1);
    expect(second.reused).toBe(true);
    expect(second.versionId).toBe(first.versionId);
    const after = await versionRows(docId);
    expect(after.length).toBe(1); // no new version row
    expect((await versionChunkRows(after[0]!.id)).length).toBe(beforeChunks.length); // no dup chunks
  });

  it('4. changed content → a NEW immutable version + a NEW object', async () => {
    const docId = await makeDoc(ctx, 'changed.md', 'changed.md');
    const first = await ingest(ctx, docId, V1);
    const second = await ingest(ctx, docId, V2);
    expect(second.reused).toBe(false);
    expect(second.versionId).not.toBe(first.versionId);
    const rows = await versionRows(docId);
    expect(rows.length).toBe(2);
    // Two distinct content-addressed objects exist.
    expect(await store.get(versionObjectKey(ctx, docId, sha(Buffer.from(V1, 'utf8'))))).toBeTruthy();
    expect(await store.get(versionObjectKey(ctx, docId, sha(Buffer.from(V2, 'utf8'))))).toBeTruthy();
  });

  it('5. an earlier version and its chunks are unchanged by a later version', async () => {
    const docId = await makeDoc(ctx, 'earlier.md', 'earlier.md');
    const first = await ingest(ctx, docId, V1);
    const firstChunks = await versionChunkRows(first.versionId);
    await ingest(ctx, docId, V2);
    // The v1 row is byte-identical to before; its chunks are untouched.
    const v1 = (await versionRows(docId)).find((r) => r.id === first.versionId)!;
    expect(v1.sha).toBe(sha(Buffer.from(V1, 'utf8')));
    expect(v1.status).toBe('indexed');
    const stillChunks = await versionChunkRows(first.versionId);
    expect(stillChunks.map((c) => c.content)).toEqual(firstChunks.map((c) => c.content));
  });

  it('6. current version repoints to the newest INDEXED version', async () => {
    const docId = await makeDoc(ctx, 'current.md', 'current.md');
    const first = await ingest(ctx, docId, V1);
    expect(await currentVersionId(docId)).toBe(first.versionId);
    const second = await ingest(ctx, docId, V2);
    expect(await currentVersionId(docId)).toBe(second.versionId);
  });

  it('7. a key collision (same key, different bytes) fails safely — object never overwritten', async () => {
    const docId = await makeDoc(ctx, 'collide.md', 'collide.md');
    const key = versionObjectKey(ctx, docId, sha(Buffer.from(V1, 'utf8')));
    // Pre-seed the exact key with DIFFERENT bytes (an impossible SHA collision, simulated).
    await store.put(key, Buffer.from('tampered bytes', 'utf8'), 'text/markdown');
    await expect(ingest(ctx, docId, V1)).rejects.toThrow(/collision/i);
    // No version row was created, and the object was not overwritten.
    expect((await versionRows(docId)).length).toBe(0);
    expect((await store.get(key)).toString('utf8')).toBe('tampered bytes');
  });

  it('8. a failed parse retains the version + bytes, never becomes current, and adds no retrievable chunks', async () => {
    const docId = await makeDoc(ctx, 'failed.md', 'failed.md');
    const res = await ingest(ctx, docId, V1, () => {
      throw new Error('parser blew up');
    });
    expect(res.indexStatus).toBe('failed');
    const [v] = await versionRows(docId);
    expect(v!.status).toBe('failed');
    // Bytes are still retained (byte_exact + object present).
    expect(v!.fidelity).toBe('byte_exact');
    expect((await store.get(v!.key!)).equals(Buffer.from(V1, 'utf8'))).toBe(true);
    // Never current, and no version chunks were written.
    expect(await currentVersionId(docId)).toBeNull();
    expect((await versionChunkRows(v!.id)).length).toBe(0);
  });

  it('9. setCurrentVersion rejects a version from a DIFFERENT document', async () => {
    const docA = await makeDoc(ctx, 'a9.md', 'a9.md');
    const docB = await makeDoc(ctx, 'b9.md', 'b9.md');
    const va = await ingest(ctx, docA, V1);
    await expect(withTenant(ctx, (tx) => setCurrentVersion(tx, ctx, docB, va.versionId))).rejects.toThrow(/different document/i);
  });

  it('10. setCurrentVersion rejects a version from a DIFFERENT workspace', async () => {
    const docHere = await makeDoc(ctx, 'here10.md', 'here10.md');
    const docThere = await makeDoc(otherCtx, 'there10.md', 'there10.md');
    const vThere = await ingest(otherCtx, docThere, V1);
    // Even naming the local doc id, a foreign version id is not in this workspace.
    await expect(withTenant(ctx, (tx) => setCurrentVersion(tx, ctx, docHere, vThere.versionId))).rejects.toThrow(/not in this workspace/i);
  });

  it('11. setCurrentVersion rejects a version that is not indexed (pending/failed)', async () => {
    const docId = await makeDoc(ctx, 'pending11.md', 'pending11.md');
    // A pending version, inserted directly (never indexed).
    const inserted = await getSetupDb()
      .insert(documentVersions)
      .values({ orgId: ctx.orgId, projectId: ctx.projectId, documentId: docId, sha256: 'p'.repeat(64), sizeBytes: 1, objectKey: versionObjectKey(ctx, docId, 'p'.repeat(64)), contentFidelity: 'byte_exact', indexStatus: 'pending' })
      .returning({ id: documentVersions.id });
    await expect(withTenant(ctx, (tx) => setCurrentVersion(tx, ctx, docId, inserted[0]!.id))).rejects.toThrow(/successfully-indexed/i);
  });

  it('12. the current pointer is only ever set by the service (not left dangling on failure)', async () => {
    const docId = await makeDoc(ctx, 'noptr12.md', 'noptr12.md');
    await ingest(ctx, docId, V1, () => {
      throw new Error('boom');
    });
    // Failed ingest left current null (invariant complements test 8).
    expect(await currentVersionId(docId)).toBeNull();
  });

  it('13. DB trigger blocks rewriting immutable version facts', async () => {
    const docId = await makeDoc(ctx, 'immut13.md', 'immut13.md');
    const v = await ingest(ctx, docId, V1);
    await expectDbReject(
      () => getSetupDb().execute(sql`update document_versions set sha256 = ${'z'.repeat(64)} where id = ${v.versionId}`),
      /immutable version facts/i,
    );
    await expectDbReject(
      () => getSetupDb().execute(sql`update document_versions set object_key = 'other/key' where id = ${v.versionId}`),
      /immutable version facts/i,
    );
  });

  it('14. DB trigger blocks reverting index_status once terminal', async () => {
    const docId = await makeDoc(ctx, 'terminal14.md', 'terminal14.md');
    const v = await ingest(ctx, docId, V1); // indexed
    await expectDbReject(
      () => getSetupDb().execute(sql`update document_versions set index_status = 'pending' where id = ${v.versionId}`),
      /index status is terminal/i,
    );
  });

  it('15. CHECK constraint forbids byte_exact without a retained object', async () => {
    const docId = await makeDoc(ctx, 'check15.md', 'check15.md');
    await expect(
      getSetupDb().execute(
        sql`insert into document_versions (org_id, project_id, document_id, sha256, size_bytes, content_fidelity, object_key, index_status) values (${ctx.orgId}, ${ctx.projectId}, ${docId}, ${'a'.repeat(64)}, 1, 'byte_exact', null, 'pending')`,
      ),
    ).rejects.toThrow();
  });

  it('16. an unavailable-fidelity version MAY have no object (evidence honestly absent)', async () => {
    const docId = await makeDoc(ctx, 'unavail16.md', 'unavail16.md');
    // This is legal: 'unavailable' records that bytes are honestly not retained.
    await getSetupDb().execute(
      sql`insert into document_versions (org_id, project_id, document_id, sha256, size_bytes, content_fidelity, object_key, index_status) values (${ctx.orgId}, ${ctx.projectId}, ${docId}, ${'b'.repeat(64)}, 0, 'unavailable', null, 'failed')`,
    );
    const rows = await versionRows(docId);
    expect(rows.find((r) => r.fidelity === 'unavailable')).toBeTruthy();
  });

  it('17. the object is reused (hash-verified) on a retry after a simulated DB failure', async () => {
    const docId = await makeDoc(ctx, 'retry17.md', 'retry17.md');
    // First attempt: object is written, but pretend the DB txn rolled back by deleting the version rows
    // while leaving the object in place (mirrors a crash between put and commit).
    await ingest(ctx, docId, V1);
    const key = versionObjectKey(ctx, docId, sha(Buffer.from(V1, 'utf8')));
    await getSetupDb().delete(documentChunks).where(eq(documentChunks.documentId, docId));
    await getSetupDb().delete(documentVersions).where(eq(documentVersions.documentId, docId));
    await getSetupDb().update(documents).set({ currentVersionId: null }).where(eq(documents.id, docId));
    // Retry: the object already exists and hashes correctly → reused, no error, version re-created.
    const res = await ingest(ctx, docId, V1);
    expect(res.indexStatus).toBe('indexed');
    expect((await store.get(key)).equals(Buffer.from(V1, 'utf8'))).toBe(true);
  });

  it('18. version chunks NEVER leak into legacy retrieval (retrieval switch is Stage C2)', async () => {
    // A fresh workspace with a version but NO legacy null-version chunks: retrieval must return nothing,
    // proving the transition guard filters version-scoped chunks.
    const isoCtx = otherCtx;
    const docId = await makeDoc(isoCtx, 'leak18.md', 'leak18.md');
    await ingest(isoCtx, docId, '# Kubernetes\n\nDeployment runs on kubernetes with three replicas.');
    const hits = await withTenant(isoCtx, (tx) => retrieveRelevant(tx, isoCtx, 'kubernetes replicas deployment', 5));
    expect(hits.every((h) => h.relativePath !== 'leak18.md')).toBe(true);
  });

  it('19. reuse updates last_seen_at but creates no new rows and does not move current', async () => {
    const docId = await makeDoc(ctx, 'seen19.md', 'seen19.md');
    const first = await ingest(ctx, docId, V1);
    const beforeCurrent = await currentVersionId(docId);
    await ingest(ctx, docId, V1); // same content
    const seen = await getSetupDb().select({ s: documents.lastSeenAt }).from(documents).where(eq(documents.id, docId));
    expect(seen[0]!.s).not.toBeNull();
    expect((await versionRows(docId)).length).toBe(1);
    expect(await currentVersionId(docId)).toBe(beforeCurrent);
    expect(beforeCurrent).toBe(first.versionId);
  });

  describe('folder refresh — disappearance / reappearance', () => {
    it('20. local-folder refresh dual-writes an immutable version alongside the legacy index', async () => {
      const folder = await mkdtemp(join(tmpdir(), 'dv-folder-'));
      try {
        await writeFile(join(folder, 'brief.md'), V1);
        await withTenant(ctx, (tx) => linkFolder(tx, ctx, folder));
        const s = await withTenant(ctx, (tx) => refreshIndex(tx, ctx));
        expect(s.indexed).toBe(1);
        const doc = (await getSetupDb().select({ id: documents.id }).from(documents).where(and(eq(documents.projectId, ctx.projectId), eq(documents.relativePath, 'brief.md'))))[0]!;
        const vers = await versionRows(doc.id);
        expect(vers.length).toBe(1);
        expect(vers[0]!.status).toBe('indexed');
        expect(await currentVersionId(doc.id)).toBe(vers[0]!.id);
        // Legacy (null-version) chunks exist and are retrievable.
        const legacy = await getSetupDb().select({ n: documentChunks.id }).from(documentChunks).where(and(eq(documentChunks.documentId, doc.id), isNull(documentChunks.documentVersionId)));
        expect(legacy.length).toBeGreaterThan(0);
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    });

    it('21. when a source disappears, its versions + version chunks are preserved (evidence survives archival)', async () => {
      const folder = await mkdtemp(join(tmpdir(), 'dv-disappear-'));
      try {
        const file = join(folder, 'ephemeral.md');
        await writeFile(file, V1);
        await withTenant(ctx, (tx) => linkFolder(tx, ctx, folder));
        await withTenant(ctx, (tx) => refreshIndex(tx, ctx));
        const doc = (await getSetupDb().select({ id: documents.id }).from(documents).where(and(eq(documents.projectId, ctx.projectId), eq(documents.relativePath, 'ephemeral.md'))))[0]!;
        const vId = (await versionRows(doc.id))[0]!.id;

        await unlink(file); // source vanishes
        const s = await withTenant(ctx, (tx) => refreshIndex(tx, ctx));
        expect(s.archived).toBeGreaterThanOrEqual(1);
        const after = await getSetupDb().select({ status: documents.status }).from(documents).where(eq(documents.id, doc.id));
        expect(after[0]!.status).toBe('archived');
        // Legacy chunks removed (not retrievable), but the version + its chunks remain as evidence.
        const legacy = await getSetupDb().select({ n: documentChunks.id }).from(documentChunks).where(and(eq(documentChunks.documentId, doc.id), isNull(documentChunks.documentVersionId)));
        expect(legacy.length).toBe(0);
        expect((await versionRows(doc.id)).length).toBe(1);
        expect((await versionChunkRows(vId)).length).toBeGreaterThan(0);
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    });

    it('22. reappearance with the SAME content reuses the version; CHANGED content forks a new one', async () => {
      const folder = await mkdtemp(join(tmpdir(), 'dv-reappear-'));
      try {
        const file = join(folder, 'reappearing.md');
        await writeFile(file, V1);
        await withTenant(ctx, (tx) => linkFolder(tx, ctx, folder));
        await withTenant(ctx, (tx) => refreshIndex(tx, ctx));
        const doc = (await getSetupDb().select({ id: documents.id }).from(documents).where(and(eq(documents.projectId, ctx.projectId), eq(documents.relativePath, 'reappearing.md'))))[0]!;
        expect((await versionRows(doc.id)).length).toBe(1);

        await unlink(file);
        await withTenant(ctx, (tx) => refreshIndex(tx, ctx)); // archived

        // Reappears with identical content → reuse (still one version).
        await writeFile(file, V1);
        await withTenant(ctx, (tx) => refreshIndex(tx, ctx));
        expect((await versionRows(doc.id)).length).toBe(1);

        // Now changes → a second immutable version.
        await writeFile(file, V2);
        await withTenant(ctx, (tx) => refreshIndex(tx, ctx));
        const rows = await versionRows(doc.id);
        expect(rows.length).toBe(2);
        expect(await currentVersionId(doc.id)).toBe(rows.find((r) => r.sha === sha(Buffer.from(V2, 'utf8')))!.id);
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    });
  });
});
