/**
 * Which AccurateBids contractor account a workspace acts as.
 *
 * Owner direction 2026-11-13: Hill Street Construction (project key `empera-home-improvement`)
 * must bill its Roosevelt Island work to ITS OWN AccurateBids account, not Empera Air
 * Conditioning's. AccurateBids PR #219 made every hub-* endpoint resolve the contractor from the
 * bearer token (`hub_integration_config.token_sha256`), so routing a workspace is entirely a
 * question of sending the right token — no payload field, no schema change on either side.
 *
 * Resolution order for a workspace:
 *   1. `ACCURATEBIDS_SERVICE_TOKEN__<KEY>` — that workspace's own token (KEY uppercased, '-' → '_').
 *   2. the shared `ACCURATEBIDS_SERVICE_TOKEN` — but only if the workspace may use it.
 *   3. nothing, and the caller must refuse.
 *
 * Step 3 is the point of the file. Falling back silently is how a Hill Street invoice lands on
 * Empera's account: the exact bug being fixed, except now invisible. Once
 * `ACCURATEBIDS_DEFAULT_TOKEN_KEYS` names the workspaces entitled to the shared token, a missing
 * or misspelled per-workspace secret BLOCKS instead of misrouting. Left unset it permits every
 * workspace, which is today's behaviour exactly — so this file changes nothing until it is set.
 *
 * Per-workspace env vars rather than one JSON map on purpose: Fly secrets are set individually,
 * so rotating one token never means re-pasting the others, one malformed value cannot break every
 * workspace at once, and `fly secrets list` shows by NAME which workspaces are wired (values stay
 * hidden either way).
 */

/**
 * Project keys are slugs. Uppercasing with '-' → '_' would map both `a-b` and `a_b` onto
 * `ACCURATEBIDS_SERVICE_TOKEN__A_B`, so a key outside this charset resolves to NO variable name
 * at all rather than to a colliding one: a token can never be read for the wrong workspace.
 */
const PROJECT_KEY_RE = /^[a-z0-9-]+$/;

/** 'per-project' = its own token; 'default' = the shared one; 'none' = refuse, do not send. */
export type TokenSource = 'per-project' | 'default' | 'none';

export interface ResolvedServiceToken {
  readonly token: string | undefined;
  readonly source: TokenSource;
}

/** The env var holding this workspace's own token, or null if the key cannot map to one safely. */
export function serviceTokenEnvVar(projectKey: string): string | null {
  if (!PROJECT_KEY_RE.test(projectKey)) return null;
  return `ACCURATEBIDS_SERVICE_TOKEN__${projectKey.replace(/-/g, '_').toUpperCase()}`;
}

/** Workspaces allowed to act as the shared contractor account. Empty/unset means all of them. */
export function defaultTokenKeys(env: Record<string, string | undefined> = process.env): string[] {
  return (env.ACCURATEBIDS_DEFAULT_TOKEN_KEYS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve the token a workspace must present to AccurateBids.
 *
 * An absent `projectKey` (a call site that has no workspace in hand) keeps the shared token, so
 * nothing regresses while call sites are threaded through one at a time. An UNKNOWN workspace is
 * not the same thing and must be refused by the caller before it gets here — see dispatch.ts.
 */
export function resolveServiceToken(
  projectKey: string | undefined,
  env: Record<string, string | undefined> = process.env,
): ResolvedServiceToken {
  const shared = env.ACCURATEBIDS_SERVICE_TOKEN || undefined;
  if (!projectKey) return { token: shared, source: 'default' };
  const name = serviceTokenEnvVar(projectKey);
  const own = name ? env[name] : undefined;
  if (own) return { token: own, source: 'per-project' };
  const allowed = defaultTokenKeys(env);
  if (allowed.length === 0 || allowed.includes(projectKey)) return { token: shared, source: 'default' };
  return { token: undefined, source: 'none' };
}

/** True when this workspace has SOME usable token — its own or a shared one it may use. */
export function hasServiceToken(
  projectKey: string | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(resolveServiceToken(projectKey, env).token);
}

/** Why a workspace was refused, in words the owner can act on. Never names a token value. */
export const NO_TOKEN_FOR_WORKSPACE =
  'This workspace has no AccurateBids account of its own and is not permitted to use the shared one, ' +
  'so nothing was sent — billing the wrong contractor account is worse than doing nothing. ' +
  'Set ACCURATEBIDS_SERVICE_TOKEN__<WORKSPACE_KEY> for it, or add its key to ACCURATEBIDS_DEFAULT_TOKEN_KEYS.';
