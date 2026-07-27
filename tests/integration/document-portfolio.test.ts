import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type KnowledgeDisclosure, type TenantContext } from '@/types/domain';
import { type DbTx, getSetupDb } from '@/db/client';
import { agents, documentChunks, documentVersions, documents, knowledgeItems, knowledgeSources, memberships, organizations, profiles, projectMembers, projects, runDocumentVersions, runs, tasks } from '@/db/schema';
import { chunkText } from '@/domain/documents/documents';
import { backfillProject } from '@/domain/documents/backfill';
import { ingestDocumentVersion } from '@/domain/documents/versions';
import { LocalObjectStore } from '@/domain/documents/local-object-store';
import { tenantObjectKey } from '@/domain/documents/object-store';
import { assessDocument, loadDocumentPortfolio } from '@/domain/documents/portfolio';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[document-portfolio.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

let storeDir = '';
let store: LocalObjectStore;
let orgId = '';
let ownerId = '';
const db = () => getSetupDb();
const shaOf = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const NOW = new Date('2026-07-27T12:00:00Z');
const load = (ctx: TenantContext, now: Date = NOW) => db().transaction((t) => loadDocumentPortfolio(t as unknown as DbTx, ctx, now));

async function makeWorkspace(): Promise<TenantContext> {
  const p = await db().insert(projects).values({ orgId, key: fixtureKey('pf'), name: 'PF WS' }).returning({ id: projects.id });
  await db().insert(projectMembers).values({ orgId, projectId: p[0]!.id, userId: ownerId, role: 'admin' });
  return { userId: ownerId, orgId, projectId: p[0]!.id, orgRole: 'owner', projectRole: 'admin' };
}
async function addMember(ctx: TenantContext, role: 'admin' | 'member'): Promise<TenantContext> {
  const u = randomUUID();
  await db().insert(profiles).values({ id: u, email: `pm-${u.slice(0, 8)}@t.local`, displayName: 'PM' });
  await db().insert(projectMembers).values({ orgId: ctx.orgId, projectId: ctx.projectId, userId: u, role });
  return { userId: u, orgId: ctx.orgId, projectId: ctx.projectId, orgRole: 'member', projectRole: role };
}
async function runBackfill(ctx: TenantContext) {
  return db().transaction((t) => backfillProject(t, ctx, store, { operationId: randomUUID() }));
}
async function reconDoc(ctx: TenantContext, relPath: string, chunks: string[], disclosure: KnowledgeDisclosure = 'workspace_internal') {
  const body = chunks.join('\n\n');
  const ins = await db().insert(documents).values({ orgId: ctx.orgId, projectId: ctx.projectId, source: 'local_folder', sourceId: relPath, relativePath: relPath, kind: 'markdown', sha256: shaOf(body), sizeBytes: 10, status: 'active', disclosure }).returning({ id: documents.id });
  const docId = ins[0]!.id;
  await db().insert(documentChunks).values(chunks.map((content, i) => ({ orgId: ctx.orgId, projectId: ctx.projectId, documentId: docId, chunkIndex: i, content })));
  await db().update(documents).set({ chunkCount: chunks.length, indexedAt: new Date() }).where(eq(documents.id, docId));
  await runBackfill(ctx);
  const v = (await db().select({ id: documentVersions.id }).from(documentVersions).where(and(eq(documentVersions.documentId, docId), eq(documentVersions.indexStatus, 'indexed'))))[0]!;
  return { docId, versionId: v.id };
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
async function unavailableDoc(ctx: TenantContext, relPath: string) {
  await db().insert(documents).values({ orgId: ctx.orgId, projectId: ctx.projectId, source: 'local_folder', sourceId: relPath, relativePath: relPath, kind: 'markdown', sha256: shaOf(relPath + 'x'), sizeBytes: 1, status: 'active' });
  await runBackfill(ctx);
  return (await db().select({ id: documents.id }).from(documents).where(and(eq(documents.projectId, ctx.projectId), eq(documents.relativePath, relPath))))[0]!.id;
}
async function bareDoc(ctx: TenantContext, relPath: string, status: string) {
  await db().insert(documents).values({ orgId: ctx.orgId, projectId: ctx.projectId, source: 'cloud_upload', sourceId: relPath, relativePath: relPath, kind: 'markdown', sha256: shaOf(relPath), sizeBytes: 1, status: status as 'uploaded' }).returning({ id: documents.id });
}
async function newVersion(ctx: TenantContext, docId: string, body: string): Promise<string> {
  return db().transaction((t) => ingestDocumentVersion(t as never, ctx, store, { documentId: docId, bytes: Buffer.from(body, 'utf8'), text: body, mimeType: 'text/markdown', disclosure: 'workspace_internal', chunk: chunkText }).then((r) => r.versionId));
}
async function addFailedNewerVersion(ctx: TenantContext, docId: string) {
  await db().insert(documentVersions).values({ orgId: ctx.orgId, projectId: ctx.projectId, documentId: docId, sha256: shaOf(docId + 'newerfailed'), sizeBytes: 1, contentFidelity: 'reconstructed_text', indexStatus: 'failed', parserVersion: 'chunk-v1', createdAt: new Date(Date.now() + 60000) });
}
async function bindKnowledge(ctx: TenantContext, path: string, versionId: string) {
  const ki = await db().insert(knowledgeItems).values({ orgId: ctx.orgId, projectId: ctx.projectId, title: 'k', body: 'b', createdBy: ctx.userId }).returning({ id: knowledgeItems.id });
  await db().insert(knowledgeSources).values({ orgId: ctx.orgId, projectId: ctx.projectId, knowledgeItemId: ki[0]!.id, knowledgeVersion: 1, sourceType: 'document', sourceRef: path, sourceLabel: path, sourceVersionHash: shaOf('h'), transformation: 'quoted', documentVersionId: versionId });
}
async function supplyToRun(ctx: TenantContext, versionId: string, chunkIndexes: number[]) {
  const a = await db().insert(agents).values({ orgId: ctx.orgId, projectId: ctx.projectId, name: 'a', role: 'primary', provider: 'openai', model: 'm', systemPrompt: 'x' }).returning({ id: agents.id });
  const t = await db().insert(tasks).values({ orgId: ctx.orgId, projectId: ctx.projectId, title: 't', input: 'x', providerSelection: 'openai', status: 'completed', createdBy: ctx.userId }).returning({ id: tasks.id });
  const r = await db().insert(runs).values({ orgId: ctx.orgId, projectId: ctx.projectId, taskId: t[0]!.id, status: 'completed', primaryAgentId: a[0]!.id }).returning({ id: runs.id });
  for (const ci of chunkIndexes) await db().insert(runDocumentVersions).values({ orgId: ctx.orgId, projectId: ctx.projectId, runId: r[0]!.id, documentVersionId: versionId, chunkIndex: ci, disclosureSnapshot: 'workspace_internal' });
  return r[0]!.id;
}

beforeAll(async () => {
  if (!available) return;
  storeDir = await mkdtemp(join(tmpdir(), 'pf-store-'));
  process.env.LOCAL_OBJECT_STORE_DIR = storeDir;
  store = new LocalObjectStore(storeDir);
  ownerId = randomUUID();
  await db().insert(profiles).values({ id: ownerId, email: `pf-${randomUUID().slice(0, 8)}@t.local`, displayName: 'PF' });
  const org = await db().insert(organizations).values({ name: 'PF Org', slug: `pf-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db().insert(memberships).values({ orgId, userId: ownerId, role: 'owner' });
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

describe.skipIf(!available)('Documents Portfolio — assessment, grouping, lenses, access filtering', () => {
  it('1/2/3. owner + admin see restricted records; an ordinary member does not', async () => {
    const owner = await makeWorkspace();
    const admin = await addMember(owner, 'admin');
    const member = await addMember(owner, 'member');
    await byteExactDoc(owner, 'r1.md', 'restricted body', 'restricted');
    await byteExactDoc(owner, 'ok1.md', 'internal body');
    const ownerView = await load(owner);
    const adminView = await load(admin);
    const memberView = await load(member);
    expect(ownerView.groups.available.some((r) => r.relativePath === 'r1.md')).toBe(true);
    expect(adminView.groups.available.some((r) => r.relativePath === 'r1.md')).toBe(true);
    expect(memberView.groups.available.some((r) => r.relativePath === 'r1.md')).toBe(false);
    expect(memberView.groups.available.some((r) => r.relativePath === 'ok1.md')).toBe(true);
  });

  it('4. a non-member receives no inventory', async () => {
    const ctx = await makeWorkspace();
    await byteExactDoc(ctx, 'nm.md', 'body');
    const nonMember: TenantContext = { userId: randomUUID(), orgId: ctx.orgId, projectId: ctx.projectId, orgRole: 'member', projectRole: 'member' };
    const view = await load(nonMember);
    expect(view.isMember).toBe(false);
    expect(view.total).toBe(0);
  });

  it('5/24. group + lens counts are computed after access filtering; restricted paths absent from member payload', async () => {
    const owner = await makeWorkspace();
    const member = await addMember(owner, 'member');
    await byteExactDoc(owner, 'zzsecret.md', 'restricted body', 'restricted');
    await byteExactDoc(owner, 'visible.md', 'internal body');
    const memberView = await load(member);
    expect(memberView.total).toBe(1); // only the visible doc counted
    expect(memberView.groupCounts.available).toBe(1);
    expect(memberView.lensCounts.restricted).toBe(0); // the restricted doc contributes nothing
    expect(JSON.stringify(memberView)).not.toContain('zzsecret');
  });

  it('6/7/8. Available requires a valid indexed current version; a newer failed version keeps it Available + flags it', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await byteExactDoc(ctx, 'nf.md', 'current body');
    await addFailedNewerVersion(ctx, docId);
    const view = await load(ctx);
    const rec = view.groups.available.find((r) => r.relativePath === 'nf.md')!;
    expect(rec).toBeTruthy(); // still Available (7)
    expect(rec.lifecycleReason).toBe('available_newer_failed');
    expect(rec.newerVersionState).toBe('failed');
    expect(rec.attention.some((a) => a.code === 'newer_version_failed')).toBe(true); // (8)
    expect(view.groups.unavailable.some((r) => r.relativePath === 'nf.md')).toBe(false);
  });

  it('9. Processing applies only when no valid current version exists', async () => {
    const ctx = await makeWorkspace();
    await bareDoc(ctx, 'proc.md', 'uploaded'); // no version yet
    const view = await load(ctx);
    expect(view.groups.processing.some((r) => r.relativePath === 'proc.md')).toBe(true);
    expect(view.groups.processing[0]!.stateLabel).toBe('Processing upload');
  });

  it('10/11. source-unavailable and failed-initial-indexing belong to Unavailable with distinct reasons', async () => {
    const ctx = await makeWorkspace();
    await unavailableDoc(ctx, 'gone.md'); // → source_unavailable
    await bareDoc(ctx, 'failinit.md', 'failed');
    const view = await load(ctx);
    const gone = view.groups.unavailable.find((r) => r.relativePath === 'gone.md')!;
    const failed = view.groups.unavailable.find((r) => r.relativePath === 'failinit.md')!;
    expect(gone.lifecycleReason).toBe('source_disconnected');
    expect(failed.lifecycleReason).toBe('initial_indexing_failed');
    expect(gone.lifecycleReason).not.toBe(failed.lifecycleReason); // not collapsed into one label
  });

  it('12/13/14. archived → Historical; restricted + multiple-versions are lenses, not groups', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await byteExactDoc(ctx, 'arch.md', 'v1');
    await newVersion(ctx, docId, 'v2'); // multiple versions, still Available
    await db().update(documents).set({ status: 'archived' }).where(eq(documents.id, docId));
    const { docId: rid } = await byteExactDoc(ctx, 'restr.md', 'body', 'restricted');
    void rid;
    const view = await load(ctx);
    expect(view.groups.historical.some((r) => r.relativePath === 'arch.md')).toBe(true);
    // restricted is a lens over its canonical group, not its own group.
    const restr = view.groups.available.find((r) => r.relativePath === 'restr.md')!;
    expect(restr.group).toBe('available');
    expect(restr.lenses).toContain('restricted');
    // multiple-versions is a lens; the archived multi-version doc is Historical, not a "versions" group.
    expect(view.groups.available.find((r) => r.relativePath === 'restr.md')!.lenses).not.toContain('multiple_versions');
  });

  it('15/16. Knowledge refs use explicit relationships; AI-operation counts dedupe chunk rows by run', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId } = await byteExactDoc(ctx, 'refs.md', 'body');
    await bindKnowledge(ctx, 'refs.md', versionId);
    await supplyToRun(ctx, versionId, [-1, 0, 1]); // one run, three rows → one AI operation
    void docId;
    const rec = (await load(ctx)).groups.available.find((r) => r.relativePath === 'refs.md')!;
    expect(rec.knowledgeRefCount).toBe(1);
    expect(rec.aiOperationCount).toBe(1); // deduped by run
    expect(rec.lenses).toContain('referenced_by_knowledge');
    expect(rec.lenses).toContain('supplied_to_ai');
  });

  it('17. zero reference counts are omitted from compact summaries (count stays 0, not surfaced as a lens)', async () => {
    const ctx = await makeWorkspace();
    await byteExactDoc(ctx, 'noref.md', 'body');
    const rec = (await load(ctx)).groups.available.find((r) => r.relativePath === 'noref.md')!;
    expect(rec.knowledgeRefCount).toBe(0);
    expect(rec.aiOperationCount).toBe(0);
    expect(rec.lenses).not.toContain('referenced_by_knowledge');
    expect(rec.lenses).not.toContain('supplied_to_ai');
  });

  it('18/19. reconstructed fidelity is visible + honest; raw enums are translated to wording', async () => {
    const ctx = await makeWorkspace();
    await reconDoc(ctx, 'recon.md', ['reconstructed chunk']);
    const rec = (await load(ctx)).groups.available.find((r) => r.relativePath === 'recon.md')!;
    expect(rec.fidelity).toBe('reconstructed_text');
    expect(rec.fidelityLabel).toBe('Reconstructed indexed text'); // never "indexed" as fidelity
    expect(rec.stateLabel).toBe('Available'); // operator wording, not a raw enum
    expect(rec.attention.some((a) => a.code === 'reconstructed_evidence')).toBe(true);
  });

  it('20/21. a record can be Available AND in Needs Attention with concise reasons', async () => {
    const ctx = await makeWorkspace();
    await reconDoc(ctx, 'attn.md', ['reconstructed chunk']); // reconstructed → attention, still Available
    const view = await load(ctx);
    const rec = view.groups.available.find((r) => r.relativePath === 'attn.md')!;
    expect(rec.group).toBe('available');
    expect(rec.lenses).toContain('needs_attention');
    expect(rec.attention.length).toBeGreaterThan(0);
    expect(rec.attention.every((a) => typeof a.label === 'string' && a.label.length > 0)).toBe(true);
    expect(view.lensCounts.needs_attention).toBeGreaterThanOrEqual(1);
  });

  it('22. assessDocument (pure) does not read the database — retrieval never depends on Portfolio groups', () => {
    const rec = assessDocument(
      { id: 'x', relativePath: 'p.md', source: 'cloud_upload', status: 'active', disclosure: 'workspace_internal', currentVersionId: 'v1', indexedAt: null, currentVersion: { id: 'v1', contentFidelity: 'byte_exact', indexStatus: 'indexed', indexDegraded: false }, latestVersion: { id: 'v1', contentFidelity: 'byte_exact', indexStatus: 'indexed', createdAt: NOW }, versionCount: 1, knowledgeRefCount: 0, aiOperationCount: 0, lastChangeAt: NOW, viewerIsAdmin: true },
      NOW,
    );
    expect(rec.group).toBe('available');
    expect(rec.fidelityLabel).toBe('Exact source retained');
  });

  it('23. record-level actions reflect lifecycle validity', async () => {
    const ctx = await makeWorkspace();
    await byteExactDoc(ctx, 'act.md', 'body'); // active cloud → archive+replace, no retry
    await bareDoc(ctx, 'failact.md', 'failed'); // failed cloud → retry
    const view = await load(ctx);
    const act = view.groups.available.find((r) => r.relativePath === 'act.md')!;
    expect(act.actions.archive).toBe(true);
    expect(act.actions.replace).toBe(true);
    expect(act.actions.retry).toBe(false);
    const fail = view.groups.unavailable.find((r) => r.relativePath === 'failact.md')!;
    expect(fail.actions.retry).toBe(true);
  });

  it('25. no query returns cross-workspace Documents', async () => {
    const a = await makeWorkspace();
    const b = await makeWorkspace();
    await byteExactDoc(b, 'onlyB.md', 'body');
    const view = await load(a);
    expect(view.total).toBe(0);
    expect(Object.values(view.groups).flat().some((r) => r.relativePath === 'onlyB.md')).toBe(false);
  });

  it('26. the loader avoids N+1 — a constant number of queries regardless of Document count', async () => {
    const ctx = await makeWorkspace();
    for (let i = 0; i < 8; i += 1) await byteExactDoc(ctx, `n${i}.md`, `body ${i}`);
    const count = async () => {
      let selects = 0;
      await db().transaction((t) => {
        const proxied = new Proxy(t, {
          get(target, prop, recv) {
            const val = Reflect.get(target, prop, recv);
            if (prop === 'select') return (...args: unknown[]) => { selects += 1; return (val as (...a: unknown[]) => unknown).apply(target, args); };
            return typeof val === 'function' ? (val as (...a: unknown[]) => unknown).bind(target) : val;
          },
        });
        return loadDocumentPortfolio(proxied as unknown as DbTx, ctx, NOW);
      });
      return selects;
    };
    const withEight = await count();
    // Single-workspace fixed query set (member, docs, versions, knowledge, runs) — independent of N.
    expect(withEight).toBeLessThanOrEqual(6);
  });
});
