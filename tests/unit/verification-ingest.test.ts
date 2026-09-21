import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  adjudicate,
  buildVerificationView,
  describeAccess,
  describeApprovalDetails,
  InMemoryArtifactStore,
  InMemoryCatalogResolver,
  InMemoryUploadGrantStore,
  InMemoryVerificationStore,
  ingestEvidence,
  signEvidence,
  StaticRunnerSecretSource,
  type CheckResult,
  type EvidenceSubmission,
  type IngestDeps,
  type SignedEnvelope,
  type IngestDecision,
  type PriorEvidence,
  type SubmittedArtifact,
  type VerificationRequest,
  type VerificationStore,
} from '@/domain/verification';
import { envRunnerSecretSource } from '@/domain/verification/runtime-adapters';

const ORG = 'org-1';
const PROJ = 'proj-1';
const SECRET = 'runner-secret-abc';
const COMMIT = 'a'.repeat(40);
const NEWER = 'b'.repeat(40);
// A fixed trusted catalog the contract pins and the submission declares. Commands match the checks.
const CAT = { version: 'test-cat-v1', digest: 'testdigest0001', commands: { unit: 'npm run unit', typecheck: 'npm run typecheck' } } as const;
const ARTIFACT_BYTES = Buffer.from('{"passed":true}', 'utf8');
const ARTIFACT_SHA = createHash('sha256').update(ARTIFACT_BYTES).digest('hex');
const ARTIFACT_KEY = `org/${ORG}/project/${PROJ}/art/test-results.json`;

function makeRequest(over: Partial<VerificationRequest> = {}): VerificationRequest {
  return {
    id: 'req-1',
    orgId: ORG,
    projectId: PROJ,
    taskId: 'task-1',
    repoFullName: 'acme/widget',
    expectedCommitSha: COMMIT,
    requiredChecks: ['unit', 'typecheck'],
    requiredArtifacts: ['test-results.json'],
    allowDirty: false,
    catalogVersion: CAT.version,
    catalogDigest: CAT.digest,
    createdBy: 'user-1',
    createdAt: '2026-09-20T00:00:00.000Z',
    ...over,
  };
}

const passed = (name: string): CheckResult => ({
  name,
  status: 'passed',
  command: `npm run ${name}`,
  exitCode: 0,
  startedAt: '2026-09-20T00:00:00.000Z',
  finishedAt: '2026-09-20T00:00:05.000Z',
  detail: null,
});

function makeSubmission(over: Partial<EvidenceSubmission> = {}): EvidenceSubmission {
  const artifact: SubmittedArtifact = {
    path: 'test-results.json',
    sha256: ARTIFACT_SHA,
    sizeBytes: ARTIFACT_BYTES.length,
    storageKey: ARTIFACT_KEY,
  };
  return {
    requestId: 'req-1',
    orgId: ORG,
    projectId: PROJ,
    taskId: 'task-1',
    repoFullName: 'acme/widget',
    commitSha: COMMIT,
    dirty: false,
    uncommittedChangesDigest: null,
    runnerId: 'runner-ci-1',
    runId: 'run-42',
    attemptId: 'attempt-1',
    environment: 'local-offline',
    source: 'local_runner',
    checks: [passed('unit'), passed('typecheck')],
    artifacts: [artifact],
    catalogVersion: CAT.version,
    catalogDigest: CAT.digest,
    idempotencyKey: 'idem-1',
    submittedAt: '2026-09-20T00:00:10.000Z',
    ...over,
  };
}

let store: InMemoryVerificationStore;
let artifacts: InMemoryArtifactStore;
let grants: InMemoryUploadGrantStore;
let deps: IngestDeps;
const ctx = { orgId: ORG, projectId: PROJ };

/** Sign a submission AND seed a matching uploaded grant for each of its artifacts (PR-4 binding). Tests
 *  that specifically exercise the grant-binding rejections seed their own store instead. */
function sign(payload: EvidenceSubmission, secret = SECRET): SignedEnvelope {
  for (const a of payload.artifacts) {
    grants.seedUploaded(payload.orgId, payload.projectId, payload.requestId, payload.attemptId, a);
  }
  return { runnerId: payload.runnerId, payload, signature: signEvidence(secret, payload) };
}

beforeEach(() => {
  store = new InMemoryVerificationStore();
  store.addRequest(makeRequest());
  artifacts = new InMemoryArtifactStore();
  artifacts.put(ARTIFACT_KEY, ARTIFACT_BYTES);
  grants = new InMemoryUploadGrantStore();
    const catalog = new InMemoryCatalogResolver();
  catalog.addVersion({ version: CAT.version, digest: CAT.digest, commands: CAT.commands });
  deps = {
    store,
    artifacts,
    secrets: new StaticRunnerSecretSource(new Map([[`${ORG}|${PROJ}`, SECRET]])),
    catalog,
    grants,
    now: () => new Date('2026-09-20T00:00:11.000Z'),
  };
});

describe('VER-002 acceptance', () => {
  it('1. valid evidence is accepted for the correct task and commit', async () => {
    const d = await ingestEvidence(deps, ctx, sign(makeSubmission()));
    expect(d.accepted).toBe(true);
    expect(d.rejection).toBeNull();
    expect(d.status).toBe('verified_complete');
    expect(d.deliverable).toBe(true);
  });

  it('2. wrong tenant / project / repository are rejected', async () => {
    const wrongOrg = await ingestEvidence(deps, ctx, sign(makeSubmission({ orgId: 'org-EVIL', idempotencyKey: 'idem-org' })));
    expect(wrongOrg.accepted).toBe(false);
    expect(wrongOrg.rejection?.code).toBe('wrong_tenant');

    const wrongProj = await ingestEvidence(deps, ctx, sign(makeSubmission({ projectId: 'proj-EVIL', idempotencyKey: 'idem-proj' })));
    expect(wrongProj.rejection?.code).toBe('wrong_project');

    const wrongRepo = await ingestEvidence(deps, ctx, sign(makeSubmission({ repoFullName: 'acme/OTHER', idempotencyKey: 'idem-repo' })));
    expect(wrongRepo.rejection?.code).toBe('wrong_repo');
  });

  it('binds evidence whose repository differs only in capitalization (same repo, not wrong_repo)', async () => {
    // Contract repo is 'acme/widget'; the runner reports 'Acme/Widget' — the SAME repository.
    const d = await ingestEvidence(deps, ctx, sign(makeSubmission({ repoFullName: 'Acme/Widget', idempotencyKey: 'idem-case' })));
    expect(d.rejection?.code).not.toBe('wrong_repo');
    expect(d.accepted).toBe(true);
    expect(d.status).toBe('verified_complete');
  });

  it('3. stale commit evidence cannot verify newer code', async () => {
    store.addRequest(makeRequest({ id: 'req-new', expectedCommitSha: NEWER }));
    const d = await ingestEvidence(
      deps,
      ctx,
      sign(makeSubmission({ requestId: 'req-new', commitSha: COMMIT, idempotencyKey: 'idem-stale' })),
    );
    expect(d.accepted).toBe(false);
    expect(d.rejection?.code).toBe('stale_commit');
    expect(d.status).not.toBe('verified_complete');
  });

  it('4. duplicate / replayed submissions do not change the result', async () => {
    const first = await ingestEvidence(deps, ctx, sign(makeSubmission()));
    expect(first.replayed).toBe(false);
    const replay = await ingestEvidence(deps, ctx, sign(makeSubmission()));
    expect(replay.replayed).toBe(true);
    expect(replay.status).toBe(first.status);
    // A CHANGED submission reusing the same key is an explicit conflict — never a
    // silent overwrite — and the original decision is preserved.
    const conflict = await ingestEvidence(
      deps,
      ctx,
      sign(makeSubmission({ checks: [passed('unit')] /* drop typecheck */ })),
    );
    expect(conflict.rejection?.code).toBe('idempotency_conflict');
    expect(store.evidence.length).toBe(1); // original still the only persisted record
  });

  it('5. missing / skipped / failed required checks prevent verification', async () => {
    const skipped = await ingestEvidence(
      deps,
      ctx,
      sign(makeSubmission({ checks: [passed('unit'), { ...passed('typecheck'), status: 'skipped', exitCode: null }], idempotencyKey: 'idem-skip' })),
    );
    expect(skipped.accepted).toBe(true);
    expect(skipped.status).toBe('verification_failed');
    expect(skipped.deliverable).toBe(false);

    const missing = await ingestEvidence(
      deps,
      ctx,
      sign(makeSubmission({ checks: [passed('unit')], idempotencyKey: 'idem-miss' })),
    );
    expect(missing.status).toBe('verification_failed');
    expect(missing.checkEvaluation?.failing.some((f) => f.name === 'typecheck' && f.status === 'missing')).toBe(true);
  });

  it('6. missing or altered artifacts prevent a verified delivery claim', async () => {
    const gone = await ingestEvidence(
      deps,
      ctx,
      sign(makeSubmission({ artifacts: [{ path: 'x', sha256: ARTIFACT_SHA, sizeBytes: 1, storageKey: `org/${ORG}/project/${PROJ}/missing` }], idempotencyKey: 'idem-gone' })),
    );
    expect(gone.status).toBe('verification_failed');
    expect(gone.artifactAvailability[0]?.state).toBe('unavailable');

    artifacts.overwrite(ARTIFACT_KEY, Buffer.from('TAMPERED', 'utf8'));
    const altered = await ingestEvidence(deps, ctx, sign(makeSubmission({ idempotencyKey: 'idem-alt' })));
    expect(altered.status).toBe('verification_failed');
    expect(altered.artifactAvailability[0]?.state).toBe('hash_mismatch');
  });

  it('7. agent prose alone cannot produce verified completion', async () => {
    // No signature (prose posing as evidence).
    const noSig = await ingestEvidence(deps, ctx, { runnerId: 'x', payload: makeSubmission(), signature: '' });
    expect(noSig.rejection?.code).toBe('unauthenticated');
    // Signed with the wrong secret.
    const wrongSecret = await ingestEvidence(deps, ctx, sign(makeSubmission(), 'not-the-secret'));
    expect(wrongSecret.rejection?.code).toBe('unauthenticated');
    expect(wrongSecret.status).not.toBe('verified_complete');
  });

  it('8. existing non-technical tasks continue to work', () => {
    // No verification contract → the VER-001 lifecycle is untouched.
    const access = describeAccess(null, null);
    const view = buildVerificationView(access, null, null);
    expect(view.verification.status).toBe('not_requested');
    // A non-executable task still finishes via the draft path, never mislabeled verified.
    const adj = adjudicate({ hasDraft: true, requiresExecution: false, access, evidence: null, requiredArtifacts: [] });
    expect(adj.status).toBe('draft_complete');
  });

  it('always rejects a dirty working tree in the initial integration (allowDirty not honored)', async () => {
    const dirty = await ingestEvidence(
      deps,
      ctx,
      sign(makeSubmission({ dirty: true, uncommittedChangesDigest: 'sha:deadbeef', idempotencyKey: 'idem-dirty' })),
    );
    expect(dirty.rejection?.code).toBe('dirty_tree');
    // Even when a (reserved) allowDirty contract exists, a dirty tree is still rejected.
    store.addRequest(makeRequest({ id: 'req-dirty', allowDirty: true }));
    const dirty2 = await ingestEvidence(
      deps,
      ctx,
      sign(makeSubmission({ requestId: 'req-dirty', dirty: true, uncommittedChangesDigest: 'sha:beef', idempotencyKey: 'idem-dirty2' })),
    );
    expect(dirty2.rejection?.code).toBe('dirty_tree');
  });
});

describe('VER-002 approval details + view', () => {
  it('separates external requests from internal assignments and marks unknown cost', () => {
    const ext = describeApprovalDetails({ actionType: 'external_http', payload: { url: 'https://api.x/y' }, purpose: 'sync quote' });
    expect(ext.scope).toBe('external');
    expect(ext.transmittedInformation.leavesTenant).toBe(true);
    expect(ext.cost.known).toBe(false);

    const internal = describeApprovalDetails({ actionType: 'org_delegation', payload: { agentId: 'a1' }, purpose: 'delegate' });
    expect(internal.scope).toBe('internal');
    expect(internal.transmittedInformation.leavesTenant).toBe(false);
    expect(internal.executionCaveat).toMatch(/does not prove an executor is enabled/);
  });

  it('view surfaces reviewed commit, checks, result, and blockers', async () => {
    const d = await ingestEvidence(deps, ctx, sign(makeSubmission({ checks: [passed('unit')], idempotencyKey: 'v' })));
    const access = describeAccess(
      { repoFullName: 'acme/widget', defaultBranch: 'main' },
      { ok: true, branch: 'main', commitSha: COMMIT, checkedAt: 'now', workingTreeChanges: null, error: null },
      { canRunCommands: false },
    );
    const view = buildVerificationView(access, makeRequest(), d);
    expect(view.reviewedCommit).toBe(COMMIT);
    expect(view.requiredChecks.find((c) => c.name === 'typecheck')?.status).toBe('missing');
    expect(view.verification.status).toBe('verification_failed');
    expect(view.remainingBlockers.length).toBeGreaterThan(0);
    expect(view.verification.scannerLimitation).toMatch(/not proof that no secrets exist/);
  });
});

describe('VER-002 review fixes', () => {
  it('F1: runner secret is genuinely per-project and scope comes from ctx, not payload', async () => {
    const prev = process.env.VERIFICATION_RUNNER_MASTER_SECRET;
    process.env.VERIFICATION_RUNNER_MASTER_SECRET = 'x'.repeat(48);
    try {
      const src = envRunnerSecretSource();
      const a = await src.getRunnerSecret('org-1', 'proj-A');
      const b = await src.getRunnerSecret('org-1', 'proj-B');
      expect(a).toBeTruthy();
      expect(a).not.toBe(b); // different project → different derived key
      expect(await src.getRunnerSecret('org-1', 'proj-A')).toBe(a); // deterministic

      // A runner holding project-A's derived key cannot authenticate for project-B.
      const bStore = new InMemoryVerificationStore();
      bStore.addRequest(makeRequest({ id: 'req-b', orgId: 'org-1', projectId: 'proj-B', taskId: 'task-b' }));
      const bDeps: IngestDeps = { store: bStore, artifacts, secrets: src, catalog: deps.catalog, grants: new InMemoryUploadGrantStore(), now: () => new Date('2026-09-20T00:00:11.000Z') };
      const payload = makeSubmission({ requestId: 'req-b', projectId: 'proj-B', taskId: 'task-b', idempotencyKey: 'idem-b' });
      const envelope: SignedEnvelope = { runnerId: payload.runnerId, payload, signature: signEvidence(a!, payload) };
      const d = await ingestEvidence(bDeps, { orgId: 'org-1', projectId: 'proj-B' }, envelope);
      expect(d.rejection?.code).toBe('unauthenticated');
    } finally {
      if (prev === undefined) delete process.env.VERIFICATION_RUNNER_MASTER_SECRET;
      else process.env.VERIFICATION_RUNNER_MASTER_SECRET = prev;
    }
  });

  it('F1: no master secret → ingestion disabled (unauthenticated)', async () => {
    const prev = process.env.VERIFICATION_RUNNER_MASTER_SECRET;
    delete process.env.VERIFICATION_RUNNER_MASTER_SECRET;
    try {
      expect(await envRunnerSecretSource().getRunnerSecret('o', 'p')).toBeNull();
    } finally {
      if (prev !== undefined) process.env.VERIFICATION_RUNNER_MASTER_SECRET = prev;
    }
  });

  it('F2: a stale or future signed timestamp is rejected as expired', async () => {
    const stale = await ingestEvidence(deps, ctx, sign(makeSubmission({ submittedAt: '2026-09-19T00:00:00.000Z', idempotencyKey: 'idem-old' })));
    expect(stale.rejection?.code).toBe('expired');
    const future = await ingestEvidence(deps, ctx, sign(makeSubmission({ submittedAt: '2026-09-20T02:00:00.000Z', idempotencyKey: 'idem-future' })));
    expect(future.rejection?.code).toBe('expired');
  });

  it('F2: a tampered payload (post-signature) fails authentication', async () => {
    const payload = makeSubmission({ idempotencyKey: 'idem-tamper' });
    const envelope = sign(payload);
    const tampered: SignedEnvelope = { ...envelope, payload: { ...payload, commitSha: 'z'.repeat(40) } };
    const d = await ingestEvidence(deps, ctx, tampered);
    expect(d.rejection?.code).toBe('unauthenticated');
  });

  it('F3: an artifact key in another tenant partition is forbidden even if the hash matches', async () => {
    // Put real bytes at ANOTHER tenant's key; the guard must never dereference it.
    const foreignKey = 'org/org-OTHER/project/proj-OTHER/art/test-results.json';
    artifacts.put(foreignKey, ARTIFACT_BYTES); // hash WOULD match
    const d = await ingestEvidence(
      deps,
      ctx,
      sign(makeSubmission({ artifacts: [{ path: 'x', sha256: ARTIFACT_SHA, sizeBytes: ARTIFACT_BYTES.length, storageKey: foreignKey }], idempotencyKey: 'idem-cross' })),
    );
    expect(d.status).toBe('verification_failed');
    expect(d.artifactAvailability[0]?.state).toBe('forbidden');
    expect(d.artifactAvailability[0]?.observedSha256).toBeNull(); // never read
  });

  it('conflicting reuse of an idempotency key is an explicit conflict; original preserved', async () => {
    const first = await ingestEvidence(deps, ctx, sign(makeSubmission({ idempotencyKey: 'idem-conflict' })));
    expect(first.status).toBe('verified_complete');
    // Re-sign a DIFFERENT payload under the same key (valid signature, changed runId).
    const conflict = await ingestEvidence(deps, ctx, sign(makeSubmission({ idempotencyKey: 'idem-conflict', runId: 'run-DIFFERENT' })));
    expect(conflict.accepted).toBe(false);
    expect(conflict.rejection?.code).toBe('idempotency_conflict');
    // An IDENTICAL retry, by contrast, safely replays the original.
    const retry = await ingestEvidence(deps, ctx, sign(makeSubmission({ idempotencyKey: 'idem-conflict' })));
    expect(retry.replayed).toBe(true);
    expect(retry.status).toBe(first.status);
    expect(store.evidence.filter((e) => e.submission.idempotencyKey === 'idem-conflict').length).toBe(1);
  });

  it('F-checks: contradictory / duplicate / missing-metadata checks are rejected as invalid_checks', async () => {
    // status 'passed' with a non-zero exit code (contradiction).
    const contra = await ingestEvidence(
      deps,
      ctx,
      sign(makeSubmission({ checks: [passed('unit'), { ...passed('typecheck'), exitCode: 2 }], idempotencyKey: 'idem-contra' })),
    );
    expect(contra.rejection?.code).toBe('invalid_checks');
    // duplicate check name.
    const dup = await ingestEvidence(
      deps,
      ctx,
      sign(makeSubmission({ checks: [passed('unit'), passed('unit'), passed('typecheck')], idempotencyKey: 'idem-dup' })),
    );
    expect(dup.rejection?.code).toBe('invalid_checks');
    // 'passed' with no execution metadata.
    const nometa = await ingestEvidence(
      deps,
      ctx,
      sign(makeSubmission({ checks: [passed('unit'), { name: 'typecheck', status: 'passed', command: null, exitCode: null, startedAt: null, finishedAt: null, detail: null }], idempotencyKey: 'idem-nometa' })),
    );
    expect(nometa.rejection?.code).toBe('invalid_checks');
  });

  it('F-checks: a failed check is never described as passed in the scope statement', async () => {
    const failed = await ingestEvidence(
      deps,
      ctx,
      sign(makeSubmission({ checks: [passed('unit'), { ...passed('typecheck'), status: 'failed', exitCode: 1 }], idempotencyKey: 'idem-scope' })),
    );
    expect(failed.status).toBe('verification_failed');
    expect(failed.checkEvaluation?.scope).toMatch(/did NOT pass/);
    expect(failed.checkEvaluation?.scope).not.toMatch(/check\(s\) passed/);
  });

  it('F-artifacts: an empty submitted list cannot bypass a required artifact', async () => {
    const empty = await ingestEvidence(deps, ctx, sign(makeSubmission({ artifacts: [], idempotencyKey: 'idem-empty' })));
    expect(empty.status).toBe('verification_failed');
    expect(empty.reasons.some((r) => /Required artifact\(s\) missing/.test(r))).toBe(true);
  });

  it('F-metadata: empty command / invalid or reversed timestamps are invalid_checks', async () => {
    const emptyCmd = await ingestEvidence(
      deps,
      ctx,
      sign(makeSubmission({ checks: [passed('unit'), { ...passed('typecheck'), command: '   ' }], idempotencyKey: 'idem-emptycmd' })),
    );
    expect(emptyCmd.rejection?.code).toBe('invalid_checks');

    const badTs = await ingestEvidence(
      deps,
      ctx,
      sign(makeSubmission({ checks: [passed('unit'), { ...passed('typecheck'), startedAt: 'not-a-date' }], idempotencyKey: 'idem-badts' })),
    );
    expect(badTs.rejection?.code).toBe('invalid_checks');

    const reversed = await ingestEvidence(
      deps,
      ctx,
      sign(makeSubmission({ checks: [passed('unit'), { ...passed('typecheck'), startedAt: '2026-09-20T00:00:09.000Z', finishedAt: '2026-09-20T00:00:01.000Z' }], idempotencyKey: 'idem-rev' })),
    );
    expect(reversed.rejection?.code).toBe('invalid_checks');
  });
});

describe('VER-002 concurrent persistence conflict (every path)', () => {
  // A store that reports NO prior at check time but returns a DIFFERENT winner at
  // save time — simulating a concurrent insert that won the (request,key) row.
  class ConflictStore implements VerificationStore {
    constructor(
      private readonly request: VerificationRequest,
      private readonly winner: PriorEvidence,
    ) {}
    async getRequest(): Promise<VerificationRequest> {
      return this.request;
    }
    async findExisting(): Promise<PriorEvidence | null> {
      return null;
    }
    async saveEvidence(): Promise<PriorEvidence> {
      return this.winner; // a different submission won; its digest will not match ours
    }
    async taskExistsInTenant(): Promise<boolean> {
      throw new Error('not used in this test');
    }
    async findRequestByTaskCommit(): Promise<VerificationRequest | null> {
      throw new Error('not used in this test');
    }
    async linkedRepoFullNames(): Promise<string[]> {
      throw new Error('not used in this test');
    }
    async createRequest(): Promise<{ request: VerificationRequest; inserted: boolean }> {
      throw new Error('not used in this test');
    }
    async listRequests(): Promise<never> {
      throw new Error('not used in this test');
    }
    async getRequestSummary(): Promise<never> {
      throw new Error('not used in this test');
    }
  }

  const winnerSuccess: IngestDecision = {
    accepted: true,
    rejection: null,
    status: 'verified_complete',
    deliverable: true,
    idempotencyKey: 'idem-1',
    checkEvaluation: null,
    artifactAvailability: [],
    reasons: ['the winner succeeded'],
    decidedAt: '2026-09-20T00:00:11.000Z',
    replayed: false,
  };

  function conflictDeps(): IngestDeps {
    const s = new InMemoryArtifactStore();
    s.put(ARTIFACT_KEY, ARTIFACT_BYTES);
    const catalog = new InMemoryCatalogResolver();
    catalog.addVersion({ version: CAT.version, digest: CAT.digest, commands: CAT.commands });
    return {
      store: new ConflictStore(makeRequest(), { decision: winnerSuccess, submissionSha256: 'A-DIFFERENT-WINNER-DIGEST' }),
      artifacts: s,
      secrets: new StaticRunnerSecretSource(new Map([[`${ORG}|${PROJ}`, SECRET]])),
      catalog,
      grants,
      now: () => new Date('2026-09-20T00:00:11.000Z'),
    };
  }

  it('a losing changed submission never inherits the winner’s success — on the accepted path', async () => {
    const d = await ingestEvidence(conflictDeps(), ctx, sign(makeSubmission({ idempotencyKey: 'k1' })));
    expect(d.rejection?.code).toBe('idempotency_conflict');
    expect(d.status).not.toBe('verified_complete');
    expect(d.deliverable).toBe(false);
  });

  it('every rejection path also routes through the conflict check — invalid_checks', async () => {
    const d = await ingestEvidence(conflictDeps(), ctx, sign(makeSubmission({ checks: [passed('unit'), passed('unit')], idempotencyKey: 'k2' })));
    expect(d.rejection?.code).toBe('idempotency_conflict'); // not the winner's success, not invalid_checks
  });

  it('every rejection path also routes through the conflict check — binding failure', async () => {
    const d = await ingestEvidence(conflictDeps(), ctx, sign(makeSubmission({ repoFullName: 'acme/OTHER', idempotencyKey: 'k3' })));
    expect(d.rejection?.code).toBe('idempotency_conflict');
    expect(d.status).not.toBe('verified_complete');
  });
});

describe('VER-002 PR-2 — signing-key version', () => {
  it('accepts an envelope with no version (existing envelopes ⇒ v1)', async () => {
    const d = await ingestEvidence(deps, ctx, sign(makeSubmission({ idempotencyKey: 'sv-absent' })));
    expect(d.rejection?.code).not.toBe('unsupported_signing_version');
    expect(d.accepted).toBe(true);
  });
  it('accepts an explicit supported version v1', async () => {
    const env = { ...sign(makeSubmission({ idempotencyKey: 'sv-v1' })), signingKeyVersion: 'v1' };
    const d = await ingestEvidence(deps, ctx, env);
    expect(d.rejection?.code).not.toBe('unsupported_signing_version');
    expect(d.accepted).toBe(true);
  });
  it('rejects an unsupported version on the ingest path — distinct from unauthenticated', async () => {
    // A fully valid signature, but a retired/unknown signing-key version: rejected as a signing-key
    // retirement, NOT as a bad credential.
    const env = { ...sign(makeSubmission({ idempotencyKey: 'sv-v2' })), signingKeyVersion: 'v2' };
    const d = await ingestEvidence(deps, ctx, env);
    expect(d.accepted).toBe(false);
    expect(d.rejection?.code).toBe('unsupported_signing_version');
  });
});

describe('VER-002 PR-3 — catalog pinning', () => {
  it('rejects a LEGACY unpinned contract (fail closed)', async () => {
    store.addRequest(makeRequest({ id: 'req-unpinned', catalogVersion: 'unpinned', catalogDigest: 'unpinned' }));
    const d = await ingestEvidence(deps, ctx, sign(makeSubmission({ requestId: 'req-unpinned', idempotencyKey: 'idem-unpinned' })));
    expect(d.accepted).toBe(false);
    expect(d.rejection?.code).toBe('catalog_unpinned');
  });

  it('fails closed when the contract’s pinned catalog version no longer resolves', async () => {
    store.addRequest(makeRequest({ id: 'req-gone', catalogVersion: 'gone-v9', catalogDigest: 'x' }));
    const d = await ingestEvidence(
      deps,
      ctx,
      sign(makeSubmission({ requestId: 'req-gone', catalogVersion: 'gone-v9', catalogDigest: 'x', idempotencyKey: 'idem-gone' })),
    );
    expect(d.rejection?.code).toBe('catalog_unavailable');
  });

  it('rejects caller-supplied catalog tampering (payload digest ≠ contract/server)', async () => {
    const d = await ingestEvidence(deps, ctx, sign(makeSubmission({ catalogDigest: 'TAMPERED', idempotencyKey: 'idem-tamper' })));
    expect(d.rejection?.code).toBe('catalog_mismatch');
  });

  it('rejects a required check whose command does not EXACTLY match the pinned catalog entry', async () => {
    const d = await ingestEvidence(
      deps,
      ctx,
      sign(makeSubmission({ checks: [{ ...passed('unit'), command: 'rm -rf /' }, passed('typecheck')], idempotencyKey: 'idem-cmd' })),
    );
    expect(d.rejection?.code).toBe('invalid_checks');
  });

  it('a contract pinned to an OLD catalog version still verifies after the catalog updates', async () => {
    const older = { version: 'old-v0', digest: 'olddigest', commands: { unit: 'npm run unit', typecheck: 'npm run typecheck' } };
    (deps.catalog as InMemoryCatalogResolver).addVersion(older);
    // A newer version exists (and would be the default), with a DIFFERENT command — must not be used.
    (deps.catalog as InMemoryCatalogResolver).addVersion({ version: 'new-v2', digest: 'newdigest', commands: { unit: 'DIFFERENT', typecheck: 'x' } });
    store.addRequest(makeRequest({ id: 'req-old', catalogVersion: older.version, catalogDigest: older.digest }));
    const d = await ingestEvidence(
      deps,
      ctx,
      sign(makeSubmission({ requestId: 'req-old', catalogVersion: older.version, catalogDigest: older.digest, idempotencyKey: 'idem-old' })),
    );
    expect(d.accepted).toBe(true);
    expect(d.status).toBe('verified_complete');
  });
});
