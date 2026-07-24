/**
 * Cross-layer domain vocabulary. Table row types are inferred from the Drizzle
 * schema — this file holds only the enums and small value objects shared by
 * layers that must not import the schema (e.g. providers).
 */

export const TASK_STATUSES = [
  'pending',
  'running',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const RUN_STATUSES = ['running', 'completed', 'failed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const STEP_KINDS = ['primary', 'review', 'revision', 'consolidate'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const MESSAGE_ROLES = ['user', 'assistant', 'reviewer', 'system'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const REVIEW_VERDICTS = ['approve', 'revise', 'reject'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const REVIEW_SEVERITIES = ['critical', 'major', 'minor'] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

/** One concrete problem a reviewer found, extracted from the issues block. */
export interface ReviewIssue {
  readonly severity: ReviewSeverity;
  readonly summary: string;
  readonly detail?: string;
}

/** Structured review outcome stored on the review step (run_steps.verdict_detail). */
export interface ReviewDetail {
  readonly verdict: ReviewVerdict;
  readonly issues: readonly ReviewIssue[];
}

/**
 * The closed set of consequential actions a model may PROPOSE. Executing any of
 * them requires a human approval row. Anything outside this enum is not
 * representable and therefore not executable. See SECURITY.md §4.
 */
export const ACTION_TYPES = [
  'file_write',
  'git_commit',
  'git_push',
  'git_pr',
  'deployment',
  'db_mutation',
  'email_send',
  'social_publish',
  'financial',
  'destructive',
  'external_http',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const ORG_ROLES = ['owner', 'admin', 'member'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const PROJECT_ROLES = ['admin', 'member', 'viewer'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const AGENT_ROLES = ['primary', 'reviewer'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const CONTEXT_ITEM_STATUSES = ['pending', 'approved', 'archived'] as const;
export type ContextItemStatus = (typeof CONTEXT_ITEM_STATUSES)[number];

/**
 * Standing work cadences (Sprint 8, Continuous Operations). Schedules are
 * human-authored; each tick creates exactly one gated task+run — recurrence
 * can never compound into an unbounded loop.
 */
export const CADENCES = ['daily', 'weekly', 'monthly'] as const;
export type Cadence = (typeof CADENCES)[number];

/**
 * Project Folder documents (D-020, DESIGN-REVIEW-PROJECT-FOLDER). A document
 * is indexed from a linked local folder; `active` documents are retrievable,
 * `archived` are files that vanished from the folder since the last refresh.
 */
export const DOCUMENT_KINDS = ['markdown', 'text', 'pdf', 'docx'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_STATUSES = ['active', 'archived', 'failed'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** Provenance: which document chunks fed a given run (transparency, D-020). */
export interface RetrievedDocRef {
  relativePath: string;
  chunkIndex: number;
  rank: number;
}

/**
 * Why a piece of context was included in a run's prompt (O-14). The panel
 * groups the assembled package by this so inclusion is explainable, and new
 * sources (project state, task history, approvals) slot in without touching
 * retrieval. See CONTEXT-PACKAGE.md.
 */
export const CONTEXT_SOURCES = [
  'objective',
  'charter',
  'retrieved',
  'core_reference',
  'production_status',
  // Project State (O-15): operational state from Hub records, not documents.
  'objective_progress',
  'active_work',
  'blocker',
  'recent_outcome',
  'pending_review',
] as const;
export type ContextSource = (typeof CONTEXT_SOURCES)[number];

export interface ContextManifestEntry {
  source: ContextSource;
  /** Document path, objective title, or knowledge-item title. */
  label: string;
  /** e.g. 'chunk 0 · relevance 0.039' or the core-reference type name. */
  detail?: string;
}

/** Company Knowledge (KNOWLEDGE-DESIGN.md, D-011). K1: project scope only. */
export const KNOWLEDGE_SCOPES = ['org', 'project', 'department', 'employee'] as const;
export type KnowledgeScope = (typeof KNOWLEDGE_SCOPES)[number];

export const KNOWLEDGE_KINDS = [
  'standard',
  'policy',
  'decision',
  'playbook',
  'persona',
  'template',
  'brand',
  'fact',
] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export const KNOWLEDGE_STATUSES = ['draft', 'active', 'archived'] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

export const KNOWLEDGE_SOURCES = ['manual', 'promoted_artifact', 'promoted_context'] as const;
export type KnowledgeSource = (typeof KNOWLEDGE_SOURCES)[number];

/** Objectives (OBJECTIVES.md, D-010). Dark schema in Sprint 3; UI in Sprint 4. */
export const OBJECTIVE_STATUSES = ['draft', 'active', 'completed', 'cancelled'] as const;
export type ObjectiveStatus = (typeof OBJECTIVE_STATUSES)[number];

export const MILESTONE_STATUSES = ['planned', 'active', 'completed', 'cancelled'] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

/**
 * One measurable success criterion on an objective (SPRINT-03-PLAN §5.3).
 * An objective cannot complete while any criterion is 'unmet'; criteria are
 * met or explicitly waived by a human, and both transitions are audited.
 */
export interface SuccessCriterion {
  readonly label: string;
  readonly metric: string;
  readonly target: number;
  readonly unit: string;
  readonly source: 'manual' | 'usage' | `integration:${string}`;
  readonly status: 'unmet' | 'met' | 'waived';
  readonly verifiedBy: string | null;
  readonly verifiedAt: string | null;
}

/**
 * Model routing tiers (SPRINT-03-PLAN.md §4, D-014). `standard` uses each
 * agent's configured model; `flagship` overrides to the flagship model for the
 * agent's provider. Selected per task by a human, never by a model.
 */
export const MODEL_TIERS = ['standard', 'flagship'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/**
 * The approved reserved list for flagship spend. A flagship task must declare
 * one, so every flagship dollar is attributable to a stated reason.
 */
export const FLAGSHIP_CATEGORIES = [
  'architecture',
  'security',
  'database_design',
  'major_refactoring',
  'product_strategy',
  'complex_reasoning',
  'release_review',
] as const;
export type FlagshipCategory = (typeof FLAGSHIP_CATEGORIES)[number];

export const ARTIFACT_KINDS = ['text', 'markdown', 'json', 'file'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * The tenant scope every repository call must carry. Constructed exclusively by
 * `requireTenant()` after verifying session and membership; nothing else may
 * build one outside of tests.
 */
export interface TenantContext {
  readonly userId: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly orgRole: OrgRole;
  readonly projectRole: ProjectRole;
}
