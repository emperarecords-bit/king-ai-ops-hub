import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type TenantContext } from '@/types/domain';
import { ForbiddenError, ValidationError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { vercelProjectLinks } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';

/**
 * Vercel project-link lifecycle (Phase 2D): the per-project binding of a Hub workspace to one external Vercel
 * project (by its opaque id, optionally team-scoped). Admin-only, tenant-scoped under `withTenant` (RLS confines
 * every row to the caller's project). The row holds NO secret — the Vercel API token is an owner-gated platform
 * secret that never enters the database (same design as github_repo_links / supabase_project_links).
 */

const linkSchema = z.object({
  /** Vercel project id — e.g. "prj_xxxx…". Opaque identifier, not a secret. */
  vercelProjectId: z
    .string()
    .trim()
    .regex(/^prj_[A-Za-z0-9]{8,64}$/, 'vercelProjectId must be a Vercel project id (prj_…)'),
  /** Optional Vercel team id scoping the project. */
  vercelTeamId: z
    .string()
    .trim()
    .regex(/^team_[A-Za-z0-9]{8,64}$/, 'vercelTeamId must be a Vercel team id (team_…)')
    .optional(),
  label: z.string().trim().min(1).max(120).optional(),
});

export type LinkVercelProjectInput = z.input<typeof linkSchema>;

export interface VercelProjectLinkSummary {
  readonly id: string;
  readonly vercelProjectId: string;
  readonly vercelTeamId: string | null;
  readonly label: string | null;
  readonly linkedBy: string;
  readonly createdAt: Date;
}

function requireProjectAdmin(ctx: TenantContext): void {
  if (ctx.projectRole !== 'admin') {
    throw new ForbiddenError('linking or unlinking a Vercel project requires the project admin role');
  }
}

/** Bind one Vercel project (by id) to the caller's project. */
export async function linkVercelProject(tx: DbTx, ctx: TenantContext, input: LinkVercelProjectInput): Promise<string> {
  requireProjectAdmin(ctx);
  const parsed = linkSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message));
  const { vercelProjectId, vercelTeamId, label } = parsed.data;

  const inserted = await tx
    .insert(vercelProjectLinks)
    .values({ orgId: ctx.orgId, projectId: ctx.projectId, vercelProjectId, vercelTeamId: vercelTeamId ?? null, label: label ?? null, linkedBy: ctx.userId })
    .returning({ id: vercelProjectLinks.id });
  const id = inserted[0]!.id;
  await writeAudit(tx, ctx, {
    action: 'vercel.project_linked',
    entityType: 'vercel_project_link',
    entityId: id,
    detail: { vercelProjectId, vercelTeamId: vercelTeamId ?? null, label: label ?? null },
  });
  return id;
}

/** Remove a Vercel project link. Idempotent: false when it was already gone. */
export async function unlinkVercelProject(tx: DbTx, ctx: TenantContext, linkId: string): Promise<boolean> {
  requireProjectAdmin(ctx);
  const deleted = await tx
    .delete(vercelProjectLinks)
    .where(eq(vercelProjectLinks.id, linkId))
    .returning({ id: vercelProjectLinks.id, vercelProjectId: vercelProjectLinks.vercelProjectId });
  if (deleted.length === 0) return false;
  await writeAudit(tx, ctx, {
    action: 'vercel.project_unlinked',
    entityType: 'vercel_project_link',
    entityId: linkId,
    detail: { vercelProjectId: deleted[0]!.vercelProjectId },
  });
  return true;
}

export async function listVercelProjectLinks(tx: DbTx, ctx: TenantContext): Promise<VercelProjectLinkSummary[]> {
  return tx
    .select({
      id: vercelProjectLinks.id,
      vercelProjectId: vercelProjectLinks.vercelProjectId,
      vercelTeamId: vercelProjectLinks.vercelTeamId,
      label: vercelProjectLinks.label,
      linkedBy: vercelProjectLinks.linkedBy,
      createdAt: vercelProjectLinks.createdAt,
    })
    .from(vercelProjectLinks)
    .where(eq(vercelProjectLinks.projectId, ctx.projectId))
    .orderBy(desc(vercelProjectLinks.createdAt));
}
