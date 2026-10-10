import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type TenantContext } from '@/types/domain';
import { ForbiddenError, ValidationError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { supabaseProjectLinks } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';

/**
 * Supabase project-link lifecycle (Phase 2C): the per-project binding of a Hub workspace to one external
 * Supabase project (by its opaque `ref`). Admin-only, tenant-scoped under `withTenant` (RLS confines every row
 * to the caller's project). The row holds NO secret — the Supabase Management API token is an owner-gated
 * platform secret that never enters the database (same design as github_repo_links).
 */

const linkSchema = z.object({
  /** Supabase project ref — lowercase alphanumeric, ~20 chars (e.g. "bblnywrcdsfdasytkzps"). */
  projectRef: z
    .string()
    .trim()
    .regex(/^[a-z0-9]{16,40}$/, 'project ref must be a Supabase project ref (lowercase alphanumeric)'),
  label: z.string().trim().min(1).max(120).optional(),
});

export type LinkProjectInput = z.input<typeof linkSchema>;

export interface ProjectLinkSummary {
  readonly id: string;
  readonly projectRef: string;
  readonly label: string | null;
  readonly linkedBy: string;
  readonly createdAt: Date;
}

function requireProjectAdmin(ctx: TenantContext): void {
  if (ctx.projectRole !== 'admin') {
    throw new ForbiddenError('linking or unlinking a Supabase project requires the project admin role');
  }
}

/** Bind one Supabase project (by ref) to the caller's project. */
export async function linkSupabaseProject(tx: DbTx, ctx: TenantContext, input: LinkProjectInput): Promise<string> {
  requireProjectAdmin(ctx);
  const parsed = linkSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message));
  const { projectRef, label } = parsed.data;

  const inserted = await tx
    .insert(supabaseProjectLinks)
    .values({ orgId: ctx.orgId, projectId: ctx.projectId, projectRef, label: label ?? null, linkedBy: ctx.userId })
    .returning({ id: supabaseProjectLinks.id });
  const id = inserted[0]!.id;
  await writeAudit(tx, ctx, {
    action: 'supabase.project_linked',
    entityType: 'supabase_project_link',
    entityId: id,
    detail: { projectRef, label: label ?? null },
  });
  return id;
}

/** Remove a Supabase project link. Idempotent: false when it was already gone. */
export async function unlinkSupabaseProject(tx: DbTx, ctx: TenantContext, linkId: string): Promise<boolean> {
  requireProjectAdmin(ctx);
  const deleted = await tx
    .delete(supabaseProjectLinks)
    .where(eq(supabaseProjectLinks.id, linkId))
    .returning({ id: supabaseProjectLinks.id, projectRef: supabaseProjectLinks.projectRef });
  if (deleted.length === 0) return false;
  await writeAudit(tx, ctx, {
    action: 'supabase.project_unlinked',
    entityType: 'supabase_project_link',
    entityId: linkId,
    detail: { projectRef: deleted[0]!.projectRef },
  });
  return true;
}

export async function listSupabaseProjectLinks(tx: DbTx, ctx: TenantContext): Promise<ProjectLinkSummary[]> {
  return tx
    .select({
      id: supabaseProjectLinks.id,
      projectRef: supabaseProjectLinks.projectRef,
      label: supabaseProjectLinks.label,
      linkedBy: supabaseProjectLinks.linkedBy,
      createdAt: supabaseProjectLinks.createdAt,
    })
    .from(supabaseProjectLinks)
    .where(eq(supabaseProjectLinks.projectId, ctx.projectId))
    .orderBy(desc(supabaseProjectLinks.createdAt));
}
