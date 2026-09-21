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
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signEvidence } from '@/domain/verification';

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
  opts: { cookie?: string; bearer?: string; authHeaderRaw?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const url = `${base}${path}`;
  assertLoopback(url); // before any request / credential leaves the process
  // `authHeaderRaw` sets the Authorization header VERBATIM (for odd-cased/empty-token cases); `bearer`
  // is the convenience form. Either way the request is validated against loopback above before sending.
  const authorization = opts.authHeaderRaw ?? (opts.bearer ? `Bearer ${opts.bearer}` : undefined);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(authorization !== undefined ? { authorization } : {}),
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
    catalogVersion: 'x',
    catalogDigest: 'x',
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

  it('a malformed bearer (no session) is 401 and never reaches ingest', async () => {
    const res = await post(ON, ingestPath(KEY), { bearer: 'not-a-valid-credential', body: envelope() });
    expect(res.status).toBe(401);
    expect(res.json).toHaveProperty('error');
    expect(res.json).not.toHaveProperty('decision');
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

// ─────────────────── dispatch regressions (with a valid session present) ───────────────────
describe.skipIf(!enabled)('VER-002 PR-2 — auth dispatch (bearer vs session)', () => {
  it('a bearer AND a session together is rejected as ambiguous (400) — never disambiguated', async () => {
    const issued = await post(ON, keysPath(KEY), { cookie: ADMIN });
    const cred = String(issued.json.credential);
    const res = await post(ON, ingestPath(KEY), { bearer: cred, cookie: ADMIN, body: envelope() });
    expect(res.status).toBe(400);
    expect(res.json).not.toHaveProperty('decision');
  });

  it('a differently-cased bearer (no session) still commits to the machine path — no session fallback', async () => {
    const issued = await post(ON, keysPath(KEY), { cookie: ADMIN });
    const cred = String(issued.json.credential);
    // lowercase scheme, no cookie → machine path → guard passes → a decision is returned.
    const res = await post(ON, ingestPath(KEY), { authHeaderRaw: `bearer ${cred}`, body: envelope() });
    expect(res.json).toHaveProperty('decision');
    expect(res.json).not.toHaveProperty('error');
  });

  it('a differently-cased MALFORMED bearer with a valid session is still rejected (never falls back)', async () => {
    // Both present → ambiguous 400 (bearer detected case-insensitively; not silently treated as session).
    const res = await post(ON, ingestPath(KEY), { authHeaderRaw: 'BEARER not-a-valid-credential', cookie: ADMIN, body: envelope() });
    expect(res.status).toBe(400);
    expect(res.json).not.toHaveProperty('decision');
  });

  // A bearer scheme with an EMPTY or whitespace-only token is still a bearer ATTEMPT: without a session
  // it is 401 (never a fallback); with a session it is 400 (ambiguous). Covers "Bearer", "Bearer ", "BEARER\t".
  for (const header of ['Bearer', 'Bearer ', 'BEARER\t']) {
    const label = JSON.stringify(header);
    it(`an empty/whitespace bearer token (${label}) with NO session → 401, never a session fallback`, async () => {
      const res = await post(ON, ingestPath(KEY), { authHeaderRaw: header, body: envelope() });
      expect(res.status).toBe(401);
      expect(res.json).not.toHaveProperty('decision');
    });
    it(`an empty/whitespace bearer token (${label}) WITH a session → 400 ambiguous`, async () => {
      const res = await post(ON, ingestPath(KEY), { authHeaderRaw: header, cookie: ADMIN, body: envelope() });
      expect(res.status).toBe(400);
      expect(res.json).not.toHaveProperty('decision');
    });
  }
});

// ─────────────────── genuine machine-authenticated ingestion (real signature) ───────────────────
const ingestEnabled = Boolean(
  enabled &&
    process.env.VER_RK_MASTER &&
    process.env.VER_RK_ORG &&
    process.env.VER_RK_PROJECT_ID &&
    process.env.VER_RK_CONTRACT_ID &&
    process.env.VER_RK_TASK_ID &&
    process.env.VER_RK_COMMIT &&
    process.env.VER_RK_REPO &&
    process.env.VER_RK_CRED_EXPIRED &&
    process.env.VER_RK_CATALOG_VERSION &&
    process.env.VER_RK_CATALOG_DIGEST,
);
const M = {
  master: process.env.VER_RK_MASTER ?? '',
  org: process.env.VER_RK_ORG ?? '',
  project: process.env.VER_RK_PROJECT_ID ?? '',
  contract: process.env.VER_RK_CONTRACT_ID ?? '',
  task: process.env.VER_RK_TASK_ID ?? '',
  commit: process.env.VER_RK_COMMIT ?? '',
  repo: process.env.VER_RK_REPO ?? '',
  credExpired: process.env.VER_RK_CRED_EXPIRED ?? '',
  catalogVersion: process.env.VER_RK_CATALOG_VERSION ?? '',
  catalogDigest: process.env.VER_RK_CATALOG_DIGEST ?? '',
};
const ART_BYTES = Buffer.from('{"passed":true}', 'utf8');
const ART_SHA = createHash('sha256').update(ART_BYTES).digest('hex');
/** The exact object key the orchestration wrote the artifact to (canonical tenant key). */
const artKey = () => `org/${M.org}/project/${M.project}/request/${M.contract}/attempt/att-1/test-results.json`;
/** Derive the project's runner signing secret the same way the server does (v1). */
const derivedSecret = () => createHmac('sha256', M.master).update(`verification-runner:v1:${M.org}:${M.project}`).digest('hex');
function signedEnvelope(over: Record<string, unknown> = {}, signingKeyVersion?: string) {
  const payload = {
    requestId: M.contract,
    orgId: M.org,
    projectId: M.project,
    taskId: M.task,
    repoFullName: M.repo,
    commitSha: M.commit,
    dirty: false,
    uncommittedChangesDigest: null,
    runnerId: 'runner-real',
    runId: 'run-real-1',
    attemptId: 'att-1',
    environment: 'ci',
    source: 'local_runner' as const,
    checks: [{ name: 'unit', status: 'passed' as const, command: 'npm run unit', exitCode: 0, startedAt: '2026-09-20T00:00:00.000Z', finishedAt: '2026-09-20T00:00:05.000Z', detail: null }],
    artifacts: [{ path: 'test-results.json', sha256: ART_SHA, sizeBytes: ART_BYTES.length, storageKey: artKey() }],
    catalogVersion: M.catalogVersion,
    catalogDigest: M.catalogDigest,
    idempotencyKey: 'idem-real-1',
    submittedAt: new Date().toISOString(),
    ...over,
  };
  const env: Record<string, unknown> = { runnerId: payload.runnerId, payload, signature: signEvidence(derivedSecret(), payload as never) };
  if (signingKeyVersion) env.signingKeyVersion = signingKeyVersion;
  return env;
}

describe.skipIf(!ingestEnabled)('VER-002 PR-2 — genuine machine-authenticated ingestion', () => {
  it('valid signature + passing check + required artifact → verified_complete, and identical retry replays', async () => {
    const issued = await post(ON, keysPath(KEY), { cookie: ADMIN });
    const cred = String(issued.json.credential);
    // Build ONE envelope (unique idempotency key + a single fixed submittedAt) and post it twice, so the
    // retry is byte-identical (same digest ⇒ a true idempotent replay, not a conflict).
    const env = signedEnvelope({ idempotencyKey: `idem-${randomUUID()}`, submittedAt: new Date().toISOString() });
    const first = await post(ON, ingestPath(KEY), { bearer: cred, body: env });
    const d1 = first.json.decision as { accepted: boolean; status: string; deliverable: boolean } | undefined;
    expect(d1?.accepted).toBe(true);
    expect(d1?.status).toBe('verified_complete');
    expect(d1?.deliverable).toBe(true);
    // Identical retry → replayed, same decision, not a second row.
    const again = await post(ON, ingestPath(KEY), { bearer: cred, body: env });
    const d2 = again.json.decision as { accepted: boolean; status: string; replayed?: boolean } | undefined;
    expect(d2?.accepted).toBe(true);
    expect(d2?.status).toBe('verified_complete');
    expect(d2?.replayed).toBe(true);
  });

  it('an expired credential is refused (401)', async () => {
    const res = await post(ON, ingestPath(KEY), { bearer: M.credExpired, body: signedEnvelope({ idempotencyKey: 'idem-exp' }) });
    expect(res.status).toBe(401);
    expect(res.json).not.toHaveProperty('decision');
  });

  it('a wrong secret (valid keyId) is refused (401)', async () => {
    const issued = await post(ON, keysPath(KEY), { cookie: ADMIN });
    const keyId = String(issued.json.keyId);
    const res = await post(ON, ingestPath(KEY), { bearer: `${keyId}.wrongsecretwrongsecretwrongsecret`, body: signedEnvelope({ idempotencyKey: 'idem-wrong' }) });
    expect(res.status).toBe(401);
    expect(res.json).not.toHaveProperty('decision');
  });

  it('an unsupported signing version is rejected on the MACHINE path', async () => {
    const issued = await post(ON, keysPath(KEY), { cookie: ADMIN });
    const cred = String(issued.json.credential);
    const res = await post(ON, ingestPath(KEY), { bearer: cred, body: signedEnvelope({ idempotencyKey: 'idem-v2-m' }, 'v2') });
    expect((res.json.decision as { rejection?: { code: string } })?.rejection?.code).toBe('unsupported_signing_version');
  });

  it('an unsupported signing version is rejected on the HUMAN (session) path too', async () => {
    const res = await post(ON, ingestPath(KEY), { cookie: ADMIN, body: signedEnvelope({ idempotencyKey: 'idem-v2-h' }, 'v2') });
    expect((res.json.decision as { rejection?: { code: string } })?.rejection?.code).toBe('unsupported_signing_version');
  });
});
