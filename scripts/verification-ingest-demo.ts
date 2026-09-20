/**
 * Integration demo for external-runner evidence ingestion (VER-002, Option A).
 *
 * A trusted local runner executes REAL commands against a synthetic repo, signs
 * the resulting evidence, and posts it through the same `ingestEvidence`
 * orchestrator the production route uses (here over in-memory adapters). Proves
 * the end-to-end flow and the guard rails. No live Hub, no network, no deploy.
 *
 *   npm run demo:verification-ingest
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ingestEvidence,
  signEvidence,
  InMemoryArtifactStore,
  InMemoryVerificationStore,
  StaticRunnerSecretSource,
  type CheckResult,
  type EvidenceSubmission,
  type IngestDeps,
  type SignedEnvelope,
  type VerificationRequest,
} from '../src/domain/verification';

const ORG = 'org-demo';
const PROJ = 'proj-demo';
const SECRET = 'demo-runner-secret';
const REPO = 'synthetic/demo';
const ctx = { orgId: ORG, projectId: PROJ };

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} — ${name}\n        ${detail}`);
  if (!ok) failures++;
}
function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function makeRepo(): { dir: string; commit: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ver-ingest-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'r@local']);
  git(dir, ['config', 'user.name', 'Runner']);
  writeFileSync(
    join(dir, 'run-tests.js'),
    [
      "const fs=require('fs');",
      "const fail=process.argv.includes('--fail');",
      "fs.writeFileSync('test-results.json', JSON.stringify({passed:!fail, at:new Date().toISOString()}));",
      "if(fail){console.error('1 failing');process.exit(1);} console.log('3/3 green'); process.exit(0);",
    ].join('\n'),
  );
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'fixtures']);
  return { dir, commit: git(dir, ['rev-parse', 'HEAD']) };
}

/** The trusted runner: execute a real check and turn its real result into evidence + an artifact. */
function runCheck(dir: string, name: string, args: string[]): { check: CheckResult; bytes: Buffer } {
  const startedAt = new Date().toISOString();
  const r = spawnSync('node', ['run-tests.js', ...args], { cwd: dir, encoding: 'utf8' });
  const finishedAt = new Date().toISOString();
  const bytes = readFileSync(join(dir, 'test-results.json'));
  return {
    check: {
      name,
      status: r.status === 0 ? 'passed' : 'failed',
      command: `node run-tests.js ${args.join(' ')}`.trim(),
      exitCode: r.status ?? -1,
      startedAt,
      finishedAt,
      detail: (r.stdout || r.stderr || '').trim() || null,
    },
    bytes,
  };
}

function makeRequest(over: Partial<VerificationRequest>): VerificationRequest {
  return {
    id: 'req-demo',
    orgId: ORG,
    projectId: PROJ,
    taskId: 'task-demo',
    repoFullName: REPO,
    expectedCommitSha: 'x',
    requiredChecks: ['unit'],
    requiredArtifacts: ['test-results.json'],
    allowDirty: false,
    createdBy: 'owner',
    createdAt: new Date().toISOString(),
    ...over,
  };
}
function submission(commit: string, checks: CheckResult[], artSha: string, over: Partial<EvidenceSubmission> = {}): EvidenceSubmission {
  return {
    requestId: 'req-demo',
    orgId: ORG,
    projectId: PROJ,
    taskId: 'task-demo',
    repoFullName: REPO,
    commitSha: commit,
    dirty: false,
    uncommittedChangesDigest: null,
    runnerId: 'local-runner-1',
    runId: 'run-1',
    attemptId: 'att-1',
    environment: 'local-offline',
    source: 'local_runner',
    checks,
    artifacts: [{ path: 'test-results.json', sha256: artSha, sizeBytes: 1, storageKey: `org/${ORG}/project/${PROJ}/art/test-results.json` }],
    idempotencyKey: 'idem-happy',
    submittedAt: new Date().toISOString(),
    ...over,
  };
}
const sign = (p: EvidenceSubmission, secret = SECRET): SignedEnvelope => ({ runnerId: p.runnerId, payload: p, signature: signEvidence(secret, p) });

async function main(): Promise<void> {
  const { dir, commit } = makeRepo();
  console.log(`Synthetic repo ${dir}\nReviewed commit ${commit}\n`);
  const store = new InMemoryVerificationStore();
  const artifacts = new InMemoryArtifactStore();
  const deps: IngestDeps = {
    store,
    artifacts,
    secrets: new StaticRunnerSecretSource(new Map([[`${ORG}|${PROJ}`, SECRET]])),
  };

  try {
    // Contract pinned to the reviewed commit, required check declared BEFORE results.
    store.addRequest(makeRequest({ expectedCommitSha: commit }));

    // Runner executes the real passing check and stores the real artifact.
    console.log('Happy path — real passing check + stored artifact');
    const pass = runCheck(dir, 'unit', []);
    const artSha = createHash('sha256').update(pass.bytes).digest('hex');
    artifacts.put(`org/${ORG}/project/${PROJ}/art/test-results.json`, pass.bytes);
    const happySub = submission(commit, [pass.check], artSha); // one submission object…
    const happy = await ingestEvidence(deps, ctx, sign(happySub));
    check(
      'accepted → verified_complete',
      happy.accepted && happy.status === 'verified_complete' && happy.deliverable,
      `check ${pass.check.name} exit=${pass.check.exitCode} → ${happy.status}; ${happy.reasons[1] ?? ''}`,
    );

    console.log('\nReplay — a byte-identical retry returns the original result');
    const replay = await ingestEvidence(deps, ctx, sign(happySub)); // …resent verbatim
    check('replayed, unchanged', replay.replayed && replay.status === happy.status, `replayed=${replay.replayed} status=${replay.status}`);

    console.log('\nConflict — same key, DIFFERENT content is rejected (original preserved)');
    const conflict = await ingestEvidence(deps, ctx, sign(submission(commit, [pass.check], artSha, { runId: 'run-DIFFERENT' })));
    check('rejected idempotency_conflict', conflict.rejection?.code === 'idempotency_conflict', `${conflict.rejection?.code}`);

    console.log('\nStale commit — evidence for an older commit cannot verify a newer contract');
    writeFileSync(join(dir, 'README.md'), 'new work\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'newer']);
    const newer = git(dir, ['rev-parse', 'HEAD']);
    store.addRequest(makeRequest({ id: 'req-newer', expectedCommitSha: newer }));
    const stale = await ingestEvidence(deps, ctx, sign(submission(commit, [pass.check], artSha, { requestId: 'req-newer', idempotencyKey: 'idem-stale' })));
    check('rejected stale_commit', stale.rejection?.code === 'stale_commit', `${stale.rejection?.code}: reviewed ${newer.slice(0, 8)} vs evidence ${commit.slice(0, 8)}`);

    console.log('\nWrong tenant — rejected');
    const wrong = await ingestEvidence(deps, ctx, sign(submission(commit, [pass.check], artSha, { orgId: 'org-evil', idempotencyKey: 'idem-wrong' })));
    check('rejected wrong_tenant', wrong.rejection?.code === 'wrong_tenant', `${wrong.rejection?.code}`);

    console.log('\nFailing check — real exit 1 cannot verify');
    const fail = runCheck(dir, 'unit', ['--fail']);
    const failSha = createHash('sha256').update(fail.bytes).digest('hex');
    artifacts.put(`org/${ORG}/project/${PROJ}/art/test-results.json`, fail.bytes);
    const failed = await ingestEvidence(deps, ctx, sign(submission(commit, [fail.check], failSha, { idempotencyKey: 'idem-fail' })));
    check('verification_failed, not deliverable', failed.status === 'verification_failed' && !failed.deliverable, `check exit=${fail.check.exitCode} → ${failed.status}`);

    console.log('\nAltered artifact — hash mismatch cannot verify');
    artifacts.put(`org/${ORG}/project/${PROJ}/art/test-results.json`, pass.bytes); // restore good bytes
    artifacts.overwrite(`org/${ORG}/project/${PROJ}/art/test-results.json`, Buffer.from('TAMPERED', 'utf8')); // then tamper
    const altered = await ingestEvidence(deps, ctx, sign(submission(commit, [pass.check], artSha, { idempotencyKey: 'idem-alt' })));
    check('verification_failed on hash_mismatch', altered.status === 'verification_failed' && altered.artifactAvailability[0]?.state === 'hash_mismatch', `artifact ${altered.artifactAvailability[0]?.state}`);

    console.log('\nAgent prose — unsigned submission rejected');
    const prose = await ingestEvidence(deps, ctx, { runnerId: 'x', payload: submission(commit, [pass.check], artSha, { idempotencyKey: 'idem-prose' }), signature: '' });
    check('rejected unauthenticated', prose.rejection?.code === 'unauthenticated', `${prose.rejection?.code}`);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  console.log(`\n${failures === 0 ? 'ALL INGEST SCENARIOS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
