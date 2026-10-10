import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError, ValidationError } from '@/lib/errors';

/**
 * Supabase project-link lifecycle (Phase 2C). Admin-only, Zod-validated, audited. The row holds NO secret.
 * Fully mocked — no DB, no network.
 */

const h = vi.hoisted(() => ({ writeAudit: vi.fn(), insertedValues: vi.fn(), deletedWhere: vi.fn() }));
vi.mock('@/domain/audit/audit', () => ({ writeAudit: h.writeAudit }));
vi.mock('@/db/schema', () => ({ supabaseProjectLinks: { id: 'id', projectRef: 'project_ref', label: 'label', linkedBy: 'linked_by', createdAt: 'created_at', projectId: 'project_id' } }));

import { linkSupabaseProject, unlinkSupabaseProject } from '@/domain/supabase/links';

const ADMIN = { userId: 'u1', orgId: 'o1', projectId: 'p1', orgRole: 'owner' as const, projectRole: 'admin' as const };
const MEMBER = { ...ADMIN, projectRole: 'member' as const };

const fakeTx = {
  insert: () => ({ values: (v: unknown) => { h.insertedValues(v); return { returning: async () => [{ id: 'link-1' }] }; } }),
  delete: () => ({ where: (w: unknown) => { h.deletedWhere(w); return { returning: async () => [{ id: 'link-1', projectRef: 'bblnywrcdsfdasytkzps' }] }; } }),
};

beforeEach(() => vi.clearAllMocks());

describe('linkSupabaseProject', () => {
  it('admin + valid ref → inserts the link (no secret) and audits supabase.project_linked', async () => {
    const id = await linkSupabaseProject(fakeTx as never, ADMIN, { projectRef: 'bblnywrcdsfdasytkzps', label: 'AccurateBids' });
    expect(id).toBe('link-1');
    const row = h.insertedValues.mock.calls[0]![0] as Record<string, unknown>;
    expect(row).toMatchObject({ orgId: 'o1', projectId: 'p1', projectRef: 'bblnywrcdsfdasytkzps', label: 'AccurateBids', linkedBy: 'u1' });
    // The row carries NO management token / secret.
    expect(JSON.stringify(row)).not.toMatch(/token|secret|sbp_/i);
    expect(h.writeAudit).toHaveBeenCalledWith(fakeTx, ADMIN, expect.objectContaining({ action: 'supabase.project_linked', entityType: 'supabase_project_link' }));
  });

  it('a non-admin is refused and nothing is inserted or audited', async () => {
    await expect(linkSupabaseProject(fakeTx as never, MEMBER, { projectRef: 'bblnywrcdsfdasytkzps' })).rejects.toBeInstanceOf(ForbiddenError);
    expect(h.insertedValues).not.toHaveBeenCalled();
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('a malformed project ref is a ValidationError, not a best-effort insert', async () => {
    for (const bad of ['Not-A-Ref', 'short', 'UPPERCASE1234567890', 'has space here']) {
      await expect(linkSupabaseProject(fakeTx as never, ADMIN, { projectRef: bad })).rejects.toBeInstanceOf(ValidationError);
    }
    expect(h.insertedValues).not.toHaveBeenCalled();
  });
});

describe('unlinkSupabaseProject', () => {
  it('admin → deletes + audits supabase.project_unlinked', async () => {
    const ok = await unlinkSupabaseProject(fakeTx as never, ADMIN, 'link-1');
    expect(ok).toBe(true);
    expect(h.writeAudit).toHaveBeenCalledWith(fakeTx, ADMIN, expect.objectContaining({ action: 'supabase.project_unlinked' }));
  });

  it('a non-admin cannot unlink', async () => {
    await expect(unlinkSupabaseProject(fakeTx as never, MEMBER, 'link-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('idempotent: returns false and does not audit when the link was already gone', async () => {
    const emptyTx = { delete: () => ({ where: () => ({ returning: async () => [] }) }) };
    const ok = await unlinkSupabaseProject(emptyTx as never, ADMIN, 'missing');
    expect(ok).toBe(false);
    expect(h.writeAudit).not.toHaveBeenCalled();
  });
});
