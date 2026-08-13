import { describe, expect, it } from 'vitest';
import { type TenantContext } from '@/types/domain';
import {
  MCP_PROTOCOL_VERSION,
  handleMcpRpc,
  type AuthenticatedMcp,
  type JsonRpcRequest,
} from '@/domain/mcp/server';

/**
 * Protocol-layer tests that never touch the database. `initialize`, `tools/list`, unknown-method, malformed-
 * request, and the two tool-call REJECTION paths (unknown tool, out-of-scope) all resolve before any
 * `withTenant` call, so they are exercised here without a DB. The in-scope tool-call happy path is covered by
 * the DB-gated isolation test.
 */

const ctx: TenantContext = {
  userId: '00000000-0000-0000-0000-000000000001',
  orgId: '00000000-0000-0000-0000-000000000002',
  projectId: '00000000-0000-0000-0000-000000000003',
  orgRole: 'member',
  projectRole: 'member',
};

const readOnlyAuth: AuthenticatedMcp = { ctx, tokenId: 't1', scopes: ['list_projects', 'get_task'] };

function rpc(method: string, params?: unknown, id: number = 1): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method, params };
}

describe('mcp server protocol', () => {
  it('initialize returns the protocol version and server info', async () => {
    const res = await handleMcpRpc(readOnlyAuth, rpc('initialize'));
    expect(res.error).toBeUndefined();
    expect(res.result).toMatchObject({ protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: 'king-ai-ops-hub' } });
  });

  it('tools/list advertises ONLY the tools the token scope grants', async () => {
    const res = await handleMcpRpc(readOnlyAuth, rpc('tools/list'));
    const names = (res.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names.sort()).toEqual(['get_task', 'list_projects']);
    expect(names).not.toContain('create_task'); // write tool not in scope → not advertised
  });

  it('unknown method → JSON-RPC method-not-found', async () => {
    const res = await handleMcpRpc(readOnlyAuth, rpc('resources/list'));
    expect(res.error?.code).toBe(-32601);
  });

  it('malformed request → invalid request', async () => {
    const res = await handleMcpRpc(readOnlyAuth, { jsonrpc: '1.0', id: 9, method: 'initialize' } as unknown as JsonRpcRequest);
    expect(res.error?.code).toBe(-32600);
  });

  it('tools/call for an unknown tool returns an in-band tool error (no DB touched)', async () => {
    const res = await handleMcpRpc(readOnlyAuth, rpc('tools/call', { name: 'drop_tables', arguments: {} }));
    expect(res.error).toBeUndefined();
    expect(res.result).toMatchObject({ isError: true });
  });

  it('tools/call for a tool OUTSIDE the token scope is refused before any tenant work', async () => {
    // create_task is a real tool, but this token lacks the scope → forbidden, in-band, no withTenant/DB.
    const res = await handleMcpRpc(readOnlyAuth, rpc('tools/call', { name: 'create_task', arguments: {} }));
    expect(res.result).toMatchObject({ isError: true });
    const text = (res.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toMatch(/scope/i);
  });

  it('tools/call without a name → invalid params', async () => {
    const res = await handleMcpRpc(readOnlyAuth, rpc('tools/call', { arguments: {} }));
    expect(res.error?.code).toBe(-32602);
  });
});
