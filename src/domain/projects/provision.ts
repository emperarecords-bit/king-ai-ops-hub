import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type TenantContext } from '@/types/domain';
import { ConflictError, ValidationError } from '@/lib/errors';
import { log } from '@/lib/log';
import { getDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import {
  agents,
  departments,
  knowledgeItems,
  memberships,
  organizations,
  projectMembers,
  projects,
  spendLimits,
} from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';
import { type AuthenticatedUser } from '@/domain/auth/guard';
import { findMemberships } from '@/db/system';
import { DEFAULT_STAFF } from './default-staff';

/**
 * Workspace provisioning — the front door (Sprint 5, ONBOARDING.md stage 2).
 *
 * Creating a workspace auto-staffs it: default employees, a development
 * budget, the eight standard departments (first workspace of a new org), and
 * a charter context item. The user lands in a working company, not an empty
 * shell.
 *
 * Two phases because TenantContext cannot exist before the project row does:
 *   1. org-level transaction: organization (if first), membership, project,
 *      project membership — GUCs stamped mid-transaction as ids are created.
 *   2. withTenant(new ctx): departments (if first), staff, budget, charter,
 *      audit — the ordinary tenant path.
 */

const DEFAULT_WORKSPACE_BUDGET_MICROS = 25_000_000n; // $25/month, adjustable later

const STANDARD_DEPARTMENTS = [
  ['engineering', 'Engineering'],
  ['marketing', 'Marketing'],
  ['finance', 'Finance'],
  ['operations', 'Operations'],
  ['support', 'Support'],
  ['sales', 'Sales'],
  ['legal', 'Legal'],
  ['research', 'Research'],
] as const;

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(2, 'Workspace name is required (2+ characters)').max(80),
  description: z.string().trim().max(500).default(''),
});

export type CreateWorkspaceInput = z.input<typeof createWorkspaceSchema>;

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'workspace';
}

export async function createWorkspace(
  user: AuthenticatedUser,
  input: CreateWorkspaceInput,
): Promise<{ projectKey: string }> {
  const parsed = createWorkspaceSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message));
  }
  const { name, description } = parsed.data;
  const db = getDb();

  // Resolve the org: first owner/admin membership wins; a brand-new user gets
  // an org of their own, created in the same transaction as the project.
  const existing = (await findMemberships(user.id)).find(
    (m) => m.orgRole === 'owner' || m.orgRole === 'admin',
  );

  // ---- Phase 1: org-level rows ---------------------------------------------
  const phase1 = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${user.id}, true)`);

    let orgId = existing?.orgId ?? null;
    if (!orgId) {
      const orgName = `${user.displayName.split('@')[0]}'s Company`;
      const orgSlug = `${slugify(orgName)}-${crypto.randomUUID().slice(0, 8)}`;
      const org = await tx
        .insert(organizations)
        .values({ name: orgName, slug: orgSlug })
        .returning({ id: organizations.id });
      orgId = org[0]!.id;
      await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
      await tx.insert(memberships).values({ orgId, userId: user.id, role: 'owner' });
    } else {
      await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    }

    // Unique key within the org: slug, then slug-2, slug-3…
    const base = slugify(name);
    const taken = await tx
      .select({ key: projects.key })
      .from(projects)
      .where(eq(projects.orgId, orgId));
    const keys = new Set(taken.map((t) => t.key));
    let key = base;
    for (let n = 2; keys.has(key); n += 1) {
      if (n > 50) throw new ConflictError('Could not find a free workspace key — rename it.');
      key = `${base}-${n}`;
    }

    const project = await tx
      .insert(projects)
      .values({ orgId, key, name, description })
      .returning({ id: projects.id });
    const projectId = project[0]!.id;

    await tx
      .insert(projectMembers)
      .values({ orgId, projectId, userId: user.id, role: 'admin' });

    return { orgId, projectId, key };
  });

  const ctx: TenantContext = {
    userId: user.id,
    orgId: phase1.orgId,
    projectId: phase1.projectId,
    orgRole: existing?.orgRole ?? 'owner',
    projectRole: 'admin',
  };

  // ---- Phase 2: staffing and defaults, ordinary tenant path ----------------
  await withTenant(ctx, async (tx) => {
    for (const [key, deptName] of STANDARD_DEPARTMENTS) {
      await tx
        .insert(departments)
        .values({ orgId: ctx.orgId, key, name: deptName })
        .onConflictDoNothing();
    }
    const engineering = (
      await tx
        .select({ id: departments.id })
        .from(departments)
        .where(and(eq(departments.orgId, ctx.orgId), eq(departments.key, 'engineering')))
        .limit(1)
    )[0];

    for (const staff of DEFAULT_STAFF) {
      await tx.insert(agents).values({
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        name: staff.name,
        role: staff.role,
        departmentId: engineering?.id ?? null,
        provider: staff.provider,
        model: staff.model,
        systemPrompt: staff.systemPrompt,
      });
    }

    await tx.insert(spendLimits).values({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      monthlyLimitMicros: DEFAULT_WORKSPACE_BUDGET_MICROS,
    });

    // The charter is the workspace's first knowledge item (K1) — active
    // immediately: the human founder is the approver.
    await tx.insert(knowledgeItems).values({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      scope: 'project',
      kind: 'fact',
      title: 'Workspace charter',
      body: `${name}: ${description || 'No description yet.'} This charter is company knowledge, consulted by every employee before work in this workspace only.`,
      status: 'active',
      source: 'manual',
      createdBy: ctx.userId,
      approvedBy: ctx.userId,
      approvedAt: new Date(),
    });

    await writeAudit(tx, ctx, {
      action: 'workspace.created',
      entityType: 'project',
      entityId: ctx.projectId,
      detail: { name, key: phase1.key, staffed: DEFAULT_STAFF.length },
    });
  });

  log.info('workspace provisioned', { projectId: phase1.projectId, key: phase1.key });
  return { projectKey: phase1.key };
}
