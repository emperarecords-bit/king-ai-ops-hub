import 'server-only';
import { and, asc, eq } from 'drizzle-orm';
import { type AgentRole, type TenantContext } from '@/types/domain';
import { AppError, NotFoundError, ValidationError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { agents, decisions, departments, objectives, projects, tasks } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';

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

export type OwnableObject = 'task' | 'decision' | 'objective' | 'project';

/** Assign (or clear, with null) the employee owner of a core object. Tenant-scoped
 *  on both the object and the owner. Descriptive — no routing follows. */
export async function setOwner(
  tx: DbTx,
  ctx: TenantContext,
  object: OwnableObject,
  objectId: string,
  ownerAgentId: string | null,
): Promise<void> {
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
  } else if (object === 'objective') {
    updated = await tx.update(objectives).set({ accountableAgentId: ownerAgentId, updatedAt: new Date() })
      .where(and(eq(objectives.id, objectId), eq(objectives.orgId, ctx.orgId), eq(objectives.projectId, ctx.projectId))).returning({ id: objectives.id });
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
