import 'server-only';
import { cache } from 'react';
import { type TenantContext, type VerificationCaller } from '@/types/domain';
import { ForbiddenError, UnauthenticatedError, ValidationError } from '@/lib/errors';
import { serverEnv } from '@/lib/env.server';
import {
  findAccessibleProjects,
  findOrgRole,
  findProfileById,
  findProjectAccessByKey,
  upsertProfile,
  type ProjectAccessRecord,
} from '@/db/system';
import {
  lookupRunnerKeyById,
  resolveProjectByKey,
  touchRunnerKeyLastUsed,
} from '@/db/runner-keys';
import {
  hasBearerCredential,
  isRunnerKeyActive,
  parseRunnerCredential,
  verifyRunnerSecret,
} from './runner-credential';
import { createSupabaseServerClient } from './supabase';

/**
 * TB-1: the ONLY way request handlers learn who is calling and what project
 * they may touch. The client supplies a project KEY; everything else —
 * user id, org id, project id, roles — is resolved server-side.
 */

export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
}

/**
 * Verifies the session against the Supabase auth server (getUser(), not the
 * unverified getSession() payload) and syncs the local profile row.
 * request-scoped-cached: many components per render may call this.
 */
export const requireUser = cache(async (): Promise<AuthenticatedUser> => {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user || !user.email) {
    throw new UnauthenticatedError();
  }

  const profile = await findProfileById(user.id);
  if (!profile) {
    await upsertProfile({
      id: user.id,
      email: user.email,
      displayName: (user.user_metadata?.display_name as string | undefined) ?? user.email,
    });
  }

  return {
    id: user.id,
    email: user.email,
    displayName: profile?.displayName ?? user.email,
  };
});

/** Session check that returns null instead of throwing (for redirects). */
export async function currentUser(): Promise<AuthenticatedUser | null> {
  try {
    return await requireUser();
  } catch {
    return null;
  }
}

/**
 * The tenancy gate. Resolves a project key to a TenantContext or throws.
 * Returns identical errors for "project does not exist" and "not a member" so
 * project keys cannot be probed.
 */
export async function requireTenant(projectKey: string): Promise<TenantContext> {
  const user = await requireUser();

  const access = await findProjectAccessByKey(user.id, projectKey);
  if (!access) {
    throw new ForbiddenError(`No access to project key '${projectKey}' for user ${user.id}`);
  }

  const orgRole = await findOrgRole(user.id, access.orgId);
  if (!orgRole) {
    throw new ForbiddenError(`User ${user.id} has project but no org membership`);
  }

  return {
    userId: user.id,
    orgId: access.orgId,
    projectId: access.projectId,
    orgRole,
    projectRole: access.projectRole,
  };
}

/** A Supabase SSR session cookie is present (name `sb-<ref>-auth-token`, possibly chunked `.0`/`.1`). */
function hasSessionCookie(req: Request): boolean {
  const cookie = req.headers.get('cookie');
  return typeof cookie === 'string' && /(?:^|;\s*)sb-[^=;]*-auth-token(?:\.\d+)?=/.test(cookie);
}

/**
 * VER-002 PR-2 — the machine-or-human gate for runner-facing verification endpoints.
 *
 * Dispatch is unambiguous and case-insensitive:
 *  - A bearer credential (any casing) commits the request to the MACHINE path — an invalid/rejected
 *    bearer is a 401 and NEVER falls back to a session (a bad machine credential must not silently
 *    become a human request).
 *  - Presenting BOTH a bearer AND a session cookie is rejected (400) as ambiguous — we never guess
 *    which credential the caller meant.
 *  - No bearer → the existing human `requireTenant` path, unchanged.
 *
 * Machine-auth acceptance is behind its own default-off control (`VERIFICATION_RUNNER_MACHINE_AUTH_ENABLED`),
 * independent of credential issuance — so machine auth can be turned off without touching issuance/revocation.
 */
export async function requireRunnerOrTenant(projectKey: string, req: Request): Promise<VerificationCaller> {
  const authHeader = req.headers.get('authorization');
  if (hasBearerCredential(authHeader)) {
    // Reject simultaneous credentials outright — do not disambiguate a bearer + session combination.
    if (hasSessionCookie(req)) {
      throw new ValidationError(['Provide either a runner bearer credential or a session, not both.']);
    }
    // COMMITTED to the machine path — no session fallback beyond this point.
    if (!serverEnv().VERIFICATION_RUNNER_MACHINE_AUTH_ENABLED) {
      throw new UnauthenticatedError();
    }
    const cred = parseRunnerCredential(authHeader);
    if (!cred) throw new UnauthenticatedError(); // malformed/ambiguous bearer

    const key = await lookupRunnerKeyById(cred.keyId);
    const now = new Date();
    if (!key || !isRunnerKeyActive({ revokedAt: key.revokedAt, expiresAt: key.expiresAt }, now)) {
      throw new UnauthenticatedError(); // unknown, revoked, or expired
    }
    if (!verifyRunnerSecret(cred.secret, key.secretSalt, key.secretHash)) {
      throw new UnauthenticatedError(); // wrong secret
    }
    // The credential's project must match the URL's project key (a key for A cannot act on B).
    const proj = await resolveProjectByKey(projectKey);
    if (!proj || proj.projectId !== key.projectId || proj.orgId !== key.orgId) {
      throw new ForbiddenError(`Runner credential is not authorized for project key '${projectKey}'`);
    }
    await touchRunnerKeyLastUsed({ orgId: key.orgId, projectId: key.projectId }, cred.keyId);
    return { kind: 'runner', runner: { kind: 'runner', runnerKeyId: cred.keyId, orgId: key.orgId, projectId: key.projectId } };
  }
  // No bearer → the human session path, exactly as before.
  return { kind: 'user', tenant: await requireTenant(projectKey) };
}

export async function listMyProjects(): Promise<ProjectAccessRecord[]> {
  const user = await requireUser();
  return findAccessibleProjects(user.id);
}

/** Projects plus the caller's role in each org — the morning briefing input. */
export async function listMyProjectsWithOrgRoles(): Promise<{
  user: AuthenticatedUser;
  projects: ProjectAccessRecord[];
  orgRoles: Map<string, NonNullable<Awaited<ReturnType<typeof findOrgRole>>>>;
}> {
  const user = await requireUser();
  const projects = await findAccessibleProjects(user.id);
  const orgRoles = new Map<string, NonNullable<Awaited<ReturnType<typeof findOrgRole>>>>();
  for (const orgId of new Set(projects.map((p) => p.orgId))) {
    const role = await findOrgRole(user.id, orgId);
    if (role) orgRoles.set(orgId, role);
  }
  return { user, projects, orgRoles };
}
