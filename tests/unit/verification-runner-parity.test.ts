/**
 * VER-002 PR-8 — the parity guards. These are the most valuable tests in the PR.
 *
 * The reference runner duplicates two pieces of the Hub on purpose (an external runner cannot
 * import Hub internals): the canonical-JSON signing basis, and the catalog digest rule. Duplication
 * is only safe if drift is caught mechanically, so each guard imports BOTH implementations and
 * asserts they agree. If someone "improves" either side alone, these fail here rather than as an
 * opaque bad_signature or catalog_mismatch in production.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Hub side.
import { canonicalJson as hubCanonicalJson, signEvidence as hubSignEvidence } from '@/domain/verification/signing';
import { fileCatalogResolver } from '@/domain/verification/catalog';
import type { EvidenceSubmission as HubSubmission } from '@/domain/verification/ingest-types';

// Runner side.
import { canonicalJson as runnerCanonicalJson } from '../../services/verification-runner/src/canonical';
import { signEvidence as runnerSignEvidence, sealEnvelope, SIGNING_KEY_VERSION } from '../../services/verification-runner/src/sign';
import { loadCatalogVersion } from '../../services/verification-runner/src/catalog';
import type { EvidenceSubmission as RunnerSubmission } from '../../services/verification-runner/src/contract';

const CATALOG_DIR = join(process.cwd(), 'config', 'verification-catalogs');

/** Shapes that break naive canonicalizers. */
const CORPUS: readonly unknown[] = [
  {},
  { b: 1, a: 2 },
  { z: { y: { x: [3, 2, 1] } }, a: null },
  [{ b: 1, a: 2 }, { d: 4, c: 3 }],
  { 'key with spaces': 1, 'Ünïcode': 2, '0': 3, A: 4, a: 5 },
  { nested: [[{ q: true }], []], empty: {}, emptyArr: [] },
  { n: 0, neg: -1.5, big: 1e21, zero: -0 },
  { s: 'quote " backslash \ newline \n tab \t' },
  { nullv: null, f: false, t: true },
];

const SAMPLE: RunnerSubmission = {
  requestId: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222',
  projectId: '33333333-3333-4333-8333-333333333333',
  taskId: '44444444-4444-4444-8444-444444444444',
  repoFullName: 'acme/widget',
  commitSha: 'a'.repeat(40),
  dirty: false,
  uncommittedChangesDigest: null,
  runnerId: 'runner-1',
  runId: 'run-1',
  attemptId: 'attempt-1',
  environment: 'ci',
  source: 'local_runner',
  checks: [
    {
      name: 'unit',
      status: 'passed',
      command: 'npm run test:unit',
      exitCode: 0,
      startedAt: '2026-11-12T00:00:00.000Z',
      finishedAt: '2026-11-12T00:01:00.000Z',
      durationMs: 60_000,
      outputDigest: 'b'.repeat(64),
    },
  ],
  artifacts: [{ logicalPath: 'test-results.json', storageKey: 'obj/abc', sizeBytes: 12, sha256: 'c'.repeat(64) }],
  catalogVersion: '2026-09-21',
  catalogDigest: 'd'.repeat(64),
  idempotencyKey: 'e'.repeat(64),
  submittedAt: '2026-11-12T00:01:01.000Z',
};

describe('PR-8 parity — canonical JSON', () => {
  it('agrees with the Hub byte-for-byte across a corpus of awkward shapes', () => {
    for (const value of CORPUS) {
      expect(runnerCanonicalJson(value)).toBe(hubCanonicalJson(value));
    }
  });

  it('agrees on a full evidence submission', () => {
    expect(runnerCanonicalJson(SAMPLE)).toBe(hubCanonicalJson(SAMPLE as unknown as HubSubmission));
  });

  it('is insensitive to key insertion order (the property signing depends on)', () => {
    const a = { requestId: 'x', orgId: 'y', checks: [{ name: 'n', status: 'passed' }] };
    const b = { checks: [{ status: 'passed', name: 'n' }], orgId: 'y', requestId: 'x' };
    expect(runnerCanonicalJson(a)).toBe(runnerCanonicalJson(b));
  });
});

describe('PR-8 parity — signature', () => {
  it('produces a signature the Hub verifier recomputes identically', () => {
    const secret = 'x'.repeat(48);
    expect(runnerSignEvidence(secret, SAMPLE)).toBe(hubSignEvidence(secret, SAMPLE as unknown as HubSubmission));
  });

  it('seals an envelope with an explicit, Hub-supported signing-key version', () => {
    const env = sealEnvelope('y'.repeat(48), SAMPLE);
    expect(env.signingKeyVersion).toBe(SIGNING_KEY_VERSION);
    expect(SIGNING_KEY_VERSION).toBe('v1');
    expect(env.runnerId).toBe(SAMPLE.runnerId);
    expect(env.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes the signature when any payload byte changes', () => {
    const secret = 'z'.repeat(48);
    const base = runnerSignEvidence(secret, SAMPLE);
    const tampered = runnerSignEvidence(secret, { ...SAMPLE, commitSha: 'b'.repeat(40) });
    expect(tampered).not.toBe(base);
  });
});

describe('PR-8 parity — catalog digest', () => {
  it('computes the same version/digest as the Hub resolver for the real in-repo catalog', () => {
    const hub = fileCatalogResolver().current('00000000-0000-4000-8000-000000000000');
    expect(hub).not.toBeNull();
    const runner = loadCatalogVersion(CATALOG_DIR, hub!.version);
    expect(runner.version).toBe(hub!.version);
    expect(runner.digest).toBe(hub!.digest);
    expect({ ...runner.commands }).toEqual({ ...hub!.commands });
  });
});
