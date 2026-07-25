import { log } from '@/lib/log';

/**
 * RLS / tenant-context observability (O-22). Small, allocation-light helpers so
 * the security-relevant failure modes are visible in structured logs WITHOUT
 * ever logging row data, prompts, or credentials — only identifiers and codes.
 *
 * Nothing here changes behavior; callers still fail closed. These functions
 * exist so a missing/invalid tenant context or a database-level RLS refusal is
 * greppable in production, not silent.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Validate the identifiers about to be stamped as tenant GUCs. Returns the list
 * of offending fields (empty when all valid). The caller decides whether a
 * given field is required for its boundary (withUser needs only userId).
 */
export function invalidTenantFields(ctx: {
  userId?: string;
  orgId?: string;
  projectId?: string;
}): string[] {
  const bad: string[] = [];
  if (ctx.userId !== undefined && !isUuid(ctx.userId)) bad.push('userId');
  if (ctx.orgId !== undefined && !isUuid(ctx.orgId)) bad.push('orgId');
  if (ctx.projectId !== undefined && !isUuid(ctx.projectId)) bad.push('projectId');
  return bad;
}

/** Postgres surfaces an RLS WITH CHECK / privilege refusal as SQLSTATE 42501. */
export function isRlsViolation(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (code === '42501') return true;
  const msg = err instanceof Error ? err.message : '';
  return /row-level security|permission denied/i.test(msg);
}

/** Log a database-level security refusal (RLS WITH CHECK, privilege denied)
 *  with identifiers only — never the row or the SQL text. */
export function logRlsRejection(
  boundary: 'withTenant' | 'withOrg' | 'withUser',
  ctx: { userId?: string; orgId?: string; projectId?: string },
  err: unknown,
): void {
  log.warn('rls.rejected', {
    boundary,
    code: (err as { code?: string })?.code ?? 'unknown',
    userId: ctx.userId,
    orgId: ctx.orgId,
    projectId: ctx.projectId,
  });
}

/** The tenant context required for a boundary was missing/malformed — fail
 *  closed. `which` names the boundary and `fields` the offending identifiers. */
export function logTenantContextInvalid(
  boundary: 'withTenant' | 'withOrg' | 'withUser',
  fields: string[],
): void {
  log.error('tenant.context_invalid', { boundary, fields });
}
