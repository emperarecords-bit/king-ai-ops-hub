/**
 * REAL integration test for VER-002 verification-REQUEST creation.
 *
 * Exercises the ACTUAL create path (createVerificationRequest + Drizzle store under withTenant + RLS)
 * and the real HTTP route against a live, DISPOSABLE Postgres — never production, never real creds.
 * Confirms: a contract is bound to the authenticated tenant/creator; the contract is immutable (the
 * app_server role has no UPDATE/DELETE, and a re-create with a different contract is a conflict);
 * unauthenticated creation is refused; and a task from another project cannot be bound.
 *
 * Prereqs (all local/isolated): DATABASE_URL (app_server), VER_INT_ORG_ID, VER_INT_PROJECT_ID,
 * VER_INT_TASK_ID, VER_INT_USER_ID (a seeded profile id). Optional HTTP case: VER_INT_BASE_URL,
 * VER_INT_PROJECT_KEY, VER_INT_COOKIE_VALID. Self-skips unless the env is set.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@/db/tenant';
import { verificationRequests } from '@/db/schema';
import { createVerificationRequest } from '@/domain/verification';
import { createDrizzleVerificationStore } from '@/domain/verification/drizzle-store';
import type { TenantContext } from '@/types/domain';

const ORG = process.env.VER_INT_ORG_ID ?? '';
const PROJECT = process.env.VER_INT_PROJECT_ID ?? '';
const TASK = process.env.VER_INT_TASK_ID ?? '';
const USER = process.env.VER_INT_USER_ID ?? '';
const enabled = Boolean(process.env.DATABASE_URL && ORG && PROJECT && TASK && USER);

const ctx = { userId: USER, orgId: ORG, projectId: PROJECT, orgRole: 'owner', projectRole: 'admin' } as unknown as TenantContext;
const createdRequestIds: string[] = [];

function assertDisposableDbTarget(): void {
  const url = new URL(process.env.DATABASE_URL ?? '');
  const host = url.hostname;
  const db = url.pathname.replace(/^\//, '');
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error(`refusing non-local DB host: ${host}`);
  if (!/_test$/.test(db)) throw new Error(`refusing DB that is not a *_test database: ${db}`);
  if (/prod|production|staging/i.test(`${host}/${db}`)) throw new Error(`refusing production/staging target: ${host}/${db}`);
}

beforeAll(async () => {
  if (!enabled) return;
  assertDisposableDbTarget();
  const rows = await withTenant(ctx, (tx) =>
    tx.execute(sql`select current_user as who, rolsuper, rolbypassrls from pg_roles where rolname = current_user`),
  );
  const row = (rows as unknown as Array<{ rolsuper: boolean; rolbypassrls: boolean }>)[0];
  expect(row?.rolsuper, 'runtime role must not be a superuser').toBe(false);
  expect(row?.rolbypassrls, 'runtime role must not have BYPASSRLS').toBe(false);
});

// Only privileged cleanup can remove immutable contracts; the disposable DB is dropped after the run,
// so we just record ids. (A delete here would fail — app_server has no DELETE on verification_requests,
// which is the point.)
afterAll(() => undefined);

const input = (over: Record<string, unknown> = {}) => ({
  taskId: TASK,
  repoFullName: 'acme/widget',
  commitSha: 'a'.repeat(40),
  requiredChecks: ['unit'],
  requiredArtifacts: ['test-results.json'],
  ...over,
});

describe.skipIf(!enabled)('VER-002 request creation — DB (createVerificationRequest under app_server + RLS)', () => {
  it('creates a contract bound to the tenant + creator; a direct UPDATE/DELETE is rejected (immutable)', async () => {
    const commit = 'c'.repeat(40);
    const out = await withTenant(ctx, (tx) => createVerificationRequest(createDrizzleVerificationStore(tx), ctx, input({ commitSha: commit })));
    expect(out.created).toBe(true);
    const id = out.request!.id;
    createdRequestIds.push(id);
    expect(out.request!.orgId).toBe(ORG);
    expect(out.request!.projectId).toBe(PROJECT);
    expect(out.request!.createdBy).toBe(USER);

    // Persisted + readable within the tenant.
    const rows = await withTenant(ctx, (tx) =>
      tx.select({ id: verificationRequests.id }).from(verificationRequests).where(eq(verificationRequests.id, id)),
    );
    expect(rows.length).toBe(1);

    // Immutability: the app_server role must not be able to UPDATE or DELETE the contract.
    await expect(
      withTenant(ctx, (tx) => tx.execute(sql`update verification_requests set repo_full_name = 'tampered' where id = ${id}`)),
    ).rejects.toThrow();
    await expect(
      withTenant(ctx, (tx) => tx.execute(sql`delete from verification_requests where id = ${id}`)),
    ).rejects.toThrow();
  });

  it('idempotent identical re-create returns the same contract; a divergent one conflicts', async () => {
    const commit = 'd'.repeat(40);
    const first = await withTenant(ctx, (tx) => createVerificationRequest(createDrizzleVerificationStore(tx), ctx, input({ commitSha: commit })));
    expect(first.created).toBe(true);
    createdRequestIds.push(first.request!.id);
    const same = await withTenant(ctx, (tx) => createVerificationRequest(createDrizzleVerificationStore(tx), ctx, input({ commitSha: commit })));
    expect(same.created).toBe(false);
    expect(same.request!.id).toBe(first.request!.id);
    const conflict = await withTenant(ctx, (tx) =>
      createVerificationRequest(createDrizzleVerificationStore(tx), ctx, input({ commitSha: commit, requiredChecks: ['unit', 'lint'] })),
    );
    expect(conflict.rejection?.code).toBe('contract_conflict');
  });

  it('a task id not in this project cannot be bound', async () => {
    const out = await withTenant(ctx, (tx) =>
      createVerificationRequest(createDrizzleVerificationStore(tx), ctx, input({ taskId: randomUUID(), commitSha: 'e'.repeat(40) })),
    );
    expect(out.rejection?.code).toBe('task_not_in_project');
  });
});

const routeEnabled = Boolean(enabled && process.env.VER_INT_BASE_URL && process.env.VER_INT_PROJECT_KEY);
const authEnabled = Boolean(routeEnabled && process.env.VER_INT_COOKIE_VALID);
const base = process.env.VER_INT_BASE_URL ?? '';
const key = process.env.VER_INT_PROJECT_KEY ?? '';
const url = `${base}/api/p/${key}/verification/requests`;
const post = (body: unknown, cookie?: string) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
    redirect: 'error',
  });

describe.skipIf(!routeEnabled)('VER-002 request creation — HTTP route', () => {
  it('rejects an unauthenticated create (401)', async () => {
    const res = await post(input({ commitSha: 'f'.repeat(40) }));
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!authEnabled)('VER-002 request creation — HTTP route (authenticated)', () => {
  const cookie = process.env.VER_INT_COOKIE_VALID ?? '';
  it('creates (201), is idempotent (200), and conflicts on a divergent contract (409)', async () => {
    const commit = Array.from({ length: 40 }, () => '9').join('');
    const created = await post(input({ commitSha: commit }), cookie);
    expect(created.status).toBe(201);
    const body = (await created.json()) as { created: boolean; request: { id: string; orgId: string; projectId: string } };
    expect(body.created).toBe(true);
    expect(body.request.orgId).toBe(ORG);
    expect(body.request.projectId).toBe(PROJECT);
    createdRequestIds.push(body.request.id);

    const again = await post(input({ commitSha: commit }), cookie);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { created: boolean }).created).toBe(false);

    const conflict = await post(input({ commitSha: commit, requiredChecks: ['unit', 'e2e'] }), cookie);
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { code: string }).code).toBe('contract_conflict');
  });

  it('rejects invalid input (400) and an unknown task (404)', async () => {
    const bad = await post(input({ commitSha: 'abc' }), cookie);
    expect(bad.status).toBe(400);
    const unknownTask = await post(input({ taskId: randomUUID(), commitSha: '1'.repeat(40) }), cookie);
    expect(unknownTask.status).toBe(404);
  });
});
