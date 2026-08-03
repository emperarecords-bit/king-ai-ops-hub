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
  // The proposal was invalidated before a decision because its originating task was cancelled
  // (or otherwise superseded). Distinct from `expired` (past due) and from a reviewer's `rejected`.
  'withdrawn',
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

/**
 * Where a document's source lives (O-23). `local_folder` is the original
 * on-disk adapter (D-020); `cloud_upload` is a file uploaded into managed object
 * storage so the Library works when the user's machine is offline. Retrieval is
 * identical for both — a run can only tell them apart via this provenance tag.
 */
export const DOCUMENT_SOURCES = ['local_folder', 'cloud_upload'] as const;
export type DocumentSource = (typeof DOCUMENT_SOURCES)[number];

/**
 * Full document lifecycle (O-23). Original states: active/archived/failed. Cloud
 * upload adds the pre-active pipeline (uploaded → queued → indexing → active),
 * `unsupported` (a recognized-but-not-indexable type, never enters retrieval),
 * and `source_unavailable` (the backing object/folder is gone, but provenance is
 * retained — never silently deleted).
 */
export const DOCUMENT_STATUSES = [
  'active', 'archived', 'failed',
  'uploaded', 'queued', 'indexing', 'unsupported', 'source_unavailable',
  // Authorized for purge and inside its retention/quarantine window: excluded from retrieval and new use,
  // still restorable (bytes retained) until the window elapses and the purge executes. Distinct from
  // 'archived' (an intentional, indefinitely-reversible retirement) — this is a pending irreversible delete.
  'purge_quarantined',
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/**
 * Per-workspace document-retrieval mode (Documents increment 1, Stage C2). Server-authoritative (stored
 * on the workspace, never client-supplied): `legacy` — only legacy null-version retrieval decides the
 * result; `shadow` — legacy decides, the versioned path is compared non-authoritatively; `versioned` —
 * the current-version path decides and runs write version-bound evidence.
 */
export const RETRIEVAL_MODES = ['legacy', 'shadow', 'versioned'] as const;
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];

/** Durable document-indexing job states (O-23), same shape as run jobs. */
export const DOCUMENT_JOB_STATUSES = ['queued', 'running', 'done', 'failed'] as const;
export type DocumentJobStatus = (typeof DOCUMENT_JOB_STATUSES)[number];

/**
 * A Document VERSION's index outcome. A version is created `pending`, becomes `indexed` on success or
 * `failed` on a parse/index error. Only an `indexed` version may become a logical Document's current
 * version; a `failed` version is retained (with its bytes + error) but never current.
 */
export const DOCUMENT_INDEX_STATUSES = ['pending', 'indexed', 'failed'] as const;
export type DocumentIndexStatus = (typeof DOCUMENT_INDEX_STATUSES)[number];

/**
 * How faithfully a Document Version's content is retained — the Hub must distinguish EXACT evidence,
 * RECONSTRUCTED evidence, and UNAVAILABLE evidence, and never let a caller infer this from whether an
 * object key happens to be null.
 *  - byte_exact: raw source bytes retained + hash-verified; exact download permitted (when authorized).
 *  - reconstructed_text: only indexed chunks retained (legacy local); text inspectable WITH a visible
 *    qualification; no exact-file download.
 *  - unavailable: neither raw bytes nor sufficient reconstructed content is retained; identity preserved.
 */
export const CONTENT_FIDELITIES = ['byte_exact', 'reconstructed_text', 'unavailable'] as const;
export type ContentFidelity = (typeof CONTENT_FIDELITIES)[number];

/** Provenance: which document chunks fed a given run (transparency, D-020). */
export interface RetrievedDocRef {
  relativePath: string;
  chunkIndex: number;
  rank: number;
  /** Source adapter for the chunk's document (O-23). Optional so historical
   *  manifests without it still parse; absent ⇒ treat as local_folder. */
  source?: DocumentSource;
}

/**
 * The IMMUTABLE evidence a run received at dispatch — captured when context is assembled, never re-read
 * from live documents later. Knowledge extraction cites against THIS: the exact version (`sha256`) the
 * originating operation saw, the disclosure classification in force then, and the exact chunk text
 * (`excerpt`) so a quoted span can be verified. A document changing after dispatch cannot alter what a
 * proposal cites; it only makes the cited version currently unavailable / a mismatch on resolution.
 */
export interface RunSourceSnapshot {
  relativePath: string;
  sha256: string;
  disclosure: KnowledgeDisclosure;
  chunkIndex: number;
  rank: number;
  /** The exact chunk text supplied to the run — the only thing a cited excerpt may be checked against. */
  excerpt: string;
  /** The immutable Document Version this evidence came from. Optional so historical snapshots without it
   *  still parse; the durable, referentially-safe pointer lives in `run_document_versions`. */
  documentVersionId?: string;
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
  // Task Dependency Graph (O-18): workflow structure from Hub records.
  'task_graph',
  // Decision Memory (O-19): approved operational/creative conclusions.
  'decision_memory',
] as const;
export type ContextSource = (typeof CONTEXT_SOURCES)[number];

/**
 * Decision Memory (O-19). A Decision is an approved operational or creative
 * conclusion the organization should remember across tasks — not conversation
 * history. Only `accepted` decisions are retrieved into context; `superseded`
 * are historical, `proposed` await human approval, `rejected` are discarded.
 */
// Record status: was the conclusion accepted as a legitimate record? `retired` = no longer active
// guidance, with no direct replacement (distinct from `superseded`, which points at a replacement).
export const DECISION_STATUSES = ['proposed', 'accepted', 'superseded', 'rejected', 'retired'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

// Category — subject matter. NOT scope (see DECISION_SCOPE) and NOT applicability.
export const DECISION_TYPES = [
  'operational',
  'creative',
  'continuity',
  'technical',
  'process',
  'other',
] as const;
export type DecisionType = (typeof DECISION_TYPES)[number];

// Guidance applicability — should the conclusion actively guide later work, or is it kept only as a
// record? Acceptance preserves the conclusion; applicability + scope decide where it may guide. Only
// `guidance` decisions are ever injected into a run.
export const DECISION_APPLICABILITY = ['record', 'guidance'] as const;
export type DecisionApplicability = (typeof DECISION_APPLICABILITY)[number];

// Scope — the maximum applicability boundary for a guidance decision. Scope defines where guidance
// MAY apply; relevance still determines whether it applies to a given run. Default narrow.
export const DECISION_SCOPES = ['task', 'objective', 'workspace'] as const;
export type DecisionScope = (typeof DECISION_SCOPES)[number];

/** Confidence of an AI-suggested candidate (O-20). Never approval authority. */
export const DECISION_CONFIDENCE = ['low', 'medium', 'high'] as const;
export type DecisionConfidence = (typeof DECISION_CONFIDENCE)[number];

/**
 * Per-run candidate-extraction outcome (O-20). Recorded on the run so the
 * bounded, one-shot extraction is idempotent — a refresh or re-run never
 * duplicates candidates.
 */
export const EXTRACTION_STATUSES = ['succeeded', 'failed', 'empty'] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

/**
 * Durable run-job lifecycle (O-21). A job is a request to execute a task's run.
 * Persisted so execution survives a browser close, terminal exit, or process
 * restart, and so a claim is atomic (no duplicate provider sequence).
 */
export const RUN_JOB_STATUSES = ['queued', 'running', 'done', 'failed'] as const;
export type RunJobStatus = (typeof RUN_JOB_STATUSES)[number];

/**
 * Hub P1d — reliable queued runs. The run's reliability lifecycle, distinct from
 * the coarse `RUN_STATUSES` (running|completed|failed) surfaced to users. This
 * tracks the durable-dispatch state a worker (Stage 2) advances a run through so
 * an interrupted attempt can be reconciled deterministically. Stage 1 only
 * DEFINES + persists the column (nullable: a legacy null derives-as-before from
 * `runs.status`); Stage 2 wires the actual transitions and idempotent
 * checkpoint/resume/finalization.
 */
export const RELIABILITY_STATES = [
  'not_dispatched',
  'dispatching',
  'result_checkpointed',
  'finalizing',
  'completed',
  'failed',
  'cancelled',
  'reconciliation_required',
] as const;
export type ReliabilityState = (typeof RELIABILITY_STATES)[number];

/**
 * Hub P1d — how a run job entered the queue. Metadata only (never changes claim
 * eligibility): `interactive` = a user started the run inline; `worker` = a
 * background enqueue; `standing` = produced by the standing-work tick. Nullable
 * for legacy rows enqueued before the column existed.
 */
export const DISPATCH_KINDS = ['interactive', 'worker', 'standing'] as const;
export type DispatchKind = (typeof DISPATCH_KINDS)[number];

/**
 * Task dependency edge kinds (O-18). Both are FORWARD edges meaning the
 * prerequisite must complete before the dependent — `blocks` is the harder
 * phrasing, `prerequisite` the softer, stored identically as
 * prerequisite → dependent. "blocked by" and "successor" are the reverse
 * reading of the same edge, derived, never stored separately.
 */
export const DEPENDENCY_KINDS = ['blocks', 'prerequisite'] as const;
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];

export interface ContextManifestEntry {
  source: ContextSource;
  /** Document path, objective title, or knowledge-item title. */
  label: string;
  /** e.g. 'chunk 0 · relevance 0.039' or the core-reference type name. */
  detail?: string;
  /** Freshness signals (O-17), persisted in context_manifest for the panel. */
  freshness?: {
    sourceUpdatedAt?: string;
    contentEffectiveAt?: string;
    confidence: FreshnessConfidence;
  };
  /** Task-graph metadata (O-18), persisted for the panel. */
  graph?: {
    nodeCount: number;
    edgeCount: number;
    rootTask: string;
    cycle: boolean;
  };
}

/**
 * Context freshness (O-17). A separate axis from authority, injection trust,
 * and relevance. Shapes live here (the shared types floor); the parser and
 * comparator live in `src/domain/context/freshness.ts`.
 */
export const FRESHNESS_CONFIDENCE = ['high', 'medium', 'low', 'unknown'] as const;
export type FreshnessConfidence = (typeof FRESHNESS_CONFIDENCE)[number];

export interface Freshness {
  /** When the Hub assembled/observed the item (ISO). */
  observedAt?: string;
  /** The source record's last-known update time (ISO). */
  sourceUpdatedAt?: string;
  /** An explicit date the CONTENT represents, only when reliably parsed (ISO date). */
  contentEffectiveAt?: string;
  confidence: FreshnessConfidence;
  /** Short deterministic note on which timestamp was used and how. */
  basis: string;
}

export const FRESHNESS_RELATIONS = [
  'hub_newer',
  'document_newer',
  'same_date',
  'not_comparable',
] as const;
export type FreshnessRelation = (typeof FRESHNESS_RELATIONS)[number];

export interface FreshnessComparison {
  relation: FreshnessRelation;
  /** Human-readable, deterministic — safe to drop straight into the prompt. */
  explanation: string;
  hubInstant: string | null;
  documentInstant: string | null;
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

// How the record was FORMED (not whether it is true). Never derived from `kind`.
export const KNOWLEDGE_EPISTEMIC_BASES = ['observed', 'human_asserted', 'extracted', 'summarized', 'inferred'] as const;
export type KnowledgeEpistemicBasis = (typeof KNOWLEDGE_EPISTEMIC_BASES)[number];

// What review has occurred — separate from activation. Activation never creates verification.
export const KNOWLEDGE_VERIFICATIONS = ['unverified', 'human_confirmed', 'source_supported', 'system_verified', 'disputed'] as const;
export type KnowledgeVerification = (typeof KNOWLEDGE_VERIFICATIONS)[number];

// Applicability boundary (distinct from the legacy org/project/department/employee KNOWLEDGE_SCOPES).
export const KNOWLEDGE_SCOPE_KINDS = ['task', 'objective', 'workspace'] as const;
export type KnowledgeScopeKind = (typeof KNOWLEDGE_SCOPE_KINDS)[number];

// Enforceable disclosure classification. `restricted` is denied by default (grants are future).
export const KNOWLEDGE_DISCLOSURES = ['workspace_internal', 'restricted'] as const;
export type KnowledgeDisclosure = (typeof KNOWLEDGE_DISCLOSURES)[number];

// Only source types the Hub can actually resolve and inspect — never a nominal label.
export const KNOWLEDGE_SOURCE_TYPES = ['document', 'artifact'] as const;
export type KnowledgeSourceType = (typeof KNOWLEDGE_SOURCE_TYPES)[number];

// How the Knowledge was derived from a source (independent of, but compatible with, epistemic basis).
export const KNOWLEDGE_TRANSFORMATIONS = ['quoted', 'extracted', 'summarized', 'inferred'] as const;
export type KnowledgeTransformation = (typeof KNOWLEDGE_TRANSFORMATIONS)[number];

/** Objectives (OBJECTIVES.md, D-010). Dark schema in Sprint 3; UI in Sprint 4. */
export const OBJECTIVE_STATUSES = ['draft', 'active', 'completed', 'cancelled'] as const;
export type ObjectiveStatus = (typeof OBJECTIVE_STATUSES)[number];

/**
 * The minimal structured operational condition for a human Work Item (Execution). It sits beside
 * the flexible free-text `stage` so the Hub can coordinate the work (planned/moving/waiting/
 * finished/stopped) without inferring meaning from arbitrary stage text (HUB-PRODUCT.md).
 */
export const WORK_ITEM_CONDITIONS = ['planned', 'moving', 'waiting', 'finished', 'stopped'] as const;
export type WorkItemCondition = (typeof WORK_ITEM_CONDITIONS)[number];

/**
 * HUB-009 data classification. A stored marker distinguishing genuine operating data from demonstration
 * and fixture data, so operator surfaces can show live data by default without ever deleting anything.
 *   live — genuine operational/business data (default).
 *   demo — intentional demonstration or verification data.
 *   seed — data generated by automated seed / fixture / test tooling.
 * Precedence for "effective" classification is seed > demo > live. `seed` carries NO auto-purge semantics;
 * the distinction only explains origin and permits display/lifecycle policy.
 */
export const DATA_CLASSIFICATIONS = ['live', 'demo', 'seed'] as const;
export type DataClassification = (typeof DATA_CLASSIFICATIONS)[number];

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
