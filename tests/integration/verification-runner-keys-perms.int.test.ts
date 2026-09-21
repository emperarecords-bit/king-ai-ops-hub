/**
 * VER-002 PR-2 — real-DB permission tests for the no-direct-access credential model.
 *
 * Verifies against a DISPOSABLE database (never prod) that, as the least-privilege `app_server` role:
 *   - verification_runner_keys is NOT directly SELECT/INSERT/UPDATE/DELETE-able (secret material is
 *     never broadly readable; credential fields are never generally mutable);
 *   - every operation goes through a narrowly-scoped SECURITY DEFINER function (issue/revoke/touch),
 *     each of which derives the tenant from the transaction GUCs;
 *   - those functions are tenant-scoped, so a caller in project B cannot revoke/touch project A's key
 *     (cross-project isolation).
 *
 * Prereqs (local): VER_RKP_SUPER_URL (superuser, seeding + assertions), VER_RKP_APP_URL (app_server).
 * Self-skips unless both are set.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

const SUPER = process.env.VER_RKP_SUPER_URL ?? '';
const APP = process.env.VER_RKP_APP_URL ?? '';
const enabled = Boolean(SUPER && APP);

function assertDisposable(url: string): void {
  const u = new URL(url);
  if (!['localhost', '127.0.0.1', '::1'].includes(u.hostname)) throw new Error(`refusing non-local host: ${u.hostname}`);
  if (!/_test$/.test(u.pathname.replace(/^\//, ''))) throw new Error('refusing DB that is not *_test');
}

const ORG = 'a0000000-0000-4000-8000-0000000000a1';
const PROJ_A = 'b0000000-0000-4000-8000-0000000000a1';
const PROJ_B = 'c0000000-0000-4000-8000-0000000000a1';
const USER = 'd0000000-0000-4000-8000-0000000000a1';
const KEY_A = 'e0000000-0000-4000-8000-0000000000a1';

let sup: postgres.Sql;
let app: postgres.Sql;

/** Run a callback as app_server with the given tenant GUCs stamped (transaction-local). */
function asTenant<T>(orgId: string, projectId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return app.begin(async (tx) => {
    await tx`select set_config('app.org_id', ${orgId}, true), set_config('app.project_id', ${projectId}, true), set_config('app.user_id', ${USER}, true)`;
    return fn(tx as unknown as postgres.TransactionSql);
  }) as Promise<T>;
}

beforeAll(async () => {
  if (!enabled) return;
  assertDisposable(SUPER);
  assertDisposable(APP);
  sup = postgres(SUPER, { max: 2, prepare: false });
  app = postgres(APP, { max: 2, prepare: false });
  await sup`insert into profiles (id,email,display_name) values (${USER},'rkp@example.com','RKP') on conflict do nothing`;
  await sup`insert into organizations (id,name,slug) values (${ORG},'RKPOrg','rkp-org') on conflict do nothing`;
  await sup`insert into projects (id,org_id,key,name) values (${PROJ_A},${ORG},'rkp-a','A') on conflict do nothing`;
  await sup`insert into projects (id,org_id,key,name) values (${PROJ_B},${ORG},'rkp-b','B') on conflict do nothing`;
});

afterAll(async () => {
  if (!enabled) return;
  await sup?.end({ timeout: 5 });
  await app?.end({ timeout: 5 });
});

describe.skipIf(!enabled)('VER-002 PR-2 — runner-key table permissions (app_server)', () => {
  it('app_server cannot directly SELECT/INSERT/UPDATE/DELETE the credential table', async () => {
    await expect(app`select count(*) from verification_runner_keys`).rejects.toThrow(/permission denied/i);
    await expect(
      app`insert into verification_runner_keys (id,org_id,project_id,secret_hash,secret_salt,expires_at) values (${KEY_A},${ORG},${PROJ_A},'h','s',now())`,
    ).rejects.toThrow(/permission denied/i);
    await expect(app`update verification_runner_keys set label = 'x'`).rejects.toThrow(/permission denied/i);
    await expect(app`delete from verification_runner_keys`).rejects.toThrow(/permission denied/i);
  });

  it('issue / revoke / touch work through the scoped functions in the caller tenant', async () => {
    await asTenant(ORG, PROJ_A, (tx) => tx`select app.issue_verification_runner_key(${KEY_A}, 'hash', 'salt', 'ci', now() + interval '90 days')`);
    const [row] = (await sup`select org_id, project_id, created_by, revoked_at, last_used_at from verification_runner_keys where id = ${KEY_A}`) as unknown as Array<Record<string, unknown>>;
    expect(row?.org_id).toBe(ORG);
    expect(row?.project_id).toBe(PROJ_A);
    expect(row?.created_by).toBe(USER);

    await asTenant(ORG, PROJ_A, (tx) => tx`select app.touch_verification_runner_key(${KEY_A})`);
    const [touched] = (await sup`select last_used_at from verification_runner_keys where id = ${KEY_A}`) as unknown as Array<{ last_used_at: string | null }>;
    expect(touched?.last_used_at).not.toBeNull();

    const revoked = (await asTenant(ORG, PROJ_A, (tx) => tx`select app.revoke_verification_runner_key(${KEY_A}) as r`)) as unknown as Array<{ r: boolean }>;
    expect(revoked[0]?.r).toBe(true);
  });

  it('cross-project: a caller in project B cannot revoke or touch project A’s key', async () => {
    // Fresh un-revoked key in A.
    const KEY2 = 'e0000000-0000-4000-8000-0000000000a2';
    await asTenant(ORG, PROJ_A, (tx) => tx`select app.issue_verification_runner_key(${KEY2}, 'h', 's', '', now() + interval '90 days')`);
    // From project B, revoke returns false and the row is untouched.
    const rB = (await asTenant(ORG, PROJ_B, (tx) => tx`select app.revoke_verification_runner_key(${KEY2}) as r`)) as unknown as Array<{ r: boolean }>;
    expect(rB[0]?.r).toBe(false);
    await asTenant(ORG, PROJ_B, (tx) => tx`select app.touch_verification_runner_key(${KEY2})`); // no-op
    const [after] = (await sup`select revoked_at, last_used_at from verification_runner_keys where id = ${KEY2}`) as unknown as Array<{ revoked_at: string | null; last_used_at: string | null }>;
    expect(after?.revoked_at).toBeNull(); // B could not revoke A's key
    expect(after?.last_used_at).toBeNull(); // B could not touch A's key
    // A can revoke its own key.
    const rA = (await asTenant(ORG, PROJ_A, (tx) => tx`select app.revoke_verification_runner_key(${KEY2}) as r`)) as unknown as Array<{ r: boolean }>;
    expect(rA[0]?.r).toBe(true);
  });
});
