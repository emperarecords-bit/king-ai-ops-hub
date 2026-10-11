// Static import is safe: live-client imports only TYPES from this module, so there is no runtime cycle.
import { LiveVercelClient } from './live-client';

/**
 * Vercel access contract (Phase 2D, governed Vercel connector). Owner-gated: with the platform token present,
 * `getVercelClient()` returns the live client (./live-client.ts); without it everything fails CLOSED — absent
 * credentials produce a typed refusal, never a fallback (same design as the GitHub/Supabase connectors).
 *
 * This FIRST PR is deliberately READ-ONLY: the interface exposes only inspection reads (project info, deployments,
 * their production/preview target, source commit SHA, and status). There is NO redeploy, promote, rollback, or any
 * other mutation method here — the governed WRITE operations land in a LATER PR as their own executor, so a write
 * is unrepresentable through this read interface by construction.
 */

/** A linked Vercel project, identified by its opaque id (+ optional team scope). The token is held by the client. */
export interface VercelProjectRef {
  readonly projectId: string;
  readonly teamId: string | null;
}

/** A project's safe, UNTRUSTED summary — no secrets. */
export interface VercelProjectInfo {
  readonly id: string;
  readonly name: string;
  readonly framework: string | null;
  /** The production alias/domain, when the API reports one. */
  readonly productionUrl: string | null;
}

/** One deployment's safe summary — production vs preview, its source commit, and its status. No secrets. */
export interface VercelDeploymentSummary {
  readonly id: string;
  readonly url: string | null;
  /** READY | BUILDING | ERROR | QUEUED | INITIALIZING | CANCELED | BLOCKED | … */
  readonly state: string;
  /** 'production' for a production deployment, 'preview' otherwise. */
  readonly target: 'production' | 'preview';
  /** The git commit SHA this deployment was built from (meta.githubCommitSha), or null. */
  readonly sourceSha: string | null;
  /** The git branch (meta.githubCommitRef), or null. */
  readonly branch: string | null;
  readonly createdAt: string | null;
  readonly inspectorUrl: string | null;
}

export interface VercelClient {
  /** Read one project's state (name, framework, production URL). Read-only. */
  getProject(ref: VercelProjectRef): Promise<VercelProjectInfo>;
  /** List a project's recent deployments (production + preview), newest first. Read-only. */
  listDeployments(ref: VercelProjectRef, opts?: { limit?: number }): Promise<VercelDeploymentSummary[]>;
}

/** Thrown for every operation while the owner-gated Vercel API token is absent. */
export class VercelUnconfiguredError extends Error {
  constructor() {
    super(
      'Vercel access is not configured: the owner-gated Vercel API token (VERCEL_TOKEN) is absent. All Vercel operations fail closed.',
    );
    this.name = 'VercelUnconfiguredError';
  }
}

/** The fail-closed placeholder: every method refuses. It performs no I/O of any kind. */
class UnconfiguredVercelClient implements VercelClient {
  getProject(): Promise<VercelProjectInfo> {
    return Promise.reject(new VercelUnconfiguredError());
  }
  listDeployments(): Promise<VercelDeploymentSummary[]> {
    return Promise.reject(new VercelUnconfiguredError());
  }
}

let testOverride: VercelClient | null = null;

/** Tests inject a fake here (mirrors setSupabaseClientOverrideForTests). Pass null to clear. */
export function setVercelClientOverrideForTests(client: VercelClient | null): void {
  testOverride = client;
}

/** True only when the owner-gated Vercel token is present in the environment. */
export function isVercelConfigured(): boolean {
  return Boolean(process.env.VERCEL_TOKEN);
}

/** Hard ceiling on any single Vercel REST call — a hung read becomes a bounded failure. */
const VERCEL_FETCH_TIMEOUT_MS = 25_000;

let liveClient: VercelClient | null = null;

/**
 * Resolve the Vercel client. With the token present this returns the live client; without it, the fail-closed
 * placeholder whose every method rejects. Absence of the credential can never degrade into a fallback. The token
 * is read ONLY here (never stored in the DB), exactly like the GitHub/Supabase credentials.
 */
export function getVercelClient(): VercelClient {
  if (testOverride) return testOverride;
  const token = process.env.VERCEL_TOKEN;
  if (!token) return new UnconfiguredVercelClient();
  if (!liveClient) {
    liveClient = new LiveVercelClient({
      token,
      fetchImpl: async (url, init) => {
        const res = await fetch(url, { ...init, signal: AbortSignal.timeout(VERCEL_FETCH_TIMEOUT_MS) });
        return { status: res.status, json: () => res.json() };
      },
    });
  }
  return liveClient;
}

/** Test hook: drop the cached live client so env changes take effect between tests. */
export function resetVercelClientForTests(): void {
  liveClient = null;
}
