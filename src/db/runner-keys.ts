import { sql } from 'drizzle-orm';
import type { TenantContext } from '@/types/domain';
import { getDb } from './client';
import { withRunner, withTenant } from './tenant';

/**
 * VER-002 PR-2 — data access for runner (machine) credentials.
 *
 * app_server has NO direct table privileges on verification_runner_keys (no select/insert/update/
 * delete): secret material is never broadly SELECTable and credential fields are never generally
 * mutable. EVERY operation goes through a narrowly-scoped SECURITY DEFINER function (src/db/rls.sql):
 *  - the two PRE-TENANT reads (lookup a bearer's keyId, resolve a project key) run before any tenant
 *    context exists and return only what authentication needs;
 *  - issue/revoke/touch run under the caller's tenant GUCs (withTenant/withRunner) and derive the
 *    tenant from those GUCs, so they can only ever act within the caller's own project.
 */

/** getDb().execute() returns a driver-shaped result ({rows} or an array); read the first row uniformly. */
function firstRow<T>(result: unknown): T | undefined {
  const wrapped = (result as { rows?: T[] }).rows;
  if (Array.isArray(wrapped)) return wrapped[0];
  if (Array.isArray(result)) return (result as T[])[0];
  return undefined;
}

export interface RunnerKeyLookup {
  readonly orgId: string;
  readonly projectId: string;
  readonly secretHash: string;
  readonly secretSalt: string;
  readonly revokedAt: Date | null;
  readonly expiresAt: Date;
}

/** Pre-tenant: resolve a bearer keyId to its stored auth material (via the definer function). */
export async function lookupRunnerKeyById(keyId: string): Promise<RunnerKeyLookup | null> {
  const result = await getDb().execute(
    sql`select org_id, project_id, secret_hash, secret_salt, revoked_at, expires_at
        from app.lookup_verification_runner_key(${keyId})`,
  );
  const r = firstRow<{
    org_id: string;
    project_id: string;
    secret_hash: string;
    secret_salt: string;
    revoked_at: string | null;
    expires_at: string;
  }>(result);
  if (!r) return null;
  return {
    orgId: r.org_id,
    projectId: r.project_id,
    secretHash: r.secret_hash,
    secretSalt: r.secret_salt,
    revokedAt: r.revoked_at ? new Date(r.revoked_at) : null,
    expiresAt: new Date(r.expires_at),
  };
}

/** Pre-tenant: resolve a project KEY to its (org, project) ids (via the definer function). */
export async function resolveProjectByKey(projectKey: string): Promise<{ orgId: string; projectId: string } | null> {
  const result = await getDb().execute(
    sql`select org_id, project_id from app.resolve_project_by_key(${projectKey})`,
  );
  const r = firstRow<{ org_id: string; project_id: string }>(result);
  return r ? { orgId: r.org_id, projectId: r.project_id } : null;
}

/** Issue a credential via the scoped definer function (tenant/creator taken from the admin's GUCs). */
export async function insertRunnerKey(
  ctx: TenantContext,
  values: { keyId: string; secretHash: string; secretSalt: string; label: string; expiresAt: Date },
): Promise<void> {
  await withTenant(ctx, (tx) =>
    tx.execute(
      sql`select app.issue_verification_runner_key(${values.keyId}, ${values.secretHash}, ${values.secretSalt}, ${values.label}, ${values.expiresAt.toISOString()})`,
    ),
  );
}

/** Revoke a credential via the scoped definer function. Returns true iff a not-yet-revoked row in the
 *  caller's OWN project was revoked (cross-project keys never match). Independent of the issuance flag. */
export async function revokeRunnerKey(ctx: TenantContext, keyId: string): Promise<boolean> {
  const result = await withTenant(ctx, (tx) =>
    tx.execute(sql`select app.revoke_verification_runner_key(${keyId}) as revoked`),
  );
  const r = firstRow<{ revoked: boolean }>(result);
  return r?.revoked === true;
}

/** Best-effort last-used stamp after a successful machine auth, via the scoped definer function. */
export async function touchRunnerKeyLastUsed(ctx: { orgId: string; projectId: string }, keyId: string): Promise<void> {
  try {
    await withRunner(ctx, (tx) => tx.execute(sql`select app.touch_verification_runner_key(${keyId})`));
  } catch {
    /* best effort — never fail auth on a stamp */
  }
}
