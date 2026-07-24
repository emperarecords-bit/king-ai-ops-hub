import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { type ReviewDetail, type SuccessCriterion } from '@/types/domain';
import {
  actionTypeEnum,
  agentRoleEnum,
  approvalStatusEnum,
  artifactKindEnum,
  contextItemStatusEnum,
  flagshipCategoryEnum,
  knowledgeKindEnum,
  knowledgeScopeEnum,
  knowledgeSourceEnum,
  knowledgeStatusEnum,
  messageRoleEnum,
  milestoneStatusEnum,
  modelTierEnum,
  objectiveStatusEnum,
  orgRoleEnum,
  projectRoleEnum,
  providerIdEnum,
  providerSelectionEnum,
  reviewVerdictEnum,
  runStatusEnum,
  stepKindEnum,
  taskStatusEnum,
} from './enums';

/**
 * Schema conventions (see ARCHITECTURE.md §8, DECISIONS.md D-008):
 *  - Every tenant-scoped table carries org_id AND project_id, NOT NULL, indexed,
 *    even where derivable by join. RLS predicates stay single-table.
 *  - Money is bigint USD micros. Tokens are integer. Time is timestamptz.
 *  - messages and audit_logs are append-only; triggers in the RLS migration
 *    block UPDATE/DELETE.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

// ---------------------------------------------------------------------------
// Identity & tenancy
// ---------------------------------------------------------------------------

/** Mirrors supabase auth.users; id IS the Supabase user id. */
export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  ...timestamps,
});

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  ...timestamps,
});

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    role: orgRoleEnum('role').notNull().default('member'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('memberships_org_user_uq').on(t.orgId, t.userId),
    index('memberships_user_idx').on(t.userId),
  ],
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** URL-safe, unique per org. What the client is allowed to send. */
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    archived: boolean('archived').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('projects_org_key_uq').on(t.orgId, t.key),
    index('projects_org_idx').on(t.orgId),
  ],
);

export const projectMembers = pgTable(
  'project_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    role: projectRoleEnum('role').notNull().default('member'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('project_members_project_user_uq').on(t.projectId, t.userId),
    index('project_members_user_idx').on(t.userId),
    index('project_members_org_project_idx').on(t.orgId, t.projectId),
  ],
);

/**
 * Departments (D-012, D-015): the stable organizational structure of the AI
 * workforce. Org-scoped (not per-project) — an employee's department is the
 * same in every workspace. A table, not an enum: the set grows (Sales, Legal,
 * Research…) and will eventually accept custom entries.
 */
export const departments = pgTable(
  'departments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** URL-safe stable identifier, e.g. 'engineering'. */
    key: text('key').notNull(),
    name: text('name').notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('departments_org_key_uq').on(t.orgId, t.key),
    index('departments_org_idx').on(t.orgId),
  ],
);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    role: agentRoleEnum('role').notNull().default('primary'),
    /** D-015: every employee belongs to a department. Nullable until backfilled. */
    departmentId: uuid('department_id').references(() => departments.id, {
      onDelete: 'set null',
    }),
    provider: providerIdEnum('provider').notNull(),
    model: text('model').notNull(),
    systemPrompt: text('system_prompt').notNull(),
    /** Stored x1000 to keep it integral: 700 = 0.7 */
    temperatureMilli: integer('temperature_milli').notNull().default(700),
    maxOutputTokens: integer('max_output_tokens').notNull().default(4096),
    enabled: boolean('enabled').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index('agents_org_project_idx').on(t.orgId, t.projectId),
    uniqueIndex('agents_project_name_uq').on(t.projectId, t.name),
  ],
);

/**
 * The project's memory. ONLY status='approved' rows are ever loaded into a
 * prompt; 'pending' is the quarantine state for anything model-proposed.
 */
export const projectContextItems = pgTable(
  'project_context_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    content: text('content').notNull(),
    status: contextItemStatusEnum('status').notNull().default('pending'),
    createdBy: uuid('created_by').references(() => profiles.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [index('context_items_org_project_status_idx').on(t.orgId, t.projectId, t.status)],
);

/**
 * Company Knowledge (KNOWLEDGE-DESIGN.md, D-011): versioned, never edited —
 * a change is a new row with `supersedes` lineage, and activating a version
 * archives its predecessor in the same transaction. Only `active` items are
 * ever injected into prompts; `draft` is the quarantine state for anything
 * model-proposed (same posture as pending context was).
 *
 * K1 uses scope='project' only. The org/department/employee scope columns
 * exist now so K2–K4 are policy + code changes, not migrations. project_id is
 * nullable ONLY for the future org scope (K4); RLS keeps such rows invisible
 * until an explicit org policy ships.
 */
export const knowledgeItems = pgTable(
  'knowledge_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    scope: knowledgeScopeEnum('scope').notNull().default('project'),
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'set null' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    kind: knowledgeKindEnum('kind').notNull().default('fact'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    version: integer('version').notNull().default(1),
    supersedes: uuid('supersedes'),
    status: knowledgeStatusEnum('status').notNull().default('draft'),
    source: knowledgeSourceEnum('source').notNull().default('manual'),
    sourceRef: uuid('source_ref'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => profiles.id, { onDelete: 'restrict' }),
    approvedBy: uuid('approved_by').references(() => profiles.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('knowledge_org_project_status_idx').on(t.orgId, t.projectId, t.status),
    index('knowledge_project_kind_idx').on(t.projectId, t.kind),
    index('knowledge_supersedes_idx').on(t.supersedes),
  ],
);

export const integrationSecrets = pgTable(
  'integration_secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** v<keyVersion>.<iv>.<tag>.<ciphertext>, AES-256-GCM. Never plaintext. */
    ciphertext: text('ciphertext').notNull(),
    keyVersion: integer('key_version').notNull(),
    lastFour: text('last_four').notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('integration_secrets_project_name_uq').on(t.projectId, t.name),
    index('integration_secrets_org_project_idx').on(t.orgId, t.projectId),
  ],
);

// ---------------------------------------------------------------------------
// Work hierarchy (OBJECTIVES.md, D-010/D-015) — dark in Sprint 3, UI Sprint 4.
// Containment: Project → Objective → Milestone → Task. Department/Employee is
// an ASSIGNMENT dimension (sponsoring_department_id, accountable_agent_id),
// never a parent.
// ---------------------------------------------------------------------------

export const objectives = pgTable(
  'objectives',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    status: objectiveStatusEnum('status').notNull().default('draft'),
    /** Single-ordinal priority; lower = more important (OBJECTIVES.md). */
    priority: integer('priority').notNull().default(100),
    sponsoringDepartmentId: uuid('sponsoring_department_id').references(() => departments.id, {
      onDelete: 'set null',
    }),
    accountableAgentId: uuid('accountable_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    /**
     * SPRINT-03-PLAN §5.3: completion is gated on every criterion being met
     * or human-waived; post-activation changes are audit events.
     */
    successCriteria: jsonb('success_criteria')
      .$type<SuccessCriterion[]>()
      .notNull()
      .default([]),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => profiles.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [
    index('objectives_org_project_idx').on(t.orgId, t.projectId),
    index('objectives_project_status_idx').on(t.projectId, t.status),
  ],
);

export const milestones = pgTable(
  'milestones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    objectiveId: uuid('objective_id')
      .notNull()
      .references(() => objectives.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    status: milestoneStatusEnum('status').notNull().default('planned'),
    /** Ordering within the objective. */
    position: integer('position').notNull().default(0),
    targetDate: timestamp('target_date', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('milestones_org_project_idx').on(t.orgId, t.projectId),
    index('milestones_objective_position_idx').on(t.objectiveId, t.position),
  ],
);

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    /** The user's brief, verbatim. Injection surface — handled per SECURITY.md T2. */
    input: text('input').notNull(),
    providerSelection: providerSelectionEnum('provider_selection').notNull(),
    reviewEnabled: boolean('review_enabled').notNull().default(true),
    /** D-014: human-selected routing tier; flagship requires a stated category. */
    modelTier: modelTierEnum('model_tier').notNull().default('standard'),
    flagshipCategory: flagshipCategoryEnum('flagship_category'),
    /** Optional attachment into the work hierarchy (D-010); dark until Sprint 4. */
    objectiveId: uuid('objective_id').references(() => objectives.id, { onDelete: 'set null' }),
    milestoneId: uuid('milestone_id').references(() => milestones.id, { onDelete: 'set null' }),
    status: taskStatusEnum('status').notNull().default('pending'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => profiles.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [
    index('tasks_org_project_idx').on(t.orgId, t.projectId),
    index('tasks_project_status_idx').on(t.projectId, t.status),
    index('tasks_project_created_idx').on(t.projectId, t.createdAt),
  ],
);

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    status: runStatusEnum('status').notNull().default('running'),
    primaryAgentId: uuid('primary_agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'restrict' }),
    reviewerAgentId: uuid('reviewer_agent_id').references(() => agents.id, {
      onDelete: 'restrict',
    }),
    /** Deterministic consolidation output. Null until the run finishes. */
    consolidatedResult: text('consolidated_result'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('runs_org_project_idx').on(t.orgId, t.projectId),
    index('runs_task_idx').on(t.taskId),
  ],
);

export const runSteps = pgTable(
  'run_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    /** 1-based position; the engine enforces the ceiling, the DB records it. */
    stepNumber: integer('step_number').notNull(),
    kind: stepKindEnum('kind').notNull(),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'restrict' }),
    provider: providerIdEnum('provider'),
    model: text('model'),
    verdict: reviewVerdictEnum('verdict'),
    /** Structured review outcome: { verdict, issues: [{severity, summary, detail?}] } */
    verdictDetail: jsonb('verdict_detail').$type<ReviewDetail>(),
    succeeded: boolean('succeeded').notNull(),
    errorMessage: text('error_message'),
    latencyMs: integer('latency_ms'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('run_steps_run_number_uq').on(t.runId, t.stepNumber),
    index('run_steps_org_project_idx').on(t.orgId, t.projectId),
  ],
);

/**
 * Immutable. The audit-grade record of everything said to and by each model.
 * UPDATE/DELETE are blocked by trigger — corrections are new rows.
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'cascade' }),
    runStepId: uuid('run_step_id').references(() => runSteps.id, { onDelete: 'cascade' }),
    role: messageRoleEnum('role').notNull(),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'restrict' }),
    provider: providerIdEnum('provider'),
    model: text('model'),
    content: text('content').notNull(),
    ...timestamps,
  },
  (t) => [
    index('messages_org_project_idx').on(t.orgId, t.projectId),
    index('messages_task_created_idx').on(t.taskId, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Output & control
// ---------------------------------------------------------------------------

export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    kind: artifactKindEnum('kind').notNull(),
    /** Inline content for text kinds; storage path for kind='file' (Phase 4). */
    content: text('content'),
    storagePath: text('storage_path'),
    sha256: text('sha256').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    ...timestamps,
  },
  (t) => [
    index('artifacts_org_project_idx').on(t.orgId, t.projectId),
    index('artifacts_task_idx').on(t.taskId),
  ],
);

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    actionType: actionTypeEnum('action_type').notNull(),
    /** The model's proposed payload, Zod-validated at extraction. */
    payload: jsonb('payload').notNull(),
    /** sha256 of the canonical payload JSON; executors re-verify before acting. */
    payloadSha256: text('payload_sha256').notNull(),
    summary: text('summary').notNull(),
    status: approvalStatusEnum('status').notNull().default('pending'),
    requestedBy: providerIdEnum('requested_by_provider'),
    decidedBy: uuid('decided_by').references(() => profiles.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [
    index('approvals_org_project_status_idx').on(t.orgId, t.projectId, t.status),
    index('approvals_task_idx').on(t.taskId),
  ],
);

/**
 * Append-only, hash-chained per org. UPDATE/DELETE blocked by trigger.
 * Writes happen in the same transaction as the change they describe.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Monotonic per insert order; the chain verification sorts by this. */
    seq: bigint('seq', { mode: 'bigint' }).notNull().generatedAlwaysAsIdentity(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'restrict' }),
    actorId: uuid('actor_id').references(() => profiles.id, { onDelete: 'restrict' }),
    /** dotted verb, e.g. task.created, run.completed, approval.decided */
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    detail: jsonb('detail').notNull().default({}),
    prevHash: text('prev_hash').notNull(),
    rowHash: text('row_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_org_seq_idx').on(t.orgId, t.seq),
    index('audit_logs_org_project_idx').on(t.orgId, t.projectId),
    index('audit_logs_entity_idx').on(t.entityType, t.entityId),
  ],
);

export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    runStepId: uuid('run_step_id').references(() => runSteps.id, { onDelete: 'set null' }),
    provider: providerIdEnum('provider').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    costMicros: bigint('cost_micros', { mode: 'bigint' }).notNull(),
    /** Pricing table version used, so historical costs stay explainable. */
    pricingVersion: text('pricing_version').notNull(),
    ...timestamps,
  },
  (t) => [
    index('usage_events_org_project_created_idx').on(t.orgId, t.projectId, t.createdAt),
    index('usage_events_run_idx').on(t.runId),
  ],
);

export const spendLimits = pgTable(
  'spend_limits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    monthlyLimitMicros: bigint('monthly_limit_micros', { mode: 'bigint' }).notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex('spend_limits_project_uq').on(t.projectId)],
);

/** Fixed-window rate limiting, one row per (scope, window start). */
export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** e.g. runs:user:<uuid> or runs:project:<uuid> */
    scopeKey: text('scope_key').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [uniqueIndex('rate_limit_scope_window_uq').on(t.scopeKey, t.windowStart)],
);
