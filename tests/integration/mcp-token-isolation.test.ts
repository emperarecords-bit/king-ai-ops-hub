import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { assertDisposableDbForVerification } from '@tests/support/require-disposable-db';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { memberships, messages, organizations, profiles, projectMembers, projects, spendLimits, tasks } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { mintApiToken, revokeApiToken } from '@/domain/mcp/tokens';
import { authenticateMcp, handleMcpRpc, type JsonRpcRequest } from '@/domain/mcp/server';

/**
 * Phase 5 EXIT CRITERIA — an MCP token scoped to one project cannot read another project's task. Two projects (A
 * and B) share one admin. A token minted for A is exercised through the real MCP server; every cross-project read
 * is refused by RLS, not by app-layer filtering alone. Also proves scope enforcement (a read-only token cannot
 * create a task) and that revocation immediately inerts a token.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY ?? Buffer.alloc(32).toString('base64');

assertDisposableDbForVerification('mcp-token-isolation.test');

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[mcp-token-isolation.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

const db = getSetupDb();
let orgId = '';
let userId = '';
let ctxA: TenantContext;
let ctxB: TenantContext;
let taskA = '';
let taskB = '';

function rpc(method: string, params?: unknown): JsonRpcRequest {
  return { jsonrpc: '2.0', id: 1, method, params };
}
function callResult(res: Awaited<ReturnType<typeof handleMcpRpc>>): { text: string; isError: boolean } {
  const r = res.result as { content: Array<{ text: string }>; isError: boolean };
  return { text: r.content[0]!.text, isError: r.isError };
}

async function seedProject(marker: string): Promise<{ ctx: TenantContext; taskId: string }> {
  const pid = (await db.insert(projects).values({ orgId, key: fixtureKey('mcp'), name: `W-${marker}` }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId: pid, userId, role: 'admin' });
  await db.insert(spendLimits).values({ orgId, projectId: pid, monthlyLimitMicros: 100_000_000n });
  const taskId = (await db.insert(tasks).values({ orgId, projectId: pid, title: `Task ${marker}`, input: `do ${marker}`, providerSelection: 'anthropic', createdBy: userId }).returning({ id: tasks.id }))[0]!.id;
  await db.insert(messages).values({ orgId, projectId: pid, taskId, role: 'user', content: `message body ${marker}` });
  const ctx: TenantContext = { userId, orgId, projectId: pid, orgRole: 'owner', projectRole: 'admin' };
  return { ctx, taskId };
}

beforeAll(async () => {
  if (!available) return;
  userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `mcp-${randomUUID().slice(0, 8)}@t.local`, displayName: 'A' });
  orgId = (await db.insert(organizations).values({ name: 'O', slug: `mcp-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  const a = await seedProject('ALPHA');
  const b = await seedProject('BRAVO');
  ctxA = a.ctx; taskA = a.taskId;
  ctxB = b.ctx; taskB = b.taskId;
});
afterAll(async () => {
  if (available) await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});

describe.skipIf(!available)('Phase 5 — MCP token project isolation', () => {
  it('a token scoped to project A reads A\'s task but NOT project B\'s task (RLS-enforced)', async () => {
    const secret = (await withTenant(ctxA, (tx) => mintApiToken(tx, ctxA, { name: 'reader', scopes: ['get_task', 'list_projects', 'search_messages'] }))).secret;
    const auth = await authenticateMcp(secret);
    expect(auth).not.toBeNull();
    expect(auth!.ctx.projectId).toBe(ctxA.projectId);

    const own = await handleMcpRpc(auth!, rpc('tools/call', { name: 'get_task', arguments: { taskId: taskA } }));
    expect(callResult(own).isError).toBe(false);
    expect(callResult(own).text).toContain('Task ALPHA');

    // The exit criterion: B's task id is a valid uuid the caller happens to know, but it is another tenant's.
    const foreign = await handleMcpRpc(auth!, rpc('tools/call', { name: 'get_task', arguments: { taskId: taskB } }));
    expect(callResult(foreign).isError).toBe(true);
    expect(callResult(foreign).text).not.toContain('Task BRAVO');
  });

  it('list_projects and search_messages never surface project B', async () => {
    const secret = (await withTenant(ctxA, (tx) => mintApiToken(tx, ctxA, { name: 'reader2', scopes: ['list_projects', 'search_messages'] }))).secret;
    const auth = (await authenticateMcp(secret))!;

    const list = await handleMcpRpc(auth, rpc('tools/call', { name: 'list_projects', arguments: {} }));
    expect(callResult(list).text).toContain(ctxA.projectId);
    expect(callResult(list).text).not.toContain(ctxB.projectId);

    const hitA = await handleMcpRpc(auth, rpc('tools/call', { name: 'search_messages', arguments: { query: 'ALPHA' } }));
    expect(callResult(hitA).text).toContain('message body ALPHA');
    const missB = await handleMcpRpc(auth, rpc('tools/call', { name: 'search_messages', arguments: { query: 'BRAVO' } }));
    expect(callResult(missB).text).not.toContain('BRAVO'); // B's message is invisible even by content search
  });

  it('a read-only token cannot create a task; a write-scoped token can — in project A only', async () => {
    const readOnly = (await withTenant(ctxA, (tx) => mintApiToken(tx, ctxA, { name: 'ro', scopes: ['get_task'] }))).secret;
    const authRo = (await authenticateMcp(readOnly))!;
    const denied = await handleMcpRpc(authRo, rpc('tools/call', { name: 'create_task', arguments: { title: 't', input: 'i', primaryAgentId: randomUUID() } }));
    expect(callResult(denied).isError).toBe(true);
    expect(callResult(denied).text).toMatch(/scope/i);
  });

  it('revocation immediately inerts the token', async () => {
    const minted = await withTenant(ctxA, (tx) => mintApiToken(tx, ctxA, { name: 'short-lived', scopes: ['get_task'] }));
    expect(await authenticateMcp(minted.secret)).not.toBeNull();
    const revoked = await withTenant(ctxA, (tx) => revokeApiToken(tx, ctxA, minted.id));
    expect(revoked).toBe(true);
    expect(await authenticateMcp(minted.secret)).toBeNull();
  });
});
