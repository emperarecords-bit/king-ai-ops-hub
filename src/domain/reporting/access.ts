import { type TenantContext } from '@/types/domain';
import { AppError } from '@/lib/errors';

/**
 * M0a detailed-report access gate (M0a §6). Project-admin ONLY. This is deliberately STRICTER than
 * `assertCanViewAudit` (which also permits `member`): cost, employee attribution, highest-cost runs, and
 * pricing coverage are admin-grade, so a plain member or viewer is denied.
 *
 * There is NO org-owner elevation here: an organization owner reaches this only when the existing tenant
 * resolver (`requireTenant`) already granted them a project access row whose `projectRole` is `admin`. An
 * owner without project membership never obtains a TenantContext for the project, so they are denied upstream
 * — this guard adds no implicit membership and never bypasses RLS.
 */
export function assertProjectReportAccess(ctx: TenantContext): void {
  if (ctx.projectRole !== 'admin') {
    throw new AppError('forbidden', 'Only project admins can view usage reporting.');
  }
}

/** Non-throwing predicate form, for UI branches that must not surface admin-only reporting affordances. */
export function canViewProjectReport(ctx: TenantContext): boolean {
  return ctx.projectRole === 'admin';
}
