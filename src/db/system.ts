import { and, eq, sql } from 'drizzle-orm';
import { type OrgRole, type ProjectRole } from '@/types/domain';
import { log } from '@/lib/log';
import { getDb } from './client';
import { withUser } from './tenant';
import { memberships, profiles, projectMembers, projects } from './schema';

/**
 * The narrow set of reads that must happen BEFORE a TenantContext exists —
 * you cannot scope-by-project while resolving which projects the user is in.
 * Everything here is filtered by the authenticated user id and nothing else is
 * exposed. Keep this file short; every function added here is a bypass of
 * `withTenant` and needs a reason.
 */

export async function findProfileById(userId: string) {
  const rows = await withUser({ userId }, (tx) =>
    tx.select().from(profiles).where(eq(profiles.id, userId)).limit(1),
  );
  return rows[0] ?? null;
}

export async function upsertProfile(args: {
  id: string;
  email: string;
  displayName: string;
}) {
  // Detection AND the relink are cross-identity: they read/rewrite a PLACEHOLDER
  // profile that belongs to a different id, which per-user RLS (O-22) correctly
  // hides. So the whole thing lives in one fixed SECURITY DEFINER function
  // (app.adopt_placeholder_profile); the app role only invokes it. It returns
  // 'relinked' | 'conflict' | 'upserted' for logging.
  const rows = await getDb().execute(
    sql`select app.adopt_placeholder_profile(${args.id}, ${args.email}, ${args.displayName}) as outcome`,
  );
  const outcome = String(
    (rows as unknown as { rows?: Array<{ outcome?: string }> }).rows?.[0]?.outcome ??
      (Array.isArray(rows) ? (rows[0] as { outcome?: string })?.outcome : undefined) ??
      '',
  );
  if (outcome === 'relinked') {
    log.info('profile relinked from seed placeholder', { userId: args.id });
  } else if (outcome === 'conflict') {
    log.warn('profile email conflict left unresolved', { userId: args.id });
  }
}

export interface MembershipRecord {
  orgId: string;
  orgRole: OrgRole;
}

export async function findMemberships(userId: string): Promise<MembershipRecord[]> {
  return withUser({ userId }, (tx) =>
    tx
      .select({ orgId: memberships.orgId, orgRole: memberships.role })
      .from(memberships)
      .where(eq(memberships.userId, userId)),
  );
}

export interface ProjectAccessRecord {
  projectId: string;
  orgId: string;
  key: string;
  name: string;
  description: string;
  projectRole: ProjectRole;
}

/** Every non-archived project the user is explicitly a member of. */
export async function findAccessibleProjects(userId: string): Promise<ProjectAccessRecord[]> {
  return withUser({ userId }, (tx) =>
    tx
      .select({
        projectId: projects.id,
        orgId: projects.orgId,
        key: projects.key,
        name: projects.name,
        description: projects.description,
        projectRole: projectMembers.role,
      })
      .from(projectMembers)
      .innerJoin(projects, eq(projectMembers.projectId, projects.id))
      .where(and(eq(projectMembers.userId, userId), eq(projects.archived, false))),
  );
}

/**
 * Resolve a client-supplied project KEY to a project the user belongs to.
 * Returns null rather than distinguishing "no such project" from "not yours" —
 * the caller cannot probe for other tenants' project keys.
 */
export async function findProjectAccessByKey(
  userId: string,
  projectKey: string,
): Promise<ProjectAccessRecord | null> {
  const rows = await withUser({ userId }, (tx) =>
    tx
      .select({
        projectId: projects.id,
        orgId: projects.orgId,
        key: projects.key,
        name: projects.name,
        description: projects.description,
        projectRole: projectMembers.role,
      })
      .from(projectMembers)
      .innerJoin(projects, eq(projectMembers.projectId, projects.id))
      .where(
        and(
          eq(projectMembers.userId, userId),
          eq(projects.key, projectKey),
          eq(projects.archived, false),
        ),
      )
      .limit(1),
  );
  return rows[0] ?? null;
}

export async function findOrgRole(userId: string, orgId: string): Promise<OrgRole | null> {
  const rows = await withUser({ userId }, (tx) =>
    tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)))
      .limit(1),
  );
  return rows[0]?.role ?? null;
}
