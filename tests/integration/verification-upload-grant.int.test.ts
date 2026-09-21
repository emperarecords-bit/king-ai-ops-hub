/**
 * REAL integration test for VER-002 PR-4 — artifact upload grants.
 *
 * Drives the ACTUAL HTTP routes through the real middleware against a disposable Postgres + LOCAL object
 * store: request a grant, redeem it by streaming bytes, then ingest evidence that binds to it. Exercises
 * the complete grant → upload → ingest flow plus concurrent redemption, an interrupted (truncated) stream,
 * crash-after-write recovery, expiry during recovery, a later failed retry, and cross-contract/attempt
 * rejection. LOCAL storage only — this proves the local adapter, NOT any production storage adapter.
 * Uploads are enabled ONLY inside this disposable server. No provisioning, no real creds.
 *
 * Prereqs (all local, self-skips unless set): VER_UP_BASE, VER_UP_PROJECT_KEY, VER_UP_RUNNER_CRED,
 * VER_UP_MASTER, VER_UP_ORG, VER_UP_PROJECT_ID, VER_UP_CONTRACT_ID, VER_UP_TASK_ID, VER_UP_COMMIT,
 * VER_UP_STORE_DIR, VER_UP_DB_URL.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env.VER_UP_BASE ?? '';
const KEY = process.env.VER_UP_PROJECT_KEY ?? '';
const RUNNER = process.env.VER_UP_RUNNER_CRED ?? '';
const MASTER = process.env.VER_UP_MASTER ?? '';
const ORG = process.env.VER_UP_ORG ?? '';
const PROJECT_ID = process.env.VER_UP_PROJECT_ID ?? '';
const CONTRACT = process.env.VER_UP_CONTRACT_ID ?? '';
const TASK = process.env.VER_UP_TASK_ID ?? '';
const COMMIT = process.env.VER_UP_COMMIT ?? '';
const STORE_DIR = process.env.VER_UP_STORE_DIR ?? '';
const DB_URL = process.env.VER_UP_DB_URL ?? '';
const CAT_VERSION = process.env.VER_UP_CATALOG_VERSION ?? '';
const CAT_DIGEST = process.env.VER_UP_CATALOG_DIGEST ?? '';
const ADMIN_COOKIE = process.env.VER_UP_COOKIE_ADMIN ?? ''; // optional: exercises the non-runner path
const enabled = Boolean(BASE && KEY && RUNNER && MASTER && ORG && PROJECT_ID && CONTRACT && TASK && COMMIT && STORE_DIR && DB_URL && CAT_VERSION && CAT_DIGEST);

const PATH = 'test-results.json';
const RUN = randomUUID().slice(0, 8); // per-run prefix so the suite is re-runnable against a shared DB
function assertLoopback(target: string): void {
  const u = new URL(target);
  if (u.protocol !== 'http:' || !['localhost', '127.0.0.1', '::1'].includes(u.hostname)) throw new Error(`refusing non-loopback: ${target}`);
}
async function req(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  opts: { bearer?: string; json?: unknown; body?: Uint8Array } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const url = `${BASE}${path}`;
  assertLoopback(url);
  const headers: Record<string, string> = {};
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  let body: BodyInit | undefined;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/octet-stream';
    body = opts.body as unknown as BodyInit;
  }
  const res = await fetch(url, { method, headers, body, redirect: 'error' });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* empty */
  }
  return { status: res.status, json };
}

const bytes = (s: string): Buffer => Buffer.from(s, 'utf8');
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const uploads = `/api/p/${KEY}/verification/uploads`;
const ingest = `/api/p/${KEY}/verification`;

/** Request a grant for a required artifact of the contract under `attemptId`. */
async function requestGrant(attemptId: string, body: Buffer, over: Record<string, unknown> = {}) {
  return req('POST', uploads, {
    bearer: RUNNER,
    json: { requestId: CONTRACT, attemptId, logicalPath: PATH, declaredSize: body.length, declaredSha256: sha(body), ...over },
  });
}

/** Canonical JSON matching the server's signing canonicalization. */
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
const derivedSecret = () => createHmac('sha256', MASTER).update(`verification-runner:v1:${ORG}:${PROJECT_ID}`).digest('hex');

/** A signed ingest envelope referencing an uploaded artifact. */
function signedEnvelope(attemptId: string, artifact: { path: string; sha256: string; sizeBytes: number; storageKey: string }) {
  const payload = {
    requestId: CONTRACT,
    orgId: ORG,
    projectId: PROJECT_ID,
    taskId: TASK,
    repoFullName: 'acme/widget',
    commitSha: COMMIT,
    dirty: false,
    uncommittedChangesDigest: null,
    runnerId: 'up-runner',
    runId: 'up-run',
    attemptId,
    environment: 'ci',
    source: 'local_runner' as const,
    checks: [{ name: 'unit', status: 'passed' as const, command: 'npm run unit', exitCode: 0, startedAt: '2026-09-21T00:00:00.000Z', finishedAt: '2026-09-21T00:00:01.000Z', detail: null }],
    artifacts: [artifact],
    catalogVersion: CAT_VERSION,
    catalogDigest: CAT_DIGEST,
    idempotencyKey: `idem-${randomUUID()}`,
    submittedAt: new Date().toISOString(),
  };
  return { runnerId: payload.runnerId, payload, signature: createHmac('sha256', derivedSecret()).update(canon(payload)).digest('hex') };
}

// Direct DB access (disposable test DB, superuser) for the expiry setup only.
type Sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => Promise<unknown[]>) & { end: () => Promise<void>; unsafe: (q: string, v?: unknown[]) => Promise<unknown[]> };
let sql: Sql;

beforeAll(async () => {
  if (!enabled) return;
  const { default: postgres } = await import('postgres');
  sql = postgres(DB_URL, { max: 1 }) as unknown as Sql;
});
afterAll(async () => {
  if (enabled && sql) await sql.end();
});

describe.skipIf(!enabled)('VER-002 PR-4 — grant issuance + binding', () => {
  it('issues a canonical grant for a required artifact; idempotent re-request; changed declaration conflicts', async () => {
    const body = bytes('{"passed":true,"a":1}');
    const first = await requestGrant(`att-${RUN}-issue`, body);
    expect(first.status).toBe(201);
    const grant = first.json.grant as Record<string, unknown>;
    expect(String(grant.objectKey)).toContain(`org/${ORG}/project/${PROJECT_ID}/request/${CONTRACT}/attempt/att-${RUN}-issue/`);

    const again = await requestGrant(`att-${RUN}-issue`, body);
    expect(again.status).toBe(200);
    expect((again.json.grant as Record<string, unknown>).grantId).toBe(grant.grantId);

    const changed = await requestGrant(`att-${RUN}-issue`, bytes('DIFFERENT bytes entirely'));
    expect(changed.status).toBe(409);
    expect(changed.json.code).toBe('grant_conflict');
  });

  it('rejects a non-required path and an unknown contract', async () => {
    const body = bytes('x');
    const notReq = await requestGrant(`att-${RUN}-x`, body, { logicalPath: 'nope.json' });
    expect(notReq.status).toBe(400);
    expect(notReq.json.code).toBe('path_not_required');
    const unknown = await req('POST', uploads, { bearer: RUNNER, json: { requestId: randomUUID(), attemptId: `att-${RUN}-x`, logicalPath: PATH, declaredSize: 1, declaredSha256: sha(body) } });
    expect(unknown.status).toBe(404);
  });
});

describe.skipIf(!enabled)('VER-002 PR-4 — redemption (stream → atomic create-only)', () => {
  it('happy path: stream exact bytes → completed; identical retry replays idempotently', async () => {
    const body = bytes('{"passed":true,"redeem":"happy"}');
    const g = (await requestGrant(`att-${RUN}-happy`, body)).json.grant as Record<string, unknown>;
    const up = await req('PUT', String(g.uploadPath), { bearer: RUNNER, body });
    expect(up.status).toBe(200);
    expect(up.json.completed).toBe(true);
    expect(up.json.idempotent).toBe(false);

    const again = await req('PUT', String(g.uploadPath), { bearer: RUNNER, body });
    expect(again.status).toBe(200);
    expect(again.json.idempotent).toBe(true);
  });

  it('checksum mismatch (422) and a truncated/short stream (400) create no object', async () => {
    const body = bytes('{"passed":true,"redeem":"bad"}');
    // Same LENGTH, different bytes → passes the size check, fails the checksum check.
    const g = (await requestGrant(`att-${RUN}-bad`, body)).json.grant as Record<string, unknown>;
    const tampered = await req('PUT', String(g.uploadPath), { bearer: RUNNER, body: bytes('{"passed":true,"redeem":"BAD"}') });
    expect(tampered.status).toBe(422);
    expect(tampered.json.code).toBe('checksum_mismatch');

    // An interrupted upload arrives as fewer bytes than declared → rejected, nothing published.
    const g2 = (await requestGrant(`att-${RUN}-trunc`, body)).json.grant as Record<string, unknown>;
    const truncated = await req('PUT', String(g2.uploadPath), { bearer: RUNNER, body: bytes('{"passed"') });
    expect(truncated.status).toBe(400);
    expect(truncated.json.code).toBe('size_mismatch');
  });

  it('concurrent redemption of one grant → both complete, exactly one object, no overwrite', async () => {
    const body = bytes('{"passed":true,"redeem":"concurrent"}');
    const g = (await requestGrant(`att-${RUN}-conc`, body)).json.grant as Record<string, unknown>;
    const [a, b] = await Promise.all([
      req('PUT', String(g.uploadPath), { bearer: RUNNER, body }),
      req('PUT', String(g.uploadPath), { bearer: RUNNER, body }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.json.completed && b.json.completed).toBe(true);
    // Exactly ONE redemption is the primary create (neither idempotent nor reconciled); the other either
    // short-circuits on the committed completion (idempotent) or reconciles the landed object — never a
    // second object, never an overwrite.
    const primary = [a, b].filter((r) => !r.json.idempotent && !r.json.reconciled);
    expect(primary.length).toBe(1);
  });

  it('crash-after-write recovery: an object present without a completion event → reconciled', async () => {
    const body = bytes('{"passed":true,"redeem":"crash"}');
    const g = (await requestGrant(`att-${RUN}-crash`, body)).json.grant as Record<string, unknown>;
    // Simulate a crash between the object write and the event append: place the object, no redemption event.
    const objPath = join(STORE_DIR, String(g.objectKey));
    mkdirSync(dirname(objPath), { recursive: true });
    writeFileSync(objPath, body);
    const up = await req('PUT', String(g.uploadPath), { bearer: RUNNER, body });
    expect(up.status).toBe(200);
    expect(up.json.completed).toBe(true);
    expect(up.json.reconciled).toBe(true);
  });

  it('expiry: refuses NEW creation when expired+absent (410); reconciles an existing object after expiry', async () => {
    const body = bytes('{"passed":true,"redeem":"expiry"}');
    // Insert two grants with a PAST expiry directly (INSERT is allowed; the append-only trigger is on UPDATE/DELETE).
    const mkExpired = async (attempt: string): Promise<string> => {
      const id = randomUUID();
      const objectKey = `org/${ORG}/project/${PROJECT_ID}/request/${CONTRACT}/attempt/${attempt}/${randomUUID()}`;
      await sql.unsafe(
        `insert into verification_upload_grants
           (id, org_id, project_id, request_id, attempt_id, logical_path, object_key, declared_size, declared_sha256, content_type, expires_at, max_upload_ms)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'application/octet-stream', now() - interval '1 hour', 300000)`,
        [id, ORG, PROJECT_ID, CONTRACT, attempt, PATH, objectKey, body.length, sha(body)],
      );
      return objectKey;
    };
    const absentKey = await mkExpired(`att-${RUN}-exp-absent`);
    const uploadPathFor = (id: string) => `${uploads}/${id}`;
    // Find the grant ids we just inserted.
    const absentRow = ((await sql.unsafe(`select id from verification_upload_grants where object_key = $1`, [absentKey])) as { id: string }[])[0]!;
    const expiredAbsent = await req('PUT', uploadPathFor(absentRow.id), { bearer: RUNNER, body });
    expect(expiredAbsent.status).toBe(410);
    expect(expiredAbsent.json.code).toBe('grant_expired');

    const presentKey = await mkExpired(`att-${RUN}-exp-present`);
    const objPath = join(STORE_DIR, presentKey);
    mkdirSync(dirname(objPath), { recursive: true });
    writeFileSync(objPath, body); // object landed before the crash/expiry
    const presentRow = ((await sql.unsafe(`select id from verification_upload_grants where object_key = $1`, [presentKey])) as { id: string }[])[0]!;
    const expiredPresent = await req('PUT', uploadPathFor(presentRow.id), { bearer: RUNNER, body });
    expect(expiredPresent.status).toBe(200);
    expect(expiredPresent.json.completed).toBe(true);
    expect(expiredPresent.json.reconciled).toBe(true);
  });

  it('an ACTUAL interrupted/cancelled stream leaves no object, no completion, and no leftover temp file', async () => {
    const body = bytes('{"passed":true,"redeem":"cancel"}');
    const g = (await requestGrant('att-cancel', body)).json.grant as Record<string, unknown>;
    // A request body that emits one chunk then ERRORS mid-stream — a genuine interrupted upload, not an
    // undersized-but-complete body.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"passed"'));
        setTimeout(() => controller.error(new Error('client reset mid-upload')), 20);
      },
    });
    let clientFailed = false;
    try {
      await fetch(`${BASE}${String(g.uploadPath)}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${RUNNER}`, 'content-type': 'application/octet-stream' },
        body: stream,
        // @ts-expect-error Node/undici requires duplex for a streaming request body
        duplex: 'half',
        redirect: 'error',
      });
    } catch {
      clientFailed = true; // the errored body aborts the request
    }
    expect(clientFailed).toBe(true);
    // No object was published at the grant's key.
    expect(existsSync(join(STORE_DIR, String(g.objectKey)))).toBe(false);
    // The temp file was cleaned up (poll briefly for the server's finally to run).
    const tmpDir = join(STORE_DIR, '.uploads-tmp');
    let tmpCount = 1;
    for (let i = 0; i < 30; i++) {
      tmpCount = existsSync(tmpDir) ? readdirSync(tmpDir).length : 0;
      if (tmpCount === 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(tmpCount).toBe(0);
    // The grant was never marked uploaded.
    const rows = (await sql.unsafe(
      `select count(*)::int c from verification_upload_grant_events where grant_id = $1 and event_type = 'uploaded'`,
      [String(g.grantId)],
    )) as { c: number }[];
    expect(rows[0]!.c).toBe(0);
  });

  it.skipIf(!ADMIN_COOKIE)('a non-runner (human session) is refused (403) on the redeem path', async () => {
    // Runner-only: a human session may not redeem. The body-cancel cleanup on this early return is proven
    // deterministically by the route-unit tests (tests/unit/verification-upload-redeem-route.test.ts).
    const body = bytes('{"passed":true,"redeem":"human"}');
    const g = (await requestGrant('att-human', body)).json.grant as Record<string, unknown>;
    const res = await fetch(`${BASE}${String(g.uploadPath)}`, {
      method: 'PUT',
      headers: { cookie: ADMIN_COOKIE, 'content-type': 'application/octet-stream' },
      body: new Uint8Array(body),
      redirect: 'error',
    });
    expect(res.status).toBe(403);
  });

  it('a later failed retry cannot undo a completion', async () => {
    const body = bytes('{"passed":true,"redeem":"survive"}');
    const g = (await requestGrant(`att-${RUN}-survive`, body)).json.grant as Record<string, unknown>;
    await req('PUT', String(g.uploadPath), { bearer: RUNNER, body });
    // A later retry with WRONG bytes short-circuits to idempotent success — completion stands.
    const bad = await req('PUT', String(g.uploadPath), { bearer: RUNNER, body: bytes('WRONG') });
    expect(bad.status).toBe(200);
    expect(bad.json.idempotent).toBe(true);
  });
});

describe.skipIf(!enabled)('VER-002 PR-4 — ingest binds to a successful grant', () => {
  it('an uploaded artifact ingests and verifies; a cross-attempt or field-mismatch reference is rejected', async () => {
    const body = bytes('{"passed":true,"ingest":"ok"}');
    const g = (await requestGrant(`att-${RUN}-ingest`, body)).json.grant as Record<string, unknown>;
    const up = await req('PUT', String(g.uploadPath), { bearer: RUNNER, body });
    expect(up.status).toBe(200);
    const objectKey = String(g.objectKey);
    const artifact = { path: PATH, sha256: sha(body), sizeBytes: body.length, storageKey: objectKey };

    // Bound correctly → accepted (verified_complete).
    const ok = await req('POST', ingest, { bearer: RUNNER, json: signedEnvelope(`att-${RUN}-ingest`, artifact) });
    const okd = ok.json.decision as { accepted: boolean; status: string };
    expect(okd.accepted).toBe(true);
    expect(okd.status).toBe('verified_complete');

    // Same object referenced from a DIFFERENT attempt → no grant for (contract, att-OTHER, path) → rejected.
    const cross = await req('POST', ingest, { bearer: RUNNER, json: signedEnvelope(`att-${RUN}-OTHER`, artifact) });
    expect((cross.json.decision as { rejection?: { code: string } }).rejection?.code).toBe('artifact_not_granted');

    // Correct attempt but a mismatched declared size → grant_binding_mismatch.
    const mismatch = await req('POST', ingest, { bearer: RUNNER, json: signedEnvelope(`att-${RUN}-ingest`, { ...artifact, sizeBytes: body.length + 1 }) });
    expect((mismatch.json.decision as { rejection?: { code: string } }).rejection?.code).toBe('grant_binding_mismatch');
  });
});
