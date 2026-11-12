/**
 * VER-002 PR-8 — stage 2. The refusals that keep a signature honest, plus the HTTP contract.
 *
 * `buildSubmission` is the hinge of the trust model, so most of this file is about what it will NOT
 * sign: records from another run, records whose isolation was not enforced, a narrowed set of
 * required checks, a command that drifted from the pinned catalog, or a missing required artifact.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  buildSubmission,
  deriveIdempotencyKey,
  SubmissionError,
  HubClient,
  HubError,
  withRetries,
  assertCommitMatchesContract,
} from '../../services/verification-runner/src/attest';
import type { HarnessRecord, IsolationReport } from '../../services/verification-runner/src/harness';
import { probeIsolation } from '../../services/verification-runner/src/harness';
import type { ResolvedCatalog } from '../../services/verification-runner/src/catalog';
import type { VerificationContract } from '../../services/verification-runner/src/contract';

/**
 * A fully-enforced report, written as a LITERAL rather than derived from `probeIsolation`.
 *
 * Deriving it would make these tests platform-dependent for the wrong reason: `probeIsolation`
 * correctly refuses to report `enforced` on win32 (no uid support), so a derived fixture would be
 * unenforced on a Windows dev box and enforced on Linux CI — and every assertion below about
 * `buildSubmission` would silently test the opposite thing depending on where it ran. These tests
 * are about how `buildSubmission` REACTS to a report; `probeIsolation`'s own platform behaviour is
 * asserted in verification-runner-harness.test.ts.
 */
const ENFORCED: IsolationReport = {
  enforced: true,
  controls: { separateExecutionUid: true, sandboxed: true, egressDenied: true, sinkUnreachableByExecution: true },
  gaps: [],
  platform: 'linux',
};

const UNENFORCED = probeIsolation({});

const CATALOG: ResolvedCatalog = {
  version: '2026-09-21',
  digest: 'f'.repeat(64),
  commands: { unit: 'npm run test:unit', lint: 'npm run lint' },
};

const CONTRACT: VerificationContract = {
  id: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222',
  projectId: '33333333-3333-4333-8333-333333333333',
  taskId: '44444444-4444-4444-8444-444444444444',
  repoFullName: 'acme/widget',
  expectedCommitSha: 'a'.repeat(40),
  requiredChecks: ['unit'],
  requiredArtifacts: [],
  catalogVersion: CATALOG.version,
  catalogDigest: CATALOG.digest,
};

const REPO = { commitSha: 'a'.repeat(40), dirty: false, uncommittedChangesDigest: null };

function record(over: Partial<HarnessRecord> = {}): HarnessRecord {
  return {
    schema: 'king-verification-harness/v1',
    name: 'unit',
    command: 'npm run test:unit',
    status: 'passed',
    exitCode: 0,
    timedOut: false,
    startedAt: '2026-11-12T00:00:00.000Z',
    finishedAt: '2026-11-12T00:01:00.000Z',
    durationMs: 60_000,
    outputDigest: null,
    outputBytes: 0,
    isolation: ENFORCED,
    runId: 'run-1',
    ...over,
  };
}

const BASE = {
  contract: CONTRACT,
  catalog: CATALOG,
  repo: REPO,
  artifacts: [],
  runnerId: 'runner-1',
  runId: 'run-1',
  attemptId: 'attempt-1',
  environment: 'ci',
  submittedAt: '2026-11-12T00:01:01.000Z',
};

describe('PR-8 attest — what it refuses to sign', () => {
  it('refuses records whose isolation was not enforced, unless acknowledged', () => {
    const input = { ...BASE, records: [record({ isolation: UNENFORCED })] };
    expect(() => buildSubmission(input)).toThrow(SubmissionError);
    expect(() => buildSubmission(input)).toThrow(/isolation was not enforced/);
    const ok = buildSubmission({ ...input, acknowledgeUnisolated: true });
    expect(ok.checks).toHaveLength(1);
  });

  it('refuses records carried over from a different run', () => {
    expect(() => buildSubmission({ ...BASE, records: [record({ runId: 'run-OLD' })] })).toThrow(/records from other runs/);
  });

  it('refuses when a required check has no harness record (a runner cannot narrow the contract)', () => {
    const contract = { ...CONTRACT, requiredChecks: ['unit', 'lint'] };
    expect(() => buildSubmission({ ...BASE, contract, records: [record()] })).toThrow(/no record for required check\(s\): lint/);
  });

  it('refuses a command that drifted from the pinned catalog', () => {
    expect(() => buildSubmission({ ...BASE, records: [record({ command: 'true' })] })).toThrow(/catalog approves/);
  });

  it('refuses when a required artifact is absent from the submission', () => {
    const contract = { ...CONTRACT, requiredArtifacts: ['test-results.json'] };
    expect(() => buildSubmission({ ...BASE, contract, records: [record()] })).toThrow(/missing required artifact\(s\)/);
  });

  it('refuses a structurally invalid record rather than signing around it', () => {
    expect(() => buildSubmission({ ...BASE, records: [{ schema: 'nope' }] })).toThrow(/unknown record schema/);
  });
});

describe('PR-8 attest — what it builds', () => {
  it('takes requirements from the contract and facts from the records', () => {
    const payload = buildSubmission({ ...BASE, records: [record()] });
    expect(payload.requestId).toBe(CONTRACT.id);
    expect(payload.orgId).toBe(CONTRACT.orgId);
    expect(payload.source).toBe('local_runner');
    expect(payload.catalogVersion).toBe(CATALOG.version);
    expect(payload.catalogDigest).toBe(CATALOG.digest);
    expect(payload.checks).toEqual([
      {
        name: 'unit',
        status: 'passed',
        command: 'npm run test:unit',
        exitCode: 0,
        startedAt: '2026-11-12T00:00:00.000Z',
        finishedAt: '2026-11-12T00:01:00.000Z',
        durationMs: 60_000,
        outputDigest: null,
      },
    ]);
  });

  it('orders checks by the contract, not by whatever order the sink yielded', () => {
    const contract = { ...CONTRACT, requiredChecks: ['unit', 'lint'] };
    const records = [record({ name: 'lint', command: 'npm run lint' }), record({ name: 'unit' })];
    const payload = buildSubmission({ ...BASE, contract, records });
    expect(payload.checks.map((c) => c.name)).toEqual(['unit', 'lint']);
  });

  it('carries a failing check through rather than hiding it', () => {
    const payload = buildSubmission({ ...BASE, records: [record({ status: 'failed', exitCode: 1 })] });
    expect(payload.checks[0]?.status).toBe('failed');
    expect(payload.checks[0]?.exitCode).toBe(1);
  });

  it('propagates dirty-tree facts into the signed payload', () => {
    const repo = { commitSha: 'a'.repeat(40), dirty: true, uncommittedChangesDigest: 'b'.repeat(64) };
    const payload = buildSubmission({ ...BASE, repo, records: [record()] });
    expect(payload.dirty).toBe(true);
    expect(payload.uncommittedChangesDigest).toBe('b'.repeat(64));
  });
});

describe('PR-8 attest — idempotency key is deterministic, not random', () => {
  it('is stable across identical rebuilds, so a retried submit replays instead of duplicating', () => {
    const a = buildSubmission({ ...BASE, records: [record()] });
    const b = buildSubmission({ ...BASE, records: [record()] });
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
    expect(a.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the attempt, commit, or a check result changes', () => {
    const basis = { requestId: CONTRACT.id, attemptId: 'attempt-1', commitSha: 'a'.repeat(40), records: [record()] };
    const base = deriveIdempotencyKey(basis);
    expect(deriveIdempotencyKey({ ...basis, attemptId: 'attempt-2' })).not.toBe(base);
    expect(deriveIdempotencyKey({ ...basis, commitSha: 'b'.repeat(40) })).not.toBe(base);
    expect(deriveIdempotencyKey({ ...basis, records: [record({ status: 'failed', exitCode: 1 })] })).not.toBe(base);
  });
});

describe('PR-8 attest — commit pinning', () => {
  it('refuses a checkout that is not at the pinned commit', () => {
    expect(() => assertCommitMatchesContract(CONTRACT, { ...REPO, commitSha: 'c'.repeat(40) })).toThrow(/contract pins/);
  });

  it('compares case-insensitively, matching the Hub', () => {
    expect(() => assertCommitMatchesContract({ expectedCommitSha: 'A'.repeat(40) }, REPO)).not.toThrow();
  });
});

describe('PR-8 attest — HTTP contract', () => {
  function clientWith(responder: (url: string, init: RequestInit) => Response): HubClient {
    return new HubClient({
      baseUrl: 'https://hub.example.com/',
      projectKey: 'proj',
      keyId: 'key-1',
      keySecret: 'secret-1',
      fetchImpl: ((url: string, init: RequestInit) => Promise.resolve(responder(String(url), init))) as unknown as typeof fetch,
    });
  }

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('sends the bearer credential as a header and never in the URL', async () => {
    const seen: { url?: string; auth?: string } = {};
    const c = clientWith((url, init) => {
      seen.url = url;
      seen.auth = new Headers(init.headers).get('authorization') ?? undefined;
      return json({ requests: [] });
    });
    await c.listContracts();
    expect(seen.auth).toBe('Bearer key-1.secret-1');
    expect(seen.url).toBe('https://hub.example.com/api/p/proj/verification/requests');
    expect(seen.url).not.toContain('secret-1');
  });

  it('maps 507 to a non-retryable quota_exceeded, because the project is full', async () => {
    const c = clientWith(() => json({ error: 'quota_exceeded' }, 507));
    const err = await c
      .requestGrant({ requestId: 'r', attemptId: 'a', logicalPath: 'p', declaredSize: 1, declaredSha256: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HubError);
    expect((err as HubError).kind).toBe('quota_exceeded');
    expect((err as HubError).retryable).toBe(false);
  });

  it('maps the documented upload failures to distinct, non-retryable kinds', async () => {
    const cases: readonly [number, string][] = [
      [403, 'forbidden_or_disabled'],
      [404, 'not_found'],
      [409, 'conflict'],
      [410, 'gone'],
      [413, 'payload_too_large'],
      [422, 'unprocessable'],
    ];
    for (const [status, kind] of cases) {
      const c = clientWith(() => json({ error: kind }, status));
      const err = (await c.redeemGrant('/api/p/proj/verification/uploads/g1', new Uint8Array([1]), 'application/json').catch((e: unknown) => e)) as HubError;
      expect(err.kind).toBe(kind);
      expect(err.retryable).toBe(false);
    }
  });

  it('treats only 5xx and 503 as retryable', async () => {
    for (const status of [500, 502, 503]) {
      const c = clientWith(() => json({ error: 'boom' }, status));
      const err = (await c.listContracts().catch((e: unknown) => e)) as HubError;
      expect(err.retryable).toBe(true);
    }
  });

  it('flags a malformed success body instead of returning undefined', async () => {
    const c = clientWith(() => json({ unexpected: true }));
    const err = (await c.listContracts().catch((e: unknown) => e)) as HubError;
    expect(err.kind).toBe('malformed_response');
  });

  it('reports accepted only when the Hub says accepted: true', async () => {
    const yes = clientWith(() => json({ accepted: true }));
    const no = clientWith(() => json({ accepted: false, rejection: { code: 'catalog_mismatch' } }));
    expect((await yes.submitEvidence({ runnerId: 'r', payload: {} as never, signature: 's' })).accepted).toBe(true);
    expect((await no.submitEvidence({ runnerId: 'r', payload: {} as never, signature: 's' })).accepted).toBe(false);
  });

  it('refuses to construct without a credential', () => {
    expect(() => new HubClient({ baseUrl: 'https://h', projectKey: 'p', keyId: '', keySecret: 's' })).toThrow(/keyId and keySecret/);
  });
});

describe('PR-8 attest — retry policy', () => {
  it('retries a retryable failure and succeeds', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new HubError('server_error', 500, 'boom'))
      .mockResolvedValueOnce('ok');
    await expect(withRetries(fn, 3)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a settled refusal', async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(new HubError('conflict', 409, 'declared differently'));
    await expect(withRetries(fn, 3)).rejects.toThrow(/declared differently/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts and surfaces the last error', async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(new HubError('server_error', 500, 'still down'));
    await expect(withRetries(fn, 2)).rejects.toThrow(/still down/);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
