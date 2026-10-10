// Static import is safe: live-client imports only TYPES from this module, so there is no runtime cycle.
import { LiveSupabaseManagementClient } from './live-client';

/**
 * Supabase Management API access contract (Phase 2C, governed Supabase connector). Owner-gated: with the
 * platform secret present, `getSupabaseClient()` returns the live client (./live-client.ts); without it
 * everything fails CLOSED — absent credentials produce a typed refusal, never a fallback (same design as the
 * GitHub connector, docs/architecture/github-integration-decision.md).
 *
 * The read-only inspection surface is `SupabaseManagementClient` below: it exposes ONLY reads, so a write is
 * unrepresentable through it by construction and every read-path consumer keeps that guarantee. The governed
 * WRITE surface is a SEPARATE interface, `SupabaseDeployClient` (Phase 2C write slice): one edge-function deploy,
 * resolved only by the governed deploy executor. SQL/migration execution is still NOT here — it lands later as
 * its own action type + executor. `db push` is never a method on either surface.
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

/** One edge-function source file — bundle-relative path + UTF-8 content. Carries NO secret. */
export interface SupabaseEdgeFunctionFile {
  readonly path: string;
  readonly content: string;
}

/** The exact, fully-resolved bytes + metadata of one edge-function deploy (built by the governed executor). */
export interface SupabaseEdgeFunctionDeploySpec {
  readonly slug: string;
  /** Bundle-relative entrypoint (e.g. "index.ts"); must be one of `files`. */
  readonly entrypointPath: string;
  /** Bundle-relative import map, or null. */
  readonly importMapPath: string | null;
  readonly verifyJwt: boolean;
  readonly files: ReadonlyArray<SupabaseEdgeFunctionFile>;
}

/**
 * The Supabase WRITE surface (Phase 2C write slice) — deliberately SEPARATE from the read-only
 * `SupabaseManagementClient` so the read connector's "a write is unrepresentable" guarantee holds for every
 * read-path consumer. ONLY the governed deploy executor resolves this (via `getSupabaseDeployClient()`), and the
 * single mutating method deploys one edge function. `getEdgeFunction` is a read used purely for post-deploy
 * verification. There is still NO SQL, migration, or `db push` method anywhere.
 */
export interface SupabaseDeployClient {
  /** Deploy one edge function's exact bytes to a project. The ONLY write. Returns the new slug + version. */
  deployEdgeFunction(
    ref: SupabaseProjectRef,
    spec: SupabaseEdgeFunctionDeploySpec,
  ): Promise<{ slug: string; version: number | null }>;
  /** Read one edge function by slug for post-deploy verification, or null when absent. Read-only. */
  getEdgeFunction(ref: SupabaseProjectRef, slug: string): Promise<SupabaseEdgeFunctionSummary | null>;
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

/** The fail-closed placeholder for the WRITE surface: both methods refuse, performing no I/O. */
class UnconfiguredSupabaseDeployClient implements SupabaseDeployClient {
  deployEdgeFunction(): Promise<{ slug: string; version: number | null }> {
    return Promise.reject(new SupabaseUnconfiguredError());
  }
  getEdgeFunction(): Promise<SupabaseEdgeFunctionSummary | null> {
    return Promise.reject(new SupabaseUnconfiguredError());
  }
}

let testOverride: SupabaseManagementClient | null = null;
let deployTestOverride: SupabaseDeployClient | null = null;

/** Tests inject a fake here (mirrors setGitHubClientOverrideForTests). Pass null to clear. */
export function setSupabaseClientOverrideForTests(client: SupabaseManagementClient | null): void {
  testOverride = client;
}

/** Tests inject a fake WRITE client here. Pass null to clear. */
export function setSupabaseDeployClientOverrideForTests(client: SupabaseDeployClient | null): void {
  deployTestOverride = client;
}

/** True only when the owner-gated Management token is present in the environment. */
export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_MANAGEMENT_TOKEN);
}

/** Hard ceiling on any single Supabase Management API call — a hung read becomes a bounded failure. */
const SUPABASE_FETCH_TIMEOUT_MS = 25_000;

let liveClient: LiveSupabaseManagementClient | null = null;

/** Build (once) the shared live client. The token is read ONLY here, never stored in the DB. */
function resolveLiveClient(): LiveSupabaseManagementClient | null {
  const token = process.env.SUPABASE_MANAGEMENT_TOKEN;
  if (!token) return null;
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

/**
 * Resolve the READ-only Supabase client. With the Management token present this returns the live client; without
 * it, the fail-closed placeholder whose every method rejects. Absence of the credential can never degrade into a
 * fallback. The same live instance backs the deploy surface, but this getter's return type exposes only reads.
 */
export function getSupabaseClient(): SupabaseManagementClient {
  if (testOverride) return testOverride;
  return resolveLiveClient() ?? new UnconfiguredSupabaseManagementClient();
}

/**
 * Resolve the WRITE (deploy) Supabase client. Same owner-gated token + fail-closed discipline as the read client;
 * ONLY the governed deploy executor calls this. Without the token it is the fail-closed deploy placeholder.
 */
export function getSupabaseDeployClient(): SupabaseDeployClient {
  if (deployTestOverride) return deployTestOverride;
  return resolveLiveClient() ?? new UnconfiguredSupabaseDeployClient();
}

/** Test hook: drop the cached live client so env changes take effect between tests. */
export function resetSupabaseClientForTests(): void {
  liveClient = null;
}
