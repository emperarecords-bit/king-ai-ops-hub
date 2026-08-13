import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  type ContextManifestEntry,
  type DispatchKind,
  type ExecutorAttemptState,
  type ExecutorExecutionState,
  type ExecutorReconciliationState,
  type ReliabilityState,
  type RetrievedDocRef,
  type ReviewDetail,
  type RunSourceSnapshot,
  type SuccessCriterion,
} from '@/types/domain';
import {
  actionTypeEnum,
  agentRoleEnum,
  approvalStatusEnum,
  artifactKindEnum,
  cadenceEnum,
  decisionApplicabilityEnum,
  decisionConfidenceEnum,
  decisionScopeEnum,
  decisionStatusEnum,
  decisionTypeEnum,
  dependencyKindEnum,
  extractionStatusEnum,
  documentKindEnum,
  documentStatusEnum,
  retrievalModeEnum,
  documentSourceEnum,
  documentJobStatusEnum,
  documentIndexStatusEnum,
  contentFidelityEnum,
  contextItemStatusEnum,
  flagshipCategoryEnum,
  knowledgeKindEnum,
  knowledgeDisclosureEnum,
  knowledgeEpistemicBasisEnum,
  knowledgeScopeEnum,
  knowledgeScopeKindEnum,
  knowledgeSourceEnum,
  knowledgeStatusEnum,
  knowledgeVerificationEnum,
  messageRoleEnum,
  milestoneStatusEnum,
  modelTierEnum,
  objectiveStatusEnum,
  workItemConditionEnum,
  orgRoleEnum,
  projectRoleEnum,
  dataClassificationEnum,
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
    /** Server-authoritative document-retrieval mode (Documents increment 1, Stage C2). Defaults to
     *  `legacy`; an operator advances a workspace to `shadow` then `versioned`. Never client-supplied. */
    retrievalMode: retrievalModeEnum('retrieval_mode').notNull().default('legacy'),
    archived: boolean('archived').notNull().default(false),
    /** Slice 1: the employee responsible for this project ("who owns this?").
     *  Human membership + roles stay in project_members; this is the employee
     *  the org chart holds accountable. Nullable. */
    ownerAgentId: uuid('owner_agent_id').references((): AnyPgColumn => agents.id, {
      onDelete: 'set null',
    }),
    /** HUB-009 — genuine vs demonstration vs fixture data. A whole demo/seed workspace classifies all its
     *  children effectively non-live (seed > demo > live). Default live; never inferred from key/name. */
    classification: dataClassificationEnum('classification').notNull().default('live'),
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
    /** Business role/title (Slice 1): "CEO", "CMO", "Sales Manager". Free text —
     *  the org chart is descriptive, not an enum, so businesses vary freely.
     *  `role` above stays the TECHNICAL pipeline position (primary/reviewer). */
    title: text('title'),
    /** D-015: every employee belongs to a department. Nullable until backfilled. */
    departmentId: uuid('department_id').references(() => departments.id, {
      onDelete: 'set null',
    }),
    /** Slice 1 reporting line: this employee's manager. Self-referential, nullable
     *  (the CEO reports to nobody). Descriptive only — no routing/delegation. */
    reportsToId: uuid('reports_to_id').references((): AnyPgColumn => agents.id, {
      onDelete: 'set null',
    }),
    provider: providerIdEnum('provider').notNull(),
    model: text('model').notNull(),
    systemPrompt: text('system_prompt').notNull(),
    /** Optional reviewer-specific criteria. Application + DB enforce an 8192 UTF-8 byte ceiling. */
    reviewRubric: text('review_rubric'),
    /** Stored x1000 to keep it integral: 700 = 0.7 */
    temperatureMilli: integer('temperature_milli').notNull().default(700),
    maxOutputTokens: integer('max_output_tokens').notNull().default(4096),
    enabled: boolean('enabled').notNull().default(true),
    /** HUB-009 — a demo/seed AGENT makes the activity it performs non-live, without the agent itself being
     *  reclassified when it performs live work. Default live. */
    classification: dataClassificationEnum('classification').notNull().default('live'),
    ...timestamps,
  },
  (t) => [
    index('agents_org_project_idx').on(t.orgId, t.projectId),
    uniqueIndex('agents_project_name_uq').on(t.projectId, t.name),
    // P1a agent pinning — a tenant-bound candidate key so tasks/runs/task_schedules can bind COMPOSITE
    // foreign keys on (org_id, project_id, agent_id) → agents(org_id, project_id, id). id is already the
    // primary key (globally unique), so this is additive/safe; its purpose is to make an agent reference
    // enforce SAME-workspace by construction (a non-null agent id can never point across tenants).
    unique('agents_tenant_id_uq').on(t.orgId, t.projectId, t.id),
    check('agents_review_rubric_bytes_ck', sql`${t.reviewRubric} is null or octet_length(${t.reviewRubric}) <= 8192`),
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
    // Trustworthiness model. Epistemic basis = how it was FORMED (default: a human wrote it).
    epistemicBasis: knowledgeEpistemicBasisEnum('epistemic_basis').notNull().default('human_asserted'),
    // Verification = what review occurred, SEPARATE from activation (default: none).
    verification: knowledgeVerificationEnum('verification').notNull().default('unverified'),
    /** When the content was considered current; when it was last verified; when to review; when it expires. */
    asOf: timestamp('as_of', { withTimezone: true }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    reviewAfter: timestamp('review_after', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    // Applicability boundary + concrete target (workspace scope needs no target).
    scopeKind: knowledgeScopeKindEnum('scope_kind').notNull().default('workspace'),
    scopeTaskId: uuid('scope_task_id').references(() => tasks.id, { onDelete: 'set null' }),
    scopeObjectiveId: uuid('scope_objective_id').references(() => objectives.id, { onDelete: 'set null' }),
    // Enforceable disclosure classification. `restricted` is withheld by default (grants are future).
    disclosure: knowledgeDisclosureEnum('disclosure').notNull().default('workspace_internal'),
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
 * The honest reverse trail for Knowledge: one row each time a knowledge item VERSION was injected
 * into a run (not merely eligible, and not proof it influenced the result). Stores the exact rendered
 * text supplied — an immutable snapshot, so a later revision can't rewrite what a past run received.
 * `reason` records why it was eligible. Idempotent per (run, knowledge_item).
 */
export const knowledgeInjections = pgTable(
  'knowledge_injections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    knowledgeItemId: uuid('knowledge_item_id').notNull().references(() => knowledgeItems.id, { onDelete: 'cascade' }),
    /** The exact version supplied, so the trail is pinned to what the consumer received. */
    version: integer('version').notNull(),
    /** The AI consumer that received it — every consumer leaves the same record. 'task_run' |
     *  'objective_suggestion' | future operation types. */
    consumerType: text('consumer_type').notNull().default('task_run'),
    /** The consumer's stable id (a run id for a task run; a per-call operation id for a suggestion). */
    consumerId: uuid('consumer_id'),
    /** Task-run context (kept for convenience); null for consumers that are not a task run. */
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    /** Why it was eligible (with matched terms): e.g. 'subject: postgres, schema'. */
    reason: text('reason').notNull(),
    /** Immutable snapshot of the exact rendered text supplied to the AI. */
    memoryText: text('memory_text'),
    /** Immutable trust snapshot AT DISPATCH — epistemic basis, verification, freshness, provenance,
     *  use-state, scope, disclosure, intended use, relied/supplemental source ids, per-source
     *  resolution, support-judgment id, rendering-format version. Explains a past dispatch without
     *  recomputing from today's records; never rewritten by later events. */
    trustSnapshot: jsonb('trust_snapshot'),
    injectedAt: timestamp('injected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('knowledge_injections_item_idx').on(t.knowledgeItemId),
    index('knowledge_injections_org_project_idx').on(t.orgId, t.projectId),
    // Idempotent per (consumer, item): one application per operation, so a retry can't double-count.
    uniqueIndex('knowledge_injections_consumer_item_uq').on(t.consumerType, t.consumerId, t.knowledgeItemId),
  ],
);

/**
 * Version-specific provenance: the sources a particular Knowledge item VERSION derives from. Immutable
 * once the version is active/applied — a changed source/version/locator/transformation requires a new
 * Knowledge version (enforced in the domain). Only resolvable source types (document/artifact); a
 * manual assertion legitimately has no rows here. The exact cited version (`sourceVersionHash`) is
 * preserved so a citation is never resolved to the latest.
 */
export const knowledgeSources = pgTable(
  'knowledge_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    knowledgeItemId: uuid('knowledge_item_id').notNull().references(() => knowledgeItems.id, { onDelete: 'cascade' }),
    knowledgeVersion: integer('knowledge_version').notNull(),
    sourceType: text('source_type').notNull(), // 'document' | 'artifact'
    /** Resolvable identifier: a document's relativePath, or an artifact id. */
    sourceRef: text('source_ref').notNull(),
    sourceLabel: text('source_label').notNull(),
    /** Exact cited version — a document's sha256; null for immutable artifacts. */
    sourceVersionHash: text('source_version_hash'),
    /** Durable pointer to the immutable Document Version cited (document sources). Null for artifacts,
     *  and for a legacy citation whose exact version was overwritten before versioning existed — such a
     *  citation keeps its path+hash and resolves "exact version unavailable", never bound to another
     *  version merely because the path matches. */
    documentVersionId: uuid('document_version_id').references(() => documentVersions.id, { onDelete: 'set null' }),
    sourceDate: timestamp('source_date', { withTimezone: true }),
    transformation: text('transformation').notNull(), // quoted | extracted | summarized | inferred
    locator: text('locator'),
    addedBy: uuid('added_by').references(() => profiles.id, { onDelete: 'set null' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('knowledge_sources_item_version_idx').on(t.knowledgeItemId, t.knowledgeVersion)],
);

/**
 * Append-only support-judgment events. A judgment SNAPSHOTS the sources relied upon and their
 * resolution at verification time, so a later resolution failure never rewrites the historical
 * judgment (it only limits present reliance). The only path to `source_supported`.
 */
export const knowledgeVerificationEvents = pgTable(
  'knowledge_verification_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    knowledgeItemId: uuid('knowledge_item_id').notNull().references(() => knowledgeItems.id, { onDelete: 'cascade' }),
    knowledgeVersion: integer('knowledge_version').notNull(),
    judgment: text('judgment').notNull(), // 'source_supported' | 'human_confirmed' | 'disputed' | 'inspected'
    verifier: uuid('verifier').references(() => profiles.id, { onDelete: 'set null' }),
    /** The source-relationship ids the judgment relied upon (jsonb string[]). */
    reliedOnSourceIds: jsonb('relied_on_source_ids').$type<string[]>().notNull().default([]),
    /** Per-relied-source resolution outcome AT verification time (jsonb {sourceId: outcome}). */
    resolutionSnapshot: jsonb('resolution_snapshot').notNull().default({}),
    rationale: text('rationale'),
    limitations: text('limitations'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('knowledge_verification_events_item_version_idx').on(t.knowledgeItemId, t.knowledgeVersion)],
);

/**
 * Enforceable disclosure grants. A `restricted` Knowledge item is withheld from every consumer UNLESS
 * a live grant authorizes it for a SPECIFIC agent and a SPECIFIC purpose (intended use) within an
 * explicit validity window. This is the only path by which restricted Knowledge reaches a prompt.
 * Grants are revocable (revoke is a first-class, audited decision — not a delete), and a supplied
 * restricted disclosure records the authorizing grant id into its application trust snapshot, so a past
 * disclosure is always explainable. A grant is LIVE when: not revoked AND granted_at <= now < expires_at.
 */
export const knowledgeDisclosureGrants = pgTable(
  'knowledge_disclosure_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    /** Subject: the restricted item this grant authorizes. */
    knowledgeItemId: uuid('knowledge_item_id').notNull().references(() => knowledgeItems.id, { onDelete: 'cascade' }),
    /** Consumer: the specific agent permitted to receive it. */
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    /** The agent's MATERIAL execution fingerprint at grant time. A grant authorizes disclosure only
     *  while the agent's current execution profile still matches this — a reconfiguration (new provider,
     *  model, instructions, sampling, role) invalidates the grant and requires a new one. */
    agentExecutionFingerprint: text('agent_execution_fingerprint').notNull(),
    /** Purpose: the intended use granted (a KnowledgeUseIntent). Must match the consumer's derived use. */
    purpose: text('purpose').notNull(),
    rationale: text('rationale'),
    grantedBy: uuid('granted_by').references(() => profiles.id, { onDelete: 'set null' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    /** Explicit period end — a grant without an expiry is not a grant; an expired grant is no grant. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => profiles.id, { onDelete: 'set null' }),
    revokeReason: text('revoke_reason'),
  },
  (t) => [
    index('knowledge_disclosure_grants_item_idx').on(t.knowledgeItemId),
    index('knowledge_disclosure_grants_lookup_idx').on(t.projectId, t.purpose, t.knowledgeItemId, t.agentId),
  ],
);

/**
 * Enforceable disclosure grants for restricted DOCUMENTS (Documents increment 1, Stage C2). The exact
 * analogue of `knowledge_disclosure_grants`, keyed by document: a restricted Document's chunks reach an
 * AI consumer's prompt ONLY when every consuming agent holds a live grant for the operation's derived
 * purpose AND still matches the execution fingerprint the grant was bound to. Revocation is audited, never
 * a delete. Without a grant, restricted Document content is withheld inside retrieval — it never crosses
 * the retrieval boundary.
 */
export const documentDisclosureGrants = pgTable(
  'document_disclosure_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    /** Subject: the restricted Document this grant authorizes. */
    documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
    /** Consumer: the specific agent permitted to receive it. */
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    /** The agent's MATERIAL execution fingerprint at grant time; a reconfiguration invalidates the grant. */
    agentExecutionFingerprint: text('agent_execution_fingerprint').notNull(),
    /** Purpose: the intended use granted (a KnowledgeUseIntent). Must match the consumer's derived use. */
    purpose: text('purpose').notNull(),
    rationale: text('rationale'),
    grantedBy: uuid('granted_by').references(() => profiles.id, { onDelete: 'set null' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => profiles.id, { onDelete: 'set null' }),
    revokeReason: text('revoke_reason'),
  },
  (t) => [
    index('document_disclosure_grants_doc_idx').on(t.documentId),
    index('document_disclosure_grants_lookup_idx').on(t.projectId, t.purpose, t.documentId, t.agentId),
  ],
);

/**
 * AI-proposed Knowledge — the quarantine record for the extraction/promotion path. The AI may only
 * PROPOSE: extraction creates a DRAFT knowledge_item (conservative ACTUAL values) plus one of these
 * rows holding the AI's SUGGESTED values and the extraction provenance. Suggested values live here,
 * physically separate from the operator's actual choices on the item — a promotion cannot silently
 * inherit them. `reviewStatus` is the proposal's own lifecycle (pending → promoted | rejected),
 * distinct from the item's draft/active lifecycle. A rejected proposal is preserved, never deleted.
 */
export const knowledgeProposals = pgTable(
  'knowledge_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    /** The quarantined draft this proposal produced. */
    knowledgeItemId: uuid('knowledge_item_id').notNull().references(() => knowledgeItems.id, { onDelete: 'cascade' }),
    /** Extraction provenance: the run whose output was mined, the durable extraction operation, model. */
    suggestedByRunId: uuid('suggested_by_run_id').references(() => runs.id, { onDelete: 'set null' }),
    extractionOperationId: uuid('extraction_operation_id').references(() => aiOperations.id, { onDelete: 'set null' }),
    provider: text('provider'),
    model: text('model'),
    promptVersion: text('prompt_version').notNull(),
    /** The AI's own confidence + one-line reason — evidence for the reviewer, NEVER authority. */
    confidence: text('confidence').notNull().default('low'),
    reason: text('reason'),
    /** SUGGESTED values (the AI's proposal) — separate from the item's actual columns. */
    suggestedScopeKind: knowledgeScopeKindEnum('suggested_scope_kind').notNull().default('workspace'),
    suggestedScopeTaskId: uuid('suggested_scope_task_id').references(() => tasks.id, { onDelete: 'set null' }),
    suggestedScopeObjectiveId: uuid('suggested_scope_objective_id').references(() => objectives.id, { onDelete: 'set null' }),
    suggestedDisclosure: knowledgeDisclosureEnum('suggested_disclosure').notNull().default('workspace_internal'),
    suggestedAsOf: timestamp('suggested_as_of', { withTimezone: true }),
    suggestedReviewAfter: timestamp('suggested_review_after', { withTimezone: true }),
    suggestedExpiresAt: timestamp('suggested_expires_at', { withTimezone: true }),
    /** Proposal lifecycle, distinct from the item's: pending | promoted | rejected. */
    reviewStatus: text('review_status').notNull().default('pending'),
    reviewedBy: uuid('reviewed_by').references(() => profiles.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    rejectionReason: text('rejection_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('knowledge_proposals_item_idx').on(t.knowledgeItemId),
    index('knowledge_proposals_review_idx').on(t.projectId, t.reviewStatus),
  ],
);

/**
 * A durable record of an AI operation that is NOT a task run (e.g. objective suggestion), so that
 * every AI use of Knowledge belongs to an inspectable operation rather than an ephemeral correlation
 * value. Recorded before provider dispatch; its status advances to completed/failed. An
 * `idempotencyKey` lets the same logical retry reuse the same operation identity; a new request
 * creates a new one. `knowledge_injections.consumerId` points here for non-run consumers.
 */
export const aiOperations = pgTable(
  'ai_operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    operationType: text('operation_type').notNull(),
    /** What the operation concerned (e.g. 'objective_draft'); id is polymorphic, not an FK. */
    subjectType: text('subject_type'),
    subjectId: uuid('subject_id'),
    /** Stable logical-request key — the same retry reuses the same operation; null = each call distinct. */
    idempotencyKey: text('idempotency_key'),
    status: text('status').notNull().default('dispatched'), // dispatched | completed | failed
    provider: text('provider'),
    model: text('model'),
    /** The Knowledge-use purpose DERIVED from this operation's type (a KnowledgeUseIntent), recorded so
     *  a caller can never relabel an operation to obtain Knowledge under looser rules. Server-derived. */
    knowledgePurpose: text('knowledge_purpose'),
    contextHash: text('context_hash'),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    resultRef: uuid('result_ref'),
    /** The operation's result payload, so a replay of the same key returns it without re-dispatching. */
    resultData: jsonb('result_data'),
    /** Attempt counter — a retry under the same logical operation increments this. */
    attempt: integer('attempt').notNull().default(1),
    error: text('error'),
    retryOf: uuid('retry_of'),
    createdBy: uuid('created_by').references(() => profiles.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    index('ai_operations_org_project_type_idx').on(t.orgId, t.projectId, t.operationType),
    // Idempotency: one operation per (project, type, key). NULL keys are distinct, so keyless calls
    // never collide.
    uniqueIndex('ai_operations_idempotency_uq').on(t.projectId, t.operationType, t.idempotencyKey),
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
    /** Disclosure classification of the source itself. Knowledge DERIVED from this document may be no
     *  less restrictive than this (sensitivity is inherited, never laundered). Defaults to
     *  workspace_internal; an operator marks a document `restricted` to quarantine what it produces. */
    disclosure: knowledgeDisclosureEnum('disclosure').notNull().default('workspace_internal'),
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
    // ---- Immutable version model (Documents increment 1, additive) ----------
    /** Pointer to the current SUCCESSFULLY-INDEXED version used for normal retrieval. Never repointed to
     *  a pending/failed version. Not a hard FK (documents↔document_versions form a cycle); integrity is
     *  enforced in the domain + checked on backfill. */
    currentVersionId: uuid('current_version_id'),
    /** Last time ingestion observed this source (same-content refresh + disappearance behavior). */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    /** Set when a Document was archived by an EXPLICIT operator action (adapter-neutral archive) — as
     *  opposed to the implicit disappearance-archive a folder refresh performs when a source file vanishes.
     *  A normal refresh reactivates a reappeared disappearance-archived source, but NEVER silently restores
     *  one an operator intentionally archived (this flag set); restoring that requires the explicit action. */
    archivedIntentAt: timestamp('archived_intent_at', { withTimezone: true }),
    /** Set when an operator explicitly asks to restore an intentionally-archived Document. A normal folder
     *  refresh never reactivates an archived Document on its own; it only completes the restore of one that
     *  carries this intent (then clears it). Null for a Document that was never archived or whose restore
     *  has completed. Adapter-neutral: cloud restore completes immediately and never persists this. */
    restoreRequestedAt: timestamp('restore_requested_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // local_folder keeps path-uniqueness; cloud_upload is keyed by (source_id),
    // so "different source, same filename" cannot merge. Both are partial so the
    // two adapters never collide on each other's identity. (Enforced in the
    // migration as partial unique indexes; see rls.sql / 0013.)
    index('documents_org_project_status_idx').on(t.orgId, t.projectId, t.status),
    index('documents_source_idx').on(t.projectId, t.source, t.sourceId),
    index('documents_current_version_idx').on(t.currentVersionId),
  ],
);

/**
 * A DOCUMENT VERSION — one immutable content state of a logical Document. "A Document identifies the
 * source; a Document Version identifies the evidence." Content and hash never change once inserted.
 * Raw bytes for every NEW version are retained under a content-addressed object key; legacy local
 * versions carry `contentFidelity='reconstructed_text'` (chunks only, no original bytes). A `failed`
 * version is retained (with bytes + error) but never becomes a Document's current version. Uniqueness
 * on (documentId, sha256) enforces same-content idempotency within one logical source.
 */
export const documentVersions = pgTable(
  'document_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
    sha256: text('sha256').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    mimeType: text('mime_type'),
    /** Immutable content-addressed object key (projects/{p}/documents/{d}/versions/{sha256}); null only
     *  for a legacy local version whose original bytes were never retained (reconstructed_text). */
    objectKey: text('object_key'),
    contentFidelity: contentFidelityEnum('content_fidelity').notNull().default('unavailable'),
    /** The source's own revision id, when the adapter supplies one. */
    sourceRevisionId: text('source_revision_id'),
    sourceModifiedAt: timestamp('source_modified_at', { withTimezone: true }),
    /** The trustworthy time the SOURCE MATERIAL genuinely changed — set only when this version was created
     *  by a real ingestion observation (a new/changed source hash), preferring the source's own modified
     *  time and falling back to the observation time. NULL for a version created by infrastructure backfill
     *  / migration: creating a retained version row is not a business-source change, so a migration must
     *  never make a Document look recently changed. The "recently changed" lens reads only this column. */
    sourceChangeAt: timestamp('source_change_at', { withTimezone: true }),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }),
    indexedAt: timestamp('indexed_at', { withTimezone: true }),
    indexStatus: documentIndexStatusEnum('index_status').notNull().default('pending'),
    errorMessage: text('error_message'),
    /** Classification recorded AT INGEST — a historical fact, never rewritten by a later reclassification. */
    disclosureSnapshot: knowledgeDisclosureEnum('disclosure_snapshot').notNull().default('workspace_internal'),
    parserVersion: text('parser_version'),
    /** The ingestion operation that created this version (audit/provenance). */
    ingestionOperationId: uuid('ingestion_operation_id'),
    /** The DERIVED index (chunks) is untrustworthy — the source bytes remain inspectable but chunk-level
     *  evidence cannot be reproduced identically. Set by repair when a faithful rebuild cannot be proven;
     *  never rewrites historical chunk text. Not part of the immutable content-identity facts. */
    indexDegraded: boolean('index_degraded').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('document_versions_document_idx').on(t.documentId),
    // Same-content idempotency for RETRIEVABLE versions. Partial: `unavailable` placeholders are excluded
    // so an unavailable version (which records an expected hash it never verified) and a later real
    // byte_exact version of the SAME hash can coexist — that is how a disconnected source reconnects
    // (the placeholder is preserved; a verified version is added) without a uniqueness collision.
    uniqueIndex('document_versions_document_sha_uq').on(t.documentId, t.sha256).where(sql`content_fidelity <> 'unavailable'`),
    // The complementary guard: at most ONE `unavailable` placeholder per (document, expected hash), so a
    // concurrent or defective writer that bypasses service-level idempotency cannot create duplicate
    // placeholders. Net invariant: ≤1 unavailable placeholder + ≤1 retained version per (doc, hash), and
    // the two may coexist.
    uniqueIndex('document_versions_document_sha_unavailable_uq').on(t.documentId, t.sha256).where(sql`content_fidelity = 'unavailable'`),
  ],
);

/**
 * Purge tombstone (Documents increment 1, Stage D). A privileged purge deletes a version row, its chunks,
 * and (if unshared) its object; this immutable record survives so the identity of what was destroyed —
 * and who authorized it — is auditable forever. Not an FK to document_versions (that row is gone).
 */
export const documentVersionTombstones = pgTable(
  'document_version_tombstones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    /** The purged version's id + document + content identity, retained for audit. */
    versionId: uuid('version_id').notNull(),
    documentId: uuid('document_id').notNull(),
    sha256: text('sha256').notNull(),
    contentFidelity: text('content_fidelity').notNull(),
    objectKey: text('object_key'),
    objectDeleted: boolean('object_deleted').notNull().default(false),
    /** Two-phase lifecycle: DB revocation is authoritative (phase 1); object cleanup is restartable
     *  (phase 2). `object_cleanup_pending` → `completed` | `completed_object_retained_shared`. */
    status: text('status').notNull().default('object_cleanup_pending'),
    /** The retention assessment snapshot at purge time (decision + blocking categories/counts). */
    assessment: jsonb('assessment'),
    cleanupError: text('cleanup_error'),
    cleanupAttempts: integer('cleanup_attempts').notNull().default(0),
    reason: text('reason'),
    purgedBy: uuid('purged_by').references(() => profiles.id, { onDelete: 'set null' }),
    purgedAt: timestamp('purged_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('document_version_tombstones_version_uq').on(t.versionId),
    index('document_version_tombstones_doc_idx').on(t.documentId),
  ],
);

/**
 * Legacy-object cleanup operations — the persisted lifecycle for deleting a storage object that is proven
 * obsolete and unreferenced (an orphan left by a failed/rolled-back upload). Deletion of an external object
 * cannot be rolled back through a DB transaction, so the lifecycle is explicit and restartable:
 *   proposed → authorized → deleted | failed
 * A proposal records the exact object identity (size + content hash) and starts a QUIET period; authorization
 * re-checks that the key stayed continuously orphaned (closing the upload put-before-commit window), that
 * ingestion is quiescent, and that the object identity still matches, before the external delete. This table
 * NEVER deletes a document/version/tombstone row — cleanup is strictly separate from purge.
 */
export const objectCleanupOperations = pgTable(
  'object_cleanup_operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    /** The exact tenant-scoped storage key proposed for cleanup. */
    objectKey: text('object_key').notNull(),
    /** Identity binding captured at proposal — never object bytes. */
    objectSize: integer('object_size'),
    objectSha256: text('object_sha256'),
    /** sha256(objectKey|size|sha256) — the exact state a later authorize/delete rebinds to (constraint #5). */
    fingerprint: text('fingerprint').notNull(),
    /** proposed → authorized → deleted | failed | aborted. */
    status: text('status').notNull().default('proposed'),
    objectDeleted: boolean('object_deleted').notNull().default(false),
    /** Snapshot of the reference checks performed (categories + counts; never restricted content or bytes). */
    referencesChecked: jsonb('references_checked'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    reason: text('reason'),
    proposedBy: uuid('proposed_by').references(() => profiles.id, { onDelete: 'set null' }),
    authorizedBy: uuid('authorized_by').references(() => profiles.id, { onDelete: 'set null' }),
    proposedAt: timestamp('proposed_at', { withTimezone: true }).notNull().defaultNow(),
    authorizedAt: timestamp('authorized_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // At most one LIVE (proposed|authorized) operation per key — idempotent proposal, no double-delete race.
    uniqueIndex('object_cleanup_operations_live_key_uq').on(t.orgId, t.projectId, t.objectKey).where(sql`status in ('proposed','authorized')`),
    index('object_cleanup_operations_org_project_idx').on(t.orgId, t.projectId),
    index('object_cleanup_operations_status_idx').on(t.status),
  ],
);

/**
 * Document purge operations — the persisted, staged lifecycle for the deliberate, IRREVERSIBLE removal of a
 * document and its retained representations. Purge is admin-authorized, one document at a time, and always
 * passes through a visible retention/quarantine window during which it can be cancelled and the bytes are
 * still restorable. Database removal (authoritative) and external-object deletion are separate, independently
 * observable phases. `document_id` is a PLAIN uuid (not an FK) so this operation row — the evidence trail —
 * survives the document's own deletion.
 *   proposed → authorized → quarantined → retention_elapsed → database_purged → object_cleanup_pending →
 *   completed | failed ; cancelled is terminal from any pre-database_purged state.
 */
export const documentPurgeOperations = pgTable(
  'document_purge_operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    /** The target document — plain uuid so the operation outlives the purge of its own document row. */
    documentId: uuid('document_id').notNull(),
    status: text('status').notNull().default('proposed'),
    /** Frozen enumerated purge scope + blocker snapshot captured at proposal (ids/counts/hashes — never content). */
    scope: jsonb('scope'),
    /** sha256 over the exact document + version-set + reference-closure + disclosure + object identity. */
    fingerprint: text('fingerprint').notNull(),
    /** Retention/quarantine window: configurable duration + the exact deadline before execution is permitted. */
    retentionMs: integer('retention_ms'),
    retentionUntil: timestamp('retention_until', { withTimezone: true }),
    /** External-object deletion progress (the DB purge is authoritative and committed before any of this). */
    objectsTotal: integer('objects_total').notNull().default(0),
    objectsDeleted: integer('objects_deleted').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    reason: text('reason'),
    proposedBy: uuid('proposed_by').references(() => profiles.id, { onDelete: 'set null' }),
    authorizedBy: uuid('authorized_by').references(() => profiles.id, { onDelete: 'set null' }),
    cancelledBy: uuid('cancelled_by').references(() => profiles.id, { onDelete: 'set null' }),
    proposedAt: timestamp('proposed_at', { withTimezone: true }).notNull().defaultNow(),
    authorizedAt: timestamp('authorized_at', { withTimezone: true }),
    databasePurgedAt: timestamp('database_purged_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // At most one LIVE purge operation per document (anything not yet terminal).
    uniqueIndex('document_purge_operations_live_doc_uq').on(t.orgId, t.projectId, t.documentId).where(sql`status not in ('completed','failed','cancelled')`),
    index('document_purge_operations_org_project_idx').on(t.orgId, t.projectId),
    index('document_purge_operations_status_idx').on(t.status),
  ],
);

/**
 * Normalized run→version references — the referentially-safe complement to the immutable JSON
 * `runs.retrieved_sources` snapshot. "Historical prompt snapshots preserve representation; normalized
 * references preserve integrity." Used for reverse trails, retention/purge checks, and usage queries.
 */
export const runDocumentVersions = pgTable(
  'run_document_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
    documentVersionId: uuid('document_version_id').notNull().references(() => documentVersions.id, { onDelete: 'restrict' }),
    /** Retrieval unit within the version (nullable when whole-doc). -1 sentinel avoids NULL in the uq. */
    chunkIndex: integer('chunk_index').notNull().default(-1),
    retrievalReason: text('retrieval_reason'),
    /** The relevance score (Postgres `ts_rank`, a float4) the run saw for this unit; null for whole-doc /
     *  core references. Context metadata — the integrity relationship is the row itself. */
    rank: real('rank'),
    disclosureSnapshot: knowledgeDisclosureEnum('disclosure_snapshot').notNull().default('workspace_internal'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('run_document_versions_run_idx').on(t.runId),
    index('run_document_versions_version_idx').on(t.documentVersionId),
    uniqueIndex('run_document_versions_uq').on(t.runId, t.documentVersionId, t.chunkIndex),
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
    /** The immutable version these chunks belong to. Nullable during backfill; every new chunk is
     *  version-scoped. Reindexing a new version creates NEW chunks — a version's chunks are never
     *  edited or replaced once it is active or referenced. */
    documentVersionId: uuid('document_version_id').references(() => documentVersions.id, { onDelete: 'cascade' }),
    /** 0-based position within the document, for stable ordering + display. */
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    /** Where in the source this chunk is (section/offset), when derivable — a checkable locator. */
    locator: text('locator'),
    parserVersion: text('parser_version'),
    contentHash: text('content_hash'),
    ...timestamps,
  },
  (t) => [
    index('document_chunks_org_project_idx').on(t.orgId, t.projectId),
    index('document_chunks_document_idx').on(t.documentId),
    index('document_chunks_version_idx').on(t.documentVersionId),
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
// MCP API tokens (Phase 5). A bearer credential scoped to exactly one (org,
// project), minted by a project admin. Only the SHA-256 HASH of the secret is
// stored — never the plaintext. `prefix`/`last_four` are non-secret display
// aids. Identity binds to `created_by` (see docs/architecture/mcp-server-decision.md).
// ---------------------------------------------------------------------------

export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** SHA-256 hex of the wire secret. The plaintext is shown once at mint and never stored. */
    tokenHash: text('token_hash').notNull(),
    /** Non-secret identifier shown in listings (the characters after `kmcp_`, truncated). */
    prefix: text('prefix').notNull(),
    lastFour: text('last_four').notNull(),
    /** Allowed MCP tool names (subset of the known tools). Empty ⇒ no tool permitted. */
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    /** The project member this token acts as; a token can never exceed their access. */
    createdBy: uuid('created_by')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('api_tokens_token_hash_uq').on(t.tokenHash),
    uniqueIndex('api_tokens_project_name_uq').on(t.projectId, t.name),
    index('api_tokens_org_project_idx').on(t.orgId, t.projectId),
  ],
);

// ---------------------------------------------------------------------------
// GitHub repository links (Phase 6). The per-project binding of a GitHub App
// INSTALLATION to exactly one repository. Contains NO secret — the App
// credentials are owner-gated platform secrets that never enter the database
// (docs/architecture/github-integration-decision.md). `defaultBranch` is
// recorded at link time because the write policy must reject any write
// targeting it (branch + PR only, never a default-branch push).
// ---------------------------------------------------------------------------

export const githubRepoLinks = pgTable(
  'github_repo_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** GitHub App installation id for this org/repo — an opaque number, not a secret. */
    installationId: bigint('installation_id', { mode: 'bigint' }).notNull(),
    /** Canonical `owner/repo`. */
    repoFullName: text('repo_full_name').notNull(),
    /** The branch writes must never target (checked by the git write policy). */
    defaultBranch: text('default_branch').notNull(),
    linkedBy: uuid('linked_by')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('github_repo_links_project_repo_uq').on(t.projectId, t.repoFullName),
    index('github_repo_links_org_project_idx').on(t.orgId, t.projectId),
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
    /**
     * Frozen closure record — the durable executive conclusion when the objective became
     * terminal (completed/cancelled). Captured at the transition, not reconstructed later.
     * A cancellation reason is required; a completion may carry an optional caveat.
     */
    closedBy: uuid('closed_by').references(() => profiles.id, { onDelete: 'set null' }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closureReason: text('closure_reason'),
    /** HUB-009 — genuine vs demonstration vs fixture objective. Default live. */
    classification: dataClassificationEnum('classification').notNull().default('live'),
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
    /** P1a agent pinning — the exact employees each due tick pins its produced task to. Nullable so legacy
     *  schedules migrate cleanly; a null pin ⇒ the tick SKIPS dispatch (fail closed), never provider-derives
     *  an agent. Same-workspace enforced by the composite FKs below. */
    assignedPrimaryAgentId: uuid('assigned_primary_agent_id'),
    assignedReviewerAgentId: uuid('assigned_reviewer_agent_id'),
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
    // P1a agent pinning — composite FKs to agents (MATCH SIMPLE / RESTRICT): null skips (legacy schedules),
    // non-null is workspace-bound so a schedule can never pin a cross-workspace employee.
    foreignKey({ columns: [t.orgId, t.projectId, t.assignedPrimaryAgentId], foreignColumns: [agents.orgId, agents.projectId, agents.id], name: 'task_schedules_assigned_primary_agent_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.projectId, t.assignedReviewerAgentId], foreignColumns: [agents.orgId, agents.projectId, agents.id], name: 'task_schedules_assigned_reviewer_agent_fk' }).onDelete('restrict'),
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
    /** Hub P1d — the DETERMINISTIC occurrence identity of the schedule tick that produced this task: the
     *  schedule's due `next_run_at` at dispatch. Paired with `schedule_id` in a partial unique index so two
     *  concurrent scheduler ticks can never create two tasks for the same occurrence — the second insert
     *  conflicts and is suppressed. Null for every non-standing task. */
    scheduleOccurrenceAt: timestamp('schedule_occurrence_at', { withTimezone: true }),
    status: taskStatusEnum('status').notNull().default('pending'),
    /** Slice 1: the employee accountable for this task ("who owns this?"). */
    ownerAgentId: uuid('owner_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    /** P1a agent pinning — the EXACT enabled employees this task is pinned to. The run executes these
     *  specific agents; the runner never re-derives an agent from the provider. Nullable so legacy rows
     *  migrate cleanly (a null pin ⇒ the runner fails closed rather than substituting). Enforced same-
     *  workspace by the composite FKs below (non-null ⇒ must live in this org+project). */
    assignedPrimaryAgentId: uuid('assigned_primary_agent_id'),
    assignedReviewerAgentId: uuid('assigned_reviewer_agent_id'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => profiles.id, { onDelete: 'restrict' }),
    /** Operator-supplied reason when a person cancels the task (Execution closure). The engine's
     * technical cancelled status + audit history are preserved separately. */
    cancelReason: text('cancel_reason'),
    /** HUB-002 recovery: when this task was SUPERSEDED, the replacement task it points to. The old task
     *  becomes terminal (cancelled) but the relationship is preserved so history is never rewritten. */
    supersededByTaskId: uuid('superseded_by_task_id').references((): AnyPgColumn => tasks.id, { onDelete: 'set null' }),
    /** HUB-009 — a demo/seed task in an otherwise live project. Its runs snapshot non-live activity. Default
     *  live; a live project may legitimately contain a demo/seed task. */
    classification: dataClassificationEnum('classification').notNull().default('live'),
    ...timestamps,
  },
  (t) => [
    unique('tasks_tenant_id_uq').on(t.orgId, t.projectId, t.id),
    index('tasks_org_project_idx').on(t.orgId, t.projectId),
    index('tasks_project_status_idx').on(t.projectId, t.status),
    index('tasks_project_created_idx').on(t.projectId, t.createdAt),
    // Hub P1d — deterministic occurrence identity for standing work. One task per (schedule, occurrence):
    // a partial unique index (only where both are non-null) so ordinary non-standing tasks are unaffected,
    // and two concurrent scheduler ticks for the same due instant collapse to a single task.
    uniqueIndex('tasks_schedule_occurrence_uq')
      .on(t.scheduleId, t.scheduleOccurrenceAt)
      .where(sql`schedule_id is not null and schedule_occurrence_at is not null`),
    // P1a agent pinning — composite FKs to agents. MATCH SIMPLE: a NULL agent id skips the check (legacy
    // rows are fine); a non-null id must reference an agent in the SAME (org_id, project_id) — a cross-
    // workspace pin is impossible. RESTRICT: a pinned employee cannot be deleted out from under history.
    foreignKey({ columns: [t.orgId, t.projectId, t.assignedPrimaryAgentId], foreignColumns: [agents.orgId, agents.projectId, agents.id], name: 'tasks_assigned_primary_agent_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.projectId, t.assignedReviewerAgentId], foreignColumns: [agents.orgId, agents.projectId, agents.id], name: 'tasks_assigned_reviewer_agent_fk' }).onDelete('restrict'),
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
    // Guidance applicability + scope + validity: acceptance preserves the conclusion; these decide
    // WHERE and HOW LONG it may guide future work. `record` decisions are never injected. Scope is
    // the ceiling; relevance still gates each run. Existing rows keep prior behavior (guidance,
    // workspace) via defaults; new decisions default to the narrowest useful scope in the domain layer.
    applicability: decisionApplicabilityEnum('applicability').notNull().default('guidance'),
    scope: decisionScopeEnum('scope').notNull().default('workspace'),
    /** For task-scoped guidance: the exact task whose work it may guide (concrete target, required). */
    scopeTaskId: uuid('scope_task_id').references(() => tasks.id, { onDelete: 'set null' }),
    /** For objective-scoped guidance: the objective whose work it may guide (concrete target, required). */
    scopeObjectiveId: uuid('scope_objective_id').references(() => objectives.id, { onDelete: 'set null' }),
    /** Time-bounded validity: after this instant, the decision is historically valid but not active. */
    effectiveUntil: timestamp('effective_until', { withTimezone: true }),
    /** Why an accepted decision was retired (who/when live in reviewedBy/reviewedAt). */
    statusReason: text('status_reason'),
    supersededBy: uuid('superseded_by'),
    // AI-suggested candidates (O-20). Null suggested_by_run_id ⇒ human-filed;
    // set ⇒ a model suggestion from that run, awaiting human review.
    suggestedByRunId: uuid('suggested_by_run_id'),
    suggestionConfidence: decisionConfidenceEnum('suggestion_confidence'),
    suggestionReason: text('suggestion_reason'),
    // The AI's RECOMMENDED reuse — evidence for the reviewer, kept separate from the actual
    // applicability/scope above. Suggested reuse is never active scope until the operator promotes.
    suggestedApplicability: decisionApplicabilityEnum('suggested_applicability'),
    suggestedScope: decisionScopeEnum('suggested_scope'),
    suggestedScopeTaskId: uuid('suggested_scope_task_id').references(() => tasks.id, { onDelete: 'set null' }),
    reviewedBy: uuid('reviewed_by').references(() => profiles.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    /** Slice 1: the employee accountable for this decision ("who owns this?"). */
    ownerAgentId: uuid('owner_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    /** HUB-009 — genuine vs demonstration vs fixture decision. Default live. */
    classification: dataClassificationEnum('classification').notNull().default('live'),
    ...timestamps,
  },
  (t) => [
    index('decisions_org_project_status_idx').on(t.orgId, t.projectId, t.status),
    index('decisions_originating_task_idx').on(t.originatingTaskId),
    index('decisions_superseded_by_idx').on(t.supersededBy),
  ],
);

/**
 * The honest reverse trail: one row each time a decision was actually INJECTED into a run's context
 * (not merely eligible, and not proof it influenced the result). `reason` records why it was eligible
 * (same task / objective / shared reference). Append-only in practice; read for "where was this
 * memory applied?" on the decision detail.
 */
export const decisionInjections = pgTable(
  'decision_injections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    decisionId: uuid('decision_id').notNull().references(() => decisions.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    /** Why it was eligible for this run: 'task' | 'objective' | 'reference'. */
    reason: text('reason').notNull(),
    /** The EXACT rendered memory line supplied to the AI for this run — an immutable snapshot, so the
     *  detail can show what the model actually received even after rendering/metadata later change. */
    memoryText: text('memory_text'),
    injectedAt: timestamp('injected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('decision_injections_decision_idx').on(t.decisionId),
    index('decision_injections_org_project_idx').on(t.orgId, t.projectId),
    // Idempotency: one application record per (run, decision) — a runner retry must not double-count.
    uniqueIndex('decision_injections_run_decision_uq').on(t.runId, t.decisionId),
  ],
);

/**
 * Work items (Org Slice 1 follow-up): a human-owned, editable tracking item.
 * The counterpart to `tasks`, which are write-once AI *executions* — this
 * represents human work (a conversation, a deal, a follow-up) that a person
 * owns and advances through their own stages. Deliberately minimal: title,
 * a free-text stage, editable notes, an optional employee owner, and an
 * optional attachment to an objective (so pipelines group under a goal).
 * No AI run, no cost, no automation — updated by hand as work progresses.
 */
export const workItems = pgTable(
  'work_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    /** Structured operational condition — the minimum lifecycle meaning the Hub needs to
     * coordinate human work (Execution). Sits beside the flexible free-text `stage`. NULLABLE on
     * purpose: null = never established (→ "Unknown" in the shared model). A DB default must never
     * masquerade as a real condition, so legacy rows stay null until a human sets one. */
    condition: workItemConditionEnum('condition'),
    /** Optional: what a "waiting" item is waiting on (e.g. "outside counsel response"). */
    waitingOn: text('waiting_on'),
    /** Free-text business stage (e.g. "Sourced", "Demo booked"). Not an enum —
     * the vocabulary is the operator's, not the platform's. */
    stage: text('stage').notNull().default('New'),
    /** Editable free-form notes — the whole point vs. a write-once task. */
    notes: text('notes').notNull().default(''),
    /** Slice 1 ownership: the employee accountable for this work item. */
    ownerAgentId: uuid('owner_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    /** Optional grouping under a goal (e.g. a pilot pipeline under an objective). */
    objectiveId: uuid('objective_id').references(() => objectives.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => profiles.id, { onDelete: 'restrict' }),
    /** Frozen closure record (Execution) — captured when condition becomes finished/stopped.
     * A stop requires a reason; the item is immutable afterward, so its condition/stage/owner at
     * that moment ARE the snapshot. */
    closedBy: uuid('closed_by').references(() => profiles.id, { onDelete: 'set null' }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closureReason: text('closure_reason'),
    /** HUB-009 — genuine vs demonstration vs fixture work item. Default live. */
    classification: dataClassificationEnum('classification').notNull().default('live'),
    ...timestamps,
  },
  (t) => [
    index('work_items_org_project_idx').on(t.orgId, t.projectId),
    index('work_items_project_created_idx').on(t.projectId, t.createdAt),
    index('work_items_objective_idx').on(t.objectiveId),
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
    /** Hub P1d — last liveness beat from the executing worker. Stage 1 stamps it at claim; Stage 2 renews it
     *  during a run so a live-but-slow run is not mistaken for an abandoned lease. Null until first claim. */
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    /** Hub P1d — how this job entered the queue (DISPATCH_KINDS: interactive|worker|standing). Metadata only;
     *  never affects claim eligibility. Null for legacy rows enqueued before the column existed. */
    dispatchKind: text('dispatch_kind').$type<DispatchKind>(),
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
    /** P1a agent pinning — IMMUTABLE requested-vs-actual evidence. `requested*` records the exact agent
     *  ids the task/schedule pinned (what was asked for); `primaryAgentId`/`reviewerAgentId` above stay the
     *  ACTUAL agents the run executed. The runner loads strictly by the requested id, so requested == actual
     *  by construction (asserted before the run starts). Nullable ONLY so runs predating the feature stay
     *  untouched. Composite FKs (below) keep a non-null requested id in this workspace. */
    requestedPrimaryAgentId: uuid('requested_primary_agent_id'),
    requestedReviewerAgentId: uuid('requested_reviewer_agent_id'),
    /** Deterministic consolidation output. Null until the run finishes. */
    consolidatedResult: text('consolidated_result'),
    /** Project-folder chunks retrieved for this run (D-020 transparency). */
    retrievedDocuments: jsonb('retrieved_documents').$type<RetrievedDocRef[]>(),
    /** The full assembled context package, grouped by why each part was included (O-14). */
    contextManifest: jsonb('context_manifest').$type<ContextManifestEntry[]>(),
    /** HUB-008 reproducibility, ALL captured immutably AT DISPATCH (nullable for runs predating the feature —
     *  never synthesized for old runs). A later edit to an agent's prompt/config cannot change what these
     *  record. config hash = fingerprint over {provider,model,systemPrompt,temp,maxTokens,role}; prompt hash =
     *  sha256 of the systemPrompt; effective-prompt hash = sha256 of the assembled system+user turn; the source
     *  manifest is the ordered list of the inputs (objective, decisions, task, context) with their content hashes. */
    primaryConfigHash: text('primary_config_hash'),
    reviewerConfigHash: text('reviewer_config_hash'),
    primaryPromptHash: text('primary_prompt_hash'),
    reviewerPromptHash: text('reviewer_prompt_hash'),
    primaryEffectivePromptHash: text('primary_effective_prompt_hash'),
    /** The reviewer's STANDING effective-context (system + priorities + approved policies); the response
     *  under review is captured separately in `messages`. */
    reviewerEffectivePromptHash: text('reviewer_effective_prompt_hash'),
    assemblerVersion: text('assembler_version'),
    sourceManifest: jsonb('source_manifest').$type<{ kind: string; id?: string | null; scope?: string | null; hash: string }[]>(),
    /** IMMUTABLE evidence snapshot at dispatch — per supplied document: exact version, disclosure, and
     *  chunk excerpt. Knowledge extraction cites against this, never live documents, so a proposal
     *  names the evidence the run actually received. */
    retrievedSources: jsonb('retrieved_sources').$type<RunSourceSnapshot[]>(),
    /** Decision-candidate extraction outcome (O-20); makes extraction idempotent. */
    candidateExtractionStatus: extractionStatusEnum('candidate_extraction_status'),
    /** Knowledge-proposal extraction outcome; makes Knowledge extraction idempotent, independent of the
     *  decision extractor — one may succeed while the other is empty/failed. */
    knowledgeExtractionStatus: extractionStatusEnum('knowledge_extraction_status'),
    /** HUB-009 — IMMUTABLE data-classification snapshot resolved BEFORE dispatch from the effective
     *  classification of {project, task, performing agents} (seed > demo > live). Nullable ONLY so runs
     *  predating the feature stay untouched; those are resolved by legacy derivation at read time. A later
     *  reclassification of the task/project/agent never rewrites this value. */
    classification: dataClassificationEnum('classification'),
    /** Hub P1d — the run's durable reliability lifecycle (RELIABILITY_STATES). Nullable: a legacy null
     *  derives-as-before from `status`. Stage 1 only persists the column; Stage 2 advances the transitions. */
    reliabilityState: text('reliability_state').$type<ReliabilityState>(),
    /** Hub P1d — the id of the execution ATTEMPT that produced this run's result. Lets a reconciler tell a
     *  fresh attempt's checkpoints from a superseded one; correlated with `run_execution_checkpoints`. Null
     *  until an attempt checkpoints (Stage 2). */
    executionAttemptId: uuid('execution_attempt_id'),
    /** Hub P1d — the checkpointed final result text captured before finalization, so an interrupted run can
     *  be finalized idempotently from the checkpoint rather than re-billed (Stage 2). Null pre-checkpoint. */
    checkpointedResult: text('checkpointed_result'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    unique('runs_tenant_id_uq').on(t.orgId, t.projectId, t.id),
    index('runs_org_project_idx').on(t.orgId, t.projectId),
    index('runs_task_idx').on(t.taskId),
    // P1a agent pinning — composite FKs on the immutable requested-agent evidence. Same MATCH SIMPLE /
    // RESTRICT semantics as tasks: null skips the check (pre-feature runs), non-null is workspace-bound.
    foreignKey({ columns: [t.orgId, t.projectId, t.requestedPrimaryAgentId], foreignColumns: [agents.orgId, agents.projectId, agents.id], name: 'runs_requested_primary_agent_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.projectId, t.requestedReviewerAgentId], foreignColumns: [agents.orgId, agents.projectId, agents.id], name: 'runs_requested_reviewer_agent_fk' }).onDelete('restrict'),
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
    /** Versioned structured review JSON. Runtime readers normalize legacy/v2 shapes and reject invalid data. */
    verdictDetail: jsonb('verdict_detail').$type<ReviewDetail>(),
    succeeded: boolean('succeeded').notNull(),
    errorMessage: text('error_message'),
    latencyMs: integer('latency_ms'),
    /**
     * HUB-008 — sha256 of THIS step's exact dispatched request (system + turns), captured at dispatch.
     * The run-level `primaryEffectivePromptHash` identifies only the INITIAL primary request; a revision
     * step's request additionally carries the reviewer feedback and the prior primary response, so its
     * identity is recorded here per step. Null for the deterministic consolidate step (no model call) and
     * for steps from runs predating this feature. A later prompt edit can never rewrite a stored value.
     */
    effectivePromptHash: text('effective_prompt_hash'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('run_steps_run_number_uq').on(t.runId, t.stepNumber),
    index('run_steps_org_project_idx').on(t.orgId, t.projectId),
  ],
);

/**
 * Hub P1d — durable per-step execution checkpoints. APPEND-ONLY evidence written as each model step of a run
 * completes, so an interrupted attempt can be finalized from what already happened rather than re-billing the
 * provider sequence (the actual checkpoint/resume/idempotent-finalization logic lands in Stage 2; Stage 1
 * only creates the table so the schema is ready). One row per (run, step_number); `execution_attempt_id`
 * correlates a row with the attempt that produced it (runs.execution_attempt_id), so a superseded attempt's
 * checkpoints are distinguishable from a fresh one's. Follows the (org_id, project_id) tenant + append-only
 * posture of `messages`: INSERT/SELECT only, UPDATE/DELETE blocked by trigger.
 */
export const runExecutionCheckpoints = pgTable(
  'run_execution_checkpoints',
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
    /** The execution attempt that produced this checkpoint (correlates with runs.execution_attempt_id). */
    executionAttemptId: uuid('execution_attempt_id').notNull(),
    /** 1-based step position within the run, mirroring run_steps.step_number. */
    stepNumber: integer('step_number').notNull(),
    /** The step's kind (primary|review|revision|consolidate); text so this table carries no enum dependency. */
    stepKind: text('step_kind').notNull(),
    provider: text('provider'),
    model: text('model'),
    /** The model's response text captured at completion — the durable checkpoint the finalizer replays. */
    responseText: text('response_text'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    /** The usage_events row this step billed, when one was recorded — so finalization never double-bills. */
    usageEventId: uuid('usage_event_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One checkpoint per step of a run: a retry of the same step is idempotent, not a duplicate row.
    uniqueIndex('run_execution_checkpoints_run_step_uq').on(t.runId, t.stepNumber),
    index('run_execution_checkpoints_org_project_idx').on(t.orgId, t.projectId),
    index('run_execution_checkpoints_run_idx').on(t.runId),
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
    unique('approvals_tenant_id_uq').on(t.orgId, t.projectId, t.id),
    index('approvals_org_project_status_idx').on(t.orgId, t.projectId, t.status),
    index('approvals_task_idx').on(t.taskId),
  ],
);

/** Durable source of truth for a consequential executor lifecycle. Storage only: no executor is enabled. */
export const executorExecutions = pgTable(
  'executor_executions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
    approvalId: uuid('approval_id').notNull(),
    taskId: uuid('task_id'),
    runId: uuid('run_id'),
    executorId: text('executor_id').notNull(),
    executorVersion: text('executor_version').notNull(),
    actionType: actionTypeEnum('action_type').notNull(),
    riskClass: text('risk_class').notNull(),
    mode: text('mode').notNull(),
    workspaceStorageId: text('workspace_storage_id').notNull(),
    normalizedTarget: text('normalized_target').notNull(),
    targetCollisionKey: text('target_collision_key').notNull(),
    payloadSha256: text('payload_sha256').notNull(),
    preconditionKind: text('precondition_kind').notNull(),
    preconditionSha256: text('precondition_sha256'),
    desiredSha256: text('desired_sha256').notNull(),
    confirmationId: uuid('confirmation_id').notNull(),
    confirmationSha256: text('confirmation_sha256').notNull(),
    confirmedBy: uuid('confirmed_by').notNull().references(() => profiles.id, { onDelete: 'restrict' }),
    confirmationExpiresAt: timestamp('confirmation_expires_at', { withTimezone: true }).notNull(),
    actorId: uuid('actor_id').notNull().references(() => profiles.id, { onDelete: 'restrict' }),
    idempotencyKey: text('idempotency_key').notNull(),
    correlationId: text('correlation_id').notNull(),
    state: text('state').$type<ExecutorExecutionState>().notNull().default('proposed'),
    reconciliationState: text('reconciliation_state').$type<ExecutorReconciliationState>().notNull().default('not_required'),
    reconciliationOwner: text('reconciliation_owner'),
    reconcileAfter: timestamp('reconcile_after', { withTimezone: true }),
    reconciliationDeadline: timestamp('reconciliation_deadline', { withTimezone: true }),
    resultCode: text('result_code'),
    resultDetail: jsonb('result_detail').$type<Record<string, unknown>>().notNull().default({}),
    rollbackArtifactId: text('rollback_artifact_id'),
    rollbackSha256: text('rollback_sha256'),
    attemptCount: integer('attempt_count').notNull().default(0),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    sideEffectCheckpointAt: timestamp('side_effect_checkpoint_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    unique('executor_executions_tenant_id_uq').on(t.orgId, t.projectId, t.id),
    uniqueIndex('executor_executions_idempotency_uq').on(t.orgId, t.projectId, t.idempotencyKey),
    uniqueIndex('executor_executions_confirmation_uq').on(t.confirmationId),
    uniqueIndex('executor_executions_live_target_uq').on(t.orgId, t.projectId, t.workspaceStorageId, t.targetCollisionKey)
      .where(sql`state in ('claimed','sandbox_starting','precondition_verified','writing','verifying','ambiguous','reconciling','manual_resolution_required')`),
    index('executor_executions_state_reconcile_idx').on(t.state, t.reconcileAfter),
    index('executor_executions_project_created_idx').on(t.orgId, t.projectId, t.createdAt),
    index('executor_executions_approval_idx').on(t.approvalId),
    index('executor_executions_target_idx').on(t.workspaceStorageId, t.targetCollisionKey),
    foreignKey({ columns: [t.orgId, t.projectId, t.approvalId], foreignColumns: [approvals.orgId, approvals.projectId, approvals.id], name: 'executor_executions_approval_tenant_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.projectId, t.taskId], foreignColumns: [tasks.orgId, tasks.projectId, tasks.id], name: 'executor_executions_task_tenant_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.projectId, t.runId], foreignColumns: [runs.orgId, runs.projectId, runs.id], name: 'executor_executions_run_tenant_fk' }).onDelete('restrict'),
    check('executor_executions_risk_ck', sql`${t.riskClass} in ('read_only','reversible_internal_write','external_reversible','financial_regulated','destructive_irreversible')`),
    check('executor_executions_mode_ck', sql`${t.mode} in ('dry_run','live')`),
    check('executor_executions_state_ck', sql`${t.state} in ('proposed','confirmed','claimed','sandbox_starting','precondition_verified','writing','verifying','succeeded','blocked','definitely_not_executed','failed','ambiguous','reconciling','reconciled_succeeded','reconciled_not_executed','manual_resolution_required')`),
    check('executor_executions_reconciliation_ck', sql`${t.reconciliationState} in ('not_required','required','in_progress','resolved','manual_required')`),
    check('executor_executions_precondition_ck', sql`(${t.preconditionKind} = 'absent' and ${t.preconditionSha256} is null) or (${t.preconditionKind} = 'sha256' and ${t.preconditionSha256} ~ '^[0-9a-f]{64}$')`),
    check('executor_executions_hashes_ck', sql`${t.payloadSha256} ~ '^[0-9a-f]{64}$' and ${t.desiredSha256} ~ '^[0-9a-f]{64}$' and ${t.confirmationSha256} ~ '^[0-9a-f]{64}$' and (${t.rollbackSha256} is null or ${t.rollbackSha256} ~ '^[0-9a-f]{64}$')`),
    check('executor_executions_attempt_count_ck', sql`${t.attemptCount} >= 0 and ${t.version} > 0`),
    check('executor_executions_ambiguity_ck', sql`${t.state} <> 'ambiguous' or ${t.reconciliationState} in ('required','in_progress','manual_required')`),
  ],
);

/** Per-attempt lease/checkpoint evidence. Lease expiry authorizes reconciliation, never another write. */
export const executorExecutionAttempts = pgTable(
  'executor_execution_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
    executionId: uuid('execution_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    sandboxId: text('sandbox_id').notNull(),
    sandboxImageDigest: text('sandbox_image_digest').notNull(),
    workspaceMountIdentity: text('workspace_mount_identity').notNull(),
    leaseTokenHash: text('lease_token_hash').notNull(),
    leasedBy: text('leased_by').notNull(),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }).notNull(),
    state: text('state').$type<ExecutorAttemptState>().notNull().default('claimed'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    preWriteCheckpointAt: timestamp('pre_write_checkpoint_at', { withTimezone: true }),
    atomicInstallCheckpointAt: timestamp('atomic_install_checkpoint_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    observedPreconditionSha256: text('observed_precondition_sha256'),
    observedPostconditionSha256: text('observed_postcondition_sha256'),
    tempArtifactIdentity: text('temp_artifact_identity'),
    exitCode: integer('exit_code'),
    timeoutStage: text('timeout_stage'),
    resultDetail: jsonb('result_detail').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('executor_execution_attempts_number_uq').on(t.executionId, t.attemptNumber),
    uniqueIndex('executor_execution_attempts_active_lease_uq').on(t.executionId)
      .where(sql`state in ('claimed','sandbox_starting','precondition_verified','writing','verifying','ambiguous')`),
    index('executor_execution_attempts_lease_idx').on(t.leaseExpiresAt),
    index('executor_execution_attempts_state_lease_idx').on(t.state, t.leaseExpiresAt),
    index('executor_execution_attempts_tenant_idx').on(t.orgId, t.projectId),
    foreignKey({ columns: [t.orgId, t.projectId, t.executionId], foreignColumns: [executorExecutions.orgId, executorExecutions.projectId, executorExecutions.id], name: 'executor_execution_attempts_execution_tenant_fk' }).onDelete('restrict'),
    check('executor_execution_attempts_number_ck', sql`${t.attemptNumber} > 0`),
    check('executor_execution_attempts_state_ck', sql`${t.state} in ('claimed','sandbox_starting','precondition_verified','writing','verifying','succeeded','definitely_not_executed','failed','ambiguous','cancelled')`),
    check('executor_execution_attempts_hashes_ck', sql`${t.leaseTokenHash} ~ '^[0-9a-f]{64}$' and (${t.observedPreconditionSha256} is null or ${t.observedPreconditionSha256} ~ '^[0-9a-f]{64}$') and (${t.observedPostconditionSha256} is null or ${t.observedPostconditionSha256} ~ '^[0-9a-f]{64}$')`),
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
    /** HUB-009 — IMMUTABLE classification snapshot. For run-associated usage this INHERITS the run's
     *  snapshot at write time; it never independently recomputes if the task/agent/project later changes.
     *  Nullable: run-less usage (embeddings/extraction) is left null in this increment and resolved by
     *  legacy derivation from the project at read time; rows predating the feature stay null/untouched. */
    classification: dataClassificationEnum('classification'),
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

// ---------------------------------------------------------------------------
// P1a — Immutable, migration-seeded platform pricing (governance foundation).
// GLOBAL (not tenant-scoped). Seeded by the reviewed migration; no runtime
// mutation path. Immutability + read-only-for-app_server enforced in rls.sql.
// ---------------------------------------------------------------------------

/** One immutable pricing schedule per seed. `(id, schedule_hash)` is the composite FK target. */
export const pricingSchedules = pgTable(
  'pricing_schedules',
  {
    id: uuid('id').primaryKey(),
    sourcePricingVersion: text('source_pricing_version').notNull(),
    currency: text('currency').notNull(),
    scheduleHash: text('schedule_hash').notNull(),
    canonicalizationVersion: integer('canonicalization_version').notNull(),
    hashAlgorithm: text('hash_algorithm').notNull(),
    seededByMigration: text('seeded_by_migration').notNull(),
    seededAt: timestamp('seeded_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('pricing_schedules_hash_uq').on(t.scheduleHash),
    unique('pricing_schedules_id_hash_uq').on(t.id, t.scheduleHash),
  ],
);

/** Immutable per-model entries. Prices are integer micros per `token_unit_size` tokens. */
export const pricingScheduleEntries = pgTable(
  'pricing_schedule_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => pricingSchedules.id, { onDelete: 'restrict' }),
    provider: providerIdEnum('provider').notNull(),
    model: text('model').notNull(),
    inputUnitPriceMicros: bigint('input_unit_price_micros', { mode: 'bigint' }).notNull(),
    outputUnitPriceMicros: bigint('output_unit_price_micros', { mode: 'bigint' }).notNull(),
    tokenUnitSize: bigint('token_unit_size', { mode: 'bigint' }).notNull(),
    unitDefinition: text('unit_definition').notNull(),
    minChargeMicros: bigint('min_charge_micros', { mode: 'bigint' }),
    maxOutputTokens: integer('max_output_tokens').notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    metadata: jsonb('metadata').notNull().default({}),
  },
  (t) => [
    uniqueIndex('pricing_schedule_entries_schedule_model_uq').on(t.scheduleId, t.provider, t.model),
    index('pricing_schedule_entries_schedule_idx').on(t.scheduleId),
    check('pricing_entries_token_unit_size_pos', sql`${t.tokenUnitSize} > 0`),
    check('pricing_entries_max_output_pos', sql`${t.maxOutputTokens} > 0`),
    check(
      'pricing_entries_prices_nonneg',
      sql`${t.inputUnitPriceMicros} >= 0 AND ${t.outputUnitPriceMicros} >= 0`,
    ),
  ],
);

/** Deterministic singleton pointer to the current schedule (composite FK prevents id/hash mismatch). */
export const platformPricingState = pgTable(
  'platform_pricing_state',
  {
    singletonKey: text('singleton_key').primaryKey(),
    currentPricingScheduleId: uuid('current_pricing_schedule_id').notNull(),
    currentPricingScheduleHash: text('current_pricing_schedule_hash').notNull(),
    seededByMigration: text('seeded_by_migration').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('platform_pricing_state_singleton_ck', sql`${t.singletonKey} = 'GLOBAL'`),
    foreignKey({
      columns: [t.currentPricingScheduleId, t.currentPricingScheduleHash],
      foreignColumns: [pricingSchedules.id, pricingSchedules.scheduleHash],
      name: 'platform_pricing_state_schedule_fk',
    }),
  ],
);
