/**
 * REAL integration test for VER-002 ingestion (Area 4 of the review).
 *
 * Exercises the ACTUAL Drizzle store, tenant transaction (withTenant + RLS), and
 * the object-store artifact adapter against a live Postgres — never production.
 *
 * Prerequisites (all local/isolated):
 *   1. Docker running; `npm run db:up` (Postgres on :5433).
 *   2. `npm run db:bootstrap` then apply migration 0069 + the rls.sql verification
 *      block to the local DB (see drizzle/0069_verification_ingest.sql).
 *   3. Export DATABASE_URL and a project you own to test against:
 *        DATABASE_URL, VER_INT_ORG_ID, VER_INT_PROJECT_ID, VER_INT_TASK_ID
 *   4. `STORAGE_DRIVER=local` (default) so the artifact adapter has a backend.
 *
 * It self-skips unless those are set, so the normal unit run is unaffected.
 * STATUS AT REVIEW TIME: NOT VERIFIED — Docker Desktop was not running, so no
 * local Postgres could be started. Run this once the DB is up to close Area 4.
 */
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withTenant } from '@/db/tenant';
import { verificationEvidence } from '@/db/schema';
import { getObjectStore } from '@/domain/documents/object-store';
import {
  ingestEvidence,
  signEvidence,
  StaticRunnerSecretSource,
  type EvidenceSubmission,
  type IngestDeps,
  type SignedEnvelope,
} from '@/domain/verification';
import { createDrizzleVerificationStore } from '@/domain/verification/drizzle-store';
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
const COMMIT = 'a'.repeat(40);
const bytes = Buffer.from('{"passed":true}', 'utf8');
const artSha = createHash('sha256').update(bytes).digest('hex');
const artKey = `org/${ORG}/project/${PROJECT}/verification/test-results.json`;

function submission(over: Partial<EvidenceSubmission>): EvidenceSubmission {
  return {
    requestId: over.requestId!,
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
    checks: [{ name: 'unit', status: 'passed', command: 'npm test', exitCode: 0, startedAt: null, finishedAt: null, detail: null }],
    artifacts: [{ path: 'test-results.json', sha256: artSha, sizeBytes: bytes.length, storageKey: artKey }],
    idempotencyKey: 'int-idem-1',
    submittedAt: new Date().toISOString(),
    ...over,
  };
}
const sign = (p: EvidenceSubmission): SignedEnvelope => ({ runnerId: p.runnerId, payload: p, signature: signEvidence(SECRET, p) });

const deps = (tx: Parameters<Parameters<typeof withTenant>[1]>[0]): IngestDeps => ({
  store: createDrizzleVerificationStore(tx),
  artifacts: objectStoreArtifactStore(ctx),
  secrets: new StaticRunnerSecretSource(new Map([[`${ORG}|${PROJECT}`, SECRET]])),
});

async function seedRequest(): Promise<string> {
  return withTenant(ctx, async (tx) => {
    const id = crypto.randomUUID();
    await tx.execute(sql`
      insert into verification_requests (id, org_id, project_id, task_id, repo_full_name, expected_commit_sha, required_checks, allow_dirty)
      values (${id}, ${ORG}, ${PROJECT}, ${TASK}, 'acme/widget', ${COMMIT}, ${JSON.stringify(['unit'])}::jsonb, false)`);
    return id;
  });
}

describe.skipIf(!enabled)('VER-002 real integration (DB + store + artifact adapter)', () => {
  it('accepts valid evidence and persists a verified decision', async () => {
    await getObjectStore().then((s) => s.put(artKey, bytes, 'application/json'));
    const requestId = await seedRequest();
    const decision = await withTenant(ctx, (tx) => ingestEvidence(deps(tx), ctx, sign(submission({ requestId, idempotencyKey: `ok-${requestId}` }))));
    expect(decision.status).toBe('verified_complete');
    expect(decision.deliverable).toBe(true);
  });

  it('enforces DB uniqueness under concurrent duplicate submissions (one row wins)', async () => {
    await getObjectStore().then((s) => s.put(artKey, bytes, 'application/json'));
    const requestId = await seedRequest();
    const key = `conc-${requestId}`;
    const env = sign(submission({ requestId, idempotencyKey: key }));
    const [a, b] = await Promise.all([
      withTenant(ctx, (tx) => ingestEvidence(deps(tx), ctx, env)),
      withTenant(ctx, (tx) => ingestEvidence(deps(tx), ctx, env)),
    ]);
    expect(a.status).toBe(b.status); // same decision, no divergence
    const rows = await withTenant(ctx, (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(verificationEvidence)
        .where(and(eq(verificationEvidence.orgId, ORG), eq(verificationEvidence.projectId, PROJECT), eq(verificationEvidence.idempotencyKey, key))),
    );
    expect(rows[0]?.n).toBe(1); // unique constraint held
  });

  it('cannot read a verification_request from another project (tenant isolation)', async () => {
    const requestId = await seedRequest();
    const otherCtx = { ...ctx, projectId: '11111111-1111-1111-1111-111111111111' } as TenantContext;
    const found = await withTenant(otherCtx, (tx) => createDrizzleVerificationStore(tx).getRequest(otherCtx.orgId, otherCtx.projectId, requestId));
    expect(found).toBeNull();
  });
});
