import {
  type SupabaseManagementClient,
  type SupabaseProjectRef,
  type SupabaseProjectInfo,
  type SupabaseEdgeFunctionSummary,
  type SupabaseMigrationSummary,
} from './client';

/**
 * The LIVE Supabase Management API client (Phase 2C, read-only). Speaks the Management REST API
 * (https://api.supabase.com/v1) with the owner-gated personal/organization access token as a bearer.
 * `fetchImpl` is injected so every test runs against a recorder with zero network. Response bodies are
 * UNTRUSTED repo/project content and carry no secret. Only READS are implemented — there is no deploy, SQL,
 * or migration method here.
 */

/** Minimal fetch shape so tests inject a recorder and no test touches the network. */
export type SupabaseFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string> },
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

export class LiveSupabaseManagementClient implements SupabaseManagementClient {
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
}
