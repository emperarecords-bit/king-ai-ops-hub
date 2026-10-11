import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 2C approved-SQL validation surface (Option B — validation/dry-run only). Offline + side-effect-free:
 * it resolves the target project against the workspace's links, runs the AST policy, validates the bound-param
 * list + max-rows ceiling, and ALWAYS reports liveExecutionAvailable:false with risk destructive_irreversible.
 * No Supabase network. Fully mocked.
 */

const h = vi.hoisted(() => ({ listSupabaseProjectLinks: vi.fn() }));
vi.mock('@/domain/supabase/links', () => ({ listSupabaseProjectLinks: h.listSupabaseProjectLinks }));

import {
  validateWorkspaceApprovedSql,
  SupabaseProjectNotLinkedError,
  APPROVED_SQL_MAX_ROWS_CEILING,
} from '@/domain/supabase/approved-sql';

const CTX = { userId: 'u1', orgId: 'o1', projectId: 'p1', orgRole: 'owner' as const, projectRole: 'admin' as const };
const REF = 'bblnywrcdsfdasytkzps';
const tx = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  h.listSupabaseProjectLinks.mockResolvedValue([{ projectRef: REF, label: 'AccurateBids' }]);
});

describe('validateWorkspaceApprovedSql', () => {
  it('accepts a valid single DML with matching params + maxRows, and reports live execution as unavailable', async () => {
    const r = await validateWorkspaceApprovedSql(tx, CTX, {
      projectRef: REF,
      sql: 'update public.quotes set status = $1 where id = $2',
      params: ['approved', 42],
      maxRows: 1,
    });
    expect(r.accepted).toBe(true);
    expect(r.violations).toEqual([]);
    expect(r.policy.operation).toBe('update');
    expect(r.riskClass).toBe('destructive_irreversible');
    expect(r.liveExecutionAvailable).toBe(false);
    expect(r.liveExecutionUnavailableReason).toMatch(/not provably reversible/i);
    expect(r.rollbackEvidence).toMatch(/no generic rollback/i);
  });

  it('throws when the target project is not linked to the workspace', async () => {
    h.listSupabaseProjectLinks.mockResolvedValue([]);
    await expect(
      validateWorkspaceApprovedSql(tx, CTX, { projectRef: REF, sql: 'delete from app.s where id = $1', params: [1], maxRows: 1 }),
    ).rejects.toBeInstanceOf(SupabaseProjectNotLinkedError);
  });

  it('rejects a parameter-count mismatch', async () => {
    const r = await validateWorkspaceApprovedSql(tx, CTX, { projectRef: REF, sql: 'update public.t set a = $1 where id = $2', params: ['only-one'], maxRows: 1 });
    expect(r.accepted).toBe(false);
    expect(r.violations.join(' ')).toMatch(/parameter count mismatch/i);
  });

  it('requires maxRows and rejects an out-of-range ceiling', async () => {
    const missing = await validateWorkspaceApprovedSql(tx, CTX, { projectRef: REF, sql: 'delete from app.s where id = $1', params: [1] });
    expect(missing.accepted).toBe(false);
    expect(missing.violations.join(' ')).toMatch(/maxRows is required/i);
    const tooBig = await validateWorkspaceApprovedSql(tx, CTX, { projectRef: REF, sql: 'delete from app.s where id = $1', params: [1], maxRows: APPROVED_SQL_MAX_ROWS_CEILING + 1 });
    expect(tooBig.accepted).toBe(false);
    expect(tooBig.violations.join(' ')).toMatch(/maxRows must be an integer/i);
  });

  it('propagates a policy rejection (DDL) as not accepted', async () => {
    const r = await validateWorkspaceApprovedSql(tx, CTX, { projectRef: REF, sql: 'drop table public.t', maxRows: 1 });
    expect(r.accepted).toBe(false);
    expect(r.policy.ok).toBe(false);
  });

  it('rejects a non-scalar parameter', async () => {
    const r = await validateWorkspaceApprovedSql(tx, CTX, { projectRef: REF, sql: 'update public.t set a = $1 where id = $2', params: [{ nested: true } as never, 1], maxRows: 1 });
    expect(r.accepted).toBe(false);
    expect(r.violations.join(' ')).toMatch(/scalar/i);
  });
});
