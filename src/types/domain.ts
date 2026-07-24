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
