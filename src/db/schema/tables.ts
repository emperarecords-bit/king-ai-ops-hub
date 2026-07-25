import { sql } from 'drizzle-orm';
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
import {
  type ContextManifestEntry,
  type RetrievedDocRef,
  type ReviewDetail,
  type SuccessCriterion,
} from '@/types/domain';
import {
  actionTypeEnum,
  agentRoleEnum,
  approvalStatusEnum,
  artifactKindEnum,
  cadenceEnum,
  decisionConfidenceEnum,
  decisionStatusEnum,
  decisionTypeEnum,
  dependencyKindEnum,
  extractionStatusEnum,
  documentKindEnum,
  documentStatusEnum,
  documentSourceEnum,
  documentJobStatusEnum,
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
  runJobStatusEnum,
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
    /** Linked local Project Folder (D-020). Null until the owner links one. */
    documentFolderPath: text('document_folder_path'),
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

/**
 * Project Folder documents (D-020). One row per indexed file. We store the
 * extracted TEXT and a content hash, never the binary — refresh re-reads from
 * the source folder, so no file content lands in a blob store, and an
 * unchanged sha256 lets refresh skip a file cheaply.
 */
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Display identity: relative path (local_folder) or filename (cloud_upload). */
    relativePath: text('relative_path').notNull(),
    kind: documentKindEnum('kind').notNull(),
    sha256: text('sha256').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    /** Chunk count at last successful index; 0 for an empty or failed file. */
    chunkCount: integer('chunk_count').notNull().default(0),
    status: documentStatusEnum('status').notNull().default('active'),
    errorMessage: text('error_message'),
    indexedAt: timestamp('indexed_at', { withTimezone: true }),
    // ---- O-23 cloud source model (additive) --------------------------------
    /** Source adapter. Existing rows backfilled to 'local_folder'. */
    source: documentSourceEnum('source').notNull().default('local_folder'),
    /** Stable per-source identity. local_folder: the relative path. cloud_upload:
     *  a server-generated id that survives re-uploads (the version key). */
    sourceId: text('source_id'),
    /** Tenant-partitioned object-storage key (cloud_upload only). */
    objectKey: text('object_key'),
    mimeType: text('mime_type'),
    /** Source's own modification time, when the uploader supplies it. */
    sourceModifiedAt: timestamp('source_modified_at', { withTimezone: true }),
    /** When the current version's bytes were ingested into object storage. */
    ingestedAt: timestamp('ingested_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // local_folder keeps path-uniqueness; cloud_upload is keyed by (source_id),
    // so "different source, same filename" cannot merge. Both are partial so the
    // two adapters never collide on each other's identity. (Enforced in the
    // migration as partial unique indexes; see rls.sql / 0013.)
    index('documents_org_project_status_idx').on(t.orgId, t.projectId, t.status),
    index('documents_source_idx').on(t.projectId, t.source, t.sourceId),
  ],
);

/**
 * Durable document-indexing jobs (O-23), the same claim/lease pattern as
 * run_jobs (O-21/O-22): a cloud upload enqueues a job that the worker claims
 * atomically and executes, so indexing never depends on the browser staying
 * open and survives a worker restart. One live job per document at a time.
 */
export const documentJobs = pgTable(
  'document_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    status: documentJobStatusEnum('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    leasedUntil: timestamp('leased_until', { withTimezone: true }),
    lastError: text('last_error'),
    ...timestamps,
  },
  (t) => [
    index('document_jobs_status_idx').on(t.status),
    index('document_jobs_org_project_idx').on(t.orgId, t.projectId),
    // At most one live (queued|running) job per document — idempotent enqueue.
    uniqueIndex('document_jobs_one_live_uq')
      .on(t.documentId)
      .where(sql`status in ('queued','running')`),
  ],
);

/**
 * The searchable unit. Each chunk carries a Postgres `tsvector` (generated in
 * the migration, not here — Drizzle has no first-class tsvector column) that
 * retrieval ranks with ts_rank. Isolation is by org_id+project_id like every
 * tenant table (D-008); the retrieval read re-asserts tenancy exactly as
 * loadApprovedContext does.
 */
export const documentChunks = pgTable(
  'document_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    /** 0-based position within the document, for stable ordering + display. */
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    ...timestamps,
  },
  (t) => [
    index('document_chunks_org_project_idx').on(t.orgId, t.projectId),
    index('document_chunks_document_idx').on(t.documentId),
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

/**
 * Standing work (Sprint 8, Continuous Operations): human-authored recurring
 * assignments. Each due tick creates exactly ONE ordinary task+run through
 * the existing engine — budget gate, rate limits, review, approval queue all
 * apply unchanged. A schedule can never fan out or self-modify; disabling is
 * the kill switch and deletion is not offered (history references it).
 */
export const taskSchedules = pgTable(
  'task_schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    objectiveId: uuid('objective_id').references(() => objectives.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    /** The recurring brief, verbatim — same injection posture as task input. */
    input: text('input').notNull(),
    providerSelection: providerSelectionEnum('provider_selection').notNull(),
    reviewEnabled: boolean('review_enabled').notNull().default(true),
    modelTier: modelTierEnum('model_tier').notNull().default('standard'),
    flagshipCategory: flagshipCategoryEnum('flagship_category'),
    cadence: cadenceEnum('cadence').notNull(),
    /** UTC hour 0–23 the run is due. */
    atHour: integer('at_hour').notNull().default(6),
    /** 0=Sunday…6=Saturday; weekly cadence only. */
    weekday: integer('weekday'),
    /** 1–28; monthly cadence only (capped so every month qualifies). */
    monthday: integer('monthday'),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => profiles.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [
    index('task_schedules_due_idx').on(t.enabled, t.nextRunAt),
    index('task_schedules_org_project_idx').on(t.orgId, t.projectId),
    index('task_schedules_objective_idx').on(t.objectiveId),
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
    /** Set when this task was created by standing work (Sprint 8). */
    scheduleId: uuid('schedule_id').references(() => taskSchedules.id, { onDelete: 'set null' }),
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

/**
 * Task dependencies (O-18): explicit workflow structure, NOT inferred. One
 * canonical directed edge per row — the prerequisite must complete before the
 * dependent. "blocked by" / "successor" are the reverse reading, derived, never
 * stored. Both endpoints carry org_id + project_id (D-008) and the pair is
 * unique; a self-edge is rejected by a CHECK added in the migration.
 */
export const taskDependencies = pgTable(
  'task_dependencies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    prerequisiteTaskId: uuid('prerequisite_task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    dependentTaskId: uuid('dependent_task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    kind: dependencyKindEnum('kind').notNull().default('prerequisite'),
    createdBy: uuid('created_by').references(() => profiles.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('task_dependencies_edge_uq').on(t.projectId, t.prerequisiteTaskId, t.dependentTaskId),
    index('task_dependencies_dependent_idx').on(t.projectId, t.dependentTaskId),
    index('task_dependencies_prerequisite_idx').on(t.projectId, t.prerequisiteTaskId),
  ],
);

/**
 * Decision Memory (O-19): approved operational/creative conclusions the org
 * remembers across tasks. Structured memory only — never full prompts or
 * transcripts. `superseded_by` self-references the replacement; the reverse
 * ("what did this decision replace") is derived by querying superseded_by.
 */
export const decisions = pgTable(
  'decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    rationale: text('rationale').notNull().default(''),
    /** Structured references (document paths, objective/task ids) — not transcripts. */
    supportingRefs: jsonb('supporting_refs').$type<string[]>().notNull().default([]),
    originatingTaskId: uuid('originating_task_id').references(() => tasks.id, {
      onDelete: 'set null',
    }),
    originatingRunId: uuid('originating_run_id'),
    /** Human author profile, when a person made it. */
    authorId: uuid('author_id').references(() => profiles.id, { onDelete: 'set null' }),
    /** Display name of who made it (human or AI employee). */
    authorLabel: text('author_label').notNull(),
    decisionType: decisionTypeEnum('decision_type').notNull().default('operational'),
    status: decisionStatusEnum('status').notNull().default('proposed'),
    supersededBy: uuid('superseded_by'),
    // AI-suggested candidates (O-20). Null suggested_by_run_id ⇒ human-filed;
    // set ⇒ a model suggestion from that run, awaiting human review.
    suggestedByRunId: uuid('suggested_by_run_id'),
    suggestionConfidence: decisionConfidenceEnum('suggestion_confidence'),
    suggestionReason: text('suggestion_reason'),
    reviewedBy: uuid('reviewed_by').references(() => profiles.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('decisions_org_project_status_idx').on(t.orgId, t.projectId, t.status),
    index('decisions_originating_task_idx').on(t.originatingTaskId),
    index('decisions_superseded_by_idx').on(t.supersededBy),
  ],
);

/**
 * Durable run jobs (O-21). A job is a request to execute a task's run,
 * persisted so execution survives a browser close / terminal exit / process
 * restart. A worker claims a job atomically (FOR UPDATE SKIP LOCKED + a lease),
 * so no two processes execute the same task and no provider sequence is billed
 * twice. Reconciliation reclaims jobs whose lease expired.
 */
export const runJobs = pgTable(
  'run_jobs',
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
    status: runJobStatusEnum('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(1),
    /** Held by the worker currently executing; expiry allows reclaim. */
    leasedUntil: timestamp('leased_until', { withTimezone: true }),
    lastError: text('last_error'),
    ...timestamps,
  },
  (t) => [
    // One live job per task: prevents a duplicate enqueue from double-running.
    uniqueIndex('run_jobs_active_task_uq')
      .on(t.taskId)
      .where(sql`status in ('queued','running')`),
    index('run_jobs_claimable_idx').on(t.status, t.leasedUntil),
    index('run_jobs_org_project_idx').on(t.orgId, t.projectId),
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
    /** Project-folder chunks retrieved for this run (D-020 transparency). */
    retrievedDocuments: jsonb('retrieved_documents').$type<RetrievedDocRef[]>(),
    /** The full assembled context package, grouped by why each part was included (O-14). */
    contextManifest: jsonb('context_manifest').$type<ContextManifestEntry[]>(),
    /** Decision-candidate extraction outcome (O-20); makes extraction idempotent. */
    candidateExtractionStatus: extractionStatusEnum('candidate_extraction_status'),
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
