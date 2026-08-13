import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type TenantContext } from '@/types/domain';
import { ForbiddenError, ValidationError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { githubRepoLinks } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';

/**
 * GitHub repo-link lifecycle (Phase 6): the per-project binding of a GitHub App installation to one repository.
 * Admin-only, tenant-scoped under `withTenant` (RLS confines every row to the caller's project). The row holds
 * NO secret — App credentials are owner-gated platform secrets that never enter the database
 * (docs/architecture/github-integration-decision.md).
 */

const linkSchema = z.object({
  installationId: z.bigint().positive('installation id must be a positive GitHub App installation id'),
  repoFullName: z
    .string()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/, 'repository must be canonical owner/repo'),
  defaultBranch: z.string().trim().min(1).max(200),
});

export type LinkRepoInput = z.input<typeof linkSchema>;

export interface RepoLinkSummary {
  readonly id: string;
  readonly installationId: bigint;
  readonly repoFullName: string;
  readonly defaultBranch: string;
  readonly linkedBy: string;
  readonly createdAt: Date;
}

function requireProjectAdmin(ctx: TenantContext): void {
  if (ctx.projectRole !== 'admin') {
    throw new ForbiddenError('linking or unlinking a GitHub repository requires the project admin role');
  }
}

/** Bind one repository (via its App installation) to the caller's project. */
export async function linkRepo(tx: DbTx, ctx: TenantContext, input: LinkRepoInput): Promise<string> {
  requireProjectAdmin(ctx);
  const parsed = linkSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message));
  const { installationId, repoFullName, defaultBranch } = parsed.data;

  const inserted = await tx
    .insert(githubRepoLinks)
    .values({ orgId: ctx.orgId, projectId: ctx.projectId, installationId, repoFullName, defaultBranch, linkedBy: ctx.userId })
    .returning({ id: githubRepoLinks.id });
  const id = inserted[0]!.id;
  await writeAudit(tx, ctx, {
    action: 'github.repo_linked',
    entityType: 'github_repo_link',
    entityId: id,
    detail: { repoFullName, defaultBranch, installationId: installationId.toString() },
  });
  return id;
}

/** Remove a repo link. Idempotent: false when it was already gone. */
export async function unlinkRepo(tx: DbTx, ctx: TenantContext, linkId: string): Promise<boolean> {
  requireProjectAdmin(ctx);
  const deleted = await tx
    .delete(githubRepoLinks)
    .where(eq(githubRepoLinks.id, linkId))
    .returning({ id: githubRepoLinks.id, repoFullName: githubRepoLinks.repoFullName });
  if (deleted.length === 0) return false;
  await writeAudit(tx, ctx, {
    action: 'github.repo_unlinked',
    entityType: 'github_repo_link',
    entityId: linkId,
    detail: { repoFullName: deleted[0]!.repoFullName },
  });
  return true;
}

export async function listRepoLinks(tx: DbTx, ctx: TenantContext): Promise<RepoLinkSummary[]> {
  return tx
    .select({
      id: githubRepoLinks.id,
      installationId: githubRepoLinks.installationId,
      repoFullName: githubRepoLinks.repoFullName,
      defaultBranch: githubRepoLinks.defaultBranch,
      linkedBy: githubRepoLinks.linkedBy,
      createdAt: githubRepoLinks.createdAt,
    })
    .from(githubRepoLinks)
    .where(eq(githubRepoLinks.projectId, ctx.projectId))
    .orderBy(desc(githubRepoLinks.createdAt));
}
