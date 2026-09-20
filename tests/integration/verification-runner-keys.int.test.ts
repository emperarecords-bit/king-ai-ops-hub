/**
 * REAL integration test for VER-002 PR-2 machine-auth (runner credentials).
 *
 * Two live, DISPOSABLE Next servers share one throwaway DB: one with both default-off controls ON,
 * one with them OFF — because the env is read once per process, that is how both states are exercised.
 * Never production, never real creds. Confirms: project-admin-only issuance/revocation; a runner
 * authenticates to ingest with NO session; a malformed bearer is 401 with no session fallback; a
 * credential for one project can't act on another; revocation refuses a revoked credential; issuance
 * is refused while its control is off but REVOCATION still works; and a bearer is refused while the
 * machine-auth control is off.
 *
 * Prereqs (all local): VER_RK_BASE_ON, VER_RK_BASE_OFF, VER_RK_PROJECT_KEY, VER_RK_PROJECT_KEY_B,
 * VER_RK_COOKIE_ADMIN, VER_RK_COOKIE_MEMBER, VER_RK_COOKIE_VIEWER, VER_RK_CRED_OFF, VER_RK_CRED_OFF_REVOKE,
 * VER_RK_CRED_OFF_REVOKE_ID. Self-skips unless set.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const ON = process.env.VER_RK_BASE_ON ?? '';
const OFF = process.env.VER_RK_BASE_OFF ?? '';
const KEY = process.env.VER_RK_PROJECT_KEY ?? '';
const KEY_B = process.env.VER_RK_PROJECT_KEY_B ?? '';
const ADMIN = process.env.VER_RK_COOKIE_ADMIN ?? '';
const MEMBER = process.env.VER_RK_COOKIE_MEMBER ?? '';
const VIEWER = process.env.VER_RK_COOKIE_VIEWER ?? '';
const CRED_OFF = process.env.VER_RK_CRED_OFF ?? '';
const CRED_OFF_REVOKE = process.env.VER_RK_CRED_OFF_REVOKE ?? '';
const CRED_OFF_REVOKE_ID = process.env.VER_RK_CRED_OFF_REVOKE_ID ?? '';
const enabled = Boolean(ON && OFF && KEY && KEY_B && ADMIN && MEMBER && VIEWER && CRED_OFF && CRED_OFF_REVOKE && CRED_OFF_REVOKE_ID);

function assertLoopback(target: string): void {
  const u = new URL(target);
  if (u.protocol !== 'http:' || !['localhost', '127.0.0.1', '::1'].includes(u.hostname)) {
    throw new Error(`refusing non-loopback HTTP target: ${target}`);
  }
}
async function post(
  base: string,
  path: string,
  opts: { cookie?: string; bearer?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const url = `${base}${path}`;
  assertLoopback(url); // before any request / credential leaves the process
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
    },
    body: JSON.stringify(opts.body ?? {}),
    redirect: 'error',
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* some responses may be empty */
  }
  return { status: res.status, json };
}

/** A schema-valid evidence envelope so a request that passes the guard reaches the ingest orchestrator
 *  (which then returns a `decision`); the signature need not be valid — auth happens before ingest. */
const envelope = () => ({
  runnerId: 'runner-int',
  signature: 'deadbeef',
  payload: {
    requestId: randomUUID(),
    orgId: '00000000-0000-4000-8000-000000000000',
    projectId: '00000000-0000-4000-8000-000000000000',
    taskId: '00000000-0000-4000-8000-000000000000',
    repoFullName: 'acme/widget',
    commitSha: 'a'.repeat(40),
    dirty: false,
    uncommittedChangesDigest: null,
    runnerId: 'runner-int',
    runId: 'run-1',
    attemptId: 'attempt-1',
    environment: 'local',
    source: 'local_runner',
    checks: [],
    artifacts: [],
    idempotencyKey: 'idem-int-1',
    submittedAt: new Date().toISOString(),
  },
});
const ingestPath = (key: string) => `/api/p/${key}/verification`;
const keysPath = (key: string) => `/api/p/${key}/verification/runner-keys`;

describe.skipIf(!enabled)('VER-002 PR-2 — runner credentials (controls ON)', () => {
  it('project admin issues a credential (201); member and viewer cannot (403)', async () => {
    const created = await post(ON, keysPath(KEY), { cookie: ADMIN, body: { label: 'ci' } });
    expect(created.status).toBe(201);
    expect(typeof created.json.credential).toBe('string');
    expect(String(created.json.credential)).toContain('.');
    expect((await post(ON, keysPath(KEY), { cookie: MEMBER })).status).toBe(403);
    expect((await post(ON, keysPath(KEY), { cookie: VIEWER })).status).toBe(403);
  });

  it('a runner authenticates to ingest with NO session (guard passes → a decision is returned)', async () => {
    const issued = await post(ON, keysPath(KEY), { cookie: ADMIN });
    const cred = String(issued.json.credential);
    const res = await post(ON, ingestPath(KEY), { bearer: cred, body: envelope() });
    // Guard passed ⇒ the ingest orchestrator ran and returned a decision (not an auth error).
    expect(res.json).toHaveProperty('decision');
    expect(res.json).not.toHaveProperty('error');
  });

  it('a malformed bearer is 401 and never falls back to a session', async () => {
    const res = await post(ON, ingestPath(KEY), { bearer: 'not-a-valid-credential', cookie: ADMIN, body: envelope() });
    expect(res.status).toBe(401);
    expect(res.json).toHaveProperty('error');
    expect(res.json).not.toHaveProperty('decision'); // no fallback to the admin session
  });

  it("a credential for one project cannot act on another project's URL (403)", async () => {
    const issued = await post(ON, keysPath(KEY), { cookie: ADMIN });
    const cred = String(issued.json.credential);
    const res = await post(ON, ingestPath(KEY_B), { bearer: cred, body: envelope() });
    expect(res.status).toBe(403);
    expect(res.json).not.toHaveProperty('decision');
  });

  it('a revoked credential is refused (401) after an admin revokes it', async () => {
    const issued = await post(ON, keysPath(KEY), { cookie: ADMIN });
    const cred = String(issued.json.credential);
    const keyId = String(issued.json.keyId);
    // Works before revocation.
    expect((await post(ON, ingestPath(KEY), { bearer: cred, body: envelope() })).json).toHaveProperty('decision');
    const revoked = await post(ON, `${keysPath(KEY)}/${keyId}/revoke`, { cookie: ADMIN });
    expect(revoked.status).toBe(200);
    const after = await post(ON, ingestPath(KEY), { bearer: cred, body: envelope() });
    expect(after.status).toBe(401);
    expect(after.json).not.toHaveProperty('decision');
  });
});

describe.skipIf(!enabled)('VER-002 PR-2 — runner credentials (controls OFF)', () => {
  it('issuance is refused while the issuance control is off (403)', async () => {
    const res = await post(OFF, keysPath(KEY), { cookie: ADMIN });
    expect(res.status).toBe(403);
  });

  it('a bearer is refused while machine-auth is off (401, no decision)', async () => {
    const res = await post(OFF, ingestPath(KEY), { bearer: CRED_OFF, body: envelope() });
    expect(res.status).toBe(401);
    expect(res.json).not.toHaveProperty('decision');
  });

  it('revocation STILL works while issuance is disabled (admin revokes a pre-seeded credential)', async () => {
    const revoked = await post(OFF, `${keysPath(KEY)}/${CRED_OFF_REVOKE_ID}/revoke`, { cookie: ADMIN });
    expect(revoked.status).toBe(200);
    expect(revoked.json).toMatchObject({ revoked: true });
  });
});
