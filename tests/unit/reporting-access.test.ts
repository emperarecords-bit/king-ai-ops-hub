import { describe, expect, it } from 'vitest';
import { type TenantContext } from '@/types/domain';
import { AppError } from '@/lib/errors';
import { assertProjectReportAccess, canViewProjectReport } from '@/domain/reporting/access';

function ctx(over: Partial<TenantContext>): TenantContext {
  return {
    userId: '00000000-0000-0000-0000-000000000001',
    orgId: '00000000-0000-0000-0000-000000000002',
    projectId: '00000000-0000-0000-0000-000000000003',
    orgRole: 'member',
    projectRole: 'admin',
    ...over,
  };
}

describe('M0a report access gate (project-admin only)', () => {
  it('project admin is allowed', () => {
    expect(() => assertProjectReportAccess(ctx({ projectRole: 'admin' }))).not.toThrow();
    expect(canViewProjectReport(ctx({ projectRole: 'admin' }))).toBe(true);
  });

  it('ordinary member is denied', () => {
    expect(() => assertProjectReportAccess(ctx({ projectRole: 'member' }))).toThrow(AppError);
    expect(canViewProjectReport(ctx({ projectRole: 'member' }))).toBe(false);
  });

  it('viewer is denied', () => {
    expect(() => assertProjectReportAccess(ctx({ projectRole: 'viewer' }))).toThrow(AppError);
  });

  it('org OWNER with a non-admin project role is still denied (no org-owner elevation)', () => {
    expect(() => assertProjectReportAccess(ctx({ orgRole: 'owner', projectRole: 'member' }))).toThrow(AppError);
    expect(() => assertProjectReportAccess(ctx({ orgRole: 'owner', projectRole: 'viewer' }))).toThrow(AppError);
    expect(canViewProjectReport(ctx({ orgRole: 'owner', projectRole: 'viewer' }))).toBe(false);
  });

  it('org owner who is also a project admin is allowed (only via the admin project role)', () => {
    expect(() => assertProjectReportAccess(ctx({ orgRole: 'owner', projectRole: 'admin' }))).not.toThrow();
  });
});
