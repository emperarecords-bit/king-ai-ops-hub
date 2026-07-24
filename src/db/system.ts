import { and, eq } from 'drizzle-orm';
import { type OrgRole, type ProjectRole } from '@/types/domain';
import { getDb } from './client';
import { memberships, profiles, projectMembers, projects } from './schema';

/**
 * The narrow set of reads that must happen BEFORE a TenantContext exists —
 * you cannot scope-by-project while resolving which projects the user is in.
 * Everything here is filtered by the authenticated user id and nothing else is
 * exposed. Keep this file short; every function added here is a bypass of
 * `withTenant` and needs a reason.
 */

export async function findProfileById(userId: string) {
  const db = getDb();
  const rows = await db.select().from(profiles).where(eq(profiles.id, userId)).limit(1);
  return rows[0] ?? null;
}

export async function upsertProfile(args: {
  id: string;
  email: string;
  displayName: string;
}) {
  const db = getDb();
  await db
    .insert(profiles)
    .values(args)
    .onConflictDoUpdate({
      target: profiles.id,
      set: { email: args.email, updatedAt: new Date() },
    });
}

export interface MembershipRecord {
  orgId: string;
  orgRole: OrgRole;
}

export async function findMemberships(userId: string): Promise<MembershipRecord[]> {
  const db = getDb();
  const rows = await db
    .select({ orgId: memberships.orgId, orgRole: memberships.role })
    .from(memberships)
    .where(eq(memberships.userId, userId));
  return rows;
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
  const db = getDb();
  const rows = await db
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
    .where(and(eq(projectMembers.userId, userId), eq(projects.archived, false)));
  return rows;
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
  const db = getDb();
  const rows = await db
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
    .limit(1);
  return rows[0] ?? null;
}

export async function findOrgRole(userId: string, orgId: string): Promise<OrgRole | null> {
  const db = getDb();
  const rows = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)))
    .limit(1);
  return rows[0]?.role ?? null;
}
