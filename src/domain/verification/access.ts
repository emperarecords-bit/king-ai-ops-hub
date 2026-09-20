/**
 * Project access visibility (Priority 1).
 *
 * Turns a project's repository link + a live access probe into an honest
 * `RepoAccess`: linked repo/branch, full reviewed commit, real capabilities,
 * connection status, last-checked time, and — when access is absent — the ONE
 * exact missing connection to fix.
 *
 * Two laws enforced here:
 *  - `run_commands` is granted ONLY when a real execution environment is present.
 *    A GitHub-REST link can read files, but it cannot run commands. This is how
 *    the Hub refuses to assign execution work to an agent with no environment.
 *  - When access is missing, we name the single missing connection once — not a
 *    vague "no access."
 */
import type { Capability, RepoAccess } from './types';

/** The project's repository binding (mirror of a `github_repo_links` row we care about). */
export interface RepoLink {
  readonly repoFullName: string;
  readonly defaultBranch: string;
}

/** Result of actually attempting to reach the repo (a read), with the resolved commit. */
export interface AccessProbe {
  readonly ok: boolean;
  readonly branch: string | null;
  readonly commitSha: string | null; // full 40-hex SHA
  readonly checkedAt: string; // ISO
  readonly workingTreeChanges: string | null;
  readonly error: string | null;
}

/** Does this environment actually let the runner execute commands? Defaults to false. */
export interface EnvironmentPowers {
  readonly canRunCommands: boolean;
}

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * Compose the honest access view. `link` is null when no repo is linked to the
 * project; `probe` is null when no access check has been attempted yet.
 */
export function describeAccess(
  link: RepoLink | null,
  probe: AccessProbe | null,
  env: EnvironmentPowers = { canRunCommands: false },
): RepoAccess {
  // Not linked at all → the single missing connection is the repo link itself.
  if (!link) {
    return {
      linked: false,
      repoFullName: null,
      branch: null,
      commitSha: null,
      workingTreeChanges: null,
      capabilities: [],
      connection: 'disconnected',
      lastCheckedAt: probe?.checkedAt ?? null,
      missingConnection: 'No repository is linked to this project (github_repo_links). Link a repo to grant read access.',
      detail: 'No linked repository. The agent has no source to read and cannot execute work.',
    };
  }

  // Linked but never probed, or the probe failed → connection is not established.
  if (!probe || !probe.ok) {
    return {
      linked: true,
      repoFullName: link.repoFullName,
      branch: link.defaultBranch,
      commitSha: null,
      workingTreeChanges: null,
      capabilities: [],
      connection: probe ? 'error' : 'disconnected',
      lastCheckedAt: probe?.checkedAt ?? null,
      missingConnection: probe
        ? `GitHub read access to ${link.repoFullName} failed: ${probe.error ?? 'unknown error'}. Check the App installation and repo grant.`
        : `No successful access check for ${link.repoFullName} yet. Run a read probe to establish the connection.`,
      detail: `Linked to ${link.repoFullName} but the connection is not verified.`,
    };
  }

  // Connected. Read + network are real; run_commands only if the environment truly provides it.
  const commitSha = probe.commitSha && FULL_SHA.test(probe.commitSha) ? probe.commitSha : null;
  const capabilities: Capability[] = ['read_files', 'network'];
  if (env.canRunCommands) capabilities.push('run_commands');

  return {
    linked: true,
    repoFullName: link.repoFullName,
    branch: probe.branch ?? link.defaultBranch,
    commitSha,
    workingTreeChanges: probe.workingTreeChanges,
    capabilities,
    connection: 'connected',
    lastCheckedAt: probe.checkedAt,
    missingConnection: env.canRunCommands
      ? null
      : 'No execution environment: read/network only. Running commands (tests, builds) requires a sandbox the Hub does not have yet.',
    detail: commitSha
      ? `Connected to ${link.repoFullName} @ ${commitSha} on ${probe.branch ?? link.defaultBranch}.`
      : `Connected to ${link.repoFullName}, but no full commit SHA was resolved.`,
  };
}

/** True only when the agent may be assigned execution work in this access context. */
export function canExecute(access: RepoAccess): boolean {
  return access.connection === 'connected' && access.capabilities.includes('run_commands');
}

/**
 * Guard: refuse to assign execution work to an agent without an execution
 * environment. Returns the exact missing connection, or null when execution is allowed.
 */
export function executionBlockReason(access: RepoAccess): string | null {
  if (canExecute(access)) return null;
  if (access.connection !== 'connected') {
    return access.missingConnection ?? 'Repository access is not connected.';
  }
  return 'No execution environment: the agent can read but cannot run commands. Evidence must come from a trusted external runner.';
}
