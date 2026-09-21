/**
 * REAL integration test for VER-002 PR-3 — contract retrieval + catalog pinning.
 *
 * Drives the ACTUAL HTTP routes through the real middleware against a disposable Postgres + local
 * Supabase stub. Two Next servers share one DB: one with retrieval ON, one OFF. A mutable test catalog
 * directory (VERIFICATION_CATALOG_DIR) lets us update the catalog mid-test and confirm old contracts
 * still verify. Never production, never real creds.
 *
 * Prereqs (all local): VER_RC_BASE_ON, VER_RC_BASE_OFF, VER_RC_PROJECT_KEY, VER_RC_PROJECT_KEY_B,
 * VER_RC_COOKIE_ADMIN, VER_RC_COOKIE_MEMBER, VER_RC_COOKIE_VIEWER, VER_RC_RUNNER_CRED, VER_RC_MASTER,
 * VER_RC_ORG, VER_RC_PROJECT_ID, VER_RC_TASK_ID, VER_RC_TASK2_ID, VER_RC_REPO, VER_RC_CATALOG_DIR.
 * Self-skips unless set.
 */
import { createHmac as hmac } from 'node:crypto';
import { writeFileSync as writeFile, mkdirSync as mkdirp, rmSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const ON = process.env.VER_RC_BASE_ON ?? '';
const OFF = process.env.VER_RC_BASE_OFF ?? '';
const KEY = process.env.VER_RC_PROJECT_KEY ?? '';
const KEY_B = process.env.VER_RC_PROJECT_KEY_B ?? '';
const ADMIN = process.env.VER_RC_COOKIE_ADMIN ?? '';
const MEMBER = process.env.VER_RC_COOKIE_MEMBER ?? '';
const VIEWER = process.env.VER_RC_COOKIE_VIEWER ?? '';
const RUNNER = process.env.VER_RC_RUNNER_CRED ?? '';
const MASTER = process.env.VER_RC_MASTER ?? '';
const ORG = process.env.VER_RC_ORG ?? '';
const PROJECT_ID = process.env.VER_RC_PROJECT_ID ?? '';
const TASK = process.env.VER_RC_TASK_ID ?? '';
const TASK2 = process.env.VER_RC_TASK2_ID ?? '';
const REPO = process.env.VER_RC_REPO ?? '';
const CAT_DIR = process.env.VER_RC_CATALOG_DIR ?? '';
const enabled = Boolean(
  ON && OFF && KEY && KEY_B && ADMIN && MEMBER && VIEWER && RUNNER && MASTER && ORG && PROJECT_ID && TASK && TASK2 && REPO && CAT_DIR,
);

function assertLoopback(target: string): void {
  const u = new URL(target);
  if (u.protocol !== 'http:' || !['localhost', '127.0.0.1', '::1'].includes(u.hostname)) throw new Error(`refusing non-loopback: ${target}`);
}
async function req(
  method: 'GET' | 'POST',
  base: string,
  path: string,
  opts: { cookie?: string; bearer?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const url = `${base}${path}`;
  assertLoopback(url);
  const res = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(opts.body ?? {}) } : {}),
    redirect: 'error',
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* empty */
  }
  return { status: res.status, json };
}

const reqPath = `/api/p/${KEY}/verification/requests`;
const ingest = `/api/p/${KEY}/verification`;

/** Canonical JSON (recursively sorted keys) — must match the server's signing/canonicalization. */
function canon(v: unknown): string {
  return JSON.stringify(
    (function s(x: unknown): unknown {
      if (Array.isArray(x)) return x.map(s);
      if (x && typeof x === 'object') {
        return Object.keys(x as Record<string, unknown>)
          .sort()
          .reduce<Record<string, unknown>>((a, k) => {
            a[k] = s((x as Record<string, unknown>)[k]);
            return a;
          }, {});
      }
      return x;
    })(v),
  );
}
const derivedSecret = () => hmac('sha256', MASTER).update(`verification-runner:v1:${ORG}:${PROJECT_ID}`).digest('hex');

/** Write a catalog version file + point current.json at a default. The file resolver reads on each call. */
function writeCatalog(version: string, unitCommand: string, currentDefault: string): void {
  mkdirp(join(CAT_DIR, 'versions'), { recursive: true });
  writeFile(join(CAT_DIR, 'versions', `${version}.json`), JSON.stringify({ version, checks: { unit: { command: unitCommand } } }));
  writeFile(join(CAT_DIR, 'current.json'), JSON.stringify({ default: currentDefault, projects: {} }));
}

/** Build + sign an evidence envelope for a contract retrieved from the Hub (declares its catalog id). */
function signedEnvelope(contract: Record<string, unknown>, unitCommand: string, over: Record<string, unknown> = {}) {
  const payload = {
    requestId: contract.id,
    orgId: ORG,
    projectId: PROJECT_ID,
    taskId: contract.taskId,
    repoFullName: contract.repoFullName,
    commitSha: contract.expectedCommitSha,
    dirty: false,
    uncommittedChangesDigest: null,
    runnerId: 'rc-runner',
    runId: 'rc-run',
    attemptId: 'rc-att',
    environment: 'ci',
    source: 'local_runner' as const,
    checks: [{ name: 'unit', status: 'passed' as const, command: unitCommand, exitCode: 0, startedAt: '2026-09-20T00:00:00.000Z', finishedAt: '2026-09-20T00:00:01.000Z', detail: null }],
    artifacts: [],
    catalogVersion: contract.catalogVersion,
    catalogDigest: contract.catalogDigest,
    idempotencyKey: `idem-${Math.random().toString(36).slice(2)}`,
    submittedAt: new Date().toISOString(),
    ...over,
  };
  return { runnerId: payload.runnerId, payload, signature: hmac('sha256', derivedSecret()).update(canon(payload)).digest('hex') };
}

let contractV1: Record<string, unknown>;

beforeAll(async () => {
  if (!enabled) return;
  // Start from a known catalog: version 'rc-v1' with unit → 'run-unit'.
  writeCatalog('rc-v1', 'run-unit', 'rc-v1');
  // Create a contract (admin, no required artifacts so verification needs only the passing check).
  // Idempotent across re-runs: an existing (task, commit) contract returns 200 with the same row.
  const created = await req('POST', ON, reqPath, { cookie: ADMIN, body: { taskId: TASK, repoFullName: REPO, commitSha: 'a'.repeat(40), requiredChecks: ['unit'], requiredArtifacts: [] } });
  expect([200, 201]).toContain(created.status);
  const got = await req('GET', ON, `${reqPath}/${String((created.json.request as Record<string, unknown>).id)}`, { cookie: ADMIN });
  contractV1 = got.json;
  expect(contractV1.catalogVersion).toBe('rc-v1');
});

describe.skipIf(!enabled)('VER-002 PR-3 — retrieval (project-scoped, machine + human)', () => {
  it('a human member (and viewer) may list and read contracts', async () => {
    for (const cookie of [ADMIN, MEMBER, VIEWER]) {
      const list = await req('GET', ON, reqPath, { cookie });
      expect(list.status).toBe(200);
      expect(Array.isArray(list.json.items)).toBe(true);
    }
    const one = await req('GET', ON, `${reqPath}/${String(contractV1.id)}`, { cookie: VIEWER });
    expect(one.status).toBe(200);
    expect(one.json.catalogVersion).toBe('rc-v1');
    expect(one.json).not.toHaveProperty('createdBy'); // only contract fields + facts, no internals/secrets
  });

  it('a runner may retrieve when retrieval is ON', async () => {
    const on = await req('GET', ON, reqPath, { bearer: RUNNER });
    expect(on.status).toBe(200);
    expect(Array.isArray(on.json.items)).toBe(true);
    const onOne = await req('GET', ON, `${reqPath}/${String(contractV1.id)}`, { bearer: RUNNER });
    expect(onOne.status).toBe(200);
  });

  it.skipIf(!process.env.VER_RC_OFF_ENABLED)('a runner is REFUSED retrieval (403) when the retrieval control is OFF', async () => {
    // Runs against the OFF server (machine-auth on, retrieval off): the bearer authenticates but
    // machine retrieval is disabled — a valid bearer is refused, never leaking contract data.
    const off = await req('GET', OFF, reqPath, { bearer: RUNNER });
    expect(off.status).toBe(403);
    expect(off.json).not.toHaveProperty('items');
  });

  it('bounded pagination + open filter', async () => {
    // Create a couple more contracts, then page with limit=1.
    await req('POST', ON, reqPath, { cookie: ADMIN, body: { taskId: TASK2, repoFullName: REPO, commitSha: 'b'.repeat(40), requiredChecks: ['unit'], requiredArtifacts: [] } });
    const page1 = await req('GET', ON, `${reqPath}?limit=1`, { cookie: ADMIN });
    expect((page1.json.items as unknown[]).length).toBe(1);
    expect(typeof page1.json.nextCursor).toBe('string');
    const page2 = await req('GET', ON, `${reqPath}?limit=1&cursor=${String(page1.json.nextCursor)}`, { cookie: ADMIN });
    expect((page2.json.items as unknown[])[0]).not.toEqual((page1.json.items as unknown[])[0]);
    // "open" = no accepted evidence yet; every contract here is open until evidence is ingested.
    const open = await req('GET', ON, `${reqPath}?state=open&limit=100`, { cookie: ADMIN });
    expect((open.json.items as unknown[]).length).toBeGreaterThanOrEqual(2);
  });
});

describe.skipIf(!enabled)('VER-002 PR-3 — catalog pinning at ingest (machine path)', () => {
  it('a valid signature under the pinned catalog verifies; identical retry replays', async () => {
    const env = signedEnvelope(contractV1, 'run-unit', {});
    const first = await req('POST', ON, ingest, { bearer: RUNNER, body: env });
    const d1 = first.json.decision as { accepted: boolean; status: string } | undefined;
    expect(d1?.accepted).toBe(true);
    expect(d1?.status).toBe('verified_complete');
    const again = await req('POST', ON, ingest, { bearer: RUNNER, body: env });
    expect((again.json.decision as { replayed?: boolean })?.replayed).toBe(true);
  });

  it('caller-supplied catalog tampering is rejected (catalog_mismatch)', async () => {
    const env = signedEnvelope(contractV1, 'run-unit', { catalogDigest: 'TAMPERED' });
    const res = await req('POST', ON, ingest, { bearer: RUNNER, body: env });
    expect((res.json.decision as { rejection?: { code: string } })?.rejection?.code).toBe('catalog_mismatch');
  });

  it('a contract pinned to an OLD catalog version still verifies AFTER the catalog updates', async () => {
    // Update the catalog: add rc-v2 with a DIFFERENT unit command and make it the default.
    writeCatalog('rc-v2', 'run-unit-v2', 'rc-v2');
    // A NEW contract now pins rc-v2.
    const created2 = await req('POST', ON, reqPath, { cookie: ADMIN, body: { taskId: TASK, repoFullName: REPO, commitSha: 'c'.repeat(40), requiredChecks: ['unit'], requiredArtifacts: [] } });
    const got2 = await req('GET', ON, `${reqPath}/${String((created2.json.request as Record<string, unknown>).id)}`, { cookie: ADMIN });
    expect(got2.json.catalogVersion).toBe('rc-v2');
    // The OLD contract (rc-v1) still verifies — the server re-resolves the PINNED version, not the current one.
    const oldEnv = signedEnvelope(contractV1, 'run-unit', {});
    const oldRes = await req('POST', ON, ingest, { bearer: RUNNER, body: oldEnv });
    expect((oldRes.json.decision as { status: string })?.status).toBe('verified_complete');
  });

  it('a missing pinned catalog version fails CLOSED (catalog_unavailable)', async () => {
    // Remove rc-v1's version file; its contract can no longer be verified.
    rmSync(join(CAT_DIR, 'versions', 'rc-v1.json'), { force: true });
    const env = signedEnvelope(contractV1, 'run-unit', {});
    const res = await req('POST', ON, ingest, { bearer: RUNNER, body: env });
    expect((res.json.decision as { rejection?: { code: string } })?.rejection?.code).toBe('catalog_unavailable');
    // Restore for any later runs.
    writeCatalog('rc-v1', 'run-unit', 'rc-v2');
  });
});
