import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type TenantContext } from '@/types/domain';
import { AppError, ConflictError, ValidationError } from '@/lib/errors';
import { log } from '@/lib/log';
import { getDb, type DbTx } from '@/db/client';
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

export const STANDARD_DEPARTMENTS = [
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
      // Generate the id here and INSERT without RETURNING: under RLS the freshly
      // created org is not yet visible to the SELECT policy (no membership row
      // exists until the next statement), so a RETURNING read-back would be
      // refused. A plain INSERT only checks WITH CHECK, which passes (O-22).
      orgId = crypto.randomUUID();
      await tx.insert(organizations).values({ id: orgId, name: orgName, slug: orgSlug });
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

    // Same as the org above: generate the id and skip RETURNING, because the
    // project is not visible to projects_scope until the project_members row
    // below exists (O-22).
    const projectId = crypto.randomUUID();
    await tx.insert(projects).values({ id: projectId, orgId, key, name, description });

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

// ---------------------------------------------------------------------------
// Transaction-composable workspace provisioning (orchestrated placement path)
// ---------------------------------------------------------------------------

export interface CreateWorkspaceWithStaffInput {
  name: string;
  description?: string;
  reason: string;
}

/** The org must already exist; this op adds a workspace to it (it does NOT bootstrap a first org). */
export interface WorkspaceProvisioningActor {
  userId: string;
  orgId: string;
}

export interface CreateWorkspaceWithStaffResult {
  projectId: string;
  projectKey: string;
  leadEngineerId: string;
  seniorEngineerId: string;
  reviewEngineerId: string;
  principalReviewerId: string;
  charterKnowledgeId: string;
  spendLimitId: string;
}

/**
 * Provision a workspace + its default engineering team + charter + spend-limit + `workspace.created` audit
 * event — ENTIRELY inside a caller-supplied transaction (no internal transaction). This is the
 * transaction-composable sibling of `createWorkspace` (which bootstraps a first org and opens its own
 * transactions). Because it takes the caller's `tx`, an orchestrator can create the workspace, then its
 * explicit employees via `createEmployeeWithConfig(tx, …)`, then dormancy via `updateAgent(tx, …)` — and any
 * failure rolls back the ENTIRE workspace batch.
 *
 * Duplicate handling is STRICT and deterministic (no `-2` suffix): an existing normalized key is rejected.
 * A failed transaction leaves nothing; a retry after rollback creates normally; a retry after commit rejects.
 *
 * Tenancy transition (inside the one tx): the op starts in ORG scope — it stamps `app.user_id`/`app.org_id`
 * so the `projects` INSERT's WITH CHECK (org membership) passes; it generates the workspace id itself (never
 * from client input) and inserts the project + admin membership WITHOUT RETURNING (the row isn't visible to
 * the SELECT policy until the membership exists, O-22); it then stamps `app.project_id` = the new id,
 * transitioning to WORKSPACE scope so the tenant-scoped child inserts (staff, spend, charter, audit) satisfy
 * RLS. The org is derived only from the trusted actor context; a client-supplied org id is never accepted.
 */
export async function createWorkspaceWithStaff(
  tx: DbTx,
  actor: WorkspaceProvisioningActor,
  input: CreateWorkspaceWithStaffInput,
): Promise<CreateWorkspaceWithStaffResult> {
  const parsed = createWorkspaceSchema.safeParse({ name: input.name, description: input.description ?? '' });
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message));
  const { name, description } = parsed.data;
  const reason = (input.reason ?? '').trim();
  if (!reason) throw new ValidationError(['A reason is required to provision a workspace.']);

  // ---- Authorization: actor must be an owner/admin of the (existing) org ----
  const membership = (
    await tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.orgId, actor.orgId), eq(memberships.userId, actor.userId)))
      .limit(1)
  )[0];
  if (!membership) throw new AppError('forbidden', 'You are not a member of that organization.');
  if (membership.role !== 'owner' && membership.role !== 'admin') {
    throw new AppError('forbidden', 'Only an organization owner or admin can provision a workspace.');
  }

  // ---- ORG scope: stamp GUCs so the project INSERT's WITH CHECK passes ------
  await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
  await tx.execute(sql`select set_config('app.org_id', ${actor.orgId}, true)`);

  // ---- Strict duplicate-key rejection (no suffixing) -----------------------
  const key = slugify(name);
  const existing = (
    await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.orgId, actor.orgId), eq(projects.key, key)))
      .limit(1)
  )[0];
  if (existing) throw new ConflictError(`A workspace with key "${key}" already exists in this organization.`);

  const projectId = crypto.randomUUID();
  await tx.insert(projects).values({ id: projectId, orgId: actor.orgId, key, name, description });
  await tx.insert(projectMembers).values({ orgId: actor.orgId, projectId, userId: actor.userId, role: 'admin' });

  // ---- Transition to WORKSPACE scope ---------------------------------------
  await tx.execute(sql`select set_config('app.project_id', ${projectId}, true)`);
  const ctx: TenantContext = {
    userId: actor.userId,
    orgId: actor.orgId,
    projectId,
    orgRole: membership.role,
    projectRole: 'admin',
  };

  for (const [dkey, dname] of STANDARD_DEPARTMENTS) {
    await tx.insert(departments).values({ orgId: actor.orgId, key: dkey, name: dname }).onConflictDoNothing();
  }
  const engineering = (
    await tx
      .select({ id: departments.id })
      .from(departments)
      .where(and(eq(departments.orgId, actor.orgId), eq(departments.key, 'engineering')))
      .limit(1)
  )[0];

  const staffIds: Record<string, string> = {};
  for (const staff of DEFAULT_STAFF) {
    const r = await tx
      .insert(agents)
      .values({
        orgId: actor.orgId,
        projectId,
        name: staff.name,
        role: staff.role,
        departmentId: engineering?.id ?? null,
        provider: staff.provider,
        model: staff.model,
        systemPrompt: staff.systemPrompt,
      })
      .returning({ id: agents.id });
    staffIds[staff.name] = r[0]!.id;
  }
  const leadEngineerId = staffIds['Lead Engineer']!;
  const seniorEngineerId = staffIds['Senior Engineer']!;
  const reviewEngineerId = staffIds['Review Engineer']!;
  const principalReviewerId = staffIds['Principal Reviewer']!;

  const spend = await tx
    .insert(spendLimits)
    .values({ orgId: actor.orgId, projectId, monthlyLimitMicros: DEFAULT_WORKSPACE_BUDGET_MICROS })
    .returning({ id: spendLimits.id });
  const spendLimitId = spend[0]!.id;

  const charter = await tx
    .insert(knowledgeItems)
    .values({
      orgId: actor.orgId,
      projectId,
      scope: 'project',
      kind: 'fact',
      title: 'Workspace charter',
      body: `${name}: ${description || 'No description yet.'} This charter is company knowledge, consulted by every employee before work in this workspace only.`,
      status: 'active',
      source: 'manual',
      createdBy: actor.userId,
      approvedBy: actor.userId,
      approvedAt: new Date(),
    })
    .returning({ id: knowledgeItems.id });
  const charterKnowledgeId = charter[0]!.id;

  await writeAudit(tx, ctx, {
    action: 'workspace.created',
    entityType: 'project',
    entityId: projectId,
    detail: {
      workspaceId: projectId,
      name,
      key,
      orgId: actor.orgId,
      actorId: actor.userId,
      defaultStaffCount: DEFAULT_STAFF.length,
      defaultStaffIds: { leadEngineerId, seniorEngineerId, reviewEngineerId, principalReviewerId },
      charterKnowledgeId,
      spendLimitId,
      spendLimitMicros: String(DEFAULT_WORKSPACE_BUDGET_MICROS),
      reason,
    },
  });

  return { projectId, projectKey: key, leadEngineerId, seniorEngineerId, reviewEngineerId, principalReviewerId, charterKnowledgeId, spendLimitId };
}
