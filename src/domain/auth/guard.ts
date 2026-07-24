import 'server-only';
import { cache } from 'react';
import { type TenantContext } from '@/types/domain';
import { ForbiddenError, UnauthenticatedError } from '@/lib/errors';
import {
  findAccessibleProjects,
  findOrgRole,
  findProfileById,
  findProjectAccessByKey,
  upsertProfile,
  type ProjectAccessRecord,
} from '@/db/system';
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

export async function listMyProjects(): Promise<ProjectAccessRecord[]> {
  const user = await requireUser();
  return findAccessibleProjects(user.id);
}
