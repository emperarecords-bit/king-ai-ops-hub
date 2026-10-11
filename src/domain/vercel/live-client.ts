import {
  type VercelClient,
  type VercelProjectRef,
  type VercelProjectInfo,
  type VercelDeploymentSummary,
} from './client';

/**
 * The LIVE Vercel REST client (Phase 2D, read-only). Speaks the Vercel REST API (https://api.vercel.com) with the
 * owner-gated access token as a bearer. `fetchImpl` is injected so every test runs against a recorder with zero
 * network. Response bodies are UNTRUSTED project/deployment content and carry no secret. Only READS are
 * implemented — there is no redeploy/promote/rollback method here.
 */

/** Minimal fetch shape so tests inject a recorder and no test touches the network. */
export type VercelFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export class VercelApiError extends Error {
  readonly status: number;
  constructor(operation: string, status: number) {
    // Status + operation only — response bodies are never echoed into errors.
    super(`Vercel ${operation} failed with HTTP ${status}`);
    this.name = 'VercelApiError';
    this.status = status;
  }
}

function toProjectInfo(id: string, raw: Record<string, unknown>): VercelProjectInfo {
  const targets = (raw.targets ?? {}) as { production?: { alias?: unknown; url?: unknown } };
  const prod = targets.production ?? {};
  const alias = Array.isArray(prod.alias) && typeof prod.alias[0] === 'string' ? prod.alias[0] : null;
  const prodUrl = alias ?? (typeof prod.url === 'string' ? prod.url : null);
  return {
    id: typeof raw.id === 'string' ? raw.id : id,
    name: typeof raw.name === 'string' ? raw.name : '',
    framework: typeof raw.framework === 'string' ? raw.framework : null,
    productionUrl: prodUrl,
  };
}

function toDeployment(raw: Record<string, unknown>): VercelDeploymentSummary {
  const meta = (raw.meta ?? {}) as Record<string, unknown>;
  const created = typeof raw.createdAt === 'number' ? raw.createdAt : typeof raw.created === 'number' ? raw.created : null;
  const stateRaw = typeof raw.state === 'string' ? raw.state : typeof raw.readyState === 'string' ? raw.readyState : 'UNKNOWN';
  return {
    id: typeof raw.uid === 'string' ? raw.uid : typeof raw.id === 'string' ? raw.id : '',
    url: typeof raw.url === 'string' ? raw.url : null,
    state: stateRaw,
    target: raw.target === 'production' ? 'production' : 'preview',
    sourceSha: typeof meta.githubCommitSha === 'string' ? meta.githubCommitSha : null,
    branch: typeof meta.githubCommitRef === 'string' ? meta.githubCommitRef : null,
    createdAt: created !== null ? new Date(created).toISOString() : null,
    inspectorUrl: typeof raw.inspectorUrl === 'string' ? raw.inspectorUrl : null,
  };
}

interface LiveClientArgs {
  readonly token: string;
  readonly fetchImpl: VercelFetchLike;
  readonly apiBase?: string;
}

export class LiveVercelClient implements VercelClient {
  private readonly token: string;
  private readonly fetchImpl: VercelFetchLike;
  private readonly apiBase: string;

  constructor(args: LiveClientArgs) {
    this.token = args.token;
    this.fetchImpl = args.fetchImpl;
    this.apiBase = (args.apiBase ?? 'https://api.vercel.com').replace(/\/+$/, '');
  }

  /** Append `teamId` when the linked project is team-scoped. */
  private withTeam(path: string, ref: VercelProjectRef): string {
    if (!ref.teamId) return path;
    return `${path}${path.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(ref.teamId)}`;
  }

  private async request(operation: string, path: string): Promise<unknown> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' },
    });
    if (res.status !== 200) throw new VercelApiError(operation, res.status);
    return res.json();
  }

  async getProject(ref: VercelProjectRef): Promise<VercelProjectInfo> {
    const out = (await this.request('get project', this.withTeam(`/v9/projects/${encodeURIComponent(ref.projectId)}`, ref))) as Record<string, unknown>;
    return toProjectInfo(ref.projectId, out);
  }

  async listDeployments(ref: VercelProjectRef, opts?: { limit?: number }): Promise<VercelDeploymentSummary[]> {
    const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100);
    const out = (await this.request(
      'list deployments',
      this.withTeam(`/v6/deployments?projectId=${encodeURIComponent(ref.projectId)}&limit=${limit}`, ref),
    )) as { deployments?: Array<Record<string, unknown>> };
    const list = Array.isArray(out.deployments) ? out.deployments : [];
    return list.map(toDeployment);
  }
}
