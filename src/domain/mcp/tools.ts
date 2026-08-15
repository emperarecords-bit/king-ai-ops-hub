import { and, desc, eq, ilike, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type TenantContext } from '@/types/domain';
import { AppError, NotFoundError, ValidationError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { departments, memberships, messages, projectMembers, projects, tasks, usageEvents } from '@/db/schema';
import { createTask } from '@/domain/tasks/tasks';
import { enqueueRun } from '@/domain/jobs/jobs';
import { createWorkspaceWithStaff } from '@/domain/projects/provision';
import { createEmployeeWithConfig } from '@/domain/agents/org';
import {
  POSITION_KEYS,
  POSITION_TEMPLATES,
  getPositionTemplate,
} from '@/domain/agents/position-templates';
import { PROVIDER_IDS, PROVIDER_SELECTIONS } from '@/types/provider';
import { type McpToolName } from './tool-names';

/**
 * MCP tool handlers (Phase 5). Every handler runs inside the caller's `withTenant` transaction (opened by the
 * server, which also enforces the per-token rate limit), so RLS confines each read and write to the token's one
 * project. Write tools call the SAME domain functions as the UI — `create_task` creates a task and `submit_run`
 * enqueues a run; neither executes a side-effecting action or approves anything, so the approval queue is never
 * bypassed. A JSON Schema is published per tool for `tools/list`.
 */

export interface McpToolDefinition {
  readonly name: McpToolName;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /**
   * Tenancy scope the server opens for the handler. 'project' (default) runs
   * under withTenant bound to the token's one project. 'org' runs under
   * withOrg (user+org GUCs, no project) for provisioning tools whose target
   * workspace does not exist yet or is not the token's own — the handler
   * derives the org ONLY from the authenticated context and performs its own
   * membership checks before stamping a project scope mid-transaction.
   */
  readonly scope?: 'project' | 'org';
  readonly handler: (tx: DbTx, ctx: TenantContext, args: unknown) => Promise<unknown>;
}

function parse<T>(schema: z.ZodType<T>, args: unknown): T {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message));
  return parsed.data;
}

// --- read tools -------------------------------------------------------------

const listProjects: McpToolDefinition = {
  name: 'list_projects',
  description: 'List the project this token is scoped to (a token is bound to exactly one project).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (tx, ctx) => {
    const rows = await tx
      .select({ id: projects.id, key: projects.key, name: projects.name, description: projects.description })
      .from(projects)
      .where(eq(projects.id, ctx.projectId));
    return { projects: rows };
  },
};

const getTask: McpToolDefinition = {
  name: 'get_task',
  description: 'Fetch one task in this project by id.',
  inputSchema: {
    type: 'object',
    properties: { taskId: { type: 'string', format: 'uuid' } },
    required: ['taskId'],
    additionalProperties: false,
  },
  handler: async (tx, ctx, args) => {
    const { taskId } = parse(z.object({ taskId: z.string().uuid() }), args);
    const rows = await tx
      .select({
        id: tasks.id,
        title: tasks.title,
        input: tasks.input,
        status: tasks.status,
        createdAt: tasks.createdAt,
      })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.projectId, ctx.projectId)))
      .limit(1);
    if (rows.length === 0) throw new NotFoundError('Task');
    return rows[0];
  },
};

const searchMessages: McpToolDefinition = {
  name: 'search_messages',
  description: 'Case-insensitive substring search over message content in this project.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 200 },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
    required: ['query'],
    additionalProperties: false,
  },
  handler: async (tx, ctx, args) => {
    const { query, limit } = parse(
      z.object({ query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(50).default(20) }),
      args,
    );
    // Escape LIKE metacharacters so a query is a literal substring, never a wildcard probe.
    const needle = `%${query.replace(/([%_\\])/g, '\\$1')}%`;
    const rows = await tx
      .select({
        id: messages.id,
        taskId: messages.taskId,
        runId: messages.runId,
        content: messages.content,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(and(eq(messages.projectId, ctx.projectId), ilike(messages.content, needle)))
      .orderBy(desc(messages.createdAt))
      .limit(limit);
    return { matches: rows };
  },
};

const getUsage: McpToolDefinition = {
  name: 'get_usage',
  description: 'Aggregate token and cost usage for this project.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (tx, ctx) => {
    const rows = await tx
      .select({
        events: sql<number>`count(*)::int`,
        inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)::int`,
        costMicros: sql<string>`coalesce(sum(${usageEvents.costMicros}), 0)::text`,
      })
      .from(usageEvents)
      .where(eq(usageEvents.projectId, ctx.projectId));
    return rows[0] ?? { events: 0, inputTokens: 0, outputTokens: 0, costMicros: '0' };
  },
};

// --- write tools (same domain path as the UI; no approval bypass) -----------

const createTaskInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  input: z.string().trim().min(1).max(32_000),
  primaryAgentId: z.string().uuid(),
  providerSelection: z.enum(PROVIDER_SELECTIONS).default('anthropic'),
  reviewEnabled: z.boolean().default(false),
});

const createTaskTool: McpToolDefinition = {
  name: 'create_task',
  description: 'Create a task in this project. It enters the same lifecycle as a UI-created task.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      input: { type: 'string', minLength: 1, maxLength: 32000 },
      primaryAgentId: { type: 'string', format: 'uuid' },
      providerSelection: { type: 'string', enum: [...PROVIDER_SELECTIONS] },
      reviewEnabled: { type: 'boolean' },
    },
    required: ['title', 'input', 'primaryAgentId'],
    additionalProperties: false,
  },
  handler: async (tx, ctx, args) => {
    const v = parse(createTaskInputSchema, args);
    const taskId = await createTask(tx, ctx, {
      title: v.title,
      input: v.input,
      providerSelection: v.providerSelection,
      reviewEnabled: v.reviewEnabled,
      modelTier: 'standard',
      flagshipCategory: null,
      objectiveId: null,
      scheduleId: null,
      primaryAgentId: v.primaryAgentId,
      reviewerAgentId: null,
    });
    return { taskId };
  },
};

const submitRunTool: McpToolDefinition = {
  name: 'submit_run',
  description: 'Queue a run for an existing task. The run lands in the same queue as a UI-initiated run; any action it proposes still requires approval.',
  inputSchema: {
    type: 'object',
    properties: { taskId: { type: 'string', format: 'uuid' } },
    required: ['taskId'],
    additionalProperties: false,
  },
  handler: async (tx, ctx, args) => {
    const { taskId } = parse(z.object({ taskId: z.string().uuid() }), args);
    const exists = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.projectId, ctx.projectId)))
      .limit(1);
    if (exists.length === 0) throw new NotFoundError('Task');
    await enqueueRun(tx, ctx, taskId);
    return { taskId, enqueued: true };
  },
};

// --- provisioning tools (org scope; the voice-partner path) -----------------

const listPositionTemplates: McpToolDefinition = {
  name: 'list_position_templates',
  description:
    'List the hireable position templates (title, role, department, default AI provider/model). Use these keys with create_workspace and staff_positions.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async () => ({
    positions: POSITION_TEMPLATES.map((t) => ({
      key: t.key,
      title: t.title,
      role: t.role,
      department: t.department,
      provider: t.provider,
      model: t.model,
    })),
  }),
};

const positionRequestSchema = z.object({
  position: z.string().refine((k) => POSITION_KEYS.includes(k), {
    message: `Unknown position. Valid keys: ${POSITION_KEYS.join(', ')}`,
  }),
  name: z.string().trim().min(1).max(120).optional(),
  provider: z.enum(PROVIDER_IDS).optional(),
  model: z.string().trim().min(1).max(120).optional(),
});
type PositionRequest = z.infer<typeof positionRequestSchema>;

const positionRequestJsonSchema = {
  type: 'object',
  properties: {
    position: { type: 'string', enum: [...POSITION_KEYS] },
    name: { type: 'string', minLength: 1, maxLength: 120 },
    provider: { type: 'string', enum: [...PROVIDER_IDS] },
    model: { type: 'string', minLength: 1, maxLength: 120 },
  },
  required: ['position'],
  additionalProperties: false,
} as const;

/** Org owner/admin membership, or a clear refusal. Runs under org-scope GUCs. */
async function requireOrgAdmin(tx: DbTx, userId: string, orgId: string): Promise<'owner' | 'admin'> {
  const row = (
    await tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
      .limit(1)
  )[0];
  if (!row || (row.role !== 'owner' && row.role !== 'admin')) {
    throw new AppError('forbidden', 'Provisioning requires organization owner or admin.');
  }
  return row.role;
}

/**
 * Hire positions into a workspace the caller already administers, inside the
 * caller's transaction. Uses createEmployeeWithConfig — the same audited,
 * admin-gated path as the UI — so duplicate names are idempotent no-ops and
 * every real hire writes an employee.created audit event.
 */
async function staffFromTemplates(
  tx: DbTx,
  ctx: TenantContext,
  businessName: string,
  positions: readonly PositionRequest[],
  reason: string,
): Promise<Array<{ position: string; name: string; employeeId: string; created: boolean }>> {
  const hires: Array<{ position: string; name: string; employeeId: string; created: boolean }> = [];
  for (const req of positions) {
    const template = getPositionTemplate(req.position)!;
    const department = (
      await tx
        .select({ id: departments.id })
        .from(departments)
        .where(and(eq(departments.orgId, ctx.orgId), eq(departments.key, template.department)))
        .limit(1)
    )[0];
    const name = req.name ?? `${template.title} (${businessName})`;
    const result = await createEmployeeWithConfig(tx, ctx, {
      name,
      title: template.title,
      role: template.role,
      departmentId: department?.id ?? null,
      provider: req.provider ?? template.provider,
      model: req.model ?? template.model,
      systemPrompt: template.mission(businessName),
      reason,
    });
    hires.push({ position: req.position, name, employeeId: result.employeeId, created: result.created });
  }
  return hires;
}

const createWorkspaceTool: McpToolDefinition = {
  name: 'create_workspace',
  description:
    'Provision a new business workspace in the organization: standard departments, the default engineering team, a $25/mo budget, and a charter. Optionally staff business positions (see list_position_templates) in the same transaction. Requires org owner/admin.',
  scope: 'org',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 80 },
      description: { type: 'string', maxLength: 2000 },
      positions: { type: 'array', items: positionRequestJsonSchema, maxItems: 20 },
      reason: { type: 'string', minLength: 1, maxLength: 500 },
    },
    required: ['name', 'reason'],
    additionalProperties: false,
  },
  handler: async (tx, ctx, args) => {
    const v = parse(
      z.object({
        name: z.string().trim().min(1).max(80),
        description: z.string().trim().max(2000).optional(),
        positions: z.array(positionRequestSchema).max(20).default([]),
        reason: z.string().trim().min(1).max(500),
      }),
      args,
    );
    // The org comes ONLY from the authenticated token context, never from args.
    const orgRole = await requireOrgAdmin(tx, ctx.userId, ctx.orgId);
    const workspace = await createWorkspaceWithStaff(
      tx,
      { userId: ctx.userId, orgId: ctx.orgId },
      { name: v.name, description: v.description, reason: v.reason },
    );
    // createWorkspaceWithStaff transitioned the tx to the new workspace's scope
    // and made the actor its admin; staff the requested positions in the same tx.
    const workspaceCtx: TenantContext = {
      userId: ctx.userId,
      orgId: ctx.orgId,
      projectId: workspace.projectId,
      orgRole,
      projectRole: 'admin',
    };
    const hires = await staffFromTemplates(tx, workspaceCtx, v.name, v.positions, v.reason);
    return {
      projectId: workspace.projectId,
      projectKey: workspace.projectKey,
      defaultStaff: 4,
      hires,
    };
  },
};

const staffPositionsTool: McpToolDefinition = {
  name: 'staff_positions',
  description:
    'Hire employees from position templates into an EXISTING workspace in the organization (target by projectKey or projectId). Requires org owner/admin plus admin membership of the target workspace.',
  scope: 'org',
  inputSchema: {
    type: 'object',
    properties: {
      projectKey: { type: 'string', minLength: 1, maxLength: 120 },
      projectId: { type: 'string', format: 'uuid' },
      businessName: { type: 'string', minLength: 1, maxLength: 80 },
      positions: { type: 'array', items: positionRequestJsonSchema, minItems: 1, maxItems: 20 },
      reason: { type: 'string', minLength: 1, maxLength: 500 },
    },
    required: ['positions', 'reason'],
    additionalProperties: false,
  },
  handler: async (tx, ctx, args) => {
    const v = parse(
      z
        .object({
          projectKey: z.string().trim().min(1).max(120).optional(),
          projectId: z.string().uuid().optional(),
          businessName: z.string().trim().min(1).max(80).optional(),
          positions: z.array(positionRequestSchema).min(1).max(20),
          reason: z.string().trim().min(1).max(500),
        })
        .refine((x) => (x.projectKey != null) !== (x.projectId != null), {
          message: 'Provide exactly one of projectKey or projectId.',
        }),
      args,
    );
    const orgRole = await requireOrgAdmin(tx, ctx.userId, ctx.orgId);
    // Resolve the target inside the authenticated org only.
    const target = (
      await tx
        .select({ id: projects.id, key: projects.key, name: projects.name, archived: projects.archived })
        .from(projects)
        .where(
          and(
            eq(projects.orgId, ctx.orgId),
            v.projectId != null ? eq(projects.id, v.projectId) : eq(projects.key, v.projectKey!),
          ),
        )
        .limit(1)
    )[0];
    if (!target) throw new NotFoundError('Workspace');
    if (target.archived) throw new AppError('conflict', 'That workspace is archived.');
    const member = (
      await tx
        .select({ role: projectMembers.role })
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, target.id), eq(projectMembers.userId, ctx.userId)))
        .limit(1)
    )[0];
    if (!member || member.role !== 'admin') {
      throw new AppError('forbidden', 'You must be an admin member of the target workspace.');
    }
    // Transition the transaction from org scope to the TARGET workspace scope.
    await tx.execute(sql`select set_config('app.project_id', ${target.id}, true)`);
    const workspaceCtx: TenantContext = {
      userId: ctx.userId,
      orgId: ctx.orgId,
      projectId: target.id,
      orgRole,
      projectRole: 'admin',
    };
    const hires = await staffFromTemplates(tx, workspaceCtx, v.businessName ?? target.name, v.positions, v.reason);
    return { projectId: target.id, projectKey: target.key, hires };
  },
};

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  listProjects,
  getTask,
  searchMessages,
  getUsage,
  listPositionTemplates,
  createTaskTool,
  submitRunTool,
  createWorkspaceTool,
  staffPositionsTool,
];

const BY_NAME = new Map<string, McpToolDefinition>(MCP_TOOLS.map((t) => [t.name, t]));

export function getToolDefinition(name: string): McpToolDefinition | undefined {
  return BY_NAME.get(name);
}
