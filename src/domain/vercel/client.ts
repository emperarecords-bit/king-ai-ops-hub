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

/** One deployment's precondition state, read by the mutation executor (READY gate + SHA binding). */
export interface VercelDeploymentState {
  readonly id: string;
  /** READY | BUILDING | ERROR | QUEUED | INITIALIZING | CANCELED | … */
  readonly readyState: string;
  readonly target: 'production' | 'preview';
  readonly sourceSha: string | null;
}

/** A project's production-pointer state, for the staleness guard on promote/rollback. */
export interface VercelProjectState {
  readonly name: string;
  readonly productionDeploymentId: string | null;
  readonly productionSha: string | null;
}

/**
 * The Vercel WRITE surface (Phase 2D mutation slice) — deliberately SEPARATE from the read-only `VercelClient` so
 * the read connector's "a write is unrepresentable" guarantee holds for every read-path consumer. ONLY the
 * governed mutation executor resolves this (via `getVercelMutationClient()`). It also carries the exact reads the
 * executor needs for preconditions + post-action verification (getDeployment, getProjectState); these never widen
 * the read connector's own interface. Vercel deployments are immutable artifacts and production is a pointer, so
 * every mutation here is reversible by another repoint — hence external_reversible.
 */
export interface VercelMutationClient {
  /** Read one deployment's state (readyState, target, source SHA), or null when absent. */
  getDeployment(ref: VercelProjectRef, deploymentId: string): Promise<VercelDeploymentState | null>;
  /** Read the project's name + current production deployment id/SHA (the promote/rollback staleness anchor). */
  getProjectState(ref: VercelProjectRef): Promise<VercelProjectState>;
  /** Create a NEW deployment from an existing one's source (never targets production). Returns the new id + state. */
  redeploy(ref: VercelProjectRef, args: { name: string; sourceDeploymentId: string }): Promise<{ deploymentId: string; readyState: string }>;
  /** Point production traffic to an exact READY deployment. */
  promote(ref: VercelProjectRef, deploymentId: string): Promise<void>;
  /** Point production traffic back to an exact previous READY production deployment. */
  rollback(ref: VercelProjectRef, deploymentId: string, description?: string): Promise<void>;
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

/** The fail-closed placeholder for the WRITE surface: every method refuses, performing no I/O. */
class UnconfiguredVercelMutationClient implements VercelMutationClient {
  getDeployment(): Promise<VercelDeploymentState | null> {
    return Promise.reject(new VercelUnconfiguredError());
  }
  getProjectState(): Promise<VercelProjectState> {
    return Promise.reject(new VercelUnconfiguredError());
  }
  redeploy(): Promise<{ deploymentId: string; readyState: string }> {
    return Promise.reject(new VercelUnconfiguredError());
  }
  promote(): Promise<void> {
    return Promise.reject(new VercelUnconfiguredError());
  }
  rollback(): Promise<void> {
    return Promise.reject(new VercelUnconfiguredError());
  }
}

let testOverride: VercelClient | null = null;
let mutationTestOverride: VercelMutationClient | null = null;

/** Tests inject a fake here (mirrors setSupabaseClientOverrideForTests). Pass null to clear. */
export function setVercelClientOverrideForTests(client: VercelClient | null): void {
  testOverride = client;
}

/** Tests inject a fake WRITE client here. Pass null to clear. */
export function setVercelMutationClientOverrideForTests(client: VercelMutationClient | null): void {
  mutationTestOverride = client;
}

/** True only when the owner-gated Vercel token is present in the environment. */
export function isVercelConfigured(): boolean {
  return Boolean(process.env.VERCEL_TOKEN);
}

/** Hard ceiling on any single Vercel REST call — a hung read becomes a bounded failure. */
const VERCEL_FETCH_TIMEOUT_MS = 25_000;

let liveClient: LiveVercelClient | null = null;

/** Build (once) the shared live client. The token is read ONLY here, never stored in the DB. */
function resolveLiveClient(): LiveVercelClient | null {
  const token = process.env.VERCEL_TOKEN;
  if (!token) return null;
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

/**
 * Resolve the READ-only Vercel client. With the token present this returns the live client; without it, the
 * fail-closed placeholder whose every method rejects. Absence of the credential can never degrade into a fallback.
 * The same live instance backs the mutation surface, but this getter's return type exposes only reads.
 */
export function getVercelClient(): VercelClient {
  if (testOverride) return testOverride;
  return resolveLiveClient() ?? new UnconfiguredVercelClient();
}

/**
 * Resolve the WRITE (mutation) Vercel client. Same owner-gated token + fail-closed discipline as the read client;
 * ONLY the governed mutation executor calls this. Without the token it is the fail-closed mutation placeholder.
 */
export function getVercelMutationClient(): VercelMutationClient {
  if (mutationTestOverride) return mutationTestOverride;
  return resolveLiveClient() ?? new UnconfiguredVercelMutationClient();
}

/** Test hook: drop the cached live client so env changes take effect between tests. */
export function resetVercelClientForTests(): void {
  liveClient = null;
}
