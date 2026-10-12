import {
  type VercelClient,
  type VercelMutationClient,
  type VercelProjectRef,
  type VercelProjectInfo,
  type VercelProjectState,
  type VercelDeploymentState,
  type VercelDeploymentSummary,
} from './client';

/**
 * The LIVE Vercel REST client (Phase 2D). Speaks the Vercel REST API (https://api.vercel.com) with the owner-gated
 * access token as a bearer. `fetchImpl` is injected so every test runs against a recorder with zero network.
 * Response bodies are UNTRUSTED project/deployment content and carry no secret. It implements both the read
 * surface and — for the mutation slice — the redeploy/promote/rollback surface (`VercelMutationClient`). Every
 * mutation is an exact-id, idempotent-at-the-choke-point operation the governed executor has already bound.
 */

/** Minimal fetch shape so tests inject a recorder and no test touches the network. Mutations carry a JSON body. */
export type VercelFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
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

export class LiveVercelClient implements VercelClient, VercelMutationClient {
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

  // ── Mutation surface (Phase 2D mutation slice) ──────────────────────────────

  private async mutate(operation: string, method: string, path: string, body: unknown, okStatuses: readonly number[]): Promise<unknown> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    if (!okStatuses.includes(res.status)) throw new VercelApiError(operation, res.status);
    // promote/rollback succeed with 204 No Content (empty body). Treat a 204 — or an empty/unparseable body on
    // any already-accepted status — as a successful no-content response rather than forcing JSON parsing, which
    // throws "Unexpected end of JSON input" on an empty body and would be surfaced as a FALSE `ambiguous`.
    // Responses that DO carry a body (e.g. redeploy's new-deployment JSON) are still parsed normally.
    if (res.status === 204) return null;
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  async getDeployment(ref: VercelProjectRef, deploymentId: string): Promise<VercelDeploymentState | null> {
    const res = await this.fetchImpl(`${this.apiBase}${this.withTeam(`/v13/deployments/${encodeURIComponent(deploymentId)}`, ref)}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' },
    });
    if (res.status === 404) return null;
    if (res.status !== 200) throw new VercelApiError('get deployment', res.status);
    const raw = (await res.json()) as Record<string, unknown>;
    const meta = (raw.meta ?? {}) as Record<string, unknown>;
    return {
      id: typeof raw.uid === 'string' ? raw.uid : typeof raw.id === 'string' ? raw.id : deploymentId,
      readyState: typeof raw.readyState === 'string' ? raw.readyState : typeof raw.state === 'string' ? raw.state : 'UNKNOWN',
      target: raw.target === 'production' ? 'production' : 'preview',
      sourceSha: typeof meta.githubCommitSha === 'string' ? meta.githubCommitSha : null,
    };
  }

  async getProjectState(ref: VercelProjectRef): Promise<VercelProjectState> {
    const raw = (await this.request('get project', this.withTeam(`/v9/projects/${encodeURIComponent(ref.projectId)}`, ref))) as Record<string, unknown>;
    const targets = (raw.targets ?? {}) as { production?: { id?: unknown; meta?: Record<string, unknown> } };
    const prod = targets.production ?? {};
    const prodMeta = (prod.meta ?? {}) as Record<string, unknown>;
    return {
      name: typeof raw.name === 'string' ? raw.name : '',
      productionDeploymentId: typeof prod.id === 'string' ? prod.id : null,
      productionSha: typeof prodMeta.githubCommitSha === 'string' ? prodMeta.githubCommitSha : null,
    };
  }

  async redeploy(ref: VercelProjectRef, args: { name: string; sourceDeploymentId: string }): Promise<{ deploymentId: string; readyState: string }> {
    // Create a new deployment reusing the source deployment's files. It is NOT targeted at production, so it never
    // moves traffic — a separate promote does that.
    const out = (await this.mutate('redeploy', 'POST', this.withTeam('/v13/deployments', ref), { name: args.name, deploymentId: args.sourceDeploymentId }, [200, 201])) as Record<string, unknown>;
    return {
      deploymentId: typeof out.id === 'string' ? out.id : typeof out.uid === 'string' ? out.uid : '',
      readyState: typeof out.readyState === 'string' ? out.readyState : typeof out.status === 'string' ? out.status : 'QUEUED',
    };
  }

  async promote(ref: VercelProjectRef, deploymentId: string): Promise<void> {
    await this.mutate('promote', 'POST', this.withTeam(`/v10/projects/${encodeURIComponent(ref.projectId)}/promote/${encodeURIComponent(deploymentId)}`, ref), {}, [200, 201, 202, 204]);
  }

  async rollback(ref: VercelProjectRef, deploymentId: string, description?: string): Promise<void> {
    await this.mutate('rollback', 'POST', this.withTeam(`/v1/projects/${encodeURIComponent(ref.projectId)}/rollback/${encodeURIComponent(deploymentId)}`, ref), description ? { description } : {}, [200, 201, 202, 204]);
  }
}
