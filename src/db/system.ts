import { and, eq } from 'drizzle-orm';
import { type OrgRole, type ProjectRole } from '@/types/domain';
import { log } from '@/lib/log';
import { getDb } from './client';
import {
  approvals,
  memberships,
  profiles,
  projectContextItems,
  projectMembers,
  projects,
  tasks,
} from './schema';

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

  // The seed may have created a PLACEHOLDER profile for this email (random id)
  // carrying memberships, so the owner's workspaces exist before first
  // sign-up. When the real auth user arrives with the same email, adopt the
  // placeholder: move its references to the auth id, then remove it. Without
  // this, the insert below dies on the email unique constraint and first
  // sign-in 500s (Sprint 1 known issue #2).
  const byEmail = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.email, args.email))
    .limit(1);
  const placeholderId = byEmail[0]?.id;

  if (placeholderId && placeholderId !== args.id) {
    const existingSelf = await db
      .select({ id: profiles.id })
      .from(profiles)
      .where(eq(profiles.id, args.id))
      .limit(1);
    if (existingSelf.length > 0) {
      // Both rows exist (auth profile under an old email + another profile
      // holding the new email). Merging two REAL histories is not safe to do
      // implicitly — keep the auth profile as-is and surface the conflict.
      log.warn('profile email conflict left unresolved', {
        userId: args.id,
        conflictingProfileId: placeholderId,
      });
      return;
    }

    await db.transaction(async (tx) => {
      // Temporary unique email so the real one can move over afterwards.
      await tx.insert(profiles).values({
        id: args.id,
        email: `relinking-${args.id}@invalid.local`,
        displayName: args.displayName,
      });
      await tx
        .update(memberships)
        .set({ userId: args.id })
        .where(eq(memberships.userId, placeholderId));
      await tx
        .update(projectMembers)
        .set({ userId: args.id })
        .where(eq(projectMembers.userId, placeholderId));
      await tx
        .update(projectContextItems)
        .set({ createdBy: args.id })
        .where(eq(projectContextItems.createdBy, placeholderId));
      await tx
        .update(tasks)
        .set({ createdBy: args.id })
        .where(eq(tasks.createdBy, placeholderId));
      await tx
        .update(approvals)
        .set({ decidedBy: args.id })
        .where(eq(approvals.decidedBy, placeholderId));
      await tx.delete(profiles).where(eq(profiles.id, placeholderId));
      await tx
        .update(profiles)
        .set({ email: args.email, updatedAt: new Date() })
        .where(eq(profiles.id, args.id));
    });
    log.info('profile relinked from seed placeholder', { userId: args.id });
    return;
  }

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
