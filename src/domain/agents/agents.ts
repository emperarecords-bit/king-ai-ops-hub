import { and, asc, eq, inArray } from 'drizzle-orm';
import { type AgentRole, type TenantContext } from '@/types/domain';
import { type ProviderId } from '@/types/provider';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { sha256Hex } from '@/lib/crypto';
import { type DbTx } from '@/db/client';
import { agents, departments } from '@/db/schema';
import { knownModel } from '@/providers/pricing';
import { writeAudit } from '@/domain/audit/audit';

export interface AgentRow {
  id: string;
  name: string;
  role: AgentRole;
  provider: ProviderId;
  model: string;
  systemPrompt: string;
  temperatureMilli: number;
  maxOutputTokens: number;
  enabled: boolean;
}

/**
 * A stable fingerprint of an agent's MATERIAL execution identity — the facts that determine HOW it
 * processes context and where that context goes: provider, model, system instructions, sampling, and
 * technical role. It deliberately EXCLUDES descriptive fields (name, title, department, reporting line)
 * so a harmless rename never invalidates authority, while a real reconfiguration (new provider/model/
 * instructions) does. Disclosure grants bind to this fingerprint so authority follows the execution
 * identity that was reviewed, not merely a reusable agent name.
 */
export function agentExecutionFingerprint(a: {
  provider: string;
  model: string;
  systemPrompt: string;
  temperatureMilli: number;
  maxOutputTokens: number;
  role: string;
}): string {
  return sha256Hex(
    JSON.stringify({
      provider: a.provider,
      model: a.model,
      systemPrompt: a.systemPrompt,
      temperatureMilli: a.temperatureMilli,
      maxOutputTokens: a.maxOutputTokens,
      role: a.role,
    }),
  );
}

export interface AgentExecutionIdentity {
  id: string;
  provider: ProviderId;
  model: string;
  fingerprint: string;
}

/** Current execution identities for a set of agent ids — id → {provider, model, fingerprint}. Used by
 *  Knowledge selection to match a disclosure grant against the agent's CURRENT execution profile. */
export async function loadAgentExecutionIdentities(tx: DbTx, ctx: TenantContext, agentIds: string[]): Promise<Map<string, AgentExecutionIdentity>> {
  const index = new Map<string, AgentExecutionIdentity>();
  if (agentIds.length === 0) return index;
  const rows = await tx
    .select({
      id: agents.id,
      provider: agents.provider,
      model: agents.model,
      systemPrompt: agents.systemPrompt,
      temperatureMilli: agents.temperatureMilli,
      maxOutputTokens: agents.maxOutputTokens,
      role: agents.role,
    })
    .from(agents)
    .where(and(eq(agents.orgId, ctx.orgId), eq(agents.projectId, ctx.projectId), inArray(agents.id, agentIds)));
  for (const r of rows) {
    index.set(r.id, { id: r.id, provider: r.provider, model: r.model, fingerprint: agentExecutionFingerprint(r) });
  }
  return index;
}

export async function listAgents(tx: DbTx, ctx: TenantContext): Promise<AgentRow[]> {
  return tx
    .select({
      id: agents.id,
      name: agents.name,
      role: agents.role,
      provider: agents.provider,
      model: agents.model,
      systemPrompt: agents.systemPrompt,
      temperatureMilli: agents.temperatureMilli,
      maxOutputTokens: agents.maxOutputTokens,
      enabled: agents.enabled,
    })
    .from(agents)
    .where(and(eq(agents.projectId, ctx.projectId), eq(agents.orgId, ctx.orgId)));
}

export interface AssignableEmployee {
  id: string;
  name: string;
  departmentName: string | null;
  provider: ProviderId;
}

/**
 * Enabled primary-role employees — the "Who should do this work?" picker
 * (Sprint 5, assignee-first). The pick determines the leading vendor; the
 * cross-check counterpart is derived per D-005.
 */
export async function listAssignableEmployees(
  tx: DbTx,
  ctx: TenantContext,
): Promise<AssignableEmployee[]> {
  return tx
    .select({
      id: agents.id,
      name: agents.name,
      departmentName: departments.name,
      provider: agents.provider,
    })
    .from(agents)
    .leftJoin(departments, eq(agents.departmentId, departments.id))
    .where(
      and(
        eq(agents.projectId, ctx.projectId),
        eq(agents.orgId, ctx.orgId),
        eq(agents.role, 'primary'),
        eq(agents.enabled, true),
      ),
    )
    .orderBy(asc(agents.name));
}

/** The enabled agent for (role, provider), or null. Engine input resolution. */
export async function findAgentForRole(
  tx: DbTx,
  ctx: TenantContext,
  role: AgentRole,
  provider: ProviderId,
): Promise<AgentRow | null> {
  const rows = await tx
    .select({
      id: agents.id,
      name: agents.name,
      role: agents.role,
      provider: agents.provider,
      model: agents.model,
      systemPrompt: agents.systemPrompt,
      temperatureMilli: agents.temperatureMilli,
      maxOutputTokens: agents.maxOutputTokens,
      enabled: agents.enabled,
    })
    .from(agents)
    .where(
      and(
        eq(agents.projectId, ctx.projectId),
        eq(agents.orgId, ctx.orgId),
        eq(agents.role, role),
        eq(agents.provider, provider),
        eq(agents.enabled, true),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function updateAgent(
  tx: DbTx,
  ctx: TenantContext,
  agentId: string,
  patch: {
    model?: string;
    systemPrompt?: string;
    temperatureMilli?: number;
    maxOutputTokens?: number;
    enabled?: boolean;
  },
): Promise<void> {
  if (patch.model !== undefined && !knownModel(patch.model)) {
    throw new ValidationError([`Unknown model '${patch.model}'.`]);
  }
  if (
    patch.temperatureMilli !== undefined &&
    (patch.temperatureMilli < 0 || patch.temperatureMilli > 1000)
  ) {
    throw new ValidationError(['temperatureMilli must be between 0 and 1000.']);
  }
  if (
    patch.maxOutputTokens !== undefined &&
    (patch.maxOutputTokens < 1 || patch.maxOutputTokens > 65_536)
  ) {
    throw new ValidationError(['maxOutputTokens must be between 1 and 65536.']);
  }

  const updated = await tx
    .update(agents)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(agents.id, agentId),
        eq(agents.projectId, ctx.projectId),
        eq(agents.orgId, ctx.orgId),
      ),
    )
    .returning({ id: agents.id });

  if (updated.length === 0) throw new NotFoundError('Agent');

  await writeAudit(tx, ctx, {
    action: 'agent.updated',
    entityType: 'agent',
    entityId: agentId,
    detail: { fields: Object.keys(patch) },
  });
}
