import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type KnowledgeDisclosure, type TenantContext } from '@/types/domain';
import { type DbTx, getSetupDb } from '@/db/client';
import { agents, documentChunks, documentVersionTombstones, documentVersions, documents, knowledgeItems, knowledgeSources, knowledgeVerificationEvents, memberships, organizations, profiles, projectMembers, projects, runDocumentVersions, runSteps, runs, tasks } from '@/db/schema';
import { chunkText, declassifyDocument, restrictDocument } from '@/domain/documents/documents';
import { backfillProject } from '@/domain/documents/backfill';
import { markIndexDegraded } from '@/domain/documents/integrity';
import { ingestDocumentVersion } from '@/domain/documents/versions';
import { LocalObjectStore } from '@/domain/documents/local-object-store';
import { tenantObjectKey } from '@/domain/documents/object-store';
import { type DocumentDetail, loadDetailWithInspection, loadDocumentDetail } from '@/domain/documents/detail';

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
async function reconstructedDoc(ctx: TenantContext, relPath: string, chunks: string[]) {
  const body = chunks.join('\n\n');
  const ins = await db().insert(documents).values({ orgId: ctx.orgId, projectId: ctx.projectId, source: 'local_folder', sourceId: relPath, relativePath: relPath, kind: 'markdown', sha256: shaOf(body), sizeBytes: 10, status: 'active' }).returning({ id: documents.id });
  const docId = ins[0]!.id;
  await db().insert(documentChunks).values(chunks.map((content, i) => ({ orgId: ctx.orgId, projectId: ctx.projectId, documentId: docId, chunkIndex: i, content })));
  await db().update(documents).set({ chunkCount: chunks.length, indexedAt: new Date() }).where(eq(documents.id, docId));
  await runBackfill(ctx);
  const v = (await db().select({ id: documentVersions.id }).from(documentVersions).where(and(eq(documentVersions.documentId, docId), eq(documentVersions.indexStatus, 'indexed'))))[0]!;
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
async function supplyToRun(
  ctx: TenantContext,
  versionId: string,
  chunkIndexes: number[],
  exec: { status?: 'completed' | 'failed'; provider?: 'openai' | 'anthropic' | null; model?: string | null; reviewer?: { provider: 'openai' | 'anthropic'; model: string } } = {},
) {
  const a = await db().insert(agents).values({ orgId: ctx.orgId, projectId: ctx.projectId, name: 'a', role: 'primary', provider: 'openai', model: 'agent-current-model', systemPrompt: 'x' }).returning({ id: agents.id });
  const t = await db().insert(tasks).values({ orgId: ctx.orgId, projectId: ctx.projectId, title: 't', input: 'x', providerSelection: 'openai', status: 'completed', createdBy: ctx.userId }).returning({ id: tasks.id });
  const r = await db().insert(runs).values({ orgId: ctx.orgId, projectId: ctx.projectId, taskId: t[0]!.id, status: exec.status ?? 'completed', primaryAgentId: a[0]!.id }).returning({ id: runs.id });
  // The IMMUTABLE dispatch record: the primary execution step froze the provider/model actually used.
  if (exec.provider !== null) {
    await db().insert(runSteps).values({ orgId: ctx.orgId, projectId: ctx.projectId, runId: r[0]!.id, stepNumber: 1, kind: 'primary', agentId: a[0]!.id, provider: exec.provider ?? 'openai', model: exec.model ?? 'gpt-dispatch', succeeded: exec.status !== 'failed' });
  }
  if (exec.reviewer) {
    await db().insert(runSteps).values({ orgId: ctx.orgId, projectId: ctx.projectId, runId: r[0]!.id, stepNumber: 2, kind: 'review', agentId: a[0]!.id, provider: exec.reviewer.provider, model: exec.reviewer.model, succeeded: true });
  }
  for (const ci of chunkIndexes) await db().insert(runDocumentVersions).values({ orgId: ctx.orgId, projectId: ctx.projectId, runId: r[0]!.id, documentVersionId: versionId, chunkIndex: ci, disclosureSnapshot: 'workspace_internal' });
  return { runId: r[0]!.id, agentId: a[0]!.id };
}
async function auditDoc(ctx: TenantContext, documentId: string, action: string, detail: Record<string, unknown> = {}) {
  const { writeAudit } = await import('@/domain/audit/audit');
  await db().transaction((t) => writeAudit(t as unknown as DbTx, ctx, { action, entityType: 'document', entityId: documentId, detail }));
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
    expect(d.knowledge.find((k) => k.knowledgeSourceId === relied.sourceId)!.relationshipState).toBe('relied_upon');
    // The other is NOT supplemental just because it is absent from the judgment — its support is unjudged.
    expect(d.knowledge.find((k) => k.knowledgeSourceId === supp.sourceId)!.relationshipState).toBe('attached_not_judged');
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
    // A fixed query set (access, doc, versions, tombstones, knowledge×3, runs×3, history×2) — bounded and
    // independent of how many versions / knowledge / run relationships exist.
    expect(await count()).toBeLessThanOrEqual(16);
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

describe.skipIf(!available)('Documents Detail — Blocker 1: Knowledge relationship states never infer supplemental', () => {
  it('B1.3/B1.4 an attached source with no support judgment is attached_not_judged, never supplemental', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId } = await byteExactDoc(ctx, 'unjudged.md', 'body');
    await bindKnowledge(ctx, versionId, 'Unjudged item'); // attached, never judged
    const d = asDetail(await detail(ctx, docId));
    expect(d.knowledge).toHaveLength(1);
    expect(d.knowledge[0]!.relationshipState).toBe('attached_not_judged');
    // No source is ever labeled supplemental without an explicit supplemental fact (schema records none).
    expect(d.knowledge.every((k) => k.relationshipState !== 'supplemental')).toBe(true);
  });

  it('B1.5 a later support judgment does not rewrite the historical state of an earlier judgment', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId } = await byteExactDoc(ctx, 'rejudged.md', 'body');
    const a = await bindKnowledge(ctx, versionId, 'A item');
    const b = await bindKnowledge(ctx, versionId, 'B item');
    await recordRelied(ctx, a.itemId, [a.sourceId]); // earlier judgment relied on A
    await recordRelied(ctx, b.itemId, [b.sourceId]); // a later, separate judgment relied on B
    // The earlier verification event's recorded relied set is unchanged (append-only history).
    const events = await db().select({ relied: knowledgeVerificationEvents.reliedOnSourceIds }).from(knowledgeVerificationEvents).where(eq(knowledgeVerificationEvents.knowledgeItemId, a.itemId));
    expect(events[0]!.relied).toEqual([a.sourceId]);
    const d = asDetail(await detail(ctx, docId));
    expect(d.knowledge.find((k) => k.knowledgeSourceId === a.sourceId)!.relationshipState).toBe('relied_upon');
    expect(d.knowledge.find((k) => k.knowledgeSourceId === b.sourceId)!.relationshipState).toBe('relied_upon');
  });
});

describe.skipIf(!available)('Documents Detail — Blocker 2: historical provider/model from immutable dispatch facts', () => {
  it('B2.1/B2.2 a run shows its recorded dispatch provider/model, not the agent current config', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId } = await byteExactDoc(ctx, 'dispatch.md', 'body');
    const { agentId } = await supplyToRun(ctx, versionId, [0], { provider: 'anthropic', model: 'claude-dispatch' });
    // The agent is later reconfigured — historical Detail must not follow it.
    await db().update(agents).set({ provider: 'openai', model: 'agent-changed-model' }).where(eq(agents.id, agentId));
    const op = asDetail(await detail(ctx, docId)).aiOperations[0]!;
    expect(op.provider).toBe('anthropic');
    expect(op.model).toBe('claude-dispatch');
    expect(op.model).not.toBe('agent-changed-model');
  });

  it('B2.3 a run with no recorded primary step reports provider/model as null (Not recorded)', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId } = await byteExactDoc(ctx, 'norec.md', 'body');
    await supplyToRun(ctx, versionId, [0], { provider: null }); // no primary step recorded
    const op = asDetail(await detail(ctx, docId)).aiOperations[0]!;
    expect(op.provider).toBeNull();
    expect(op.model).toBeNull();
  });

  it('B2.4 the reviewer step is not collapsed into the primary dispatch identity', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId } = await byteExactDoc(ctx, 'reviewer.md', 'body');
    await supplyToRun(ctx, versionId, [0], { provider: 'openai', model: 'primary-model', reviewer: { provider: 'anthropic', model: 'reviewer-model' } });
    const op = asDetail(await detail(ctx, docId)).aiOperations[0]!;
    expect(op.provider).toBe('openai');
    expect(op.model).toBe('primary-model'); // never the reviewer's
  });

  it('B2.5 a failed run preserves its attempted dispatch provider/model', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId } = await byteExactDoc(ctx, 'failed.md', 'body');
    await supplyToRun(ctx, versionId, [0], { status: 'failed', provider: 'anthropic', model: 'attempted-model' });
    const op = asDetail(await detail(ctx, docId)).aiOperations[0]!;
    expect(op.runStatus).toBe('failed');
    expect(op.provider).toBe('anthropic');
    expect(op.model).toBe('attempted-model');
  });
});

describe.skipIf(!available)('Documents Detail — Blocker 3: exact selected-version resolution in the shared loader', () => {
  it('B3.1 no selection defaults to the current version', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await byteExactDoc(ctx, 'sel-default.md', 'v1');
    const v2 = await newVersion(ctx, docId, 'v2');
    const d = asDetail(await detail(ctx, docId));
    expect(d.selected.versionId).toBe(v2);
    expect(d.selected.isCurrent).toBe(true);
    expect(d.selected.resolution).toBe('selected');
  });

  it('B3.2 an older selected version stays distinct from current', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId: v1 } = await byteExactDoc(ctx, 'sel-old.md', 'v1');
    const v2 = await newVersion(ctx, docId, 'v2');
    const d = asDetail(await db().transaction((t) => loadDocumentDetail(t as unknown as DbTx, ctx, docId, v1)));
    expect(d.selected.versionId).toBe(v1);
    expect(d.selected.isCurrent).toBe(false);
    expect(d.current.versionId).toBe(v2); // current is never substituted by the selection
  });

  it('B3.3 a missing historical version does not fall back to current', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await byteExactDoc(ctx, 'sel-missing.md', 'v1');
    const d = asDetail(await db().transaction((t) => loadDocumentDetail(t as unknown as DbTx, ctx, docId, randomUUID())));
    expect(d.selected.resolution).toBe('missing');
    expect(d.selected.versionId).toBeNull(); // NOT the current version
  });

  it('B3.4 a version belonging to another Document is rejected', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await byteExactDoc(ctx, 'sel-a.md', 'a');
    const other = await byteExactDoc(ctx, 'sel-b.md', 'b');
    const d = asDetail(await db().transaction((t) => loadDocumentDetail(t as unknown as DbTx, ctx, docId, other.versionId)));
    expect(d.selected.resolution).toBe('missing');
    expect(d.selected.versionId).toBeNull();
  });

  it('B3.5 a cross-workspace version is rejected without metadata leakage', async () => {
    const ctxA = await makeWorkspace();
    const ctxB = await makeWorkspace();
    const { docId } = await byteExactDoc(ctxA, 'sel-mine.md', 'mine');
    const foreign = await byteExactDoc(ctxB, 'sel-foreign.md', 'foreign');
    const d = asDetail(await db().transaction((t) => loadDocumentDetail(t as unknown as DbTx, ctxA, docId, foreign.versionId)));
    expect(d.selected.resolution).toBe('missing');
    expect(JSON.stringify(d.selected)).not.toContain('sel-foreign');
  });

  it('B3.6 an unavailable selected version stays selected but exposes no preview capability', async () => {
    const ctx = await makeWorkspace();
    // A source-disconnected local doc gets an unavailable version via backfill; it becomes current-less.
    await db().insert(documents).values({ orgId: ctx.orgId, projectId: ctx.projectId, source: 'local_folder', sourceId: 'gone.md', relativePath: 'gone.md', kind: 'markdown', sha256: shaOf('gone'), sizeBytes: 1, status: 'active' });
    await runBackfill(ctx);
    const doc = (await db().select({ id: documents.id }).from(documents).where(and(eq(documents.projectId, ctx.projectId), eq(documents.relativePath, 'gone.md'))))[0]!;
    const unav = (await db().select({ id: documentVersions.id }).from(documentVersions).where(and(eq(documentVersions.documentId, doc.id), eq(documentVersions.contentFidelity, 'unavailable'))))[0]!;
    const d = asDetail(await db().transaction((t) => loadDocumentDetail(t as unknown as DbTx, ctx, doc.id, unav.id)));
    expect(d.selected.resolution).toBe('selected');
    expect(d.selected.version!.inspect.preview).toBe(false);
    expect(d.selected.version!.inspect.reason).toBe('unavailable');
  });

  it('B3.7 present policy governs inspection of an older selected version', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId: v1 } = await byteExactDoc(ctx, 'sel-policy.md', 'v1');
    await newVersion(ctx, docId, 'v2');
    const member = await addMember(ctx, 'member');
    await db().transaction((t) => restrictDocument(t as unknown as DbTx, ctx, docId)); // present policy: restricted
    const res = await db().transaction((t) => loadDocumentDetail(t as unknown as DbTx, member, docId, v1));
    expect(res.found).toBe(false); // current policy gates the whole Detail, old-version selection included
  });
});

describe.skipIf(!available)('Documents Detail — Blocker 4: lifecycle history covers Document- and version-scoped events', () => {
  it('B4.1 Document-level archive and restore events appear', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await byteExactDoc(ctx, 'lh-archive.md', 'body');
    await auditDoc(ctx, docId, 'document.archived');
    await auditDoc(ctx, docId, 'document.restored');
    const kinds = asDetail(await detail(ctx, docId)).history.map((h) => h.kind);
    expect(kinds).toContain('archived');
    expect(kinds).toContain('restored');
  });

  it('B4.2 version-scoped integrity (index-degraded) events appear', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId } = await byteExactDoc(ctx, 'lh-degraded.md', 'body');
    await db().transaction((t) => markIndexDegraded(t as unknown as DbTx, ctx, versionId, 'rebuild could not be proven'));
    const d = asDetail(await detail(ctx, docId));
    const ev = d.history.find((h) => h.kind === 'index_degraded');
    expect(ev).toBeTruthy();
    expect(ev!.documentVersionId).toBe(versionId); // attributed to the exact version
  });

  it('B4.3 a restricted-inspection event appears only after actual release', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await byteExactDoc(ctx, 'lh-inspect.md', 'body', 'restricted');
    expect(asDetail(await detail(ctx, docId)).history.some((h) => h.kind === 'restricted_inspected')).toBe(false);
    await auditDoc(ctx, docId, 'document.restricted_inspected', { accessType: 'download' });
    expect(asDetail(await detail(ctx, docId)).history.some((h) => h.kind === 'restricted_inspected')).toBe(true);
  });

  it('B4.5/B4.7 a purge tombstone appears once — the redundant purge audit is deduplicated', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId } = await byteExactDoc(ctx, 'lh-purge.md', 'body');
    const when = new Date();
    await db().insert(documentVersionTombstones).values({ orgId: ctx.orgId, projectId: ctx.projectId, versionId, documentId: docId, sha256: shaOf('x'), contentFidelity: 'byte_exact', status: 'completed', reason: 'test', purgedBy: ctx.userId, purgedAt: when });
    await auditDoc(ctx, docId, 'document.version_purged', { versionId }); // the redundant audit for the same op
    const purges = asDetail(await detail(ctx, docId)).history.filter((h) => h.kind === 'purged');
    expect(purges).toHaveLength(1); // one durable operation → one visible event
    expect(purges[0]!.documentVersionId).toBe(versionId);
  });

  it('B4.6 lifecycle events are deterministically ordered (newest first)', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await byteExactDoc(ctx, 'lh-order.md', 'body');
    await auditDoc(ctx, docId, 'document.restricted');
    await auditDoc(ctx, docId, 'document.declassified');
    const hist = asDetail(await detail(ctx, docId)).history;
    for (let i = 1; i < hist.length; i += 1) expect(hist[i - 1]!.at.getTime()).toBeGreaterThanOrEqual(hist[i]!.at.getTime());
  });

  it('B4.8 an unauthorized Detail result contains no lifecycle events or counts', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await byteExactDoc(ctx, 'lh-denied.md', 'body', 'restricted');
    const member = await addMember(ctx, 'member');
    const res = await detail(member, docId);
    expect(res.found).toBe(false);
    expect(JSON.stringify(res)).not.toContain('"history"');
  });
});

describe.skipIf(!available)('Documents Detail — P2: gated evidence inspection (route/UI data path)', () => {
  const inspect = (ctx: TenantContext, docId: string, versionId: string | undefined, accessType: 'preview' | 'download') =>
    db().transaction((t) => loadDetailWithInspection(t as unknown as DbTx, ctx, store, docId, versionId, { accessType, purpose: 'test' }));
  const previewText = (r: Awaited<ReturnType<typeof inspect>>) => r.inspection?.inspection?.chunks?.map((c) => c.content).join('\n\n') ?? null;
  const auditCount = async (ctx: TenantContext, docId: string, action: string) => {
    const { auditLogs } = await import('@/db/schema');
    return (await db().select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.projectId, ctx.projectId), eq(auditLogs.entityType, 'document'), eq(auditLogs.entityId, docId), eq(auditLogs.action, action)))).length;
  };

  it('P2.1 default selection releases the CURRENT version content, downloadable for byte-exact', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await byteExactDoc(ctx, 'p2-cur.md', 'the current body text');
    const r = await inspect(ctx, docId, undefined, 'preview');
    expect(r.detail.found && r.detail.selected.isCurrent).toBe(true);
    expect(r.inspection?.state).toBe('released');
    expect(previewText(r)).toContain('the current body text');
    expect(r.inspection?.inspection?.downloadable).toBe(true);
  });

  it('P2.2/P2.3 an exact historical selection releases THAT version content and is stable on repeat (share/refresh)', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId: v1 } = await byteExactDoc(ctx, 'p2-hist.md', 'ORIGINAL body');
    await newVersion(ctx, docId, 'REVISED body');
    const a = await inspect(ctx, docId, v1, 'preview');
    expect(a.detail.found && a.detail.selected.versionId).toBe(v1);
    expect(previewText(a)).toContain('ORIGINAL body');
    expect(previewText(a)).not.toContain('REVISED body'); // never the current version's content
    const b = await inspect(ctx, docId, v1, 'preview'); // refresh/share the same URL
    expect(b.detail.found && b.detail.selected.versionId).toBe(v1);
    expect(previewText(b)).toBe(previewText(a));
  });

  it('P2.4 a missing selected version releases nothing (no fall-back to current)', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await byteExactDoc(ctx, 'p2-missing.md', 'body');
    const r = await inspect(ctx, docId, randomUUID(), 'preview');
    expect(r.detail.found && r.detail.selected.resolution).toBe('missing');
    expect(r.inspection).toBeNull();
  });

  it('P2.5 a cross-document selection releases nothing', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await byteExactDoc(ctx, 'p2-a.md', 'a');
    const other = await byteExactDoc(ctx, 'p2-b.md', 'b');
    const r = await inspect(ctx, docId, other.versionId, 'preview');
    expect(r.inspection).toBeNull();
    expect(previewText(r)).toBeNull();
  });

  it('P2.6 a cross-workspace selection releases nothing and leaks no content', async () => {
    const ctxA = await makeWorkspace();
    const ctxB = await makeWorkspace();
    const { docId } = await byteExactDoc(ctxA, 'p2-mine.md', 'mine');
    const foreign = await byteExactDoc(ctxB, 'p2-foreign.md', 'FOREIGN SECRET');
    const r = await inspect(ctxA, docId, foreign.versionId, 'preview');
    expect(r.inspection).toBeNull();
    expect(JSON.stringify(r)).not.toContain('FOREIGN SECRET');
  });

  it('P2.7 preview authorization is gated — an ordinary member of a restricted source gets no content', async () => {
    const ctx = await makeWorkspace();
    const { docId } = await byteExactDoc(ctx, 'p2-restricted.md', 'SENSITIVE', 'restricted');
    const member = await addMember(ctx, 'member');
    const r = await inspect(member, docId, undefined, 'preview');
    expect(r.detail.found).toBe(false);
    expect(r.inspection).toBeNull();
    expect(JSON.stringify(r)).not.toContain('SENSITIVE');
  });

  it('P2.8 download authorization: reconstructed text is never downloadable; byte-exact is', async () => {
    const ctx = await makeWorkspace();
    const be = await byteExactDoc(ctx, 'p2-be.md', 'exact');
    const rc = await reconstructedDoc(ctx, 'p2-rc.md', ['reconstructed only']);
    expect((await inspect(ctx, be.docId, undefined, 'download')).inspection?.inspection?.downloadable).toBe(true);
    const r = await inspect(ctx, rc.docId, undefined, 'download');
    expect(r.inspection?.state).toBe('released');
    expect(r.inspection?.inspection?.downloadable).toBe(false); // no fake original
  });

  it('P2.9 unavailable content exposes no preview or download', async () => {
    const ctx = await makeWorkspace();
    await db().insert(documents).values({ orgId: ctx.orgId, projectId: ctx.projectId, source: 'local_folder', sourceId: 'p2-unav.md', relativePath: 'p2-unav.md', kind: 'markdown', sha256: shaOf('unav'), sizeBytes: 1, status: 'active' });
    await runBackfill(ctx);
    const doc = (await db().select({ id: documents.id }).from(documents).where(and(eq(documents.projectId, ctx.projectId), eq(documents.relativePath, 'p2-unav.md'))))[0]!;
    const unav = (await db().select({ id: documentVersions.id }).from(documentVersions).where(and(eq(documentVersions.documentId, doc.id), eq(documentVersions.contentFidelity, 'unavailable'))))[0]!;
    const r = await inspect(ctx, doc.id, unav.id, 'preview');
    expect(r.inspection?.state).toBe('unavailable');
    expect(r.inspection?.inspection?.chunks).toBeUndefined();
    expect(r.inspection?.inspection?.bytes).toBeUndefined();
  });

  it('P2.10 an authorized restricted RELEASE is audited; a non-restricted preview is not', async () => {
    const ctx = await makeWorkspace(); // owner/admin — cleared for restricted
    const restricted = await byteExactDoc(ctx, 'p2-audit.md', 'restricted body', 'restricted');
    const plain = await byteExactDoc(ctx, 'p2-plain.md', 'plain body');
    await inspect(ctx, restricted.docId, undefined, 'preview');
    await inspect(ctx, plain.docId, undefined, 'preview');
    expect(await auditCount(ctx, restricted.docId, 'document.restricted_inspected')).toBe(1);
    expect(await auditCount(ctx, plain.docId, 'document.restricted_inspected')).toBe(0);
  });

  it('P2.11 loading Detail METADATA (what render/prefetch does) records NO restricted inspection — only an explicit release does', async () => {
    const ctx = await makeWorkspace(); // owner — cleared for restricted
    const { docId } = await byteExactDoc(ctx, 'p2-prefetch.md', 'restricted body', 'restricted');
    // The page/prefetch path loads metadata only (loadDocumentDetail) — it must never audit a release.
    await db().transaction((t) => loadDocumentDetail(t as unknown as DbTx, ctx, docId));
    await db().transaction((t) => loadDocumentDetail(t as unknown as DbTx, ctx, docId)); // e.g. a second prefetch
    expect(await auditCount(ctx, docId, 'document.restricted_inspected')).toBe(0);
    // Only the explicit reveal (release) records an inspection.
    await inspect(ctx, docId, undefined, 'preview');
    expect(await auditCount(ctx, docId, 'document.restricted_inspected')).toBe(1);
  });

  // The restricted release is an explicit server action (POST), not a replayable GET. These exercise the
  // action's core (loadDetailWithInspection) and the GET page path (loadDocumentDetail).
  it('P2.12 one explicit release records exactly one inspection; a following page refresh/back records none', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId } = await byteExactDoc(ctx, 'p2-reveal.md', 'restricted body', 'restricted');
    const r = await inspect(ctx, docId, versionId, 'preview'); // the explicit release action releases the exact version
    expect(r.inspection?.state).toBe('released');
    expect(await auditCount(ctx, docId, 'document.restricted_inspected')).toBe(1);
    // A refresh / back-forward is a GET → metadata only → no additional inspection.
    await db().transaction((t) => loadDocumentDetail(t as unknown as DbTx, ctx, docId, versionId));
    await db().transaction((t) => loadDocumentDetail(t as unknown as DbTx, ctx, docId, versionId));
    expect(await auditCount(ctx, docId, 'document.restricted_inspected')).toBe(1);
  });

  it('P2.13 an unauthorized viewer\'s release attempt releases nothing and records no inspection', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId } = await byteExactDoc(ctx, 'p2-unauth.md', 'SECRET', 'restricted');
    const member = await addMember(ctx, 'member');
    const r = await inspect(member, docId, versionId, 'preview'); // the action reauthorizes and denies
    expect(r.detail.found).toBe(false);
    expect(r.inspection).toBeNull();
    expect(await auditCount(ctx, docId, 'document.restricted_inspected')).toBe(0);
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });

  it('P2.14 the release rejects a foreign / cross-workspace version and records nothing', async () => {
    const a = await makeWorkspace();
    const b = await makeWorkspace();
    const mine = await byteExactDoc(a, 'p2-mine-r.md', 'body', 'restricted');
    const otherDoc = await byteExactDoc(a, 'p2-other-r.md', 'other', 'restricted'); // same ws, different doc
    const foreign = await byteExactDoc(b, 'p2-foreign-r.md', 'FOREIGN', 'restricted');
    // foreign document version → rejected, nothing released, no audit on my doc.
    const rForeign = await inspect(a, mine.docId, otherDoc.versionId, 'preview');
    expect(rForeign.inspection).toBeNull();
    // cross-workspace version → rejected, no leak.
    const rCross = await inspect(a, mine.docId, foreign.versionId, 'preview');
    expect(rCross.inspection).toBeNull();
    expect(JSON.stringify(rCross)).not.toContain('FOREIGN');
    expect(await auditCount(a, mine.docId, 'document.restricted_inspected')).toBe(0);
  });
});
