/**
 * Acceptance demo for the verification/evidence layer (VER-001).
 *
 * Proves the six required behaviours against a SYNTHETIC git repository with real
 * command execution (this process is the trusted runner). It touches nothing in
 * the live Hub, no StressProbe code, no network, no deploy.
 *
 *   npm run demo:verification
 *
 * The demo's own exit code is evidence: it exits non-zero if any scenario fails.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  adjudicate,
  assertDeliverable,
  buildReviewPackage,
  canExecute,
  describeAccess,
  redact,
  type ArtifactRef,
  type ExecutionEvidence,
  type SelectedFile,
} from '../src/domain/verification';

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} — ${name}`);
  console.log(`        ${detail}`);
  if (!ok) failures++;
}
function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** Build a synthetic repo with fixtures and one commit. Returns dir + full SHA. */
function makeSyntheticRepo(): { dir: string; commit: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ver-demo-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'demo@local']);
  git(dir, ['config', 'user.name', 'Demo Runner']);
  writeFileSync(join(dir, 'source.js'), 'export const add = (a, b) => a + b;\n');
  writeFileSync(join(dir, 'report.md'), '# Synthetic report\n\nAll figures reconciled.\n');
  // A real "test" that writes an artifact and exits 0/1 based on a flag.
  writeFileSync(
    join(dir, 'run-tests.js'),
    [
      "const fs = require('fs');",
      "const fail = process.argv.includes('--fail');",
      "fs.writeFileSync('test-results.json', JSON.stringify({ passed: !fail, at: new Date().toISOString() }));",
      "if (fail) { console.error('FAIL: 1 synthetic check failed'); process.exit(1); }",
      "console.log('PASS: 3/3 synthetic checks green'); process.exit(0);",
      '',
    ].join('\n'),
  );
  // Sensitive fixtures that must NEVER reach a review package.
  writeFileSync(join(dir, '.env'), 'SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiJ9.super.secret\n');
  writeFileSync(join(dir, 'secret-note.txt'), 'note to self: prod key sk_live_0123456789abcdef\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'synthetic fixtures']);
  return { dir, commit: git(dir, ['rev-parse', 'HEAD']) };
}

/** Run a real command as the trusted runner and capture true evidence. */
function runAsTrustedRunner(
  dir: string,
  commit: string,
  cmd: string,
  args: string[],
  expectArtifacts: string[],
): ExecutionEvidence {
  const startedAt = new Date().toISOString();
  const r = spawnSync(cmd, args, { cwd: dir, encoding: 'utf8' });
  const finishedAt = new Date().toISOString();
  const artifacts: ArtifactRef[] = expectArtifacts.map((p) => {
    const abs = join(dir, p);
    if (!existsSync(abs)) return { path: p, sha256: null, sizeBytes: null, present: false };
    const bytes = readFileSync(abs);
    return { path: p, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length, present: true };
  });
  const porcelain = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  return {
    kind: 'command',
    command: `${cmd} ${args.join(' ')}`.trim(),
    cwd: dir,
    environment: 'local-offline',
    commitSha: commit,
    uncommittedChanges: porcelain ? redact(porcelain) : null,
    startedAt,
    finishedAt,
    exitCode: r.status ?? -1,
    stdout: redact(r.stdout ?? ''),
    stderr: redact(r.stderr ?? ''),
    artifacts,
    producedBy: 'trusted_runner',
  };
}

function main(): void {
  const { dir, commit } = makeSyntheticRepo();
  console.log(`Synthetic repo: ${dir}\nCommit under review: ${commit}\n`);

  try {
    // ── 1. A disconnected agent reports missing access accurately ──────────────
    console.log('1) Disconnected agent reports missing access');
    const noAccess = describeAccess(null, null);
    const adjNoAccess = adjudicate({
      hasDraft: true,
      requiresExecution: true,
      access: noAccess,
      evidence: null,
      requiredArtifacts: [],
    });
    check(
      'reports the one exact missing connection, no run_commands, blocked status',
      noAccess.connection === 'disconnected' &&
        !!noAccess.missingConnection &&
        !noAccess.capabilities.includes('run_commands') &&
        adjNoAccess.status === 'blocked_missing_access',
      `connection=${noAccess.connection}; missing="${noAccess.missingConnection}"; status=${adjNoAccess.status}`,
    );

    // ── 2. A connected agent reads a file at an identified commit ──────────────
    console.log('\n2) Connected agent reads a file at an identified commit');
    const link = { repoFullName: 'synthetic/demo', defaultBranch: git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']) };
    const probe = {
      ok: true,
      branch: link.defaultBranch,
      commitSha: commit,
      checkedAt: new Date().toISOString(),
      workingTreeChanges: null,
      error: null,
    };
    // This trusted runner has a real checkout, so it truly can execute.
    const access = describeAccess(link, probe, { canRunCommands: true });
    const fileAtCommit = git(dir, ['show', `${commit}:source.js`]);
    check(
      'connected @ full SHA, read file content at that commit, execution allowed',
      access.connection === 'connected' &&
        access.commitSha === commit &&
        /export const add/.test(fileAtCommit) &&
        canExecute(access),
      `repo=${access.repoFullName}@${access.commitSha?.slice(0, 12)}… read source.js (${fileAtCommit.length}B); canExecute=${canExecute(access)}`,
    );

    // ── 3. An allowed offline test records real output and exit status ─────────
    console.log('\n3) Allowed offline test records real output + exit status');
    const passEvidence = runAsTrustedRunner(dir, commit, 'node', ['run-tests.js'], ['test-results.json']);
    const adjPass = adjudicate({
      hasDraft: true,
      requiresExecution: true,
      access,
      evidence: passEvidence,
      requiredArtifacts: ['test-results.json'],
    });
    check(
      'real exit 0 captured, artifact present → verified_complete',
      passEvidence.exitCode === 0 &&
        passEvidence.producedBy === 'trusted_runner' &&
        adjPass.status === 'verified_complete' &&
        adjPass.deliverable,
      `cmd="${passEvidence.command}" exit=${passEvidence.exitCode} stdout="${passEvidence.stdout.trim()}" → ${adjPass.status}`,
    );

    // ── 4. A failing test cannot result in "verified complete" ─────────────────
    console.log('\n4) A failing test cannot be verified_complete');
    const failEvidence = runAsTrustedRunner(dir, commit, 'node', ['run-tests.js', '--fail'], ['test-results.json']);
    const adjFail = adjudicate({
      hasDraft: true,
      requiresExecution: true,
      access,
      evidence: failEvidence,
      requiredArtifacts: ['test-results.json'],
    });
    check(
      'real exit 1 → verification_failed, not deliverable',
      failEvidence.exitCode === 1 && adjFail.status === 'verification_failed' && !adjFail.deliverable,
      `exit=${failEvidence.exitCode} stderr="${failEvidence.stderr.trim()}" → ${adjFail.status}; deliverable=${adjFail.deliverable}`,
    );
    // And an agent summary of "success" is inadmissible.
    const summaryEvidence: ExecutionEvidence = { ...passEvidence, producedBy: 'agent_summary' };
    const adjSummary = adjudicate({
      hasDraft: true,
      requiresExecution: true,
      access,
      evidence: summaryEvidence,
      requiredArtifacts: ['test-results.json'],
    });
    check(
      'an agent summary is rejected as evidence',
      adjSummary.status !== 'verified_complete',
      `summary-as-evidence → ${adjSummary.status} (${adjSummary.reasons[0]})`,
    );

    // ── 5. A missing artifact prevents a delivery claim ────────────────────────
    console.log('\n5) A missing artifact prevents a delivery claim');
    const adjMissing = adjudicate({
      hasDraft: true,
      requiresExecution: true,
      access,
      evidence: passEvidence, // exit 0
      requiredArtifacts: ['coverage/lcov.info'], // never produced
    });
    check(
      'exit 0 but promised artifact absent → not verified, not deliverable',
      adjMissing.status === 'verification_failed' && !adjMissing.deliverable,
      `${adjMissing.status}: ${adjMissing.reasons[0]}`,
    );

    // ── 6. A sanitized review package can be downloaded and inspected ──────────
    console.log('\n6) Sanitized review package can be downloaded + inspected');
    const readFileOrNull = (p: string): Buffer | null => (existsSync(join(dir, p)) ? readFileSync(join(dir, p)) : null);
    const selected: SelectedFile[] = [
      { path: 'source.js', sourcePath: join(dir, 'source.js'), bytes: readFileOrNull('source.js') },
      { path: 'report.md', sourcePath: join(dir, 'report.md'), bytes: readFileOrNull('report.md') },
      { path: '.env', sourcePath: join(dir, '.env'), bytes: readFileOrNull('.env') }, // excluded class
      { path: 'secret-note.txt', sourcePath: join(dir, 'secret-note.txt'), bytes: readFileOrNull('secret-note.txt') }, // sensitive content
      { path: 'missing.txt', sourcePath: join(dir, 'missing.txt'), bytes: readFileOrNull('missing.txt') }, // not found
    ];
    const pkg = buildReviewPackage({ sourceCommit: commit, verificationStatus: adjPass.status, selected });
    // "Download" it: write the included files + manifest to an output dir.
    const outDir = mkdtempSync(join(tmpdir(), 'ver-export-'));
    mkdirSync(join(outDir, 'files'), { recursive: true });
    for (const f of pkg.files) writeFileSync(join(outDir, 'files', f.path.replace(/[\\/]/g, '_')), f.bytes);
    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(pkg.manifest, null, 2));

    const included = new Set(pkg.manifest.files.map((f) => f.path));
    const omittedEnv = pkg.manifest.omissions.find((o) => o.path === '.env')?.reason;
    const omittedSecret = pkg.manifest.omissions.find((o) => o.path === 'secret-note.txt')?.reason;
    const omittedMissing = pkg.manifest.omissions.find((o) => o.path === 'missing.txt')?.reason;
    // Inspect the downloaded bundle for any leaked secret value.
    const bundleText = pkg.files.map((f) => f.bytes.toString('utf8')).join('\n');
    const leak = /eyJ|sk_live_/.test(bundleText);
    check(
      'includes clean files with hashes; excludes .env + secret content + missing; no secret leaked',
      included.has('source.js') &&
        included.has('report.md') &&
        omittedEnv === 'excluded_class' &&
        omittedSecret === 'contains_sensitive' &&
        omittedMissing === 'not_found' &&
        pkg.manifest.sourceCommit === commit &&
        pkg.manifest.sensitiveScan === 'omitted' &&
        !leak,
      `included=[${[...included].join(', ')}] omissions=${pkg.manifest.omissions.map((o) => `${o.path}:${o.reason}`).join(', ')} → ${outDir}`,
    );
    // A missing/omitted file can never be claimed as delivered.
    let refused = false;
    try {
      assertDeliverable(pkg, ['secret-note.txt']);
    } catch {
      refused = true;
    }
    check('delivery claim refused for an omitted file', refused, 'assertDeliverable threw for secret-note.txt');
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  console.log(`\n${failures === 0 ? 'ALL SCENARIOS PASSED' : `${failures} SCENARIO CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
