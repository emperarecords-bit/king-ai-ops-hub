import 'server-only';
import { and, eq } from 'drizzle-orm';
import { type TenantContext } from '@/types/domain';
import { AppError, ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { memberships, organizations } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';

/**
 * Organization-level administration. Slice 1: a single audited operation — renaming the organization's
 * DISPLAY NAME. Nothing else about an organization is mutable today (it is only ever created at bootstrap),
 * so this file is deliberately small.
 *
 * Design invariants (mirroring the workspace-key immutability rationale in projects/settings.ts):
 *  - The organization ID never changes — it is the tenancy anchor for every project, membership, audit row,
 *    provider request, and integration. Only the human-facing DISPLAY NAME changes.
 *  - The technical SLUG never changes here. It was generated once at bootstrap and may appear in stored
 *    references; regenerating it on a display-name change would be a silent, unaudited identity shift.
 *    (No route uses the org slug today, but we still refuse to touch it.)
 */

/** No DB length constraint exists on `organizations.name` (it is unbounded `text`). We enforce an
 *  application limit for parity with other name fields (workspace 100, employee 120) and as a typo guard. */
export const MAX_ORG_NAME_CHARS = 120;

export interface RenameOrganizationInput {
  newName: string;
  reason: string;
}

export interface RenameOrganizationResult {
  orgId: string;
  from: string;
  to: string;
  slug: string;
}

/**
 * Rename the organization's display name. Organization-OWNER only. The organization ID is taken from the
 * trusted tenant context — a client-supplied org id is never accepted. The row update and the
 * `organization.renamed` audit event commit or roll back together in the caller's transaction.
 *
 * Reversal is the SAME operation with the prior name and a new reason — never a raw rollback.
 */
export async function renameOrganization(
  tx: DbTx,
  // Organization-level context only: a rename is project-agnostic, so no projectId is required or used.
  // Its audit event is written with project_id = NULL (organization scope).
  ctx: Pick<TenantContext, 'orgId' | 'userId'>,
  input: RenameOrganizationInput,
): Promise<RenameOrganizationResult> {
  // ---- Authorization: organization OWNER only (verified against memberships, not just ctx) ----
  const membership = (
    await tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.orgId, ctx.orgId), eq(memberships.userId, ctx.userId)))
      .limit(1)
  )[0];
  if (!membership) throw new AppError('forbidden', 'You are not a member of this organization.');
  if (membership.role !== 'owner') {
    throw new AppError('forbidden', 'Only an organization owner can rename the organization.');
  }

  // ---- Validation (all before any write) ----
  const newName = input.newName.trim();
  if (newName.length === 0) throw new ValidationError(['Organization name is required.']);
  if (newName.length > MAX_ORG_NAME_CHARS) {
    throw new ValidationError([`Organization name is too long (max ${MAX_ORG_NAME_CHARS} characters).`]);
  }
  const reason = (input.reason ?? '').trim();
  if (!reason) throw new ValidationError(['A reason is required to rename the organization.']);

  const org = (
    await tx
      .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.id, ctx.orgId))
      .limit(1)
  )[0];
  if (!org) throw new NotFoundError('Organization');
  if (org.name === newName) {
    throw new ConflictError('The organization already has that name.');
  }

  // ---- Update DISPLAY NAME only; id and slug are left untouched ----
  await tx
    .update(organizations)
    .set({ name: newName, updatedAt: new Date() })
    .where(eq(organizations.id, ctx.orgId));

  await writeAudit(tx, { orgId: ctx.orgId, userId: ctx.userId, projectId: null }, {
    action: 'organization.renamed',
    entityType: 'organization',
    entityId: ctx.orgId,
    detail: {
      orgId: ctx.orgId,
      actorId: ctx.userId,
      from: org.name,
      to: newName,
      reason,
      slug: org.slug, // unchanged — recorded to make the no-slug-change explicit in the trail
    },
  });

  return { orgId: ctx.orgId, from: org.name, to: newName, slug: org.slug };
}
