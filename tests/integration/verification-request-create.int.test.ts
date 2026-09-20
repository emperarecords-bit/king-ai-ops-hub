/**
 * REAL integration test for VER-002 verification-REQUEST creation.
 *
 * Exercises the ACTUAL create path (createVerificationRequest + Drizzle store under withTenant + RLS)
 * and the real HTTP route against a live, DISPOSABLE Postgres — never production, never real creds.
 * Confirms: contracts are bound to the authenticated tenant/creator; the requested repository is
 * validated against the project's trusted github_repo_links; a task from another project cannot be
 * bound; the contract is immutable; and write permission is enforced — admin/member may create, a
 * viewer may not, and an authenticated non-member is refused.
 *
 * Prereqs (all local/isolated): DATABASE_URL (app_server), VER_INT_ORG_ID, VER_INT_PROJECT_ID,
 * VER_INT_TASK_ID, VER_INT_USER_ID, VER_INT_REPO (a linked repo). Cross-tenant: VER_INT_OTHER_TASK_ID
 * (a task in another project). HTTP: VER_INT_BASE_URL, VER_INT_PROJECT_KEY, VER_INT_COOKIE_VALID (admin),
 * VER_INT_COOKIE_VIEWER, VER_INT_COOKIE_NONMEMBER. Self-skips unless the env is set.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@/db/tenant';
import { verificationRequests } from '@/db/schema';
import { createVerificationRequest } from '@/domain/verification';
import { createDrizzleVerificationStore } from '@/domain/verification/drizzle-store';
import type { TenantContext } from '@/types/domain';

const ORG = process.env.VER_INT_ORG_ID ?? '';
const PROJECT = process.env.VER_INT_PROJECT_ID ?? '';
const TASK = process.env.VER_INT_TASK_ID ?? '';
const USER = process.env.VER_INT_USER_ID ?? '';
const REPO = process.env.VER_INT_REPO ?? 'acme/widget';
const OTHER_TASK = process.env.VER_INT_OTHER_TASK_ID ?? '';
const enabled = Boolean(process.env.DATABASE_URL && ORG && PROJECT && TASK && USER);

const ctx = { userId: USER, orgId: ORG, projectId: PROJECT, orgRole: 'owner', projectRole: 'admin' } as unknown as TenantContext;

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
    tx.execute(sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`),
  );
  const row = (rows as unknown as Array<{ rolsuper: boolean; rolbypassrls: boolean }>)[0];
  expect(row?.rolsuper, 'runtime role must not be a superuser').toBe(false);
  expect(row?.rolbypassrls, 'runtime role must not have BYPASSRLS').toBe(false);
});

const input = (over: Record<string, unknown> = {}) => ({
  taskId: TASK,
  repoFullName: REPO,
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
    expect(out.request!.orgId).toBe(ORG);
    expect(out.request!.projectId).toBe(PROJECT);
    expect(out.request!.createdBy).toBe(USER);

    const rows = await withTenant(ctx, (tx) =>
      tx.select({ id: verificationRequests.id }).from(verificationRequests).where(eq(verificationRequests.id, id)),
    );
    expect(rows.length).toBe(1);
    await expect(withTenant(ctx, (tx) => tx.execute(sql`update verification_requests set repo_full_name = 'tampered' where id = ${id}`))).rejects.toThrow();
    await expect(withTenant(ctx, (tx) => tx.execute(sql`delete from verification_requests where id = ${id}`))).rejects.toThrow();
  });

  it('idempotent identical re-create returns the same contract; a divergent one conflicts', async () => {
    const commit = 'd'.repeat(40);
    const first = await withTenant(ctx, (tx) => createVerificationRequest(createDrizzleVerificationStore(tx), ctx, input({ commitSha: commit })));
    expect(first.created).toBe(true);
    const same = await withTenant(ctx, (tx) => createVerificationRequest(createDrizzleVerificationStore(tx), ctx, input({ commitSha: commit })));
    expect(same.created).toBe(false);
    expect(same.request!.id).toBe(first.request!.id);
    const conflict = await withTenant(ctx, (tx) =>
      createVerificationRequest(createDrizzleVerificationStore(tx), ctx, input({ commitSha: commit, requiredChecks: ['unit', 'lint'] })),
    );
    expect(conflict.rejection?.code).toBe('contract_conflict');
  });

  it.skipIf(!OTHER_TASK)('a REAL task belonging to another project cannot be bound (tenant-scoped)', async () => {
    const out = await withTenant(ctx, (tx) =>
      createVerificationRequest(createDrizzleVerificationStore(tx), ctx, input({ taskId: OTHER_TASK, commitSha: 'e'.repeat(40) })),
    );
    expect(out.rejection?.code).toBe('task_not_in_project');
  });

  it('rejects a repository not linked to the project (unrelated repo)', async () => {
    const out = await withTenant(ctx, (tx) =>
      createVerificationRequest(createDrizzleVerificationStore(tx), ctx, input({ repoFullName: 'evil/other', commitSha: 'f'.repeat(40) })),
    );
    expect(out.rejection?.code).toBe('repo_not_authorized');
  });
});

// ─────────────────────────── HTTP route ───────────────────────────
const routeEnabled = Boolean(enabled && process.env.VER_INT_BASE_URL && process.env.VER_INT_PROJECT_KEY);
const base = process.env.VER_INT_BASE_URL ?? '';
const key = process.env.VER_INT_PROJECT_KEY ?? '';
const url = `${base}/api/p/${key}/verification/requests`;

/** Loopback-only destination guard — runs in the SHARED POST helper BEFORE any request or cookie is sent,
 *  so an auth cookie can never be transmitted to a non-loopback host. */
function assertLoopbackHttp(target: string): void {
  const u = new URL(target);
  if (u.protocol !== 'http:' || !['localhost', '127.0.0.1', '::1'].includes(u.hostname)) {
    throw new Error(`refusing non-loopback HTTP target: ${target}`);
  }
}
const post = (body: unknown, cookie?: string) => {
  assertLoopbackHttp(url); // before the fetch, before the cookie leaves the process
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
    redirect: 'error',
  });
};

describe.skipIf(!routeEnabled)('VER-002 request creation — HTTP route', () => {
  it('rejects an unauthenticated create (401)', async () => {
    expect((await post(input({ commitSha: 'f'.repeat(40) }))).status).toBe(401);
  });
});

const authEnabled = Boolean(routeEnabled && process.env.VER_INT_COOKIE_VALID);
describe.skipIf(!authEnabled)('VER-002 request creation — HTTP route (admin)', () => {
  const cookie = process.env.VER_INT_COOKIE_VALID ?? '';
  it('creates (201), is idempotent (200), and conflicts on a divergent contract (409)', async () => {
    const commit = '9'.repeat(40);
    const created = await post(input({ commitSha: commit }), cookie);
    expect(created.status).toBe(201);
    const body = (await created.json()) as { created: boolean; request: { orgId: string; projectId: string } };
    expect(body.created).toBe(true);
    expect(body.request.orgId).toBe(ORG);
    expect(body.request.projectId).toBe(PROJECT);
    expect(((await (await post(input({ commitSha: commit }), cookie)).json()) as { created: boolean }).created).toBe(false);
    const conflict = await post(input({ commitSha: commit, requiredChecks: ['unit', 'e2e'] }), cookie);
    expect(conflict.status).toBe(409);
  });

  it('rejects invalid input (400), unknown task (404), and an unauthorized repo (403)', async () => {
    expect((await post(input({ commitSha: 'abc' }), cookie)).status).toBe(400);
    expect((await post(input({ taskId: randomUUID(), commitSha: '1'.repeat(40) }), cookie)).status).toBe(404);
    expect((await post(input({ repoFullName: 'evil/other', commitSha: '2'.repeat(40) }), cookie)).status).toBe(403);
  });
});

describe.skipIf(!(routeEnabled && process.env.VER_INT_COOKIE_VIEWER))('VER-002 request creation — a viewer may not create (403)', () => {
  it('rejects a create by a viewer (read-only) role', async () => {
    expect((await post(input({ commitSha: '3'.repeat(40) }), process.env.VER_INT_COOKIE_VIEWER)).status).toBe(403);
  });
});

describe.skipIf(!(routeEnabled && process.env.VER_INT_COOKIE_NONMEMBER))('VER-002 request creation — an authenticated non-member is refused (403)', () => {
  it('rejects a create by an authenticated user who is not a project member', async () => {
    expect((await post(input({ commitSha: '4'.repeat(40) }), process.env.VER_INT_COOKIE_NONMEMBER)).status).toBe(403);
  });
});
