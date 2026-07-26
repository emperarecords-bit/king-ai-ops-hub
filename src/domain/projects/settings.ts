import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type TenantContext } from '@/types/domain';
import { AppError, ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { projects, spendLimits } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';

/**
 * Workspace settings — the ownership half of the workspace lifecycle (O-12).
 *
 * Creation existed from Sprint 5; nothing let an owner change their mind
 * afterwards. This module closes that: display name, description, monthly
 * budget, and archival.
 *
 * Two deliberate immutabilities:
 *
 *  - **The key never changes.** It appears in every URL, every audit row's
 *    context, and every bookmark. Renaming it would silently break links and
 *    make historical records point at a workspace that no longer answers to
 *    that name. The display name carries identity for humans; the key carries
 *    it for the system.
 *  - **Archive, never delete.** Runs, usage events, and audit rows reference
 *    the project, and the audit trail is append-only by design (I6). A
 *    deleted workspace would either orphan that history or destroy it; both
 *    are worse than a workspace that stops appearing in pickers.
 *
 * Budget changes are permitted and audited. The spend gate's value is that
 * spending is *deliberate*, not that it is unchangeable — a limit nobody can
 * adjust becomes a limit people route around.
 */

/** $1 minimum: a zero budget would refuse every run, which is what archiving is for. */
const MIN_BUDGET_MICROS = 1_000_000n;
/** $10,000/month. Not a policy ceiling — a typo guard. */
const MAX_BUDGET_MICROS = 10_000_000_000n;

export const workspaceSettingsSchema = z.object({
  name: z.string().trim().min(1, 'A workspace needs a name.').max(100),
  description: z.string().trim().max(1_000).default(''),
  monthlyBudgetUsd: z
    .number()
    .finite()
    .min(1, 'The monthly budget must be at least $1.')
    .max(10_000, 'The monthly budget cannot exceed $10,000.'),
});

export type WorkspaceSettingsInput = z.input<typeof workspaceSettingsSchema>;

export interface WorkspaceSettings {
  key: string;
  name: string;
  description: string;
  archived: boolean;
  ownerAgentId: string | null;
  monthlyBudgetMicros: bigint;
}

export async function getWorkspaceSettings(
  tx: DbTx,
  ctx: TenantContext,
): Promise<WorkspaceSettings> {
  const rows = await tx
    .select({
      key: projects.key,
      name: projects.name,
      description: projects.description,
      archived: projects.archived,
      ownerAgentId: projects.ownerAgentId,
    })
    .from(projects)
    .where(and(eq(projects.id, ctx.projectId), eq(projects.orgId, ctx.orgId)))
    .limit(1);
  const project = rows[0];
  if (!project) throw new NotFoundError('Workspace');

  const limitRows = await tx
    .select({ limit: spendLimits.monthlyLimitMicros })
    .from(spendLimits)
    .where(eq(spendLimits.projectId, ctx.projectId))
    .limit(1);

  return { ...project, monthlyBudgetMicros: limitRows[0]?.limit ?? 0n };
}

function assertAdmin(ctx: TenantContext): void {
  if (ctx.projectRole !== 'admin') {
    throw new AppError('forbidden', 'Only workspace admins can change these settings.');
  }
}

export async function updateWorkspaceSettings(
  tx: DbTx,
  ctx: TenantContext,
  input: WorkspaceSettingsInput,
): Promise<void> {
  assertAdmin(ctx);
  const parsed = workspaceSettingsSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message));
  }

  const before = await getWorkspaceSettings(tx, ctx);
  if (before.archived) {
    throw new ConflictError('Restore this workspace before changing its settings.');
  }

  const budgetMicros = BigInt(Math.round(parsed.data.monthlyBudgetUsd * 1_000_000));
  if (budgetMicros < MIN_BUDGET_MICROS || budgetMicros > MAX_BUDGET_MICROS) {
    throw new ValidationError(['That monthly budget is outside the allowed range.']);
  }

  await tx
    .update(projects)
    .set({
      name: parsed.data.name,
      description: parsed.data.description,
      updatedAt: new Date(),
    })
    .where(and(eq(projects.id, ctx.projectId), eq(projects.orgId, ctx.orgId)));

  // A workspace provisioned before spend_limits existed would have no row;
  // upsert so the budget is always settable rather than silently ignored.
  await tx
    .insert(spendLimits)
    .values({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      monthlyLimitMicros: budgetMicros,
    })
    .onConflictDoUpdate({
      target: spendLimits.projectId,
      set: { monthlyLimitMicros: budgetMicros, updatedAt: new Date() },
    });

  // Record before/after: a budget raised the day before an overspend is a
  // question someone will eventually ask.
  await writeAudit(tx, ctx, {
    action: 'workspace.settings_updated',
    entityType: 'project',
    entityId: ctx.projectId,
    detail: {
      name: { from: before.name, to: parsed.data.name },
      descriptionChanged: before.description !== parsed.data.description,
      budgetMicros: {
        from: before.monthlyBudgetMicros.toString(),
        to: budgetMicros.toString(),
      },
    },
  });
}

export async function setWorkspaceArchived(
  tx: DbTx,
  ctx: TenantContext,
  archived: boolean,
): Promise<void> {
  assertAdmin(ctx);
  const before = await getWorkspaceSettings(tx, ctx);
  if (before.archived === archived) {
    throw new ConflictError(
      archived ? 'This workspace is already archived.' : 'This workspace is not archived.',
    );
  }

  await tx
    .update(projects)
    .set({ archived, updatedAt: new Date() })
    .where(and(eq(projects.id, ctx.projectId), eq(projects.orgId, ctx.orgId)));

  await writeAudit(tx, ctx, {
    action: archived ? 'workspace.archived' : 'workspace.restored',
    entityType: 'project',
    entityId: ctx.projectId,
    detail: { name: before.name },
  });
}
