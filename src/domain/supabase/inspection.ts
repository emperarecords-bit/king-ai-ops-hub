import 'server-only';
import { type DbTx } from '@/db/client';
import { type TenantContext } from '@/types/domain';
import { listSupabaseProjectLinks } from './links';
import {
  isSupabaseConfigured,
  type SupabaseManagementClient,
  type SupabaseProjectRef,
  type SupabaseProjectInfo,
  type SupabaseEdgeFunctionSummary,
  type SupabaseMigrationSummary,
} from './client';

/**
 * Read-only Supabase inspection for the Ops Chat bridge (Phase 2C). Every function here is a pure read: it
 * resolves the workspace's linked Supabase projects (server-side, RLS-scoped) and calls the Management client's
 * read methods. The Management token NEVER leaves the client layer; the linked project `ref` is the only
 * identifier passed around, and it is confined to projects linked to the caller's workspace. The returned DTOs
 * carry project state only — nothing secret can reach the model context, a proposal card, or an audit detail.
 */

export class SupabaseProjectNotLinkedError extends Error {
  constructor(projectRef: string) {
    super(`Supabase project "${projectRef}" is not linked to this workspace.`);
    this.name = 'SupabaseProjectNotLinkedError';
  }
}

export interface LinkedProjectView {
  readonly projectRef: string;
  readonly label: string | null;
}

export interface WorkspaceSupabaseCapabilities {
  /** Management token present in the environment (fail-closed when false). */
  readonly supabaseConfigured: boolean;
  readonly linkedProjects: readonly LinkedProjectView[];
  /** Ops Chat can inspect: configured AND at least one linked project. */
  readonly canInspect: boolean;
}

/** What read-only Supabase inspection this workspace can do right now. Pure read. */
export async function supabaseWorkspaceCapabilities(tx: DbTx, ctx: TenantContext): Promise<WorkspaceSupabaseCapabilities> {
  const links = await listSupabaseProjectLinks(tx, ctx);
  const linkedProjects: LinkedProjectView[] = links.map((l) => ({ projectRef: l.projectRef, label: l.label }));
  const configured = isSupabaseConfigured();
  return {
    supabaseConfigured: configured,
    linkedProjects,
    canInspect: configured && linkedProjects.length > 0,
  };
}

/** The workspace's linked Supabase projects as safe DTOs. Pure read. */
export async function listWorkspaceSupabaseProjects(tx: DbTx, ctx: TenantContext): Promise<LinkedProjectView[]> {
  const links = await listSupabaseProjectLinks(tx, ctx);
  return links.map((l) => ({ projectRef: l.projectRef, label: l.label }));
}

/** Resolve a linked project ref to the trusted SupabaseProjectRef, or null when it is not linked here. */
async function resolveLinkedProjectRef(tx: DbTx, ctx: TenantContext, projectRef: string): Promise<SupabaseProjectRef | null> {
  const links = await listSupabaseProjectLinks(tx, ctx);
  const link = links.find((l) => l.projectRef === projectRef);
  return link ? { projectRef: link.projectRef } : null;
}

export async function getWorkspaceSupabaseProject(
  tx: DbTx,
  ctx: TenantContext,
  client: SupabaseManagementClient,
  projectRef: string,
): Promise<SupabaseProjectInfo> {
  const ref = await resolveLinkedProjectRef(tx, ctx, projectRef);
  if (!ref) throw new SupabaseProjectNotLinkedError(projectRef);
  return client.getProject(ref);
}

export async function listWorkspaceEdgeFunctions(
  tx: DbTx,
  ctx: TenantContext,
  client: SupabaseManagementClient,
  projectRef: string,
): Promise<SupabaseEdgeFunctionSummary[]> {
  const ref = await resolveLinkedProjectRef(tx, ctx, projectRef);
  if (!ref) throw new SupabaseProjectNotLinkedError(projectRef);
  return client.listEdgeFunctions(ref);
}

export async function listWorkspaceMigrations(
  tx: DbTx,
  ctx: TenantContext,
  client: SupabaseManagementClient,
  projectRef: string,
): Promise<SupabaseMigrationSummary[]> {
  const ref = await resolveLinkedProjectRef(tx, ctx, projectRef);
  if (!ref) throw new SupabaseProjectNotLinkedError(projectRef);
  return client.listMigrations(ref);
}
