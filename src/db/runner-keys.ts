import { and, eq, isNull, sql } from 'drizzle-orm';
import type { TenantContext } from '@/types/domain';
import { getDb } from './client';
import { withRunner, withTenant } from './tenant';
import { verificationRunnerKeys } from './schema';

/**
 * VER-002 PR-2 — data access for runner (machine) credentials.
 *
 * Two PRE-TENANT reads go through hardened SECURITY DEFINER functions (src/db/rls.sql), because they
 * run before any tenant context exists: resolving a bearer's keyId and resolving a project key. Both
 * expose only what authentication needs. Issuance/revocation, by contrast, run under the admin's
 * tenant context (withTenant) so RLS confines them to the admin's own project.
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

/** Issue a credential row under the admin's tenant context (RLS pins org/project). Returns the keyId. */
export async function insertRunnerKey(
  ctx: TenantContext,
  values: { keyId: string; secretHash: string; secretSalt: string; label: string; expiresAt: Date },
): Promise<void> {
  await withTenant(ctx, (tx) =>
    tx.insert(verificationRunnerKeys).values({
      id: values.keyId,
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      secretHash: values.secretHash,
      secretSalt: values.secretSalt,
      label: values.label,
      createdBy: ctx.userId,
      expiresAt: values.expiresAt,
    }),
  );
}

/** Revoke a credential under the admin's tenant context. Returns true if a not-yet-revoked row in
 *  THIS project was revoked. Deliberately independent of the issuance flag. */
export async function revokeRunnerKey(ctx: TenantContext, keyId: string, now: Date): Promise<boolean> {
  const rows = await withTenant(ctx, (tx) =>
    tx
      .update(verificationRunnerKeys)
      .set({ revokedAt: now, revokedBy: ctx.userId })
      .where(and(eq(verificationRunnerKeys.id, keyId), isNull(verificationRunnerKeys.revokedAt)))
      .returning({ id: verificationRunnerKeys.id }),
  );
  return rows.length > 0;
}

/** Best-effort last-used stamp after a successful machine auth (runner tenant context). */
export async function touchRunnerKeyLastUsed(
  ctx: { orgId: string; projectId: string },
  keyId: string,
  now: Date,
): Promise<void> {
  try {
    await withRunner(ctx, (tx) =>
      tx.update(verificationRunnerKeys).set({ lastUsedAt: now }).where(eq(verificationRunnerKeys.id, keyId)),
    );
  } catch {
    /* best effort — never fail auth on a stamp */
  }
}
