import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import {
  agents,
  auditLogs,
  memberships,
  organizations,
  profiles,
  projectMembers,
  projects,
  runs,
  tasks,
} from '@/db/schema';
import { createObjective, getObjective, setObjectiveStatus } from '@/domain/objectives/objectives';
import { createTask, getTask } from '@/domain/tasks/tasks';
import { createWorkItem } from '@/domain/work/work-items';
import { listExecution } from '@/domain/execution/execution';
import {
  attachTaskToObjective,
  classifyTaskObjectiveLink,
  detachTaskFromObjective,
  detectObjectiveLinkContradictions,
  listOpenObjectives,
  moveTaskToObjective,
  reconcileTaskObjective,
} from '@/domain/objectives/task-link';

/**
 * HUB-003 — the canonical objective↔task relationship. One FK (`tasks.objective_id`) is the single
 * source of truth; every surface reads it; receiving an objective as run *context* never becomes a
 * durable link; relationship changes go through audited domain functions; a read-only detector reports
 * contradictory historical records.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[objective-task-link.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

let orgId = '';
let userId = '';
let ctx: TenantContext; // workspace A (admin)
let ctx2: TenantContext; // workspace B (admin) — for cross-workspace rejection
let seedAgentId = '';

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `ol-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Admin' });
  const org = await db.insert(organizations).values({ name: 'Org', slug: `ol-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  const p = await db.insert(projects).values({ orgId, key: fixtureKey('ol'), name: 'A' }).returning({ id: projects.id });
  await db.insert(projectMembers).values({ orgId, projectId: p[0]!.id, userId, role: 'admin' });
  ctx = { userId, orgId, projectId: p[0]!.id, orgRole: 'owner', projectRole: 'admin' };
  const p2 = await db.insert(projects).values({ orgId, key: fixtureKey('ol2'), name: 'B' }).returning({ id: projects.id });
  await db.insert(projectMembers).values({ orgId, projectId: p2[0]!.id, userId, role: 'admin' });
  ctx2 = { userId, orgId, projectId: p2[0]!.id, orgRole: 'owner', projectRole: 'admin' };
  const ag = await db
    .insert(agents)
    .values({ orgId, projectId: ctx.projectId, name: 'Seed', provider: 'openai', model: 'gpt-x', systemPrompt: 'x' })
    .returning({ id: agents.id });
  seedAgentId = ag[0]!.id;
});

afterAll(async () => {
  if (!available) return;
  await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});

// ---- helpers -------------------------------------------------------------
async function draftObjective(title = 'Ship the thing', project = ctx): Promise<string> {
  return withTenant(project, (tx) =>
    createObjective(tx, project, { title, description: '', successCriteria: [{ label: 'One', metric: 'm', target: 1, unit: '' }] }),
  );
}
async function plainTask(objectiveId: string | null = null): Promise<string> {
  return withTenant(ctx, (tx) =>
    createTask(tx, ctx, { title: 'Do work', input: 'x', providerSelection: 'openai', reviewEnabled: false, objectiveId }),
  );
}
async function fkOf(taskId: string): Promise<string | null> {
  const r = await getSetupDb().select({ o: tasks.objectiveId }).from(tasks).where(eq(tasks.id, taskId));
  return r[0]!.o;
}
async function setTaskStatus(taskId: string, status: 'completed' | 'running'): Promise<void> {
  await getSetupDb().update(tasks).set({ status }).where(eq(tasks.id, taskId));
}
async function auditCount(taskId: string, action: string): Promise<number> {
  const r = await getSetupDb().select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.entityId, taskId), eq(auditLogs.action, action)));
  return r.length;
}
/** Seed a completed run whose context manifest NAMED an objective (context only — not a link). */
async function seedRunWithObjectiveContext(taskId: string, objectiveTitle: string): Promise<void> {
  await getSetupDb().insert(runs).values({ classification: 'live',
    orgId,
    projectId: ctx.projectId,
    taskId,
    status: 'completed',
    primaryAgentId: seedAgentId,
    contextManifest: [{ source: 'objective', label: objectiveTitle }],
  });
}

describe.skipIf(!available)('HUB-003 canonical objective↔task relationship', () => {
  it('a task created directly from an objective persists + audits the canonical FK', async () => {
    const objId = await draftObjective('Directly-from-objective');
    const taskId = await plainTask(objId);
    expect(await fkOf(taskId)).toBe(objId);
    const created = await getSetupDb().select({ d: auditLogs.detail }).from(auditLogs).where(and(eq(auditLogs.entityId, taskId), eq(auditLogs.action, 'task.created')));
    expect((created[0]!.d as Record<string, unknown>).objectiveId).toBe(objId);
    // The task header now reads the SAME FK.
    const detail = await withTenant(ctx, (tx) => getTask(tx, ctx, taskId));
    expect(detail.objectiveId).toBe(objId);
    expect(detail.objectiveTitle).toBe('Directly-from-objective');
  });

  it('creating a task rejects a cross-workspace objective (same-workspace validation, req #4)', async () => {
    const foreignObj = await draftObjective('Foreign', ctx2);
    await expect(plainTask(foreignObj)).rejects.toThrow(); // NotFound — not in this workspace
  });

  it('a human work item created from Work persists its own canonical objective FK', async () => {
    const objId = await draftObjective('Work-item-objective');
    const wiId = await withTenant(ctx, (tx) =>
      createWorkItem(tx, ctx, { title: 'Human effort', condition: 'planned', waitingOn: '', stage: 'New', notes: '', objectiveId: objId }),
    );
    const { rows } = await withTenant(ctx, (tx) => listExecution(tx, ctx));
    const row = rows.find((r) => r.kind === 'work_item' && r.id === wiId)!;
    expect(row.objectiveId).toBe(objId);
  });

  it('a task with objective CONTEXT but no FK is NOT durably tied (no accidental link)', async () => {
    const objId = await draftObjective('Context-only goal');
    const taskId = await plainTask(null); // created WITHOUT an objective
    await seedRunWithObjectiveContext(taskId, 'Context-only goal');
    // The FK stays null — context is not a link.
    expect(await fkOf(taskId)).toBeNull();
    expect(classifyTaskObjectiveLink({ objectiveId: null, objectiveStatus: null, hadObjectiveContext: true })).toBe('context_only');
    // The detector reports it as context-only, never as a durable contribution.
    const report = await withTenant(ctx, (tx) => detectObjectiveLinkContradictions(tx, ctx));
    const finding = report.findings.find((c) => c.taskId === taskId);
    expect(finding?.category).toBe('context_only_no_link');
    expect(finding?.severity).toBe('context_only');
    // And the objective does not list it.
    const o = await withTenant(ctx, (tx) => getObjective(tx, ctx, objId));
    expect(o.tasks.some((t) => t.id === taskId)).toBe(false);
  });

  it('attach ties an untied task, audits task.objective_attached, and updates progress', async () => {
    const objId = await draftObjective('Attach target');
    const taskId = await plainTask(null);
    const before = await withTenant(ctx, (tx) => getObjective(tx, ctx, objId));
    expect(before.progress.tasksTotal).toBe(0);
    const changed = await withTenant(ctx, (tx) => attachTaskToObjective(tx, ctx, taskId, objId));
    expect(changed).toBe(true);
    expect(await fkOf(taskId)).toBe(objId);
    expect(await auditCount(taskId, 'task.objective_attached')).toBe(1);
    const after = await withTenant(ctx, (tx) => getObjective(tx, ctx, objId));
    expect(after.progress.tasksTotal).toBe(1);
    expect(after.tasks.some((t) => t.id === taskId)).toBe(true);
  });

  it('attach is idempotent and refuses a task already tied to another objective', async () => {
    const a = await draftObjective('A');
    const b = await draftObjective('B');
    const taskId = await plainTask(a);
    // Idempotent: attaching to the objective it already has is a no-op.
    expect(await withTenant(ctx, (tx) => attachTaskToObjective(tx, ctx, taskId, a))).toBe(false);
    // Already tied → must move, not attach.
    await expect(withTenant(ctx, (tx) => attachTaskToObjective(tx, ctx, taskId, b))).rejects.toThrow(/move it instead/i);
  });

  it('every surface reads the same relationship after attach (refresh consistency)', async () => {
    const objId = await draftObjective('Consistent goal');
    const taskId = await plainTask(null);
    await withTenant(ctx, (tx) => attachTaskToObjective(tx, ctx, taskId, objId));
    const detail = await withTenant(ctx, (tx) => getTask(tx, ctx, taskId));
    const o = await withTenant(ctx, (tx) => getObjective(tx, ctx, objId));
    const exec = await withTenant(ctx, (tx) => listExecution(tx, ctx));
    const execRow = exec.rows.find((r) => r.kind === 'ai_task' && r.id === taskId)!;
    expect(detail.objectiveTitle).toBe('Consistent goal');
    expect(o.tasks.some((t) => t.id === taskId)).toBe(true);
    expect(execRow.objectiveTitle).toBe('Consistent goal');
  });

  it('move re-attributes a tied task, audits task.objective_moved, and shifts progress', async () => {
    const a = await draftObjective('From');
    const b = await draftObjective('To');
    const taskId = await plainTask(a);
    const changed = await withTenant(ctx, (tx) => moveTaskToObjective(tx, ctx, taskId, b, ''));
    expect(changed).toBe(true);
    expect(await fkOf(taskId)).toBe(b);
    expect(await auditCount(taskId, 'task.objective_moved')).toBe(1);
    const from = await withTenant(ctx, (tx) => getObjective(tx, ctx, a));
    const to = await withTenant(ctx, (tx) => getObjective(tx, ctx, b));
    expect(from.tasks.some((t) => t.id === taskId)).toBe(false);
    expect(to.tasks.some((t) => t.id === taskId)).toBe(true);
    // Idempotent on the same target.
    expect(await withTenant(ctx, (tx) => moveTaskToObjective(tx, ctx, taskId, b, ''))).toBe(false);
    // Moving an untied task is refused (use attach).
    const untied = await plainTask(null);
    await expect(withTenant(ctx, (tx) => moveTaskToObjective(tx, ctx, untied, b, ''))).rejects.toThrow(/attach it instead/i);
  });

  it('detach clears the FK, audits task.objective_detached, and is idempotent', async () => {
    const objId = await draftObjective('Detach me');
    const taskId = await plainTask(objId);
    expect(await withTenant(ctx, (tx) => detachTaskFromObjective(tx, ctx, taskId, ''))).toBe(true);
    expect(await fkOf(taskId)).toBeNull();
    expect(await auditCount(taskId, 'task.objective_detached')).toBe(1);
    // Idempotent: detaching an already-untied task is a no-op.
    expect(await withTenant(ctx, (tx) => detachTaskFromObjective(tx, ctx, taskId, ''))).toBe(false);
  });

  it('moving/detaching COMPLETED work requires a reason (req #7)', async () => {
    const a = await draftObjective('Done-from');
    const b = await draftObjective('Done-to');
    const taskId = await plainTask(a);
    await setTaskStatus(taskId, 'completed');
    await expect(withTenant(ctx, (tx) => moveTaskToObjective(tx, ctx, taskId, b, ''))).rejects.toThrow(/reason is required/i);
    await expect(withTenant(ctx, (tx) => detachTaskFromObjective(tx, ctx, taskId, '   '))).rejects.toThrow(/reason is required/i);
    // With a reason both go through.
    expect(await withTenant(ctx, (tx) => moveTaskToObjective(tx, ctx, taskId, b, 'rescoped'))).toBe(true);
    expect(await withTenant(ctx, (tx) => detachTaskFromObjective(tx, ctx, taskId, 'no longer relevant'))).toBe(true);
  });

  it('relationship changes require admin authority', async () => {
    const objId = await draftObjective('Admin-only');
    const taskId = await plainTask(null);
    const member = { ...ctx, projectRole: 'member' as const };
    await expect(withTenant(member, (tx) => attachTaskToObjective(tx, member, taskId, objId))).rejects.toThrow(/admin/i);
    await expect(withTenant(member, (tx) => detachTaskFromObjective(tx, member, taskId, 'x'))).rejects.toThrow(/admin/i);
  });

  it('attach/move reject a cross-workspace objective and a missing objective', async () => {
    const taskId = await plainTask(null);
    const foreign = await draftObjective('Foreign2', ctx2);
    await expect(withTenant(ctx, (tx) => attachTaskToObjective(tx, ctx, taskId, foreign))).rejects.toThrow(); // NotFound
    await expect(withTenant(ctx, (tx) => attachTaskToObjective(tx, ctx, taskId, randomUUID()))).rejects.toThrow(); // missing
    expect(await fkOf(taskId)).toBeNull();
  });

  it('attach/move refuse a cancelled objective', async () => {
    const objId = await draftObjective('Doomed');
    await withTenant(ctx, (tx) => setObjectiveStatus(tx, ctx, objId, 'cancelled', 'abandoned'));
    const taskId = await plainTask(null);
    await expect(withTenant(ctx, (tx) => attachTaskToObjective(tx, ctx, taskId, objId))).rejects.toThrow(/cancelled objective/i);
    expect(await fkOf(taskId)).toBeNull();
  });

  it('listOpenObjectives returns only draft/active objectives', async () => {
    const openId = await draftObjective('Open one');
    const closedId = await draftObjective('Closed one');
    await withTenant(ctx, (tx) => setObjectiveStatus(tx, ctx, closedId, 'cancelled', 'x'));
    const open = await withTenant(ctx, (tx) => listOpenObjectives(tx, ctx));
    expect(open.some((o) => o.id === openId)).toBe(true);
    expect(open.some((o) => o.id === closedId)).toBe(false);
  });

  it('a COMPLETED task tied to a cancelled objective is historical-valid (not a defect)', async () => {
    const objId = await draftObjective('Will cancel');
    const taskId = await plainTask(objId);
    await setTaskStatus(taskId, 'completed');
    await withTenant(ctx, (tx) => setObjectiveStatus(tx, ctx, objId, 'cancelled', 'pivoted'));
    const report = await withTenant(ctx, (tx) => detectObjectiveLinkContradictions(tx, ctx));
    const finding = report.findings.find((c) => c.taskId === taskId);
    expect(finding?.category).toBe('fk_closed_objective');
    expect(finding?.severity).toBe('historical_valid');
    expect(finding?.recommendation).toMatch(/historical-valid|leave unchanged/i);
    // Structural guarantees are reported, not silently assumed.
    expect(report.structurallyConsistent.length).toBeGreaterThanOrEqual(3);
  });

  it('an OPEN task tied to a cancelled objective is a WARNING (working toward a dead goal)', async () => {
    const objId = await draftObjective('Cancel under live task');
    const taskId = await plainTask(objId); // stays pending (open)
    await withTenant(ctx, (tx) => setObjectiveStatus(tx, ctx, objId, 'cancelled', 'pivoted'));
    const report = await withTenant(ctx, (tx) => detectObjectiveLinkContradictions(tx, ctx));
    const finding = report.findings.find((c) => c.taskId === taskId);
    expect(finding?.category).toBe('fk_closed_objective');
    expect(finding?.severity).toBe('warning');
  });

  it('a cross-workspace FK is an ERROR (fk_foreign_or_missing) from legacy data', async () => {
    const foreign = await draftObjective('Foreign obj', ctx2);
    // Simulate legacy bad data: a raw insert that bypasses createTask's validation.
    const t = await getSetupDb()
      .insert(tasks)
      .values({ orgId, projectId: ctx.projectId, title: 'Legacy foreign-linked', input: 'x', providerSelection: 'openai', status: 'completed', createdBy: userId, objectiveId: foreign })
      .returning({ id: tasks.id });
    const taskId = t[0]!.id;
    const report = await withTenant(ctx, (tx) => detectObjectiveLinkContradictions(tx, ctx));
    const finding = report.findings.find((c) => c.taskId === taskId);
    expect(finding?.category).toBe('fk_foreign_or_missing');
    expect(finding?.severity).toBe('error');
    expect(finding?.recommendation).toMatch(/detach/i);
  });

  it('a context/FK mismatch is a WARNING (run named a different objective than the durable FK)', async () => {
    const objId = await draftObjective('Real FK objective');
    const taskId = await plainTask(objId);
    await seedRunWithObjectiveContext(taskId, 'A completely different objective');
    const report = await withTenant(ctx, (tx) => detectObjectiveLinkContradictions(tx, ctx));
    const finding = report.findings.find((c) => c.taskId === taskId);
    expect(finding?.category).toBe('context_fk_mismatch');
    expect(finding?.severity).toBe('warning');
  });

  it('a cleanly-tied task to an OPEN objective produces no finding', async () => {
    const objId = await draftObjective('Healthy goal');
    const taskId = await plainTask(objId); // FK to an open objective, no conflicting context
    const report = await withTenant(ctx, (tx) => detectObjectiveLinkContradictions(tx, ctx));
    expect(report.findings.some((c) => c.taskId === taskId)).toBe(false);
  });

  it('reconcile applies a historical repair, audits task.objective_reconciled, and is idempotent', async () => {
    const objId = await draftObjective('Reconcile target');
    const taskId = await plainTask(objId);
    await setTaskStatus(taskId, 'completed');
    // Repair: detach (to null).
    const changed = await withTenant(ctx, (tx) => reconcileTaskObjective(tx, ctx, taskId, null, 'detector: link was wrong'));
    expect(changed).toBe(true);
    expect(await fkOf(taskId)).toBeNull();
    const evs = await getSetupDb().select({ d: auditLogs.detail }).from(auditLogs).where(and(eq(auditLogs.entityId, taskId), eq(auditLogs.action, 'task.objective_reconciled')));
    expect(evs.length).toBe(1);
    expect((evs[0]!.d as Record<string, unknown>).reason).toBe('detector: link was wrong');
    // Idempotent: reconciling to the same (null) target changes nothing.
    expect(await withTenant(ctx, (tx) => reconcileTaskObjective(tx, ctx, taskId, null, 'again'))).toBe(false);
    // Reconcile requires a reason + admin.
    await expect(withTenant(ctx, (tx) => reconcileTaskObjective(tx, ctx, taskId, objId, ''))).rejects.toThrow(/reason is required/i);
    const member = { ...ctx, projectRole: 'member' as const };
    await expect(withTenant(member, (tx) => reconcileTaskObjective(tx, member, taskId, objId, 'x'))).rejects.toThrow(/admin/i);
  });
});
