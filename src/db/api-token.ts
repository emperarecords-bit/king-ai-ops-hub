import { sql } from 'drizzle-orm';
import { getDb } from './client';

/**
 * The single sanctioned resolution of an MCP API token OUTSIDE tenant scope (Phase 5). A presented token's hash
 * must be mapped to its bound (org, project, user) BEFORE a TenantContext can exist — the same pre-tenant problem
 * the identity reads in ./system.ts face. Resolution runs entirely inside the fixed `SECURITY DEFINER` function
 * `app.resolve_api_token` (owned by the BYPASSRLS `app_system` role, EXECUTE-only to app_server; see rls.sql),
 * which returns a row only for a token that is present, not revoked, and not expired, and stamps last_used_at.
 *
 * Keep this file to this one function. It is a deliberate `withTenant` bypass and, like ./system.ts, every
 * addition here needs a reason. The resolved identity is handed to `withTenant` by the caller so RLS governs the
 * actual tool work.
 */

export interface ResolvedApiToken {
  readonly tokenId: string;
  readonly orgId: string;
  readonly projectId: string;
  /** The project member the token acts as. */
  readonly createdBy: string;
  /** Allowed MCP tool names granted to this token. */
  readonly scopes: string[];
}

interface ResolverRow {
  token_id: string;
  org_id: string;
  project_id: string;
  created_by: string;
  scopes: unknown;
}

function firstRow<T>(result: unknown): T | undefined {
  const wrapped = (result as { rows?: T[] }).rows;
  if (Array.isArray(wrapped)) return wrapped[0];
  if (Array.isArray(result)) return (result as T[])[0];
  return undefined;
}

/**
 * Resolve a token hash (SHA-256 hex) to its bound identity, or null when no live token matches. The caller has
 * already hashed the presented secret; the plaintext never reaches the database.
 */
export async function resolveApiTokenIdentity(tokenHash: string): Promise<ResolvedApiToken | null> {
  const result = await getDb().execute(
    sql`select token_id, org_id, project_id, created_by, scopes from app.resolve_api_token(${tokenHash})`,
  );
  const row = firstRow<ResolverRow>(result);
  if (!row) return null;
  const scopes = Array.isArray(row.scopes) ? row.scopes.filter((s): s is string => typeof s === 'string') : [];
  return {
    tokenId: row.token_id,
    orgId: row.org_id,
    projectId: row.project_id,
    createdBy: row.created_by,
    scopes,
  };
}
