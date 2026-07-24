import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { AppError, ConflictError } from '@/lib/errors';
import { getDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import {
  auditLogs,
  memberships,
  organizations,
  profiles,
  projectMembers,
  projects,
  spendLimits,
} from '@/db/schema';
import {
  getWorkspaceSettings,
  setWorkspaceArchived,
  updateWorkspaceSettings,
} from '@/domain/projects/settings';

/**
 * Workspace ownership lifecycle (O-12). The properties that must hold:
 *  - only admins may change settings;
 *  - the key is immutable no matter what is submitted;
 *  - archiving preserves the row and its history — it is never a delete;
 *  - budget changes are permitted AND audited, since a budget raised just
 *    before an overspend is a question someone will ask later.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(
    `[workspace-settings.test] SKIPPING — database not reachable: ${err instanceof Error ? err.message : err}`,
  );
}

const adminId = randomUUID();
const memberId = randomUUID();
let adminCtx: TenantContext;
let memberCtx: TenantContext;
let orgId = '';
let projectId = '';
let projectKey = '';

beforeAll(async () => {
  if (!available) return;
  const db = getDb();
  await db.insert(profiles).values([
    { id: adminId, email: `wss-a-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Admin' },
    { id: memberId, email: `wss-m-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Member' },
  ]);
  const org = await db
    .insert(organizations)
    .values({ name: 'Settings Org', slug: `wss-${randomUUID().slice(0, 8)}` })
    .returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values([
    { orgId, userId: adminId, role: 'owner' },
    { orgId, userId: memberId, role: 'member' },
  ]);
  projectKey = fixtureKey('wss');
  const project = await db
    .insert(projects)
    .values({ orgId, key: projectKey, name: 'Original Name', description: 'Original description.' })
    .returning({ id: projects.id });
  projectId = project[0]!.id;
  await db
    .insert(spendLimits)
    .values({ orgId, projectId, monthlyLimitMicros: 25_000_000n });
  await db.insert(projectMembers).values([
    { orgId, projectId, userId: adminId, role: 'admin' },
    { orgId, projectId, userId: memberId, role: 'member' },
  ]);
  adminCtx = { userId: adminId, orgId, projectId, orgRole: 'owner', projectRole: 'admin' };
  memberCtx = { userId: memberId, orgId, projectId, orgRole: 'member', projectRole: 'member' };
});

afterAll(async () => {
  if (!available) return;
  await getDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});

describe.skipIf(!available)('workspace settings', () => {
  it('non-admins cannot change settings', async () => {
    await expect(
      withTenant(memberCtx, (tx) =>
        updateWorkspaceSettings(tx, memberCtx, {
          name: 'Hijacked',
          description: '',
          monthlyBudgetUsd: 9_999,
        }),
      ),
    ).rejects.toBeInstanceOf(AppError);

    const after = await withTenant(adminCtx, (tx) => getWorkspaceSettings(tx, adminCtx));
    expect(after.name).toBe('Original Name');
  });

  it('an admin can rename, re-describe, and re-budget', async () => {
    await withTenant(adminCtx, (tx) =>
      updateWorkspaceSettings(tx, adminCtx, {
        name: 'Renamed Workspace',
        description: 'A new description.',
        monthlyBudgetUsd: 60,
      }),
    );
    const after = await withTenant(adminCtx, (tx) => getWorkspaceSettings(tx, adminCtx));
    expect(after.name).toBe('Renamed Workspace');
    expect(after.description).toBe('A new description.');
    expect(after.monthlyBudgetMicros).toBe(60_000_000n);
  });

  it('the key never changes, whatever is submitted', async () => {
    await withTenant(adminCtx, (tx) =>
      updateWorkspaceSettings(tx, adminCtx, {
        // A `key` is not part of the input schema at all; this asserts the
        // property survives an extra field rather than being merged in.
        name: 'Renamed Again',
        description: '',
        monthlyBudgetUsd: 60,
        ...({ key: 'attacker-chosen-key' } as Record<string, unknown>),
      }),
    );
    const row = await getDb()
      .select({ key: projects.key })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    expect(row[0]!.key).toBe(projectKey);
  });

  it('records the budget change with both values', async () => {
    const entries = await getDb()
      .select({ action: auditLogs.action, detail: auditLogs.detail })
      .from(auditLogs)
      .where(
        and(eq(auditLogs.projectId, projectId), eq(auditLogs.action, 'workspace.settings_updated')),
      );
    expect(entries.length).toBeGreaterThan(0);
    const detail = entries[0]!.detail as { budgetMicros?: { from: string; to: string } };
    expect(detail.budgetMicros?.from).toBe('25000000');
    expect(detail.budgetMicros?.to).toBe('60000000');
  });

  it('rejects budgets outside the guard rails', async () => {
    for (const usd of [0, -5, 50_000]) {
      await expect(
        withTenant(adminCtx, (tx) =>
          updateWorkspaceSettings(tx, adminCtx, {
            name: 'Renamed Workspace',
            description: '',
            monthlyBudgetUsd: usd,
          }),
        ),
        `budget ${usd}`,
      ).rejects.toBeTruthy();
    }
  });

  it('archiving preserves the row and its history, and is reversible', async () => {
    await withTenant(adminCtx, (tx) => setWorkspaceArchived(tx, adminCtx, true));

    const row = await getDb()
      .select({ archived: projects.archived, name: projects.name })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    expect(row).toHaveLength(1); // still there — archive is not delete
    expect(row[0]!.archived).toBe(true);

    const audits = await getDb()
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(and(eq(auditLogs.projectId, projectId), eq(auditLogs.action, 'workspace.archived')));
    expect(audits.length).toBe(1);

    // Settings are frozen while archived: restore first, then edit.
    await expect(
      withTenant(adminCtx, (tx) =>
        updateWorkspaceSettings(tx, adminCtx, {
          name: 'Nope',
          description: '',
          monthlyBudgetUsd: 30,
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    await withTenant(adminCtx, (tx) => setWorkspaceArchived(tx, adminCtx, false));
    const restored = await withTenant(adminCtx, (tx) => getWorkspaceSettings(tx, adminCtx));
    expect(restored.archived).toBe(false);
  });

  it('refuses a no-op archive transition', async () => {
    await expect(
      withTenant(adminCtx, (tx) => setWorkspaceArchived(tx, adminCtx, false)),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
