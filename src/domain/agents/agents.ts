import { and, eq } from 'drizzle-orm';
import { type AgentRole, type TenantContext } from '@/types/domain';
import { type ProviderId } from '@/types/provider';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { agents } from '@/db/schema';
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
