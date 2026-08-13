import { and, desc, eq, ilike, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type TenantContext } from '@/types/domain';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { messages, projects, tasks, usageEvents } from '@/db/schema';
import { createTask } from '@/domain/tasks/tasks';
import { enqueueRun } from '@/domain/jobs/jobs';
import { PROVIDER_SELECTIONS } from '@/types/provider';
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

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  listProjects,
  getTask,
  searchMessages,
  getUsage,
  createTaskTool,
  submitRunTool,
];

const BY_NAME = new Map<string, McpToolDefinition>(MCP_TOOLS.map((t) => [t.name, t]));

export function getToolDefinition(name: string): McpToolDefinition | undefined {
  return BY_NAME.get(name);
}
