/**
 * REAL integration test for VER-002 ingestion (Area 4 / round-3 finding 4).
 *
 * Exercises the ACTUAL Drizzle store, tenant transaction (withTenant + RLS), and
 * the object-store artifact adapter against a live, DISPOSABLE Postgres — never
 * production, never real customer credentials.
 *
 * Prerequisites (all local/isolated):
 *   1. Docker running; `npm run db:up` (Postgres on :5433).
 *   2. `npm run db:bootstrap`; apply migration 0069 + the rls.sql verification block.
 *   3. Export: DATABASE_URL, VER_INT_ORG_ID, VER_INT_PROJECT_ID, VER_INT_TASK_ID.
 *   4. STORAGE_DRIVER=local (default) so the artifact adapter has a backend.
 *   Optional real-HTTP case: VER_INT_BASE_URL, VER_INT_PROJECT_KEY, VER_INT_COOKIE,
 *   VERIFICATION_RUNNER_MASTER_SECRET (to sign with the route's derived per-project key).
 *
 * Self-skips unless the env is set, so the normal unit run is unaffected.
 * STATUS AT REVIEW TIME: NOT VERIFIED — Docker Desktop was not running, so no
 * local Postgres could be started. The DB-role guard below fails LOUDLY if the
 * runtime role is a superuser / BYPASSRLS, so RLS assertions can never be masked.
 */
import { createHash, createHmac } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@/db/tenant';
import { verificationEvidence, verificationRequests } from '@/db/schema';
import { getObjectStore } from '@/domain/documents/object-store';
import {
  ingestEvidence,
  InMemoryCatalogResolver,
  signEvidence,
  StaticRunnerSecretSource,
  type CheckResult,
  type EvidenceSubmission,
  type IngestDeps,
  type SignedEnvelope,
} from '@/domain/verification';
import { createDrizzleUploadGrantStore, createDrizzleVerificationStore } from '@/domain/verification/drizzle-store';
import { objectStoreArtifactStore } from '@/domain/verification/runtime-adapters';
import type { TenantContext } from '@/types/domain';

const ORG = process.env.VER_INT_ORG_ID ?? '';
const PROJECT = process.env.VER_INT_PROJECT_ID ?? '';
const TASK = process.env.VER_INT_TASK_ID ?? '';
const enabled = Boolean(process.env.DATABASE_URL && ORG && PROJECT && TASK);

const ctx = {
  userId: '00000000-0000-0000-0000-000000000000',
  orgId: ORG,
  projectId: PROJECT,
  orgRole: 'owner',
  projectRole: 'admin',
} as unknown as TenantContext;

const SECRET = 'integration-runner-secret';
const CAT = { version: 'int-cat-v1', digest: 'intdigest01', commands: { unit: 'npm test' } } as const;
const COMMIT = 'a'.repeat(40);
const bytes = Buffer.from('{"passed":true}', 'utf8');
const artSha = createHash('sha256').update(bytes).digest('hex');
// Unique, test-owned artifact key per request (namespaced, cleaned up individually).
const artKeyFor = (requestId: string): string => `org/${ORG}/project/${PROJECT}/verification/int-${requestId}/test-results.json`;

const validCheck: CheckResult = {
  name: 'unit',
  status: 'passed',
  command: 'npm test',
  exitCode: 0,
  startedAt: '2026-09-20T00:00:00.000Z',
  finishedAt: '2026-09-20T00:00:05.000Z',
  detail: null,
};

function submission(over: Partial<EvidenceSubmission> & { requestId: string }): EvidenceSubmission {
  return {
    orgId: ORG,
    projectId: PROJECT,
    taskId: TASK,
    repoFullName: 'acme/widget',
    commitSha: COMMIT,
    dirty: false,
    uncommittedChangesDigest: null,
    runnerId: 'int-runner',
    runId: 'run-int',
    attemptId: 'att-int',
    environment: 'integration',
    source: 'local_runner',
    checks: [validCheck],
    artifacts: [{ path: 'test-results.json', sha256: artSha, sizeBytes: bytes.length, storageKey: artKeyFor(over.requestId) }],
    catalogVersion: CAT.version,
    catalogDigest: CAT.digest,
    idempotencyKey: `idem-${over.requestId}`,
    submittedAt: new Date().toISOString(),
    ...over,
  };
}
const sign = (p: EvidenceSubmission): SignedEnvelope => ({ runnerId: p.runnerId, payload: p, signature: signEvidence(SECRET, p) });

const deps = (tx: Parameters<Parameters<typeof withTenant>[1]>[0]): IngestDeps => ({
  store: createDrizzleVerificationStore(tx),
  artifacts: objectStoreArtifactStore(ctx),
  secrets: new StaticRunnerSecretSource(new Map([[`${ORG}|${PROJECT}`, SECRET]])),
  catalog: (() => {
    const c = new InMemoryCatalogResolver();
    c.addVersion({ version: CAT.version, digest: CAT.digest, commands: CAT.commands });
    return c;
  })(),
  // Legacy 0071-era test (self-skips unless VER_INT_* set; superseded by verification-upload-grant.int).
  // The PR-4 grant-binding source is wired for compilation; a full run would also seed uploaded grants.
  grants: createDrizzleUploadGrantStore(tx),
});

const createdRequestIds: string[] = [];
const createdArtifactKeys: string[] = [];

async function seedRequest(): Promise<string> {
  const id = crypto.randomUUID();
  await withTenant(ctx, async (tx) => {
    await tx.execute(sql`
      insert into verification_requests
        (id, org_id, project_id, task_id, repo_full_name, expected_commit_sha, required_checks, required_artifacts, allow_dirty, catalog_version, catalog_digest)
      values
        (${id}, ${ORG}, ${PROJECT}, ${TASK}, 'acme/widget', ${COMMIT},
         ${JSON.stringify(['unit'])}::jsonb, ${JSON.stringify(['test-results.json'])}::jsonb, false, ${CAT.version}, ${CAT.digest})`);
  });
  createdRequestIds.push(id);
  return id;
}

async function putArtifact(requestId: string): Promise<void> {
  const key = artKeyFor(requestId);
  await getObjectStore().then((s) => s.put(key, bytes, 'application/json'));
  createdArtifactKeys.push(key);
}

// Guard 1: the DB target must be a disposable LOCAL test database — never prod.
function assertDisposableDbTarget(): void {
  const url = new URL(process.env.DATABASE_URL ?? '');
  const host = url.hostname;
  const db = url.pathname.replace(/^\//, '');
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error(`refusing non-local DB host: ${host}`);
  if (!/_test$/.test(db)) throw new Error(`refusing DB that is not a *_test database: ${db}`);
  if (/prod|production|staging/i.test(db) || /prod|production|staging/i.test(host)) throw new Error(`refusing production/staging target: ${host}/${db}`);
}

// Guard 2: a disposable, non-superuser runtime role. If the connection is a
// superuser or BYPASSRLS, RLS assertions would be meaningless — fail loudly.
beforeAll(async () => {
  if (!enabled) return;
  assertDisposableDbTarget();
  const rows = await withTenant(ctx, (tx) =>
    tx.execute(sql`select current_user as who, rolsuper, rolbypassrls from pg_roles where rolname = current_user`),
  );
  const row = (rows as unknown as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }>)[0];
  expect(row?.rolsuper, 'runtime role must not be a superuser').toBe(false);
  expect(row?.rolbypassrls, 'runtime role must not have BYPASSRLS').toBe(false);
});

// Clean up ONLY the records/objects this test created.
afterAll(async () => {
  if (!enabled) return;
  const store = await getObjectStore();
  for (const key of createdArtifactKeys) await store.delete(key).catch(() => undefined);
  for (const id of createdRequestIds) {
    await withTenant(ctx, async (tx) => {
      await tx.execute(sql`delete from verification_evidence where request_id = ${id}`);
      await tx.execute(sql`delete from verification_requests where id = ${id}`);
    });
  }
});

describe.skipIf(!enabled)('VER-002 real integration (DB + store + artifact adapter)', () => {
  it('accepts valid evidence and persists a verified decision', async () => {
    const requestId = await seedRequest();
    await putArtifact(requestId);
    const decision = await withTenant(ctx, (tx) => ingestEvidence(deps(tx), ctx, sign(submission({ requestId }))));
    expect(decision.status).toBe('verified_complete');
    expect(decision.deliverable).toBe(true);
  });

  it('a conflicting concurrent submission (same key, different content) preserves the first decision', async () => {
    const requestId = await seedRequest();
    await putArtifact(requestId);
    const key = `conflict-${requestId}`;
    const a = sign(submission({ requestId, idempotencyKey: key, runId: 'run-A' }));
    const b = sign(submission({ requestId, idempotencyKey: key, runId: 'run-B' })); // different digest, same key
    const [ra, rb] = await Promise.all([
      withTenant(ctx, (tx) => ingestEvidence(deps(tx), ctx, a)),
      withTenant(ctx, (tx) => ingestEvidence(deps(tx), ctx, b)),
    ]);
    // Exactly one wins; the other is an explicit conflict — never the winner's success.
    const outcomes = [ra, rb].map((r) => (r.rejection?.code === 'idempotency_conflict' ? 'conflict' : r.status)).sort();
    expect(outcomes).toEqual(['conflict', 'verified_complete']);
    const rows = await withTenant(ctx, (tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(verificationEvidence).where(and(eq(verificationEvidence.requestId, requestId), eq(verificationEvidence.idempotencyKey, key))),
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('RLS blocks a cross-project read directly — no app-level project filter in the query', async () => {
    const requestId = await seedRequest();
    const otherCtx = { ...ctx, projectId: '11111111-1111-1111-1111-111111111111' } as TenantContext;
    const rows = await withTenant(otherCtx, (tx) =>
      tx.select({ id: verificationRequests.id }).from(verificationRequests).where(eq(verificationRequests.id, requestId)),
    );
    expect(rows.length).toBe(0);
  });
});

// Actual HTTP route — AUTH REJECTION (no valid session needed). Requires only a
// running local server. Confirms missing/invalid authentication is refused (401)
// and that requests never follow a redirect outside the allowed local endpoint.
const routeEnabled = Boolean(process.env.VER_INT_BASE_URL && process.env.VER_INT_PROJECT_KEY);
function assertLocalHttp(base: string): void {
  const u = new URL(base);
  if (u.protocol !== 'http:' || !['localhost', '127.0.0.1', '::1'].includes(u.hostname)) {
    throw new Error(`refusing non-local HTTP target: ${base}`);
  }
}
describe.skipIf(!routeEnabled)('VER-002 actual HTTP route — authentication rejection', () => {
  const base = process.env.VER_INT_BASE_URL ?? '';
  const key = process.env.VER_INT_PROJECT_KEY ?? '';
  const url = `${base}/api/p/${key}/verification`;
  const body = JSON.stringify({
    runnerId: 'r',
    signature: 'x',
    payload: submission({ requestId: '00000000-0000-0000-0000-000000000000' }),
  });

  it('rejects a submission with NO authentication (401), no external redirect', async () => {
    assertLocalHttp(base);
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'error' });
    expect(res.status).toBe(401);
    expect(new URL(res.url).hostname).toMatch(/^(localhost|127\.0\.0\.1|::1)$/);
  });
});

// Invalid auth in the ACTUAL @supabase/ssr cookie format, carrying a synthetic
// INVALID token. Asserts the request is refused (401) AND that the local stub
// actually RECEIVED the token and REJECTED it (evidence via /debug/requests) —
// so the 401 is proven to come from the stub validating a bad token, not from a
// malformed cookie the client silently ignored.
interface StubReq {
  readonly method: string;
  readonly url: string;
  readonly tokenValid?: boolean;
  readonly status: number;
}
const invalidTokenEnabled = Boolean(routeEnabled && process.env.VER_INT_COOKIE_INVALID && process.env.VER_INT_STUB_URL);
describe.skipIf(!invalidTokenEnabled)('VER-002 actual HTTP route — SSR-format invalid token', () => {
  const base = process.env.VER_INT_BASE_URL ?? '';
  const key = process.env.VER_INT_PROJECT_KEY ?? '';
  const stub = process.env.VER_INT_STUB_URL ?? '';
  const url = `${base}/api/p/${key}/verification`;
  const cookie = process.env.VER_INT_COOKIE_INVALID ?? '';
  const body = JSON.stringify({ runnerId: 'r', signature: 'x', payload: submission({ requestId: '00000000-0000-0000-0000-000000000000' }) });
  const stubRequests = async (): Promise<StubReq[]> => {
    assertLocalHttp(stub);
    return (await (await fetch(`${stub}/debug/requests`, { redirect: 'error' })).json()) as StubReq[];
  };

  it('SSR cookie + synthetic invalid token → 401, and the stub received + rejected the token', async () => {
    assertLocalHttp(base);
    const before = await stubRequests();
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body, redirect: 'error' });
    expect(res.status).toBe(401);
    const added = (await stubRequests()).slice(before.length);
    // The server forwarded the invalid token to the stub's /auth/v1/user, which rejected it (401).
    expect(added.some((r) => r.url === '/auth/v1/user' && r.tokenValid === false && r.status === 401)).toBe(true);
  });
});

// Actual HTTP route — AUTHENTICATED SUCCESS + cross-project rejection, end to end:
// session auth (local stub) → tenant resolution (projectKey) → signature check →
// persistence → response. Requires the running server, a minted test-session
// cookie (VER_INT_COOKIE), the runner master secret, and a second project id for
// the cross-project case. All auth stays on localhost (stub); no real session.
const OTHER_PROJECT = process.env.VER_INT_OTHER_PROJECT_ID ?? '';
const authEnabled = Boolean(routeEnabled && enabled && process.env.VER_INT_COOKIE_VALID && process.env.VERIFICATION_RUNNER_MASTER_SECRET);
describe.skipIf(!authEnabled)('VER-002 actual HTTP route — authenticated success + cross-project', () => {
  const base = process.env.VER_INT_BASE_URL ?? '';
  const key = process.env.VER_INT_PROJECT_KEY ?? '';
  const url = `${base}/api/p/${key}/verification`;
  const cookie = process.env.VER_INT_COOKIE_VALID ?? '';
  const derived = createHmac('sha256', process.env.VERIFICATION_RUNNER_MASTER_SECRET ?? '')
    .update(`verification-runner:v1:${ORG}:${PROJECT}`)
    .digest('hex');
  const post = (payload: EvidenceSubmission) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ runnerId: payload.runnerId, payload, signature: signEvidence(derived, payload) }),
      redirect: 'error',
    });

  it('authenticated + correctly-signed submission → 200 verified_complete', async () => {
    assertLocalHttp(base);
    const requestId = await seedRequest();
    await putArtifact(requestId);
    const res = await post(submission({ requestId, idempotencyKey: `auth-ok-${requestId}` }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { decision: { status: string; deliverable: boolean } };
    expect(body.decision.status).toBe('verified_complete');
    expect(body.decision.deliverable).toBe(true);
  });

  it('authenticated but payload claims a DIFFERENT project → wrong_project rejection', async () => {
    const requestId = await seedRequest();
    await putArtifact(requestId);
    const res = await post(submission({ requestId, projectId: OTHER_PROJECT, idempotencyKey: `auth-xproj-${requestId}` }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { decision: { accepted: boolean; rejection: { code: string } | null } };
    expect(body.decision.accepted).toBe(false);
    expect(body.decision.rejection?.code).toBe('wrong_project');
  });
});

