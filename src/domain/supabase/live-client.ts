import {
  type SupabaseDeployClient,
  type SupabaseEdgeFunctionDeploySpec,
  type SupabaseManagementClient,
  type SupabaseProjectRef,
  type SupabaseProjectInfo,
  type SupabaseEdgeFunctionSummary,
  type SupabaseMigrationSummary,
} from './client';

/**
 * The LIVE Supabase Management API client (Phase 2C). Speaks the Management REST API
 * (https://api.supabase.com/v1) with the owner-gated personal/organization access token as a bearer.
 * `fetchImpl` is injected so every test runs against a recorder with zero network. Response bodies are
 * UNTRUSTED repo/project content and carry no secret. It implements both the read surface and — for the
 * write slice — the single-function deploy surface (`SupabaseDeployClient`); there is still no SQL or
 * migration method. `verify_jwt` and the exact bytes come from the governed executor, never from this layer.
 */

/** Minimal fetch shape so tests inject a recorder and no test touches the network. The deploy call carries a body. */
export type SupabaseFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: FormData | string },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export class SupabaseApiError extends Error {
  readonly status: number;
  constructor(operation: string, status: number) {
    // Status + operation only — response bodies are never echoed into errors.
    super(`Supabase ${operation} failed with HTTP ${status}`);
    this.name = 'SupabaseApiError';
    this.status = status;
  }
}

function toProjectInfo(ref: string, raw: Record<string, unknown>): SupabaseProjectInfo {
  const db = (raw.database ?? {}) as { version?: unknown };
  return {
    ref: typeof raw.id === 'string' ? raw.id : ref,
    name: typeof raw.name === 'string' ? raw.name : '',
    region: typeof raw.region === 'string' ? raw.region : '',
    status: typeof raw.status === 'string' ? raw.status : 'UNKNOWN',
    databaseVersion: typeof db.version === 'string' ? db.version : null,
  };
}

function toEdgeFunction(raw: Record<string, unknown>): SupabaseEdgeFunctionSummary {
  return {
    slug: typeof raw.slug === 'string' ? raw.slug : '',
    name: typeof raw.name === 'string' ? raw.name : '',
    status: typeof raw.status === 'string' ? raw.status : 'UNKNOWN',
    version: typeof raw.version === 'number' ? raw.version : null,
    verifyJwt: typeof raw.verify_jwt === 'boolean' ? raw.verify_jwt : null,
    updatedAt:
      typeof raw.updated_at === 'string'
        ? raw.updated_at
        : typeof raw.updated_at === 'number'
          ? new Date(raw.updated_at).toISOString()
          : null,
  };
}

function toMigration(raw: Record<string, unknown>): SupabaseMigrationSummary {
  return {
    version: typeof raw.version === 'string' ? raw.version : String(raw.version ?? ''),
    name: typeof raw.name === 'string' ? raw.name : null,
  };
}

interface LiveClientArgs {
  readonly token: string;
  readonly fetchImpl: SupabaseFetchLike;
  readonly apiBase?: string;
}

export class LiveSupabaseManagementClient implements SupabaseManagementClient, SupabaseDeployClient {
  private readonly token: string;
  private readonly fetchImpl: SupabaseFetchLike;
  private readonly apiBase: string;

  constructor(args: LiveClientArgs) {
    this.token = args.token;
    this.fetchImpl = args.fetchImpl;
    this.apiBase = (args.apiBase ?? 'https://api.supabase.com').replace(/\/+$/, '');
  }

  private async request(operation: string, method: string, path: string, okStatuses: readonly number[] = [200]): Promise<unknown> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' },
    });
    if (!okStatuses.includes(res.status)) throw new SupabaseApiError(operation, res.status);
    return res.json();
  }

  async getProject(ref: SupabaseProjectRef): Promise<SupabaseProjectInfo> {
    const out = (await this.request('get project', 'GET', `/v1/projects/${ref.projectRef}`)) as Record<string, unknown>;
    return toProjectInfo(ref.projectRef, out);
  }

  async listEdgeFunctions(ref: SupabaseProjectRef): Promise<SupabaseEdgeFunctionSummary[]> {
    const out = (await this.request('list edge functions', 'GET', `/v1/projects/${ref.projectRef}/functions`)) as Array<Record<string, unknown>>;
    return (Array.isArray(out) ? out : []).map(toEdgeFunction);
  }

  async listMigrations(ref: SupabaseProjectRef): Promise<SupabaseMigrationSummary[]> {
    const out = (await this.request('list migrations', 'GET', `/v1/projects/${ref.projectRef}/database/migrations`)) as Array<Record<string, unknown>>;
    return (Array.isArray(out) ? out : []).map(toMigration);
  }

  // ── Write surface (Phase 2C write slice) ───────────────────────────────────

  /**
   * Deploy one edge function's EXACT bytes via the Management bundle-deploy endpoint
   * (`POST /v1/projects/{ref}/functions/deploy?slug=…`, multipart: a `metadata` part + one `file` part per
   * source file). The Content-Type/boundary is set by the platform fetch for the FormData — we send only the
   * bearer. The caller (the governed executor) has already read, bounded, and digest-bound these bytes.
   */
  async deployEdgeFunction(
    ref: SupabaseProjectRef,
    spec: SupabaseEdgeFunctionDeploySpec,
  ): Promise<{ slug: string; version: number | null }> {
    const form = new FormData();
    const metadata: Record<string, unknown> = {
      name: spec.slug,
      entrypoint_path: spec.entrypointPath,
      verify_jwt: spec.verifyJwt,
    };
    if (spec.importMapPath) metadata.import_map_path = spec.importMapPath;
    form.append('metadata', JSON.stringify(metadata));
    for (const f of spec.files) {
      form.append('file', new Blob([f.content], { type: 'application/typescript' }), f.path);
    }
    const res = await this.fetchImpl(
      `${this.apiBase}/v1/projects/${ref.projectRef}/functions/deploy?slug=${encodeURIComponent(spec.slug)}`,
      { method: 'POST', headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' }, body: form },
    );
    if (res.status !== 200 && res.status !== 201) throw new SupabaseApiError('deploy edge function', res.status);
    const out = (await res.json()) as Record<string, unknown>;
    return {
      slug: typeof out.slug === 'string' ? out.slug : spec.slug,
      version: typeof out.version === 'number' ? out.version : null,
    };
  }

  /** Read one edge function by slug for post-deploy verification; null on 404. */
  async getEdgeFunction(ref: SupabaseProjectRef, slug: string): Promise<SupabaseEdgeFunctionSummary | null> {
    const res = await this.fetchImpl(`${this.apiBase}/v1/projects/${ref.projectRef}/functions/${encodeURIComponent(slug)}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' },
    });
    if (res.status === 404) return null;
    if (res.status !== 200) throw new SupabaseApiError('get edge function', res.status);
    return toEdgeFunction((await res.json()) as Record<string, unknown>);
  }
}
