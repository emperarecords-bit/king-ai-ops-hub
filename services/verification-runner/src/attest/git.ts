/**
 * Repository state facts that go INTO the signed payload (design, EvidenceSubmission).
 *
 * A commit SHA alone cannot identify a dirty tree, which is why the contract carries both a
 * dirty flag and a digest of the uncommitted changes. Both are read by the COLLECTOR from git
 * itself, never from a file the checkout could write.
 *
 * Note the Hub rejects dirty submissions in this integration regardless of allowDirty, so the
 * honest thing is to surface dirtiness loudly here rather than let the operator discover it as a
 * server rejection after a full test run.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export interface RepoState {
  readonly commitSha: string;
  readonly dirty: boolean;
  /** sha256 of git status --porcelain output when dirty; null when clean. */
  readonly uncommittedChangesDigest: string | null;
}

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
}

export function readRepoState(checkoutDir: string): RepoState {
  const commitSha = git(['rev-parse', 'HEAD'], checkoutDir);
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error('readRepoState: HEAD is not a 40-hex sha: ' + commitSha);

  // --porcelain is the stable, machine-readable form; it is explicitly versioned by git for this
  // purpose, unlike the human-readable status output which changes between releases.
  const porcelain = git(['status', '--porcelain'], checkoutDir);
  const dirty = porcelain.length > 0;
  return {
    commitSha,
    dirty,
    uncommittedChangesDigest: dirty ? createHash('sha256').update(porcelain).digest('hex') : null,
  };
}

/**
 * The contract pins the exact commit it verifies. Checking locally turns a wasted full test run
 * into an immediate, legible refusal, and matches the Hub rejection that would otherwise follow.
 */
export function assertCommitMatchesContract(contract: { expectedCommitSha: string }, state: RepoState): void {
  if (contract.expectedCommitSha.toLowerCase() !== state.commitSha.toLowerCase()) {
    throw new Error(
      'checkout is at ' + state.commitSha + ' but the contract pins ' + contract.expectedCommitSha + ' (stale-commit evidence is rejected)',
    );
  }
}
