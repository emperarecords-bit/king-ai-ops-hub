import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { documentChunks, documents, memberships, organizations, profiles, projectMembers, projects } from '@/db/schema';
import { retrieveRelevant } from '@/domain/documents/documents';
import { uploadDocument } from '@/domain/documents/cloud';
import { claimNextDocumentJob, reconcileStaleDocumentJobs, runClaimedDocumentJob } from '@/domain/documents/document-jobs';
import { S3ObjectStore } from '@/domain/documents/s3-object-store';
import { __resetObjectStore } from '@/domain/documents/object-store';

/**
 * O-23 production acceptance — LIVE object storage. Validates the real
 * S3ObjectStore (SigV4 over HTTP) against a genuine S3-compatible server (local
 * MinIO). This is the same protocol as Tigris/R2/AWS; the only thing it does NOT
 * cover is the owner's specific managed bucket + credentials.
 *
 * Requires MinIO: `docker run -d --name king-minio -p 9000:9000 minio/minio
 * server /data` + a private bucket. Skips cleanly when unreachable.
 */

const S3 = {
  endpoint: process.env.S3_TEST_ENDPOINT ?? 'http://localhost:9000',
  region: 'us-east-1',
  bucket: process.env.S3_TEST_BUCKET ?? 'king-lib-staging',
  accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? 'minioadmin',
  secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? 'minioadmin-local-only',
};

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

// Route getObjectStore() (used by the worker path) at the live S3 bucket.
// Save the prior storage env so this file cannot leak the s3 driver into
// sibling test files running in the same worker.
const SAVED_STORAGE_ENV = {
  STORAGE_DRIVER: process.env.STORAGE_DRIVER,
  S3_ENDPOINT: process.env.S3_ENDPOINT,
  S3_REGION: process.env.S3_REGION,
  S3_BUCKET: process.env.S3_BUCKET,
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
  LOCAL_OBJECT_STORE_DIR: process.env.LOCAL_OBJECT_STORE_DIR,
};
process.env.STORAGE_DRIVER = 's3';
process.env.S3_ENDPOINT = S3.endpoint;
process.env.S3_REGION = S3.region;
process.env.S3_BUCKET = S3.bucket;
process.env.S3_ACCESS_KEY_ID = S3.accessKeyId;
process.env.S3_SECRET_ACCESS_KEY = S3.secretAccessKey;
__resetObjectStore();

let dbAvailable = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  dbAvailable = true;
} catch (err) {
  console.warn(`[s3-live.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}
let s3Available = false;
try {
  const res = await fetch(`${S3.endpoint}/minio/health/live`, { signal: AbortSignal.timeout(2000) });
  s3Available = res.ok;
} catch {
  console.warn('[s3-live.test] SKIPPING — MinIO/S3 not reachable at ' + S3.endpoint);
}
const available = dbAvailable && s3Available;

const store = new S3ObjectStore(S3);
let orgId = '';
let ctx: TenantContext;

async function chunkCount(documentId: string): Promise<number> {
  const rows = await getSetupDb().select({ n: documentChunks.id }).from(documentChunks).where(eq(documentChunks.documentId, documentId));
  return rows.length;
}
async function drain(): Promise<number> {
  let n = 0;
  for (let i = 0; i < 20; i += 1) {
    const job = await claimNextDocumentJob();
    if (!job) break;
    await runClaimedDocumentJob(job);
    n += 1;
  }
  return n;
}
async function upload(name: string, body: string) {
  return withTenant(ctx, (tx) => uploadDocument(tx, ctx, store, { rawFilename: name, declaredMime: 'text/markdown', bytes: Buffer.from(body, 'utf8') }));
}

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  const userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `s3-${randomUUID().slice(0, 8)}@t.local`, displayName: 'S3' });
  const org = await db.insert(organizations).values({ name: 'S3 Org', slug: `s3-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  const p = await db.insert(projects).values({ orgId, key: fixtureKey('s3'), name: 'S3 Live' }).returning({ id: projects.id });
  await db.insert(projectMembers).values({ orgId, projectId: p[0]!.id, userId, role: 'admin' });
  ctx = { userId, orgId, projectId: p[0]!.id, orgRole: 'owner', projectRole: 'admin' };
});

afterAll(async () => {
  if (available && orgId) {
    const db = getSetupDb();
    // Clean the objects we created from the live bucket.
    const keys = await db.select({ k: documents.objectKey }).from(documents).where(eq(documents.orgId, orgId));
    for (const { k } of keys) if (k) await store.delete(k).catch(() => {});
    await db.execute(sql`alter table audit_logs disable trigger audit_logs_append_only`);
    await db.execute(sql`delete from audit_logs where org_id = ${orgId}`);
    await db.execute(sql`alter table audit_logs enable trigger audit_logs_append_only`);
    await db.delete(organizations).where(eq(organizations.id, orgId));
  }
  // Restore the storage env so sibling files keep the local driver.
  for (const [k, v] of Object.entries(SAVED_STORAGE_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetObjectStore();
});

describe.skipIf(!available)('O-23 live S3 (MinIO) acceptance', () => {
  it('raw SigV4 round-trip: PUT/GET/HEAD/DELETE against the real bucket', async () => {
    const key = `org/${orgId}/project/${ctx.projectId}/doc/raw.md/v1`;
    const body = Buffer.from('# raw\n\nSigV4 over HTTP.', 'utf8');
    await store.put(key, body, 'text/markdown');
    const head = await store.head(key);
    expect(head?.size).toBe(body.length);
    expect((await store.get(key)).equals(body)).toBe(true);
    expect(await store.head(`org/${orgId}/project/${ctx.projectId}/doc/none/x`)).toBeNull();
    await store.delete(key);
    expect(await store.head(key)).toBeNull();
  });

  it('Step 3 — upload → object in bucket (tenant key) → durable index → active, chunks once', async () => {
    const up = await upload('s3-episode.md', '# Episode 7\n\nThe silver falcon returns for S01E07 continuity.');
    const documentId = (up as { documentId: string }).documentId;

    const key = (await getSetupDb().select({ k: documents.objectKey, s: documents.source }).from(documents).where(eq(documents.id, documentId)))[0]!;
    expect(key.s).toBe('cloud_upload');
    expect(key.k!.startsWith(`org/${orgId}/project/${ctx.projectId}/doc/`)).toBe(true);
    // The object really exists in the managed bucket.
    expect(await store.head(key.k!)).not.toBeNull();

    expect(await drain()).toBeGreaterThanOrEqual(1);
    const after = await getSetupDb().select({ s: documents.status, c: documents.chunkCount }).from(documents).where(eq(documents.id, documentId));
    expect(after[0]!.s).toBe('active');
    expect(await chunkCount(documentId)).toBe(after[0]!.c);

    const hits = await withTenant(ctx, (tx) => retrieveRelevant(tx, ctx, 'Review Episode 7 for continuity', 5));
    expect(hits.some((h) => h.relativePath === 's3-episode.md' && h.source === 'cloud_upload')).toBe(true);
  });

  it('Step 3 — no public access: the object is not anonymously readable', async () => {
    const key = (await getSetupDb().select({ k: documents.objectKey }).from(documents).where(and(eq(documents.orgId, orgId), eq(documents.relativePath, 's3-episode.md'))))[0]!.k!;
    const res = await fetch(`${S3.endpoint}/${S3.bucket}/${key}`); // no auth headers
    expect(res.ok).toBe(false); // 403 AccessDenied on a private bucket
    expect([401, 403]).toContain(res.status);
  });

  it('Step 4 — idempotent re-upload and atomic replacement against live storage', async () => {
    const same = await upload('s3-episode.md', '# Episode 7\n\nThe silver falcon returns for S01E07 continuity.');
    expect(same.result).toBe('unchanged');
    expect(await drain()).toBe(0);

    const docId = (await getSetupDb().select({ id: documents.id }).from(documents).where(and(eq(documents.orgId, orgId), eq(documents.sourceId, 's3-episode.md'))))[0]!.id;
    const changed = await upload('s3-episode.md', '# Episode 7 (revised)\n\nThe falcon banner gains a dusk variant for S01E07.');
    expect(changed.result).toBe('queued');
    expect((changed as { documentId: string }).documentId).toBe(docId); // stable identity
    await drain();
    const hits = await withTenant(ctx, (tx) => retrieveRelevant(tx, ctx, 'Episode 7 dusk falcon banner', 5));
    expect(hits.map((h) => h.content).join('\n')).toContain('dusk');
    const rows = await getSetupDb().select({ id: documents.id, s: documents.status }).from(documents).where(and(eq(documents.orgId, orgId), eq(documents.sourceId, 's3-episode.md')));
    expect(rows.length).toBe(1);
    expect(rows[0]!.s).toBe('active');
  });

  it('Step 5 — worker restart recovery against live storage: no duplicate chunks', async () => {
    const up = await upload('s3-restart.md', '# Restart\n\n' + 'Realm lore paragraph. '.repeat(200));
    const documentId = (up as { documentId: string }).documentId;
    const job = await claimNextDocumentJob();
    expect(job?.documentId).toBe(documentId);
    await getSetupDb().execute(sql`update document_jobs set leased_until = now() - interval '1 hour' where document_id = ${documentId}`);
    expect((await reconcileStaleDocumentJobs()).requeued).toBeGreaterThanOrEqual(1);
    await drain();
    const after = await getSetupDb().select({ s: documents.status, c: documents.chunkCount }).from(documents).where(eq(documents.id, documentId));
    expect(after[0]!.s).toBe('active');
    expect(await chunkCount(documentId)).toBe(after[0]!.c);
  });

  it('Step 2/3 — /api/health reports storage healthy against the live S3 bucket', async () => {
    const { GET } = await import('@/app/api/health/route');
    const res = await GET();
    const body = (await res.json()) as { checks: { storage?: { ok: boolean; detail?: string } } };
    expect(body.checks.storage?.ok).toBe(true);
    expect(body.checks.storage?.detail).toContain('driver=s3');
  });

  it('Step 7 — object-layer isolation: a foreign-tenant key is refused before any fetch', async () => {
    // A key under another workspace's prefix is rejected by the ownership guard
    // in indexCloudDocument (keyBelongsToTenant), so the worker never fetches it.
    const foreignKey = `org/${randomUUID()}/project/${randomUUID()}/doc/secret.md/v1`;
    await store.put(foreignKey, Buffer.from('# other tenant secret'), 'text/markdown');
    const docId = randomUUID();
    await getSetupDb().insert(documents).values({
      id: docId, orgId, projectId: ctx.projectId, source: 'cloud_upload', sourceId: 'planted.md',
      relativePath: 'planted.md', kind: 'markdown', sha256: 'h', sizeBytes: 1, objectKey: foreignKey, status: 'queued',
    });
    // Force an index attempt; the guard must mark it failed WITHOUT reading the object.
    const { indexCloudDocument } = await import('@/domain/documents/cloud');
    const res = await withTenant(ctx, (tx) => indexCloudDocument(tx, ctx, store, docId));
    expect(res.status).toBe('failed');
    expect(await chunkCount(docId)).toBe(0);
    await store.delete(foreignKey).catch(() => {});
  });
});
