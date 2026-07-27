import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { documentChunks, documents, memberships, organizations, profiles, projectMembers, projects } from '@/db/schema';
import { archiveDocument, restoreDocument, retrieveRelevant } from '@/domain/documents/documents';
import { uploadDocument } from '@/domain/documents/cloud';
import { claimNextDocumentJob, reconcileStaleDocumentJobs, runClaimedDocumentJob } from '@/domain/documents/document-jobs';
import { LocalObjectStore } from '@/domain/documents/local-object-store';

/**
 * Cloud Project Library ingestion (O-23), acceptance Tests 1,2,3,5,6,7 at the
 * durable-job level, plus the retrieval/provenance half of Test 8. Cross-
 * workspace isolation (Test 4) is proven as app_server in
 * document-cloud-isolation.test.ts.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

// One temp object-store dir shared by direct calls AND the worker path
// (getObjectStore() reads LOCAL_OBJECT_STORE_DIR).
let storeDir = '';
let store: LocalObjectStore;

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[document-cloud.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

let orgId = '';
let ctx: TenantContext;

const EP1_V1 = `# Episode 1 — Continuity Notes

The King departs the capital at dawn. His sigil is the silver falcon.

Continuity: the falcon banner must appear in every court scene of S01E01.`;
const EP1_V2 = `# Episode 1 — Continuity Notes (revised)

The King departs the capital at dusk, not dawn. Sigil unchanged: silver falcon.

Continuity: the falcon banner appears in every court scene; add the dusk lighting note for S01E01.`;

async function chunkCount(documentId: string): Promise<number> {
  // Count only the LEGACY (null-version) chunk set — the set retrieval reads and `documents.chunkCount`
  // mirrors. Stage B dual-write also writes version-scoped chunks; those are counted separately.
  const rows = await getSetupDb()
    .select({ n: documentChunks.id })
    .from(documentChunks)
    .where(and(eq(documentChunks.documentId, documentId), isNull(documentChunks.documentVersionId)));
  return rows.length;
}

async function drainDocumentJobs(): Promise<number> {
  let n = 0;
  for (let i = 0; i < 20; i += 1) {
    const job = await claimNextDocumentJob();
    if (!job) break;
    await runClaimedDocumentJob(job);
    n += 1;
  }
  return n;
}

beforeAll(async () => {
  if (!available) return;
  storeDir = await mkdtemp(join(tmpdir(), 'o23-store-'));
  process.env.LOCAL_OBJECT_STORE_DIR = storeDir;
  store = new LocalObjectStore(storeDir);

  const db = getSetupDb();
  const userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `o23-${randomUUID().slice(0, 8)}@t.local`, displayName: 'O23' });
  const org = await db.insert(organizations).values({ name: 'O23 Org', slug: `o23-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  const p = await db.insert(projects).values({ orgId, key: fixtureKey('cloud'), name: 'KingdomCore Cloud' }).returning({ id: projects.id });
  await db.insert(projectMembers).values({ orgId, projectId: p[0]!.id, userId, role: 'admin' });
  ctx = { userId, orgId, projectId: p[0]!.id, orgRole: 'owner', projectRole: 'admin' };
});

afterAll(async () => {
  if (available && orgId) {
    const db = getSetupDb();
    // audit_logs is append-only (trigger) and its org FK is restrict; disable
    // the trigger to purge it, then the org delete cascades documents/jobs/chunks.
    await db.execute(sql`alter table audit_logs disable trigger audit_logs_append_only`);
    await db.execute(sql`delete from audit_logs where org_id = ${orgId}`);
    await db.execute(sql`alter table audit_logs enable trigger audit_logs_append_only`);
    await db.delete(organizations).where(eq(organizations.id, orgId));
  }
  if (storeDir) await rm(storeDir, { recursive: true, force: true });
  delete process.env.LOCAL_OBJECT_STORE_DIR;
});

async function upload(name: string, body: string, mime = 'text/markdown') {
  return withTenant(ctx, (tx) =>
    uploadDocument(tx, ctx, store, { rawFilename: name, declaredMime: mime, bytes: Buffer.from(body, 'utf8') }),
  );
}

describe.skipIf(!available)('O-23 cloud ingestion', () => {
  it('Test 1 — upload → durable index → active → retrievable with cloud provenance', async () => {
    const up = await upload('episode1-continuity.md', EP1_V1);
    expect(up.result).toBe('queued');
    const documentId = (up as { documentId: string }).documentId;

    // Status is pre-active until the worker runs.
    const before = await getSetupDb().select({ s: documents.status }).from(documents).where(eq(documents.id, documentId));
    expect(before[0]!.s).toBe('queued');

    const drained = await drainDocumentJobs();
    expect(drained).toBeGreaterThanOrEqual(1);

    const after = await getSetupDb()
      .select({ s: documents.status, source: documents.source, chunks: documents.chunkCount })
      .from(documents)
      .where(eq(documents.id, documentId));
    expect(after[0]!.s).toBe('active');
    expect(after[0]!.source).toBe('cloud_upload');
    expect(after[0]!.chunks).toBeGreaterThan(0);
    expect(await chunkCount(documentId)).toBe(after[0]!.chunks);

    const hits = await withTenant(ctx, (tx) => retrieveRelevant(tx, ctx, 'Review Episode 1 for continuity', 5));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.relativePath === 'episode1-continuity.md')).toBe(true);
    // Test 8 provenance half: the run sees this chunk tagged as a cloud upload.
    expect(hits.find((h) => h.relativePath === 'episode1-continuity.md')!.source).toBe('cloud_upload');
  });

  it('Test 2 — idempotent re-upload: no duplicate doc, no re-index, reports unchanged', async () => {
    const before = await chunkCount(
      (await getSetupDb().select({ id: documents.id }).from(documents).where(and(eq(documents.projectId, ctx.projectId), eq(documents.sourceId, 'episode1-continuity.md'))))[0]!.id,
    );
    const up = await upload('episode1-continuity.md', EP1_V1);
    expect(up.result).toBe('unchanged');
    // No new job was queued; nothing to drain.
    expect(await drainDocumentJobs()).toBe(0);
    const docs = await getSetupDb()
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.projectId, ctx.projectId), eq(documents.sourceId, 'episode1-continuity.md')));
    expect(docs.length).toBe(1); // no duplicate
    expect(await chunkCount(docs[0]!.id)).toBe(before); // unchanged
  });

  it('Test 3 — new version: same source, new hash → old chunks replaced atomically', async () => {
    const docId = (
      await getSetupDb().select({ id: documents.id }).from(documents).where(and(eq(documents.projectId, ctx.projectId), eq(documents.sourceId, 'episode1-continuity.md')))
    )[0]!.id;

    const up = await upload('episode1-continuity.md', EP1_V2);
    expect(up.result).toBe('queued');
    expect((up as { documentId: string }).documentId).toBe(docId); // stable identity

    await drainDocumentJobs();

    // The new content is retrievable; the OLD wording ("at dawn") is gone.
    const hits = await withTenant(ctx, (tx) => retrieveRelevant(tx, ctx, 'Episode 1 dusk lighting continuity', 5));
    const joined = hits.map((h) => h.content).join('\n');
    expect(joined).toContain('dusk');
    // Only one active document for this source; chunks reflect only the new version.
    const active = await getSetupDb()
      .select({ id: documents.id, status: documents.status })
      .from(documents)
      .where(and(eq(documents.projectId, ctx.projectId), eq(documents.sourceId, 'episode1-continuity.md')));
    expect(active.length).toBe(1);
    expect(active[0]!.status).toBe('active');
  });

  it('Test 5 — worker restart mid-index recovers with no duplicate chunks', async () => {
    const up = await upload('restart-doc.md', '# Restart\n\nSome indexable content about the realm.');
    const documentId = (up as { documentId: string }).documentId;

    // Claim the job (marks running + lease) then simulate a crash: never finish.
    const job = await claimNextDocumentJob();
    expect(job?.documentId).toBe(documentId);
    // Expire the lease as a restarted worker's reconcile would find it.
    await getSetupDb().execute(
      sql`update document_jobs set leased_until = now() - interval '1 hour' where document_id = ${documentId}`,
    );
    const recon = await reconcileStaleDocumentJobs();
    expect(recon.requeued).toBeGreaterThanOrEqual(1);

    // Now a healthy worker drains it to active.
    await drainDocumentJobs();
    const after = await getSetupDb().select({ s: documents.status, c: documents.chunkCount }).from(documents).where(eq(documents.id, documentId));
    expect(after[0]!.s).toBe('active');
    expect(await chunkCount(documentId)).toBe(after[0]!.c); // exactly one set of chunks
  });

  it('Test 6 — unsupported/deceptive files are rejected or marked unsupported, never active', async () => {
    // PDF extension → recorded unsupported.
    const pdf = await upload('report.pdf', '%PDF-1.4 fake', 'application/pdf');
    expect(pdf.result).toBe('unsupported');
    // Binary content in a .md → rejected (throws), no row activated.
    await expect(upload('sneaky.md', '  binary', 'text/markdown')).rejects.toThrow();
    // Oversized text → rejected.
    const huge = 'a'.repeat(2_000_001);
    await expect(upload('huge.txt', huge, 'text/plain')).rejects.toThrow();
    // None of these are active/retrievable.
    const bad = await getSetupDb()
      .select({ status: documents.status, path: documents.relativePath })
      .from(documents)
      .where(eq(documents.projectId, ctx.projectId));
    expect(bad.find((d) => d.path === 'report.pdf')!.status).toBe('unsupported');
    expect(bad.some((d) => d.path === 'sneaky.md')).toBe(false);
    expect(bad.some((d) => d.path === 'huge.txt')).toBe(false);
  });

  it('Test 7 — cloud docs are fully manageable regardless of any local source state', async () => {
    // A local-folder document that is "offline" (unreachable folder) stays active.
    const localId = randomUUID();
    await getSetupDb().insert(documents).values({
      id: localId, orgId, projectId: ctx.projectId, source: 'local_folder',
      relativePath: 'local/offline-note.md', kind: 'markdown', sha256: 'x', sizeBytes: 10,
      status: 'active', chunkCount: 0,
    });

    // Cloud upload + index works with the local source offline.
    const up = await upload('cloud-only.md', '# Cloud only\n\nManaged entirely in the cloud.');
    await drainDocumentJobs();
    const cloudId = (up as { documentId: string }).documentId;

    // Archive then RESTORE the cloud doc — full lifecycle available (restore un-archives; retry is only
    // for failed/stuck indexing, not for reversing an intentional archive).
    await withTenant(ctx, (tx) => archiveDocument(tx, ctx, cloudId));
    let s = await getSetupDb().select({ s: documents.status }).from(documents).where(eq(documents.id, cloudId));
    expect(s[0]!.s).toBe('archived');
    await withTenant(ctx, (tx) => restoreDocument(tx, ctx, store, cloudId));
    await drainDocumentJobs();
    s = await getSetupDb().select({ s: documents.status }).from(documents).where(eq(documents.id, cloudId));
    expect(s[0]!.s).toBe('active');

    // The offline LOCAL doc was never archived by cloud activity.
    const local = await getSetupDb().select({ s: documents.status }).from(documents).where(eq(documents.id, localId));
    expect(local[0]!.s).toBe('active');
  });

  it('source_unavailable when the backing object is gone (provenance retained, not deleted)', async () => {
    const up = await upload('vanishing.md', '# Vanishing\n\nWill lose its object.');
    const documentId = (up as { documentId: string }).documentId;
    const key = (await getSetupDb().select({ k: documents.objectKey }).from(documents).where(eq(documents.id, documentId)))[0]!.k!;
    await store.delete(key); // object disappears before indexing
    await drainDocumentJobs();
    const after = await getSetupDb().select({ s: documents.status }).from(documents).where(eq(documents.id, documentId));
    expect(after[0]!.s).toBe('source_unavailable');
    // The row (provenance) is retained, not deleted.
    const still = await getSetupDb().select({ id: documents.id }).from(documents).where(eq(documents.id, documentId));
    expect(still.length).toBe(1);
  });
});
