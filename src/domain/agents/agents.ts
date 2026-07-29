import { and, asc, eq, inArray } from 'drizzle-orm';
import { type AgentRole, type DataClassification, type TenantContext } from '@/types/domain';
import { type ProviderId } from '@/types/provider';
import { AppError, NotFoundError, ValidationError } from '@/lib/errors';
import { sha256Hex } from '@/lib/crypto';
import { type DbTx } from '@/db/client';
import { agents, departments } from '@/db/schema';
import { knownModel } from '@/providers/pricing';
import { writeAudit } from '@/domain/audit/audit';

/**
 * The one shared maximum length for an employee's system prompt, enforced identically by BOTH the
 * prompt-update path (`updateEmployeePrompt`) and the full-config creation path
 * (`createEmployeeWithConfig`). A single constant prevents the two paths from drifting apart.
 */
export const MAX_EMPLOYEE_PROMPT_CHARS = 20_000;

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
  /** HUB-009 — the agent's own data classification (used to classify the ACTIVITY it performs). */
  classification: DataClassification;
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
      classification: agents.classification,
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
      classification: agents.classification,
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

/**
 * HUB-008 — a dedicated, audited employee prompt/config update. Unlike the generic `agent.updated` event
 * (field names only), this records the PREVIOUS and NEW prompt hash and config fingerprint plus a required
 * reason — so the audit trail proves what changed without storing the full prompt text. Admin-only.
 * Idempotent: if the resulting prompt/config is unchanged, it makes no write and emits NO event.
 */
export async function updateEmployeePrompt(
  tx: DbTx,
  ctx: TenantContext,
  agentId: string,
  patch: { systemPrompt?: string; model?: string; temperatureMilli?: number; maxOutputTokens?: number },
  reason: string,
): Promise<boolean> {
  if (ctx.projectRole !== 'admin') {
    throw new AppError('forbidden', 'Only a project admin can change an employee prompt or configuration.');
  }
  const r = (reason ?? '').trim();
  if (!r) throw new ValidationError(['A reason is required to change an employee prompt or configuration.']);
  if (patch.systemPrompt !== undefined && patch.systemPrompt.length > MAX_EMPLOYEE_PROMPT_CHARS) {
    throw new ValidationError([`System prompt is too long (max ${MAX_EMPLOYEE_PROMPT_CHARS} characters).`]);
  }
  if (patch.model !== undefined && !knownModel(patch.model)) throw new ValidationError([`Unknown model '${patch.model}'.`]);
  if (patch.temperatureMilli !== undefined && (patch.temperatureMilli < 0 || patch.temperatureMilli > 1000)) {
    throw new ValidationError(['temperatureMilli must be between 0 and 1000.']);
  }
  if (patch.maxOutputTokens !== undefined && (patch.maxOutputTokens < 1 || patch.maxOutputTokens > 65_536)) {
    throw new ValidationError(['maxOutputTokens must be between 1 and 65536.']);
  }

  const rows = await tx
    .select({ role: agents.role, provider: agents.provider, model: agents.model, systemPrompt: agents.systemPrompt, temperatureMilli: agents.temperatureMilli, maxOutputTokens: agents.maxOutputTokens })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.projectId, ctx.projectId), eq(agents.orgId, ctx.orgId)))
    .limit(1);
  const before = rows[0];
  if (!before) throw new NotFoundError('Agent');

  const after = {
    role: before.role,
    provider: before.provider,
    model: patch.model ?? before.model,
    systemPrompt: patch.systemPrompt ?? before.systemPrompt,
    temperatureMilli: patch.temperatureMilli ?? before.temperatureMilli,
    maxOutputTokens: patch.maxOutputTokens ?? before.maxOutputTokens,
  };
  const prevConfigHash = agentExecutionFingerprint(before);
  const newConfigHash = agentExecutionFingerprint(after);
  if (prevConfigHash === newConfigHash) return false; // idempotent — nothing actually changed, no event

  const changedFields = (['systemPrompt', 'model', 'temperatureMilli', 'maxOutputTokens'] as const).filter(
    (k) => patch[k] !== undefined && patch[k] !== (before as Record<string, unknown>)[k],
  );

  await tx
    .update(agents)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(agents.id, agentId), eq(agents.projectId, ctx.projectId), eq(agents.orgId, ctx.orgId)));

  await writeAudit(tx, ctx, {
    action: 'employee.prompt_updated',
    entityType: 'agent',
    entityId: agentId,
    detail: {
      changedFields,
      prevPromptHash: sha256Hex(before.systemPrompt),
      newPromptHash: sha256Hex(after.systemPrompt),
      prevConfigHash,
      newConfigHash,
      reason: r,
    },
  });
  return true;
}
