import { describe, expect, it } from 'vitest';
import {
  adjudicate,
  assertDeliverable,
  buildReviewPackage,
  canExecute,
  containsSensitive,
  describeAccess,
  executionBlockReason,
  isAdmissibleEvidence,
  isExcludedPath,
  redact,
  type ExecutionEvidence,
} from '@/domain/verification';

const okEvidence = (over: Partial<ExecutionEvidence> = {}): ExecutionEvidence => ({
  kind: 'command',
  command: 'node run-tests.js',
  cwd: '/tmp/x',
  environment: 'ci',
  commitSha: 'a'.repeat(40),
  uncommittedChanges: null,
  startedAt: '2026-09-20T00:00:00.000Z',
  finishedAt: '2026-09-20T00:00:01.000Z',
  exitCode: 0,
  stdout: 'PASS',
  stderr: '',
  artifacts: [{ path: 'test-results.json', sha256: 'b'.repeat(64), sizeBytes: 12, present: true }],
  producedBy: 'trusted_runner',
  ...over,
});

describe('access visibility', () => {
  it('reports the one missing connection when no repo is linked', () => {
    const a = describeAccess(null, null);
    expect(a.connection).toBe('disconnected');
    expect(a.linked).toBe(false);
    expect(a.capabilities).not.toContain('run_commands');
    expect(a.missingConnection).toMatch(/No repository is linked/);
    expect(canExecute(a)).toBe(false);
  });

  it('connects at a full SHA but withholds run_commands without an execution environment', () => {
    const link = { repoFullName: 'o/r', defaultBranch: 'main' };
    const probe = { ok: true, branch: 'main', commitSha: 'c'.repeat(40), checkedAt: 'now', workingTreeChanges: null, error: null };
    const a = describeAccess(link, probe); // default: no exec env
    expect(a.connection).toBe('connected');
    expect(a.commitSha).toBe('c'.repeat(40));
    expect(a.capabilities).toEqual(['read_files', 'network']);
    expect(canExecute(a)).toBe(false);
    expect(executionBlockReason(a)).toMatch(/No execution environment/);
  });

  it('grants run_commands only when the environment provides it', () => {
    const link = { repoFullName: 'o/r', defaultBranch: 'main' };
    const probe = { ok: true, branch: 'main', commitSha: 'd'.repeat(40), checkedAt: 'now', workingTreeChanges: null, error: null };
    const a = describeAccess(link, probe, { canRunCommands: true });
    expect(a.capabilities).toContain('run_commands');
    expect(canExecute(a)).toBe(true);
    expect(executionBlockReason(a)).toBeNull();
  });

  it('rejects a non-40-hex sha', () => {
    const link = { repoFullName: 'o/r', defaultBranch: 'main' };
    const probe = { ok: true, branch: 'main', commitSha: 'abc123', checkedAt: 'now', workingTreeChanges: null, error: null };
    expect(describeAccess(link, probe).commitSha).toBeNull();
  });
});

describe('adjudication', () => {
  const connected = describeAccess(
    { repoFullName: 'o/r', defaultBranch: 'main' },
    { ok: true, branch: 'main', commitSha: 'e'.repeat(40), checkedAt: 'now', workingTreeChanges: null, error: null },
    { canRunCommands: true },
  );
  const base = { hasDraft: true, requiresExecution: true, access: connected, requiredArtifacts: ['test-results.json'] };

  it('blocks when access is missing', () => {
    const r = adjudicate({ ...base, access: describeAccess(null, null), evidence: null });
    expect(r.status).toBe('blocked_missing_access');
    expect(r.deliverable).toBe(false);
  });

  it('is ready_for_verification with access but no evidence', () => {
    expect(adjudicate({ ...base, evidence: null }).status).toBe('ready_for_verification');
  });

  it('verifies on real exit 0 with all artifacts present', () => {
    const r = adjudicate({ ...base, evidence: okEvidence() });
    expect(r.status).toBe('verified_complete');
    expect(r.deliverable).toBe(true);
  });

  it('fails on a non-zero exit', () => {
    const r = adjudicate({ ...base, evidence: okEvidence({ exitCode: 1 }) });
    expect(r.status).toBe('verification_failed');
    expect(r.deliverable).toBe(false);
  });

  it('cannot claim delivery when a required artifact is missing', () => {
    const r = adjudicate({ ...base, requiredArtifacts: ['coverage/lcov.info'], evidence: okEvidence() });
    expect(r.status).toBe('verification_failed');
    expect(r.deliverable).toBe(false);
  });

  it('rejects an agent summary as evidence', () => {
    const r = adjudicate({ ...base, evidence: okEvidence({ producedBy: 'agent_summary' }) });
    expect(r.status).not.toBe('verified_complete');
    expect(isAdmissibleEvidence(okEvidence({ producedBy: 'agent_summary' }))).toBe(false);
  });

  it('draft-only, non-executable task stays draft_complete', () => {
    expect(adjudicate({ ...base, requiresExecution: false, evidence: null }).status).toBe('draft_complete');
  });
});

describe('sanitize', () => {
  it('redacts secret-shaped values', () => {
    const t = 'key sk_live_0123456789abcd and jwt eyJhbGciOi.aaaaaaaaaa.bbbbbbbbbb';
    const out = redact(t);
    expect(out).not.toMatch(/sk_live_0123/);
    expect(out).toContain('[REDACTED:stripe_key]');
    expect(containsSensitive(t)).toBe(true);
    expect(containsSensitive(redact(t))).toBe(false);
  });

  it('masks only the value in KEY=VALUE secrets', () => {
    expect(redact('SUPABASE_SERVICE_ROLE_KEY=abcdef123456')).toBe('SUPABASE_SERVICE_ROLE_KEY=[REDACTED:assigned_secret]');
  });

  it('excludes credential/session/git/customer paths', () => {
    for (const p of ['.env', 'a/.git/config', 'secrets/x', 'k.pem', 'sessions/s', 'customer_data/x', 'node_modules/y']) {
      expect(isExcludedPath(p).excluded).toBe(true);
    }
    expect(isExcludedPath('src/report.md').excluded).toBe(false);
  });
});

describe('review package export', () => {
  const b = (s: string) => Buffer.from(s, 'utf8');
  it('includes clean files, omits excluded/sensitive/missing, hashes each', () => {
    const pkg = buildReviewPackage({
      sourceCommit: 'f'.repeat(40),
      verificationStatus: 'verified_complete',
      selected: [
        { path: 'ok.md', sourcePath: '/r/ok.md', bytes: b('# clean') },
        { path: '.env', sourcePath: '/r/.env', bytes: b('X=1') },
        { path: 'note.txt', sourcePath: '/r/note.txt', bytes: b('sk_live_0123456789abcd') },
        { path: 'gone.txt', sourcePath: '/r/gone.txt', bytes: null },
      ],
    });
    expect(pkg.manifest.files.map((f) => f.path)).toEqual(['ok.md']);
    expect(pkg.manifest.files[0]!.sha256).toHaveLength(64);
    expect(pkg.manifest.omissions.find((o) => o.path === '.env')?.reason).toBe('excluded_class');
    expect(pkg.manifest.omissions.find((o) => o.path === 'note.txt')?.reason).toBe('contains_sensitive');
    expect(pkg.manifest.omissions.find((o) => o.path === 'gone.txt')?.reason).toBe('not_found');
    expect(pkg.manifest.sensitiveScan).toBe('omitted');
  });

  it('refuses to claim delivery of an omitted file', () => {
    const pkg = buildReviewPackage({
      sourceCommit: null,
      verificationStatus: 'verified_complete',
      selected: [{ path: '.env', sourcePath: '/r/.env', bytes: b('X=1') }],
    });
    expect(() => assertDeliverable(pkg, ['.env'])).toThrow(/Cannot claim delivery/);
  });
});
