import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type KnowledgeDisclosure, type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { agents, documentChunks, documentDisclosureGrants, documents, memberships, organizations, profiles, projectMembers, projects } from '@/db/schema';
import { retrieveRelevantVersioned } from '@/domain/documents/retrieval-versioned';
import { backfillProject } from '@/domain/documents/backfill';
import { createDocumentDisclosureGrant, resolveDocumentAccess, revokeDocumentDisclosureGrant } from '@/domain/documents/disclosure';
import { LocalObjectStore } from '@/domain/documents/local-object-store';

/**
 * Documents increment 1, Stage C2 closure (Blocker 1) — disclosure authorization enforced INSIDE
 * versioned retrieval. Restricted content never crosses the retrieval boundary unless the exact consuming
 * identity holds a live, fingerprint-matched grant for the operation's server-derived purpose.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[document-access.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

let storeDir = '';
let store: LocalObjectStore;
let orgId = '';
let userId = '';
const db = () => getSetupDb();
const shaOf = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const future = () => new Date(Date.now() + 3_600_000);

async function makeWorkspace(): Promise<TenantContext> {
  const p = await db().insert(projects).values({ orgId, key: fixtureKey('acc'), name: 'Access WS' }).returning({ id: projects.id });
  await db().insert(projectMembers).values({ orgId, projectId: p[0]!.id, userId, role: 'admin' });
  return { userId, orgId, projectId: p[0]!.id, orgRole: 'owner', projectRole: 'admin' };
}

async function makeAgent(ctx: TenantContext, model = 'gpt-x'): Promise<string> {
  const a = await db().insert(agents).values({ orgId: ctx.orgId, projectId: ctx.projectId, name: `agent-${randomUUID().slice(0, 4)}`, role: 'primary', provider: 'openai', model, systemPrompt: 'x' }).returning({ id: agents.id });
  return a[0]!.id;
}

async function makeDoc(ctx: TenantContext, relPath: string, chunks: string[], disclosure: KnowledgeDisclosure): Promise<string> {
  const body = chunks.join('\n\n');
  const ins = await db().insert(documents).values({ orgId: ctx.orgId, projectId: ctx.projectId, source: 'local_folder', sourceId: relPath, relativePath: relPath, kind: 'markdown', sha256: shaOf(body), sizeBytes: Buffer.byteLength(body, 'utf8'), status: 'active', disclosure }).returning({ id: documents.id });
  const docId = ins[0]!.id;
  await db().insert(documentChunks).values(chunks.map((content, i) => ({ orgId: ctx.orgId, projectId: ctx.projectId, documentId: docId, chunkIndex: i, content, locator: `line ${i}` })));
  await db().update(documents).set({ chunkCount: chunks.length, indexedAt: new Date() }).where(eq(documents.id, docId));
  await db().transaction((t) => backfillProject(t, ctx, store, { operationId: randomUUID() }));
  return docId;
}

const taskRunConsumer = (agentIds: string[]) => ({ consumerType: 'task_run' as const, consumerAgentIds: agentIds });

/** Versioned retrieval as an authorized consumer set. */
async function retrieveAs(ctx: TenantContext, query: string, agentIds: string[]) {
  return withTenant(ctx, async (t) => {
    const access = await resolveDocumentAccess(t, ctx, taskRunConsumer(agentIds));
    return retrieveRelevantVersioned(t, ctx, query, 5, access);
  });
}

beforeAll(async () => {
  if (!available) return;
  storeDir = await mkdtemp(join(tmpdir(), 'acc-store-'));
  process.env.LOCAL_OBJECT_STORE_DIR = storeDir;
  store = new LocalObjectStore(storeDir);
  userId = randomUUID();
  await db().insert(profiles).values({ id: userId, email: `acc-${randomUUID().slice(0, 8)}@t.local`, displayName: 'Acc' });
  const org = await db().insert(organizations).values({ name: 'Acc Org', slug: `acc-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
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

describe.skipIf(!available)('Stage C2 — disclosure authorization inside versioned retrieval', () => {
  it('1. workspace-internal Document is returned to an authorized workspace consumer', async () => {
    const ctx = await makeWorkspace();
    const agent = await makeAgent(ctx);
    await makeDoc(ctx, 'wi.md', ['zzwiterm workspace internal content'], 'workspace_internal');
    const hits = await retrieveAs(ctx, 'zzwiterm', [agent]);
    expect(hits.some((h) => h.relativePath === 'wi.md')).toBe(true);
  });

  it('2. a consumer never receives content from another workspace', async () => {
    const a = await makeWorkspace();
    const b = await makeWorkspace();
    const agentA = await makeAgent(a);
    await makeDoc(b, 'secretB.md', ['zzxtenant content only in workspace B'], 'restricted');
    // Retrieval is workspace-scoped; A's consumer never sees B's content.
    const hits = await retrieveAs(a, 'zzxtenant', [agentA]);
    expect(hits.length).toBe(0);
  });

  it('3. a restricted Document is withheld from an agent with no grant', async () => {
    const ctx = await makeWorkspace();
    const agent = await makeAgent(ctx);
    await makeDoc(ctx, 'r3.md', ['zzr3term restricted content no grant'], 'restricted');
    const hits = await retrieveAs(ctx, 'zzr3term', [agent]);
    expect(hits.some((h) => h.relativePath === 'r3.md')).toBe(false);
  });

  it('4. a restricted Document is returned to an agent with the exact valid grant', async () => {
    const ctx = await makeWorkspace();
    const agent = await makeAgent(ctx);
    const docId = await makeDoc(ctx, 'r4.md', ['zzr4term restricted content granted'], 'restricted');
    await withTenant(ctx, (t) => createDocumentDisclosureGrant(t, ctx, { documentId: docId, agentId: agent, purpose: 'current_operational_fact', expiresAt: future() }));
    const hits = await retrieveAs(ctx, 'zzr4term', [agent]);
    expect(hits.some((h) => h.relativePath === 'r4.md')).toBe(true);
  });

  it('5. a grant for another purpose does not authorize retrieval', async () => {
    const ctx = await makeWorkspace();
    const agent = await makeAgent(ctx);
    const docId = await makeDoc(ctx, 'r5.md', ['zzr5term restricted wrong purpose'], 'restricted');
    // Grant for objective_planning; a task_run derives current_operational_fact → not authorized.
    await withTenant(ctx, (t) => createDocumentDisclosureGrant(t, ctx, { documentId: docId, agentId: agent, purpose: 'objective_planning', expiresAt: future() }));
    const hits = await retrieveAs(ctx, 'zzr5term', [agent]);
    expect(hits.some((h) => h.relativePath === 'r5.md')).toBe(false);
  });

  it('6. a grant for another execution fingerprint does not authorize retrieval', async () => {
    const ctx = await makeWorkspace();
    const agent = await makeAgent(ctx, 'gpt-original');
    const docId = await makeDoc(ctx, 'r6.md', ['zzr6term restricted reconfigured agent'], 'restricted');
    await withTenant(ctx, (t) => createDocumentDisclosureGrant(t, ctx, { documentId: docId, agentId: agent, purpose: 'current_operational_fact', expiresAt: future() }));
    // Reconfigure the agent (new model) → its execution fingerprint changes → the grant no longer matches.
    await db().update(agents).set({ model: 'gpt-reconfigured' }).where(eq(agents.id, agent));
    const hits = await retrieveAs(ctx, 'zzr6term', [agent]);
    expect(hits.some((h) => h.relativePath === 'r6.md')).toBe(false);
  });

  it('7. an expired or revoked grant does not authorize retrieval', async () => {
    const ctx = await makeWorkspace();
    const agent = await makeAgent(ctx);
    const docId = await makeDoc(ctx, 'r7.md', ['zzr7term restricted expired revoked'], 'restricted');
    // Expired grant (inserted directly, bypassing the future-expiry guard).
    await db().insert(documentDisclosureGrants).values({ orgId: ctx.orgId, projectId: ctx.projectId, documentId: docId, agentId: agent, agentExecutionFingerprint: 'x', purpose: 'current_operational_fact', expiresAt: new Date(Date.now() - 1000) });
    expect((await retrieveAs(ctx, 'zzr7term', [agent])).some((h) => h.relativePath === 'r7.md')).toBe(false);
    // A live grant, then revoked.
    const gid = await withTenant(ctx, (t) => createDocumentDisclosureGrant(t, ctx, { documentId: docId, agentId: agent, purpose: 'current_operational_fact', expiresAt: future() }));
    await withTenant(ctx, (t) => revokeDocumentDisclosureGrant(t, ctx, gid, 'test'));
    expect((await retrieveAs(ctx, 'zzr7term', [agent])).some((h) => h.relativePath === 'r7.md')).toBe(false);
  });

  it('8/9. denied restricted content leaves no text, snippet, or locator anywhere in the result', async () => {
    const ctx = await makeWorkspace();
    const agent = await makeAgent(ctx);
    const secret = 'zzr8term privileged restricted body that must never leak';
    await makeDoc(ctx, 'r8.md', [secret], 'restricted');
    const hits = await retrieveAs(ctx, 'zzr8term', [agent]); // no grant
    const json = JSON.stringify(hits);
    expect(hits.some((h) => h.relativePath === 'r8.md')).toBe(false);
    expect(json).not.toContain('privileged restricted body'); // no chunk text
    expect(json).not.toContain('r8.md'); // no path/label
    expect(json).not.toContain('line 0'); // no locator
  });

  it('10. a forged consumer identity cannot create authorization', async () => {
    const ctx = await makeWorkspace();
    const realAgent = await makeAgent(ctx);
    const docId = await makeDoc(ctx, 'r10.md', ['zzr10term restricted forge attempt'], 'restricted');
    // A real, live grant exists — but for realAgent only.
    await withTenant(ctx, (t) => createDocumentDisclosureGrant(t, ctx, { documentId: docId, agentId: realAgent, purpose: 'current_operational_fact', expiresAt: future() }));
    // A caller claiming a DIFFERENT / non-existent consumer id gets no authorization.
    const forgedId = randomUUID();
    expect((await retrieveAs(ctx, 'zzr10term', [forgedId])).some((h) => h.relativePath === 'r10.md')).toBe(false);
    // And an empty consumer set authorizes nothing.
    expect((await retrieveAs(ctx, 'zzr10term', [])).some((h) => h.relativePath === 'r10.md')).toBe(false);
    // The real granted agent still gets it (control).
    expect((await retrieveAs(ctx, 'zzr10term', [realAgent])).some((h) => h.relativePath === 'r10.md')).toBe(true);
  });
});
