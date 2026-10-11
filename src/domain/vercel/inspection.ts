import 'server-only';
import { type DbTx } from '@/db/client';
import { type TenantContext } from '@/types/domain';
import { listVercelProjectLinks } from './links';
import {
  isVercelConfigured,
  type VercelClient,
  type VercelProjectRef,
  type VercelProjectInfo,
  type VercelDeploymentSummary,
} from './client';

/**
 * Read-only Vercel inspection for the Ops Chat bridge (Phase 2D). Every function here is a pure read: it resolves
 * the workspace's linked Vercel projects (server-side, RLS-scoped) and calls the client's read methods. The Vercel
 * token NEVER leaves the client layer; the linked project id (+ team id) is the only identifier passed around, and
 * it is confined to projects linked to the caller's workspace. The returned DTOs carry project/deployment state
 * only — nothing secret can reach the model context, a proposal card, or an audit detail.
 */

export class VercelProjectNotLinkedError extends Error {
  constructor(projectId: string) {
    super(`Vercel project "${projectId}" is not linked to this workspace.`);
    this.name = 'VercelProjectNotLinkedError';
  }
}

export interface LinkedVercelProjectView {
  readonly vercelProjectId: string;
  readonly vercelTeamId: string | null;
  readonly label: string | null;
}

export interface WorkspaceVercelCapabilities {
  /** Vercel token present in the environment (fail-closed when false). */
  readonly vercelConfigured: boolean;
  readonly linkedProjects: readonly LinkedVercelProjectView[];
  /** Ops Chat can inspect: configured AND at least one linked project. */
  readonly canInspect: boolean;
}

/** What read-only Vercel inspection this workspace can do right now. Pure read. */
export async function vercelWorkspaceCapabilities(tx: DbTx, ctx: TenantContext): Promise<WorkspaceVercelCapabilities> {
  const links = await listVercelProjectLinks(tx, ctx);
  const linkedProjects: LinkedVercelProjectView[] = links.map((l) => ({ vercelProjectId: l.vercelProjectId, vercelTeamId: l.vercelTeamId, label: l.label }));
  const configured = isVercelConfigured();
  return {
    vercelConfigured: configured,
    linkedProjects,
    canInspect: configured && linkedProjects.length > 0,
  };
}

/** The workspace's linked Vercel projects as safe DTOs. Pure read. */
export async function listWorkspaceVercelProjects(tx: DbTx, ctx: TenantContext): Promise<LinkedVercelProjectView[]> {
  const links = await listVercelProjectLinks(tx, ctx);
  return links.map((l) => ({ vercelProjectId: l.vercelProjectId, vercelTeamId: l.vercelTeamId, label: l.label }));
}

/** Resolve a linked project id to the trusted VercelProjectRef, or null when it is not linked here. */
async function resolveLinkedProjectRef(tx: DbTx, ctx: TenantContext, projectId: string): Promise<VercelProjectRef | null> {
  const links = await listVercelProjectLinks(tx, ctx);
  const link = links.find((l) => l.vercelProjectId === projectId);
  return link ? { projectId: link.vercelProjectId, teamId: link.vercelTeamId } : null;
}

export async function getWorkspaceVercelProject(
  tx: DbTx,
  ctx: TenantContext,
  client: VercelClient,
  projectId: string,
): Promise<VercelProjectInfo> {
  const ref = await resolveLinkedProjectRef(tx, ctx, projectId);
  if (!ref) throw new VercelProjectNotLinkedError(projectId);
  return client.getProject(ref);
}

export async function listWorkspaceVercelDeployments(
  tx: DbTx,
  ctx: TenantContext,
  client: VercelClient,
  projectId: string,
  opts?: { limit?: number },
): Promise<VercelDeploymentSummary[]> {
  const ref = await resolveLinkedProjectRef(tx, ctx, projectId);
  if (!ref) throw new VercelProjectNotLinkedError(projectId);
  return client.listDeployments(ref, opts);
}
