import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  adjudicate,
  buildVerificationView,
  describeAccess,
  describeApprovalDetails,
  InMemoryArtifactStore,
  InMemoryVerificationStore,
  ingestEvidence,
  signEvidence,
  StaticRunnerSecretSource,
  type CheckResult,
  type EvidenceSubmission,
  type IngestDeps,
  type SignedEnvelope,
  type SubmittedArtifact,
  type VerificationRequest,
} from '@/domain/verification';

const ORG = 'org-1';
const PROJ = 'proj-1';
const SECRET = 'runner-secret-abc';
const COMMIT = 'a'.repeat(40);
const NEWER = 'b'.repeat(40);
const ARTIFACT_BYTES = Buffer.from('{"passed":true}', 'utf8');
const ARTIFACT_SHA = createHash('sha256').update(ARTIFACT_BYTES).digest('hex');

function makeRequest(over: Partial<VerificationRequest> = {}): VerificationRequest {
  return {
    id: 'req-1',
    orgId: ORG,
    projectId: PROJ,
    taskId: 'task-1',
    repoFullName: 'acme/widget',
    expectedCommitSha: COMMIT,
    requiredChecks: ['unit', 'typecheck'],
    allowDirty: false,
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
    storageKey: 'artifacts/req-1/test-results.json',
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
    idempotencyKey: 'idem-1',
    submittedAt: '2026-09-20T00:00:10.000Z',
    ...over,
  };
}

function sign(payload: EvidenceSubmission, secret = SECRET): SignedEnvelope {
  return { runnerId: payload.runnerId, payload, signature: signEvidence(secret, payload) };
}

let store: InMemoryVerificationStore;
let artifacts: InMemoryArtifactStore;
let deps: IngestDeps;
const ctx = { orgId: ORG, projectId: PROJ };

beforeEach(() => {
  store = new InMemoryVerificationStore();
  store.addRequest(makeRequest());
  artifacts = new InMemoryArtifactStore();
  artifacts.put('artifacts/req-1/test-results.json', ARTIFACT_BYTES);
  deps = {
    store,
    artifacts,
    secrets: new StaticRunnerSecretSource(new Map([[`${ORG}|${PROJ}`, SECRET]])),
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
    // A tampered duplicate reusing the same idempotency key returns the ORIGINAL decision.
    const tampered = await ingestEvidence(
      deps,
      ctx,
      sign(makeSubmission({ checks: [passed('unit')] /* drop typecheck */ })),
    );
    expect(tampered.replayed).toBe(true);
    expect(tampered.status).toBe('verified_complete');
    expect(store.evidence.length).toBe(1);
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
      sign(makeSubmission({ artifacts: [{ path: 'x', sha256: ARTIFACT_SHA, sizeBytes: 1, storageKey: 'artifacts/missing' }], idempotencyKey: 'idem-gone' })),
    );
    expect(gone.status).toBe('verification_failed');
    expect(gone.artifactAvailability[0]?.state).toBe('unavailable');

    artifacts.overwrite('artifacts/req-1/test-results.json', Buffer.from('TAMPERED', 'utf8'));
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

  it('rejects a dirty working tree unless the contract allows it', async () => {
    const dirty = await ingestEvidence(
      deps,
      ctx,
      sign(makeSubmission({ dirty: true, uncommittedChangesDigest: 'sha:deadbeef', idempotencyKey: 'idem-dirty' })),
    );
    expect(dirty.rejection?.code).toBe('dirty_tree');
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
