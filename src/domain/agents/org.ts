import 'server-only';
import { and, asc, eq } from 'drizzle-orm';
import {
  AGENT_ROLES,
  DATA_CLASSIFICATIONS,
  type AgentRole,
  type DataClassification,
  type TenantContext,
} from '@/types/domain';
import { type ProviderId } from '@/types/provider';
import { AppError, NotFoundError, ValidationError } from '@/lib/errors';
import { sha256Hex } from '@/lib/crypto';
import { type DbTx } from '@/db/client';
import { agents, decisions, departments, objectives, projects, tasks, workItems } from '@/db/schema';
import { knownModel, providerSupportsModel } from '@/providers/pricing';
import { MAX_EMPLOYEE_PROMPT_CHARS } from '@/domain/agents/agents';
import { writeAudit } from '@/domain/audit/audit';
import { setObjectiveOwner } from '@/domain/objectives/objectives';

/**
 * Organizational model (Slice 1). Employees are `agents` rows — an employee IS
 * an AI agent today, a human tomorrow (owner's "role before person"). This layer
 * adds owner-facing employee management (create/edit/disable), a descriptive
 * reporting line (reports-to), and ownership assignment ("who owns this?") across
 * the core objects. Descriptive ONLY — no delegation, routing, or notifications
 * (explicitly out of scope; earn those from operating evidence).
 */

export interface EmployeeRow {
  id: string;
  name: string;
  title: string | null;
  role: AgentRole;
  departmentId: string | null;
  departmentName: string | null;
  reportsToId: string | null;
  managerName: string | null;
  enabled: boolean;
}

/** Every employee in the workspace, with department + manager names resolved,
 *  ordered by name. Powers the org view and the ownership pickers. */
export async function listEmployees(tx: DbTx, ctx: TenantContext): Promise<EmployeeRow[]> {
  const rows = await tx
    .select({
      id: agents.id,
      name: agents.name,
      title: agents.title,
      role: agents.role,
      departmentId: agents.departmentId,
      departmentName: departments.name,
      reportsToId: agents.reportsToId,
      enabled: agents.enabled,
    })
    .from(agents)
    .leftJoin(departments, eq(agents.departmentId, departments.id))
    .where(and(eq(agents.projectId, ctx.projectId), eq(agents.orgId, ctx.orgId)))
    .orderBy(asc(agents.name));

  // Resolve manager names in-process (a self-join alias fights the tenant filter).
  const byId = new Map(rows.map((r) => [r.id, r.name]));
  return rows.map((r) => ({
    ...r,
    managerName: r.reportsToId ? (byId.get(r.reportsToId) ?? null) : null,
  }));
}

/** Departments available in this org, for the employee form's picker. */
export async function listDepartments(
  tx: DbTx,
  ctx: TenantContext,
): Promise<{ id: string; name: string }[]> {
  return tx
    .select({ id: departments.id, name: departments.name })
    .from(departments)
    .where(eq(departments.orgId, ctx.orgId))
    .orderBy(asc(departments.name));
}

export interface CreateEmployeeInput {
  name: string;
  title?: string | null;
  role?: AgentRole;
  departmentId?: string | null;
  reportsToId?: string | null;
}

/**
 * Create an employee. The AI config (provider/model/system prompt/limits) is
 * copied from an existing enabled agent in the workspace as a template — so the
 * owner defines an org role without picking a model; they can tune the AI config
 * later via the existing agent editor. Fails closed if there's no template agent.
 */
export async function createEmployee(
  tx: DbTx,
  ctx: TenantContext,
  input: CreateEmployeeInput,
): Promise<string> {
  const name = input.name.trim();
  if (name.length === 0) throw new ValidationError(['Employee name is required.']);
  if (name.length > 120) throw new ValidationError(['Employee name is too long (max 120).']);

  const template = (
    await tx
      .select({
        provider: agents.provider,
        model: agents.model,
        systemPrompt: agents.systemPrompt,
        temperatureMilli: agents.temperatureMilli,
        maxOutputTokens: agents.maxOutputTokens,
      })
      .from(agents)
      .where(and(eq(agents.projectId, ctx.projectId), eq(agents.orgId, ctx.orgId)))
      .orderBy(asc(agents.createdAt))
      .limit(1)
  )[0];
  if (!template) {
    throw new AppError('validation', 'No existing employee to base the AI configuration on.');
  }

  await assertDepartmentInWorkspace(tx, ctx, input.departmentId ?? null);
  await assertManagerInWorkspace(tx, ctx, input.reportsToId ?? null, null);

  let inserted;
  try {
    inserted = await tx
      .insert(agents)
      .values({
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        name,
        title: input.title?.trim() || null,
        role: input.role ?? 'primary',
        departmentId: input.departmentId ?? null,
        reportsToId: input.reportsToId ?? null,
        provider: template.provider,
        model: template.model,
        systemPrompt: template.systemPrompt,
        temperatureMilli: template.temperatureMilli,
        maxOutputTokens: template.maxOutputTokens,
        enabled: true,
      })
      .returning({ id: agents.id });
  } catch (err) {
    // agents_project_name_uq
    if (err instanceof Error && /agents_project_name_uq|unique/i.test(err.message)) {
      throw new AppError('validation', `An employee named "${name}" already exists.`);
    }
    throw err;
  }

  const id = inserted[0]!.id;
  await writeAudit(tx, ctx, {
    action: 'employee.created',
    entityType: 'agent',
    entityId: id,
    detail: { name, title: input.title ?? null },
  });
  return id;
}

export interface CreateEmployeeWithConfigInput {
  name: string;
  title?: string | null;
  role: AgentRole;
  departmentId?: string | null;
  reportsToAgentId?: string | null;
  provider: ProviderId;
  model: string;
  systemPrompt: string;
  temperatureMilli?: number;
  maxOutputTokens?: number;
  enabled?: boolean;
  classification?: DataClassification;
  reason: string;
}

/**
 * Audited full-config employee provisioning. Unlike `createEmployee` (which copies the AI config from a
 * template agent so the UI form need not pick a model), this creates an employee with an EXPLICIT
 * provider/model/role/mission in one typed, admin-gated, transactional operation.
 *
 * - The full prompt is stored ONLY on the agent row; the audit detail carries a prompt HASH, never the text.
 * - Deterministic duplicate handling: `INSERT … ON CONFLICT (project,name) DO NOTHING RETURNING` — never an
 *   exception-driven retry inside an aborted transaction. A byte-identical retry is an idempotent no-op
 *   (`created:false`, no second audit); a same-name-different-config request is rejected.
 * - The audit event is written ONLY when a new row was actually inserted; row + audit commit or roll back
 *   together in the caller's `withTenant` transaction.
 *
 * NOTE on name uniqueness: `agents_project_name_uq` is (project_id, name), which is CASE-SENSITIVE — so
 * "Jane Smith" and "jane smith" are technically distinct employees. Names are trimmed (not case-folded);
 * normalized-case uniqueness would require a separate, separately-approved migration and is out of scope here.
 */
export async function createEmployeeWithConfig(
  tx: DbTx,
  ctx: TenantContext,
  input: CreateEmployeeWithConfigInput,
): Promise<{ employeeId: string; created: boolean }> {
  if (ctx.projectRole !== 'admin') {
    throw new AppError('forbidden', 'Only a workspace admin can provision an employee.');
  }

  // ---- normalize + validate (everything before any write) -----------------
  const name = input.name.trim();
  if (name.length === 0) throw new ValidationError(['Employee name is required.']);
  if (name.length > 120) throw new ValidationError(['Employee name is too long (max 120).']);

  const reason = (input.reason ?? '').trim();
  if (!reason) throw new ValidationError(['A reason is required to provision an employee.']);

  // Trim ONLY for the empty check; store the prompt exactly as supplied (formatting preserved).
  if (input.systemPrompt.trim().length === 0) {
    throw new ValidationError(['A mission/system prompt is required.']);
  }
  if (input.systemPrompt.length > MAX_EMPLOYEE_PROMPT_CHARS) {
    throw new ValidationError([`System prompt is too long (max ${MAX_EMPLOYEE_PROMPT_CHARS} characters).`]);
  }
  const systemPrompt = input.systemPrompt;

  if (!(AGENT_ROLES as readonly string[]).includes(input.role)) {
    throw new ValidationError([`Invalid role: ${input.role}`]);
  }
  if (!knownModel(input.model)) throw new ValidationError([`Unknown model '${input.model}'.`]);
  if (!providerSupportsModel(input.provider, input.model)) {
    throw new ValidationError([`Model '${input.model}' is not available for provider '${input.provider}'.`]);
  }

  const temperatureMilli = input.temperatureMilli ?? 700;
  if (temperatureMilli < 0 || temperatureMilli > 1000) {
    throw new ValidationError(['temperatureMilli must be between 0 and 1000.']);
  }
  const maxOutputTokens = input.maxOutputTokens ?? 4096;
  if (maxOutputTokens < 1 || maxOutputTokens > 65_536) {
    throw new ValidationError(['maxOutputTokens must be between 1 and 65536.']);
  }
  const classification: DataClassification = input.classification ?? 'live';
  if (!(DATA_CLASSIFICATIONS as readonly string[]).includes(classification)) {
    throw new ValidationError([`Invalid classification: ${classification}`]);
  }
  const enabled = input.enabled ?? true;
  const title = input.title?.trim() || null;
  const departmentId = input.departmentId ?? null;
  const reportsToAgentId = input.reportsToAgentId ?? null;

  await assertDepartmentInWorkspace(tx, ctx, departmentId);
  await assertManagerInWorkspace(tx, ctx, reportsToAgentId, null);

  const promptHash = sha256Hex(systemPrompt);

  // ---- deterministic insert-or-detect (no exception-driven retry) ---------
  const inserted = await tx
    .insert(agents)
    .values({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      name,
      title,
      role: input.role,
      departmentId,
      reportsToId: reportsToAgentId,
      provider: input.provider,
      model: input.model,
      systemPrompt,
      temperatureMilli,
      maxOutputTokens,
      enabled,
      classification,
    })
    .onConflictDoNothing({ target: [agents.projectId, agents.name] })
    .returning({ id: agents.id });

  if (inserted.length > 0) {
    const employeeId = inserted[0]!.id;
    await writeAudit(tx, ctx, {
      action: 'employee.created',
      entityType: 'agent',
      entityId: employeeId,
      detail: {
        employeeId,
        name,
        title,
        role: input.role,
        departmentId,
        reportsToAgentId,
        provider: input.provider,
        model: input.model,
        temperatureMilli,
        maxOutputTokens,
        enabled,
        classification,
        promptHash,
        reason,
      },
    });
    return { employeeId, created: true };
  }

  // Name conflict within the workspace: compare the FULL creation-controlled config.
  const existing = (
    await tx
      .select({
        id: agents.id,
        title: agents.title,
        role: agents.role,
        departmentId: agents.departmentId,
        reportsToId: agents.reportsToId,
        provider: agents.provider,
        model: agents.model,
        systemPrompt: agents.systemPrompt,
        temperatureMilli: agents.temperatureMilli,
        maxOutputTokens: agents.maxOutputTokens,
        enabled: agents.enabled,
        classification: agents.classification,
      })
      .from(agents)
      .where(and(eq(agents.projectId, ctx.projectId), eq(agents.orgId, ctx.orgId), eq(agents.name, name)))
      .limit(1)
  )[0];
  if (!existing) throw new ValidationError([`An employee named "${name}" already exists.`]);

  const identical =
    existing.title === title &&
    existing.role === input.role &&
    existing.departmentId === departmentId &&
    existing.reportsToId === reportsToAgentId &&
    existing.provider === input.provider &&
    existing.model === input.model &&
    sha256Hex(existing.systemPrompt) === promptHash &&
    existing.temperatureMilli === temperatureMilli &&
    existing.maxOutputTokens === maxOutputTokens &&
    existing.enabled === enabled &&
    existing.classification === classification;

  if (identical) return { employeeId: existing.id, created: false };
  throw new ValidationError([`An employee named "${name}" already exists with a different configuration.`]);
}

export interface UpdateEmployeeInput {
  name?: string;
  title?: string | null;
  departmentId?: string | null;
  reportsToId?: string | null;
  enabled?: boolean;
}

/** Update an employee's org fields (name, title, department, manager, status).
 *  The AI config (model/prompt) stays with the existing agent editor. */
export async function updateEmployee(
  tx: DbTx,
  ctx: TenantContext,
  employeeId: string,
  patch: UpdateEmployeeInput,
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) {
    const n = patch.name.trim();
    if (n.length === 0) throw new ValidationError(['Employee name is required.']);
    set.name = n;
  }
  if (patch.title !== undefined) set.title = patch.title?.trim() || null;
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.departmentId !== undefined) {
    await assertDepartmentInWorkspace(tx, ctx, patch.departmentId);
    set.departmentId = patch.departmentId;
  }
  if (patch.reportsToId !== undefined) {
    if (patch.reportsToId === employeeId) {
      throw new ValidationError(['An employee cannot report to themselves.']);
    }
    await assertManagerInWorkspace(tx, ctx, patch.reportsToId, employeeId);
    set.reportsToId = patch.reportsToId;
  }

  const updated = await tx
    .update(agents)
    .set(set)
    .where(and(eq(agents.id, employeeId), eq(agents.projectId, ctx.projectId), eq(agents.orgId, ctx.orgId)))
    .returning({ id: agents.id });
  if (updated.length === 0) throw new NotFoundError('Employee');

  await writeAudit(tx, ctx, {
    action: 'employee.updated',
    entityType: 'agent',
    entityId: employeeId,
    detail: { fields: Object.keys(patch) },
  });
}

/** Tenant-scoped existence check for a department (fail closed on cross-tenant ids). */
async function assertDepartmentInWorkspace(
  tx: DbTx,
  ctx: TenantContext,
  departmentId: string | null,
): Promise<void> {
  if (!departmentId) return;
  const rows = await tx
    .select({ id: departments.id })
    .from(departments)
    .where(and(eq(departments.id, departmentId), eq(departments.orgId, ctx.orgId)))
    .limit(1);
  if (rows.length === 0) throw new ValidationError(['That department is not in this workspace.']);
}

/** A manager must be an employee in the same workspace, and not the employee
 *  being edited (a one-hop self-loop guard; deeper cycles are descriptive only). */
async function assertManagerInWorkspace(
  tx: DbTx,
  ctx: TenantContext,
  managerId: string | null,
  selfId: string | null,
): Promise<void> {
  if (!managerId) return;
  if (managerId === selfId) throw new ValidationError(['An employee cannot report to themselves.']);
  const rows = await tx
    .select({ reportsToId: agents.reportsToId })
    .from(agents)
    .where(and(eq(agents.id, managerId), eq(agents.projectId, ctx.projectId), eq(agents.orgId, ctx.orgId)))
    .limit(1);
  if (rows.length === 0) throw new ValidationError(['That manager is not an employee in this workspace.']);
  // Guard the immediate 2-cycle (A→B, B→A). Full-chain cycle prevention is not
  // needed: reporting is descriptive here, never traversed for routing.
  if (selfId && rows[0]!.reportsToId === selfId) {
    throw new ValidationError(['That would create a circular reporting line.']);
  }
}

// --- Ownership: "who owns this?" across the core objects ---------------------

export type OwnableObject = 'task' | 'decision' | 'objective' | 'project' | 'work_item';

/** Assign (or clear, with null) the employee owner of a core object. Tenant-scoped
 *  on both the object and the owner. Descriptive — no routing follows. */
export async function setOwner(
  tx: DbTx,
  ctx: TenantContext,
  object: OwnableObject,
  objectId: string,
  ownerAgentId: string | null,
): Promise<void> {
  // Objective ownership has its own canonical function (HUB-005): admin authority, a disabled-employee
  // guard, idempotency, and distinct owner_assigned/_changed/_cleared audit events. Route to it so there
  // is ONE write path for the objective owner FK — never a second, weaker one here.
  if (object === 'objective') {
    await setObjectiveOwner(tx, ctx, objectId, ownerAgentId);
    return;
  }

  if (ownerAgentId) {
    const owner = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, ownerAgentId), eq(agents.projectId, ctx.projectId), eq(agents.orgId, ctx.orgId)))
      .limit(1);
    if (owner.length === 0) throw new ValidationError(['That owner is not an employee in this workspace.']);
  }

  let updated: { id: string }[];
  if (object === 'task') {
    updated = await tx.update(tasks).set({ ownerAgentId, updatedAt: new Date() })
      .where(and(eq(tasks.id, objectId), eq(tasks.orgId, ctx.orgId), eq(tasks.projectId, ctx.projectId))).returning({ id: tasks.id });
  } else if (object === 'decision') {
    updated = await tx.update(decisions).set({ ownerAgentId, updatedAt: new Date() })
      .where(and(eq(decisions.id, objectId), eq(decisions.orgId, ctx.orgId), eq(decisions.projectId, ctx.projectId))).returning({ id: decisions.id });
  } else if (object === 'work_item') {
    updated = await tx.update(workItems).set({ ownerAgentId, updatedAt: new Date() })
      .where(and(eq(workItems.id, objectId), eq(workItems.orgId, ctx.orgId), eq(workItems.projectId, ctx.projectId))).returning({ id: workItems.id });
  } else {
    updated = await tx.update(projects).set({ ownerAgentId, updatedAt: new Date() })
      .where(and(eq(projects.id, objectId), eq(projects.orgId, ctx.orgId), eq(projects.id, ctx.projectId))).returning({ id: projects.id });
  }
  if (updated.length === 0) throw new NotFoundError(object);

  await writeAudit(tx, ctx, {
    action: 'ownership.assigned',
    entityType: object,
    entityId: objectId,
    detail: { ownerAgentId },
  });
}

/** All work owned by a given employee — the "what belongs to this person?" view. */
export async function workOwnedBy(
  tx: DbTx,
  ctx: TenantContext,
  employeeId: string,
): Promise<{ objectives: number; tasks: number; decisions: number; projects: number }> {
  const [obj, tsk, dec, prj] = await Promise.all([
    tx.select({ id: objectives.id }).from(objectives).where(and(eq(objectives.accountableAgentId, employeeId), eq(objectives.projectId, ctx.projectId), eq(objectives.orgId, ctx.orgId))),
    tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.ownerAgentId, employeeId), eq(tasks.projectId, ctx.projectId), eq(tasks.orgId, ctx.orgId))),
    tx.select({ id: decisions.id }).from(decisions).where(and(eq(decisions.ownerAgentId, employeeId), eq(decisions.projectId, ctx.projectId), eq(decisions.orgId, ctx.orgId))),
    tx.select({ id: projects.id }).from(projects).where(and(eq(projects.ownerAgentId, employeeId), eq(projects.id, ctx.projectId), eq(projects.orgId, ctx.orgId))),
  ]);
  return { objectives: obj.length, tasks: tsk.length, decisions: dec.length, projects: prj.length };
}
