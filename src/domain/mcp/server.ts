import { type TenantContext } from '@/types/domain';
import { AppError } from '@/lib/errors';
import { withTenant } from '@/db/tenant';
import { resolveApiTokenIdentity } from '@/db/api-token';
import { findAccessibleProjects, findOrgRole } from '@/db/system';
import { consumeRateLimit } from '@/domain/usage/rate-limit';
import { hashTokenSecret } from './token-secret';
import { isMcpToolName, type McpToolName } from './tool-names';
import { MCP_TOOLS, getToolDefinition } from './tools';

/**
 * MCP JSON-RPC server (Phase 5) — transport-agnostic. Authentication resolves a bearer token to a live identity
 * BEFORE any tenant work (docs/architecture/mcp-server-decision.md); every tool call then runs under `withTenant`
 * with the per-token rate limit applied, so RLS and the existing limiter govern all of it. `tools/list` advertises
 * only the tools the token's scope grants.
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18';
const RATE_LIMIT_PER_MINUTE = 120;

export interface AuthenticatedMcp {
  readonly ctx: TenantContext;
  readonly tokenId: string;
  readonly scopes: McpToolName[];
}

/**
 * Resolve a presented bearer secret to a live, membership-backed identity, or null. Null covers: unknown/revoked/
 * expired token, and — crucially — a token whose minting member no longer has access to the bound project, so
 * revoking a person's project membership also inerts their tokens.
 */
export async function authenticateMcp(bearerSecret: string): Promise<AuthenticatedMcp | null> {
  const identity = await resolveApiTokenIdentity(hashTokenSecret(bearerSecret));
  if (!identity) return null;

  const accessible = await findAccessibleProjects(identity.createdBy);
  const project = accessible.find((p) => p.projectId === identity.projectId && p.orgId === identity.orgId);
  if (!project) return null;
  const orgRole = await findOrgRole(identity.createdBy, identity.orgId);
  if (!orgRole) return null;

  const scopes = identity.scopes.filter(isMcpToolName);
  return {
    tokenId: identity.tokenId,
    scopes,
    ctx: {
      userId: identity.createdBy,
      orgId: identity.orgId,
      projectId: identity.projectId,
      orgRole,
      projectRole: project.projectRole,
    },
  };
}

async function callTool(auth: AuthenticatedMcp, name: string, args: unknown): Promise<unknown> {
  if (!isMcpToolName(name)) throw new AppError('not_found', `Unknown tool: ${name}`);
  if (!auth.scopes.includes(name)) {
    throw new AppError('forbidden', `This token's scope does not grant the tool "${name}".`);
  }
  const def = getToolDefinition(name)!;
  return withTenant(auth.ctx, async (tx) => {
    // Per (token, tool) minute bucket, reusing the existing atomic limiter. Throws RateLimitedError when exceeded.
    await consumeRateLimit(tx, `mcp:${auth.tokenId}:${name}`, RATE_LIMIT_PER_MINUTE);
    return def.handler(tx, auth.ctx, args);
  });
}

// --- JSON-RPC 2.0 ------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}
function fail(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Dispatch one authenticated JSON-RPC request. Protocol errors become JSON-RPC errors; tool errors become an
 *  in-band `isError` result per the MCP convention, so a client sees the message without a transport failure. */
export async function handleMcpRpc(auth: AuthenticatedMcp, request: JsonRpcRequest): Promise<JsonRpcResponse> {
  const id = request.id ?? null;
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return fail(id, -32600, 'Invalid Request');
  }

  switch (request.method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'king-ai-ops-hub', version: '1' },
      });

    case 'tools/list': {
      const tools = MCP_TOOLS.filter((t) => auth.scopes.includes(t.name)).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      return ok(id, { tools });
    }

    case 'tools/call': {
      const params = (request.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof params.name !== 'string') return fail(id, -32602, 'Invalid params: name is required');
      try {
        const out = await callTool(auth, params.name, params.arguments);
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(out) }], isError: false });
      } catch (err) {
        const message = err instanceof AppError ? err.publicMessage : 'Tool execution failed.';
        return ok(id, { content: [{ type: 'text', text: message }], isError: true });
      }
    }

    default:
      return fail(id, -32601, `Method not found: ${request.method}`);
  }
}
