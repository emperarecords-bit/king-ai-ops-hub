import { log } from '@/lib/log';
import { parseBearer } from '@/domain/mcp/token-secret';
import { authenticateMcp, handleMcpRpc, type JsonRpcRequest } from '@/domain/mcp/server';

/**
 * MCP HTTP transport (Phase 5). A single JSON-RPC-over-POST endpoint. Authentication is a project-scoped bearer
 * API token in the `Authorization` header; there is no cookie/session path here, so a browser context cannot
 * drive it. Every authenticated call runs through the same tenant boundary and rate limiter as the rest of the
 * product (see src/domain/mcp/server.ts). This route never touches the database directly — it goes through the
 * domain server.
 */

function unauthorized(): Response {
  return Response.json(
    { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } },
    { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } },
  );
}

export async function POST(req: Request): Promise<Response> {
  const token = parseBearer(req.headers.get('authorization'));
  if (!token) return unauthorized();

  let auth;
  try {
    auth = await authenticateMcp(token);
  } catch (err) {
    log.error('mcp authentication failed', { error: err instanceof Error ? err.name : 'unknown' });
    return Response.json(
      { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } },
      { status: 500 },
    );
  }
  if (!auth) return unauthorized();

  let body: JsonRpcRequest;
  try {
    body = (await req.json()) as JsonRpcRequest;
  } catch {
    return Response.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { status: 400 },
    );
  }

  try {
    const response = await handleMcpRpc(auth, body);
    return Response.json(response, { status: 200 });
  } catch (err) {
    // handleMcpRpc maps tool errors in-band; reaching here is an unexpected server fault.
    log.error('mcp dispatch failed', { error: err instanceof Error ? err.name : 'unknown' });
    return Response.json(
      { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32603, message: 'Internal error' } },
      { status: 500 },
    );
  }
}
