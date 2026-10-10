// Static import is safe: live-client imports only TYPES from this module, so there is no runtime cycle.
import { LiveSupabaseManagementClient } from './live-client';

/**
 * Supabase Management API access contract (Phase 2C, governed Supabase connector). Owner-gated: with the
 * platform secret present, `getSupabaseClient()` returns the live client (./live-client.ts); without it
 * everything fails CLOSED — absent credentials produce a typed refusal, never a fallback (same design as the
 * GitHub connector, docs/architecture/github-integration-decision.md).
 *
 * This FIRST PR is deliberately READ-ONLY: the interface exposes only inspection reads. There is NO deploy,
 * NO SQL, and NO migration method here — the governed WRITE operations (edge-function deploy from an exact
 * source SHA; explicitly-approved SQL via a constrained contract) land in later PRs as their own executor,
 * so a write is unrepresentable through this read interface by construction. `db push` is never a method.
 */

/** A linked Supabase project, identified by its opaque ref. The Management token is held by the client, not here. */
export interface SupabaseProjectRef {
  readonly projectRef: string;
}

/** A project's safe, UNTRUSTED summary — no secrets (the Management API never returns the token). */
export interface SupabaseProjectInfo {
  readonly ref: string;
  readonly name: string;
  readonly region: string;
  readonly status: string;
  readonly databaseVersion: string | null;
}

/** One edge function's safe summary. */
export interface SupabaseEdgeFunctionSummary {
  readonly slug: string;
  readonly name: string;
  readonly status: string;
  readonly version: number | null;
  readonly verifyJwt: boolean | null;
  readonly updatedAt: string | null;
}

/** One applied database migration's safe summary. */
export interface SupabaseMigrationSummary {
  readonly version: string;
  readonly name: string | null;
}

export interface SupabaseManagementClient {
  /** Read one project's state (name, region, status, db version). Read-only. */
  getProject(ref: SupabaseProjectRef): Promise<SupabaseProjectInfo>;
  /** List the project's edge functions (slug, status, version, verify_jwt). Read-only. */
  listEdgeFunctions(ref: SupabaseProjectRef): Promise<SupabaseEdgeFunctionSummary[]>;
  /** List the project's applied database migrations (version + name). Read-only. */
  listMigrations(ref: SupabaseProjectRef): Promise<SupabaseMigrationSummary[]>;
}

/** Thrown for every operation while the owner-gated Supabase Management token is absent. */
export class SupabaseUnconfiguredError extends Error {
  constructor() {
    super(
      'Supabase access is not configured: the owner-gated Supabase Management API token (SUPABASE_MANAGEMENT_TOKEN) is absent. All Supabase operations fail closed.',
    );
    this.name = 'SupabaseUnconfiguredError';
  }
}

/** The fail-closed placeholder: every method refuses. It performs no I/O of any kind. */
class UnconfiguredSupabaseManagementClient implements SupabaseManagementClient {
  getProject(): Promise<SupabaseProjectInfo> {
    return Promise.reject(new SupabaseUnconfiguredError());
  }
  listEdgeFunctions(): Promise<SupabaseEdgeFunctionSummary[]> {
    return Promise.reject(new SupabaseUnconfiguredError());
  }
  listMigrations(): Promise<SupabaseMigrationSummary[]> {
    return Promise.reject(new SupabaseUnconfiguredError());
  }
}

let testOverride: SupabaseManagementClient | null = null;

/** Tests inject a fake here (mirrors setGitHubClientOverrideForTests). Pass null to clear. */
export function setSupabaseClientOverrideForTests(client: SupabaseManagementClient | null): void {
  testOverride = client;
}

/** True only when the owner-gated Management token is present in the environment. */
export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_MANAGEMENT_TOKEN);
}

/** Hard ceiling on any single Supabase Management API call — a hung read becomes a bounded failure. */
const SUPABASE_FETCH_TIMEOUT_MS = 25_000;

let liveClient: SupabaseManagementClient | null = null;

/**
 * Resolve the Supabase client. With the Management token present this returns the live client; without it,
 * the fail-closed placeholder whose every method rejects. Absence of the credential can never degrade into a
 * fallback. The token is read ONLY here (never stored in the DB), exactly like the GitHub App credentials.
 */
export function getSupabaseClient(): SupabaseManagementClient {
  if (testOverride) return testOverride;
  const token = process.env.SUPABASE_MANAGEMENT_TOKEN;
  if (!token) return new UnconfiguredSupabaseManagementClient();
  if (!liveClient) {
    liveClient = new LiveSupabaseManagementClient({
      token,
      fetchImpl: async (url, init) => {
        const res = await fetch(url, { ...init, signal: AbortSignal.timeout(SUPABASE_FETCH_TIMEOUT_MS) });
        return { status: res.status, json: () => res.json() };
      },
    });
  }
  return liveClient;
}

/** Test hook: drop the cached live client so env changes take effect between tests. */
export function resetSupabaseClientForTests(): void {
  liveClient = null;
}
