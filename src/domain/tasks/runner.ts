import 'server-only';
import { randomUUID } from 'node:crypto';
import { eq, and, desc, sql } from 'drizzle-orm';
import { type ReliabilityState, type TenantContext } from '@/types/domain';
import { assessProviderErrorOutcome, ProviderError, type ProviderId, type ProviderSelection } from '@/types/provider';
import { AppError, AssignmentRequiredError, ConflictError } from '@/lib/errors';
import { serverEnv } from '@/lib/env.server';
import { log } from '@/lib/log';
import { withTenant } from '@/db/tenant';
import { type DbTx } from '@/db/client';
import { agents, approvals, decisions, messages, projects, runExecutionCheckpoints, runJobs, runs, runSteps, tasks } from '@/db/schema';
import { getProvider, otherProvider } from '@/providers/registry';
import {
  AmbiguousProviderOutcomeSignal,
  executeRun,
  LeaseLostSignal,
  ReconciliationRequiredSignal,
  RunCancelledSignal,
  type CheckpointedStepResult,
  type EngineAgent,
  type ResumeHooks,
  type StepRecord,
} from '@/orchestration/engine';
import { AUTHORITY } from '@/orchestration/prompts';
import { buildDelegationRules, MAX_DELEGATIONS_PER_RUN } from '@/orchestration/delegations';
import { createTask } from '@/domain/tasks/tasks';
import { loadApprovedContextForRun } from '@/domain/github/content';
import { createTextArtifact } from '@/domain/artifacts/artifacts';
import { assembleOrgBriefing, listDelegationTargets, resolveHqProjectKey } from '@/domain/org/briefing';
import { assembleTeamBriefing } from '@/domain/tasks/team-briefing';
import { assemblePortfolioBriefing } from '@/domain/portfolio/portfolio';
import { assembleAccurateBidsSight, sightEnabledKeys } from '@/domain/integrations/accuratebids-sight';
import { createOwnerQuestions } from '@/domain/questions/questions';
import { resolveModelForTier } from '@/orchestration/routing';
import {
  type ContextManifestEntry,
  type Freshness,
  type ModelTier,
  type RetrievedDocRef,
  type RunSourceSnapshot,
  type StepKind,
} from '@/types/domain';
import { agentExecutionFingerprint, getAssignableAgentById, type AgentRow } from '@/domain/agents/agents';
import { assembleCurrentOperatingPriorities } from '@/domain/prompts/effective-prompt';
import { computeActivityClassification } from '@/domain/classification/classification';
import { ASSEMBLER_VERSION, assembleEffectivePrompt } from '@/orchestration/prompts';
import { sha256Hex } from '@/lib/crypto';
import { canonicalJson } from '@/orchestration/actions';
import { selectRelevantKnowledge, logKnowledgeApplications } from '@/domain/knowledge/knowledge';
import { loadObjectiveForRun } from '@/domain/objectives/objectives';
import { assembleDocumentSources } from '@/domain/documents/retrieval-mode';
import { writeRunVersionEvidence } from '@/domain/documents/references';
import { assembleProjectState } from '@/domain/state/project-state';
import { assembleTaskGraph } from '@/domain/dependencies/graph-context';
import { assembleDecisionMemory, logDecisionInjections, objectiveTaskIds } from '@/domain/decisions/decisions';
import {
  applyDecisionCandidatesFromText,
  buildExtractionUserTurn,
  EXTRACTION_SYSTEM,
} from '@/domain/decisions/extraction';
import {
  applyKnowledgeCandidatesFromText,
  buildKnowledgeExtractionUserTurn,
  KNOWLEDGE_EXTRACTION_SYSTEM,
} from '@/domain/knowledge/extraction';
import { compareFreshness, parseEffectiveDate } from '@/domain/context/freshness';

/** Reduces full Freshness to the compact shape persisted in the manifest. */
function manifestFreshness(
  f: Freshness,
): NonNullable<ContextManifestEntry['freshness']> {
  return {
    sourceUpdatedAt: f.sourceUpdatedAt,
    contentEffectiveAt: f.contentEffectiveAt,
    confidence: f.confidence,
  };
}
import { writeAudit } from '@/domain/audit/audit';
import { pendingDuplicateExists } from '@/domain/approvals/approvals';
import { assertWithinBudget, recordUsage } from '@/domain/usage/usage';
import { consumeRateLimit } from '@/domain/usage/rate-limit';

/**
 * Wires the pure orchestration engine to persistence. The default workflow,
 * end to end:
 *
 *   preflight (budget, rate limit, agent + context resolution; run row created
 *     with reliability_state='not_dispatched' + an execution_attempt_id)
 *   → engine.executeRun (primary → review → one revision → consolidate), each
 *     provider call fenced by a durable dispatch INTENT + a RESULT checkpoint
 *   → per step: run_steps + messages + usage_events + a durable checkpoint,
 *     committed AS THEY HAPPEN, exactly once per (run, step)
 *   → idempotent two-phase finalize (finalizing → terminal) → approvals →
 *     task status + audit
 *
 * Hub P1d — crash safety. A run row is the durable unit of a crash-safe attempt.
 * An interrupted run is RESUMED on the SAME run row (never re-created), replaying
 * checkpointed provider results with no second provider call and no re-bill; an
 * uncertain dispatch (intent recorded, result unknown) resolves to
 * reconciliation_required with ZERO automatic retry; finalization is idempotent.
 */

const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export interface RunOutcome {
  readonly runId: string;
  readonly status: 'completed' | 'awaiting_approval' | 'failed' | 'cancelled' | 'reconciliation_required';
  readonly failureReason: string | null;
}

/**
 * Hub P1d — the durable-job context threaded from the worker into a run so the runner can (a) re-confirm
 * lease ownership before every provider dispatch and before the terminal commit, and (b) renew the lease
 * heartbeat. `attempt` is the ownership TOKEN: the job's `attempts` counter at claim time. A reclaim
 * increments it, so `ownsLease()` returns false for a superseded worker — a stale worker never overwrites
 * the winner. Absent for direct (in-process, non-worker) callers, where ownership is trivially held.
 */
export interface RunJobContext {
  readonly jobId: string;
  readonly attempt: number;
  /** True if THIS worker still owns the lease (renewing it); false once the job was reclaimed. */
  ownsLease(): Promise<boolean>;
  /** Hub P1d — the IN-TRANSACTION lease fence: on the given tx, take the run_jobs row lock and return whether
   *  THIS token still owns the job. Held for the tx's life, it makes proposal application single-writer.
   *  Optional so direct/test callers can omit it (ownership trivially held); the real worker always sets it. */
  ownsLeaseTx?(tx: DbTx): Promise<boolean>;
}

/**
 * Hub P1d — a crash-injection seam for the reliability tests ONLY. The runner awaits this at labeled
 * boundaries; a test hook that THROWS simulates a process crash at that exact point (whatever committed so
 * far persists), and a hook that performs a DB write can inject a cancel-request between boundaries. Null in
 * all non-test paths, so production behavior is unchanged.
 */
type RunTestHook = (label: string, stepNumber: number) => Promise<void>;
let runTestHook: RunTestHook | null = null;
export function __setRunTestHookForTests(fn: RunTestHook | null): void {
  runTestHook = fn;
}
async function testPoint(label: string, stepNumber = 0): Promise<void> {
  if (runTestHook) await runTestHook(label, stepNumber);
}

/**
 * Optional live observers for a run in progress (SSE). Observational only:
 * nothing persisted depends on them, and a disconnected observer never fails
 * the run — callbacks are fire-and-forget.
 */
export interface RunLiveEvents {
  delta?(kind: StepKind, text: string): void;
  step?(record: StepRecord): void;
}

function toEngineAgent(row: AgentRow, tier: ModelTier): EngineAgent {
  return {
    agentId: row.id,
    displayName: row.name,
    provider: getProvider(row.provider),
    // D-014: flagship tier overrides the configured model per provider.
    model: resolveModelForTier(tier, row.provider, row.model),
    systemPrompt: row.systemPrompt,
    reviewRubric: row.reviewRubric,
    temperature: row.temperatureMilli / 1000,
    maxOutputTokens: row.maxOutputTokens,
  };
}

/** Which vendor is primary / reviewer for this task's provider selection. */
export function resolveProviderPair(selection: ProviderSelection, reviewEnabled: boolean): {
  primary: ProviderId;
  reviewer: ProviderId | null;
} {
  if (selection === 'both') {
    // Cross-provider by construction (D-005): OpenAI leads, Anthropic reviews.
    return { primary: 'openai', reviewer: 'anthropic' };
  }
  return {
    primary: selection,
    reviewer: reviewEnabled ? otherProvider(selection) : null,
  };
}

/**
 * P1a agent pinning — persist a fail-closed assignment audit in its OWN committed transaction. The
 * preflight transaction rolls back when the runner throws AssignmentRequiredError, so this evidence must
 * NOT live in that transaction or it would vanish with it. Detail carries identity ids + a machine reason
 * ONLY — never a system prompt or secret.
 */
async function auditAssignmentFailure(
  ctx: TenantContext,
  event: { action: string; entityType: string; entityId: string; detail: Record<string, unknown> },
): Promise<void> {
  await withTenant(ctx, (tx) =>
    writeAudit(tx, ctx, {
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      detail: event.detail,
    }),
  );
}

const TERMINAL_RELIABILITY: ReadonlySet<ReliabilityState> = new Set<ReliabilityState>([
  'completed',
  'failed',
  'cancelled',
  'reconciliation_required',
]);

function isTerminalReliability(state: ReliabilityState | null | undefined): boolean {
  return state != null && TERMINAL_RELIABILITY.has(state);
}

/**
 * Hub P1d — a WHERE predicate that a `runs.reliability_state` write must satisfy so a late/stale worker can
 * never move a TERMINAL run backward (e.g. resurrect a `completed` run to `result_checkpointed`). Applied to
 * every non-terminal reliability transition (dispatch intent + result-checkpoint advances). A terminal run
 * simply no-ops the update rather than regressing.
 */
function nonterminalReliability() {
  return sql`(${runs.reliabilityState} is null or ${runs.reliabilityState} not in ('completed', 'failed', 'cancelled', 'reconciliation_required'))`;
}

/**
 * Hub P1d — reserved DETERMINISTIC step identities for the post-run extraction provider calls, modeled as
 * reliability steps with their own checkpoint (same crash-safe machinery as primary/review/revision) so the
 * calls are fenced + checkpointed BEFORE the run is marked terminal. Chosen far out of the engine's step
 * band (primary=1, review=2, revision=3, consolidate=4 — all ≤ MAX_STEPS) so a checkpoint identity can never
 * collide with an engine step or with the other extraction step. The `step_kind` is free text on the
 * checkpoint row (no enum dependency).
 */
const EXTRACTION_DECISION_STEP = 101;
const EXTRACTION_KNOWLEDGE_STEP = 102;

// ---------------------------------------------------------------------------
// Shared context assembly (used by a fresh start AND a resume). Pure reads +
// deterministic derivation — no writes. The heavy retrieval/decision/knowledge
// assembly the engine needs is identical on both paths, so a resumed run rebuilds
// exactly the same context around the durable checkpoints it replays.
// ---------------------------------------------------------------------------

type TaskRow = typeof tasks.$inferSelect;

async function assembleRunContext(
  tx: DbTx,
  ctx: TenantContext,
  task: TaskRow,
  primaryRow: AgentRow,
  reviewerRow: AgentRow | null,
  nowIso: string,
) {
  // Owner intent that frames the work (closes O-9); tenant-scoped, null when
  // the task serves no live objective.
  const objective = await loadObjectiveForRun(tx, ctx, task.objectiveId);
  const knowledgeQuery = [task.input, objective?.title, objective?.description].filter(Boolean).join(' ');
  const knowledge = await selectRelevantKnowledge(tx, ctx, {
    queryText: knowledgeQuery,
    consumerType: 'task_run',
    currentTaskId: task.id,
    currentObjectiveId: task.objectiveId,
    consumerAgentIds: [primaryRow.id, reviewerRow?.id].filter((id): id is string => !!id),
  });
  const docSources = await assembleDocumentSources(tx, ctx, task.input, 5, {
    consumerType: 'task_run',
    consumerAgentIds: [primaryRow.id, reviewerRow?.id].filter((id): id is string => !!id),
  });
  // Repo browser: human-approved imported repository files (bounded; untrusted-wrapped downstream).
  const importedRepoContext = await loadApprovedContextForRun(tx, ctx);
  const retrieved = docSources.retrieved;
  const coreRefs = docSources.coreRefs;
  const productionStatus = docSources.productionStatus;

  const projectState = await assembleProjectState(tx, ctx, task.objectiveId, task.id);
  const taskGraph = await assembleTaskGraph(tx, ctx, task.id);
  const objTaskIds = await objectiveTaskIds(tx, ctx, task.objectiveId);
  const decisionMemory = await assembleDecisionMemory(tx, ctx, {
    currentTaskId: task.id,
    currentObjectiveId: task.objectiveId,
    objectiveTaskIds: objTaskIds,
    docPaths: new Set(retrieved.map((r) => r.relativePath)),
  });

  const docFreshness = (chunk: { content: string; indexedAt: Date | null }): Freshness => {
    const effective = parseEffectiveDate(chunk.content);
    return {
      observedAt: nowIso,
      sourceUpdatedAt: chunk.indexedAt?.toISOString(),
      contentEffectiveAt: effective ?? undefined,
      confidence: effective ? 'high' : chunk.indexedAt ? 'medium' : 'unknown',
      basis: effective
        ? 'explicit effective date parsed from the document header'
        : chunk.indexedAt
          ? 'indexed file modification time'
          : 'no usable document date',
    };
  };

  const contextItems = [
    ...(projectState.contextItem
      ? [
          {
            ...projectState.contextItem,
            authority: AUTHORITY.HUB_STATE,
            kind: 'Current Hub operational state',
            timestamp: nowIso.slice(0, 16).replace('T', ' ') + ' UTC',
          },
        ]
      : []),
    ...(taskGraph.contextItem
      ? [{ ...taskGraph.contextItem, authority: AUTHORITY.HUB_STATE, kind: 'Task dependency graph' }]
      : []),
    ...(decisionMemory.contextItem
      ? [{ ...decisionMemory.contextItem, authority: AUTHORITY.HUB_STATE, kind: 'Decision memory' }]
      : []),
    ...knowledge.map((k) => ({
      title: k.title,
      content: k.body,
      authority: AUTHORITY.WORKSPACE_CONTROL,
      kind: 'Knowledge context',
    })),
    ...retrieved.map((r) => ({
      title: r.relativePath,
      content: r.content,
      authority: AUTHORITY.PROJECT_DOCUMENT,
      kind: 'Linked project document',
      freshness: docFreshness(r),
    })),
    ...coreRefs.map((r) => ({
      title: r.relativePath,
      content: r.content,
      authority: AUTHORITY.PROJECT_DOCUMENT,
      kind: 'Linked project document (core reference)',
      freshness: docFreshness(r),
    })),
    ...(productionStatus
      ? [
          {
            title: productionStatus.relativePath,
            content: productionStatus.content,
            authority: AUTHORITY.PROJECT_DOCUMENT,
            kind: 'Linked project document (production status)',
            freshness: docFreshness(productionStatus),
          },
        ]
      : []),
    ...importedRepoContext,
  ];

  const PRODUCTION_STATUS_RE = /production[ _-]?status/i;
  const prodDocForCompare =
    productionStatus ??
    retrieved.find((r) => PRODUCTION_STATUS_RE.test(r.relativePath)) ??
    coreRefs.find((r) => PRODUCTION_STATUS_RE.test(r.relativePath)) ??
    null;
  const freshnessComparison =
    projectState.freshness && prodDocForCompare
      ? compareFreshness(projectState.freshness, docFreshness(prodDocForCompare))
      : null;
  const retrievedRefs: RetrievedDocRef[] = retrieved.map((r) => ({
    relativePath: r.relativePath,
    chunkIndex: r.chunkIndex,
    rank: r.rank,
    source: r.source,
  }));

  const suppliedSources = [...retrieved, ...coreRefs, ...(productionStatus ? [productionStatus] : [])];
  const retrievedSources: RunSourceSnapshot[] = suppliedSources.map((r) => ({
    relativePath: r.relativePath,
    sha256: r.sha256,
    disclosure: r.disclosure,
    chunkIndex: r.chunkIndex,
    rank: r.rank,
    excerpt: r.content,
    documentVersionId: r.documentVersionId,
  }));

  const contextManifest: ContextManifestEntry[] = [
    ...(objective ? [{ source: 'objective' as const, label: objective.title }] : []),
    ...knowledge.map((k) => ({ source: 'charter' as const, label: k.title })),
    ...retrieved.map((r) => ({
      source: 'retrieved' as const,
      label: r.relativePath,
      detail: `chunk ${r.chunkIndex} · relevance ${r.rank.toFixed(3)}`,
      freshness: manifestFreshness(docFreshness(r)),
    })),
    ...coreRefs.map((r) => ({
      source: 'core_reference' as const,
      label: r.relativePath,
      detail: r.coreType,
      freshness: manifestFreshness(docFreshness(r)),
    })),
    ...(productionStatus
      ? [
          {
            source: 'production_status' as const,
            label: productionStatus.relativePath,
            freshness: manifestFreshness(docFreshness(productionStatus)),
          },
        ]
      : []),
    ...projectState.manifest,
    ...taskGraph.manifest,
    ...decisionMemory.manifest,
  ];

  const priorities = await assembleCurrentOperatingPriorities(tx, ctx, task.id);
  const operatingPriorities = priorities.text;
  const primaryAssembled = assembleEffectivePrompt({
    variant: 'primary', agentSystemPrompt: primaryRow.systemPrompt, taskInput: task.input,
    contextItems, objective, freshnessComparison, operatingPriorities,
  });
  const approvedPolicies = contextItems.filter((i) => i.kind === 'Decision memory');
  const reviewerAssembled = reviewerRow
    ? assembleEffectivePrompt({ variant: 'review', agentSystemPrompt: reviewerRow.systemPrompt, taskInput: task.input, primaryResponse: '', approvedPolicies, operatingPriorities, reviewerRubric: reviewerRow.reviewRubric })
    : null;
  const linkedActiveObjective = task.objectiveId
    ? priorities.objectives.find((o) => o.id === task.objectiveId)
    : null;
  const objectiveSnapshot = linkedActiveObjective
    ? {
        title: linkedActiveObjective.title,
        criteria: linkedActiveObjective.criteria.map((c) => ({ label: c.label, target: c.target, unit: c.unit })),
      }
    : objective
      ? { title: objective.title, description: objective.description, openCriteria: objective.openCriteria }
      : null;
  const sourceManifest: { kind: string; id?: string | null; scope?: string | null; hash: string }[] = [
    ...(objectiveSnapshot && task.objectiveId
      ? [{ kind: 'objective', id: task.objectiveId, hash: sha256Hex(JSON.stringify(objectiveSnapshot)) }]
      : []),
    ...priorities.decisions.map((d) => ({ kind: 'decision', id: d.id, scope: d.scope, hash: d.contentHash })),
    { kind: 'task', hash: sha256Hex(task.input) },
    ...retrievedSources.map((s) => ({ kind: 'context', id: s.documentVersionId ?? s.relativePath, hash: s.sha256 })),
  ];

  const projectRow = (
    await tx.select({ classification: projects.classification }).from(projects).where(eq(projects.id, ctx.projectId)).limit(1)
  )[0];
  const runClassification = computeActivityClassification({
    projectClassification: projectRow?.classification,
    taskClassification: task.classification,
    performerClassifications: [primaryRow.classification, reviewerRow?.classification ?? null],
  }).classification;

  return {
    // engine inputs
    contextItems,
    operatingPriorities,
    objective,
    freshnessComparison,
    // run-insert values
    retrievedRefs,
    contextManifest,
    retrievedSources,
    sourceManifest,
    runClassification,
    primaryEffectiveHash: sha256Hex(`${primaryAssembled.system}\n${primaryAssembled.userTurn}`),
    reviewerEffectiveHash: reviewerAssembled ? sha256Hex(`${reviewerAssembled.system}\n${reviewerAssembled.userTurn}`) : null,
    // injection inputs
    docSources,
    suppliedSources,
    knowledge,
    decisionInjected: decisionMemory.injected,
  };
}

type AssembledRunContext = Awaited<ReturnType<typeof assembleRunContext>>;

interface RunExecParams {
  task: TaskRow;
  runId: string;
  executionAttemptId: string;
  primaryRow: AgentRow;
  reviewerRow: AgentRow | null;
  assembled: AssembledRunContext;
  provenanceExecutedAt: string;
}

export async function startRun(
  ctx: TenantContext,
  taskId: string,
  live?: RunLiveEvents,
  jobCtx?: RunJobContext,
): Promise<RunOutcome> {
  const env = serverEnv();
  const nowIso = new Date().toISOString();
  const executionAttemptId = randomUUID();

  // ---- Preflight, one transaction -----------------------------------------
  const preflight = await withTenant(ctx, async (tx) => {
    const taskRows = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.projectId, ctx.projectId), eq(tasks.orgId, ctx.orgId)))
      .limit(1);
    const task = taskRows[0];
    if (!task) throw new AppError('not_found', 'Task not found.');
    if (task.status === 'running') {
      throw new AppError('run_invalid_state', 'This task already has a run in progress.');
    }

    await consumeRateLimit(tx, `runs:user:${ctx.userId}`, env.RATE_LIMIT_RUNS_PER_MINUTE);
    await consumeRateLimit(tx, `runs:project:${ctx.projectId}`, env.RATE_LIMIT_RUNS_PER_MINUTE);
    await assertWithinBudget(tx, ctx.projectId);

    // P1a agent pinning — the run executes the EXACT employees the task is pinned to; the runner never
    // re-derives an agent from the provider. It fails closed instead (audited in a SEPARATE committed tx,
    // since this preflight rolls back on throw).
    if (task.assignedPrimaryAgentId == null) {
      await auditAssignmentFailure(ctx, {
        action: 'task.assignment_required',
        entityType: 'task',
        entityId: taskId,
        detail: { reason: 'no_assigned_primary' },
      });
      throw new AssignmentRequiredError('no_assigned_primary');
    }
    const primaryRow = await getAssignableAgentById(tx, ctx, task.assignedPrimaryAgentId, 'primary');
    if (!primaryRow) {
      await auditAssignmentFailure(ctx, {
        action: 'run.assignment_validation_failed',
        entityType: 'task',
        entityId: taskId,
        detail: { requestedPrimaryAgentId: task.assignedPrimaryAgentId, reason: 'primary_not_assignable' },
      });
      throw new AssignmentRequiredError('primary_not_assignable');
    }
    let reviewerRow: AgentRow | null = null;
    if (task.reviewEnabled) {
      if (task.assignedReviewerAgentId == null) {
        await auditAssignmentFailure(ctx, {
          action: 'run.assignment_validation_failed',
          entityType: 'task',
          entityId: taskId,
          detail: { reason: 'review_enabled_without_reviewer' },
        });
        throw new AssignmentRequiredError('review_enabled_without_reviewer');
      }
      reviewerRow = await getAssignableAgentById(tx, ctx, task.assignedReviewerAgentId, 'reviewer');
      if (!reviewerRow) {
        await auditAssignmentFailure(ctx, {
          action: 'run.assignment_validation_failed',
          entityType: 'task',
          entityId: taskId,
          detail: { requestedReviewerAgentId: task.assignedReviewerAgentId, reason: 'reviewer_not_assignable' },
        });
        throw new AssignmentRequiredError('reviewer_not_assignable');
      }
      if (reviewerRow.id === primaryRow.id) {
        await auditAssignmentFailure(ctx, {
          action: 'run.assignment_validation_failed',
          entityType: 'task',
          entityId: taskId,
          detail: { requestedReviewerAgentId: task.assignedReviewerAgentId, reason: 'reviewer_equals_primary' },
        });
        throw new AssignmentRequiredError('reviewer_equals_primary');
      }
    }

    const assembled = await assembleRunContext(tx, ctx, task, primaryRow, reviewerRow, nowIso);

    const runInserted = await tx
      .insert(runs)
      .values({
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        taskId,
        status: 'running',
        primaryAgentId: primaryRow.id,
        reviewerAgentId: reviewerRow?.id ?? null,
        requestedPrimaryAgentId: task.assignedPrimaryAgentId,
        requestedReviewerAgentId: task.assignedReviewerAgentId ?? null,
        retrievedDocuments: assembled.retrievedRefs.length > 0 ? assembled.retrievedRefs : null,
        contextManifest: assembled.contextManifest.length > 0 ? assembled.contextManifest : null,
        retrievedSources: assembled.retrievedSources.length > 0 ? assembled.retrievedSources : null,
        primaryConfigHash: agentExecutionFingerprint(primaryRow),
        reviewerConfigHash: reviewerRow ? agentExecutionFingerprint(reviewerRow) : null,
        primaryPromptHash: sha256Hex(primaryRow.systemPrompt),
        reviewerPromptHash: reviewerRow ? sha256Hex(reviewerRow.systemPrompt) : null,
        primaryEffectivePromptHash: assembled.primaryEffectiveHash,
        reviewerEffectivePromptHash: assembled.reviewerEffectiveHash,
        assemblerVersion: ASSEMBLER_VERSION,
        sourceManifest: assembled.sourceManifest,
        classification: assembled.runClassification,
        // Hub P1d — the durable crash-safe attempt identity + its initial lifecycle state.
        executionAttemptId,
        reliabilityState: 'not_dispatched',
      })
      .returning({ id: runs.id });
    const runId = runInserted[0]!.id;

    if (
      primaryRow.id !== task.assignedPrimaryAgentId ||
      (reviewerRow?.id ?? null) !== (task.assignedReviewerAgentId ?? null)
    ) {
      throw new AppError('run_invalid_state', 'Assignment integrity check failed: executing agents differ from the assigned employees.');
    }

    // Versioned-path evidence (Stage C2) + the honest reverse trail — written HERE, atomically with the run
    // row and BEFORE any provider dispatch. Because the preflight is one transaction, a resumed run always
    // finds these already durable (never re-run on resume).
    if (assembled.docSources.versioned) {
      await writeRunVersionEvidence(
        tx,
        ctx,
        runId,
        assembled.suppliedSources
          .filter((r): r is typeof r & { documentVersionId: string } => !!r.documentVersionId)
          .map((r) => ({ documentVersionId: r.documentVersionId, chunkIndex: r.chunkIndex, rank: r.rank, disclosure: r.disclosure, retrievalReason: 'run_context' })),
      );
    }
    await logDecisionInjections(tx, ctx, { runId, taskId, injected: assembled.decisionInjected });
    await logKnowledgeApplications(tx, ctx, { consumerType: 'task_run', consumerId: runId, runId, taskId, injected: assembled.knowledge });

    await tx.update(tasks).set({ status: 'running', updatedAt: new Date() }).where(eq(tasks.id, taskId));

    await tx.insert(messages).values({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      taskId,
      runId,
      role: 'user',
      content: task.input,
    });

    await writeAudit(tx, ctx, {
      action: 'run.started',
      entityType: 'run',
      entityId: runId,
      detail: {
        taskId,
        primaryProvider: primaryRow.provider,
        reviewerProvider: reviewerRow?.provider ?? null,
        modelTier: task.modelTier,
        flagshipCategory: task.flagshipCategory,
      },
    });
    await writeAudit(tx, ctx, {
      action: 'run.assignment_confirmed',
      entityType: 'run',
      entityId: runId,
      detail: {
        requestedPrimaryAgentId: task.assignedPrimaryAgentId,
        actualPrimaryAgentId: primaryRow.id,
        matched: true,
        primaryProvider: primaryRow.provider,
      },
    });
    if (reviewerRow) {
      await writeAudit(tx, ctx, {
        action: 'reviewer.assignment_confirmed',
        entityType: 'run',
        entityId: runId,
        detail: {
          requestedReviewerAgentId: task.assignedReviewerAgentId ?? null,
          actualReviewerAgentId: reviewerRow.id,
          matched: true,
          reviewerProvider: reviewerRow.provider,
        },
      });
    }

    return { task, runId, primaryRow, reviewerRow, assembled };
  });

  return executeAndFinalize(
    ctx,
    {
      task: preflight.task,
      runId: preflight.runId,
      executionAttemptId,
      primaryRow: preflight.primaryRow,
      reviewerRow: preflight.reviewerRow,
      assembled: preflight.assembled,
      provenanceExecutedAt: nowIso,
    },
    live,
    jobCtx,
  );
}

/**
 * Hub P1d — RESUME an interrupted run on the SAME run row (never create a new run). Loads the task's
 * in-flight (`running`) run, re-loads the pinned employees strictly by the run's IMMUTABLE requested ids
 * (fail closed), rebuilds the identical context, and re-enters the engine. Already-checkpointed provider
 * results are replayed with no second provider call; an uncertain dispatch (intent recorded, result
 * unknown) resolves to reconciliation_required; a completed-but-unfinalized run finalizes idempotently.
 */
export async function resumeRun(
  ctx: TenantContext,
  taskId: string,
  live?: RunLiveEvents,
  jobCtx?: RunJobContext,
): Promise<RunOutcome> {
  const nowIso = new Date().toISOString();
  const prep = await withTenant(ctx, async (tx) => {
    const task = (
      await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.projectId, ctx.projectId), eq(tasks.orgId, ctx.orgId)))
        .limit(1)
    )[0];
    if (!task) throw new AppError('not_found', 'Task not found.');
    const run = (
      await tx
        .select()
        .from(runs)
        .where(and(eq(runs.taskId, taskId), eq(runs.status, 'running')))
        .orderBy(desc(runs.createdAt))
        .limit(1)
    )[0];
    if (!run) return { kind: 'no_run' as const, task };
    if (run.requestedPrimaryAgentId == null) return { kind: 'identity_lost' as const, task, run };
    const primaryRow = await getAssignableAgentById(tx, ctx, run.requestedPrimaryAgentId, 'primary');
    if (!primaryRow) return { kind: 'identity_lost' as const, task, run };
    let reviewerRow: AgentRow | null = null;
    if (run.requestedReviewerAgentId != null) {
      reviewerRow = await getAssignableAgentById(tx, ctx, run.requestedReviewerAgentId, 'reviewer');
      if (!reviewerRow) return { kind: 'identity_lost' as const, task, run };
    }
    const assembled = await assembleRunContext(tx, ctx, task, primaryRow, reviewerRow, nowIso);
    return { kind: 'ok' as const, task, run, primaryRow, reviewerRow, assembled };
  });

  if (prep.kind === 'no_run') {
    // Task marked running but no in-flight run (preflight is atomic, so this should not occur). Fail closed.
    await withTenant(ctx, (tx) =>
      tx.update(tasks).set({ status: 'failed', updatedAt: new Date() }).where(eq(tasks.id, taskId)),
    );
    return { runId: '', status: 'failed', failureReason: 'no in-flight run to resume' };
  }
  if (prep.kind === 'identity_lost') {
    return finalizeFailed(ctx, prep.run.id, taskId, 'Pinned employee is no longer assignable.', undefined, true);
  }

  return executeAndFinalize(
    ctx,
    {
      task: prep.task,
      runId: prep.run.id,
      executionAttemptId: prep.run.executionAttemptId ?? randomUUID(),
      primaryRow: prep.primaryRow,
      reviewerRow: prep.reviewerRow,
      assembled: prep.assembled,
      provenanceExecutedAt: prep.run.createdAt.toISOString(),
    },
    live,
    jobCtx,
  );
}

// ---------------------------------------------------------------------------
// Engine execution + idempotent finalization (shared by start + resume).
// ---------------------------------------------------------------------------

async function executeAndFinalize(
  ctx: TenantContext,
  params: RunExecParams,
  live: RunLiveEvents | undefined,
  jobCtx: RunJobContext | undefined,
): Promise<RunOutcome> {
  const env = serverEnv();
  const { task, runId, executionAttemptId, primaryRow, reviewerRow, assembled, provenanceExecutedAt } = params;
  const taskId = task.id;

  // Per-step persistence, IDEMPOTENT + checkpoint-writing. The run_steps insert is guarded by the
  // (run, step_number) unique index: on a resume that replays an already-persisted step, the conflict is a
  // no-op and NO duplicate message / usage / checkpoint is written (billing stays exactly once per step).
  const persistStep = async (record: StepRecord): Promise<void> => {
    // Hub P1d — a crash HERE (provider result in hand, checkpoint not yet committed) is the durable
    // "uncertain outcome" boundary: on resume the step has an intent (state='dispatching') but no checkpoint,
    // so guardDispatch resolves it to reconciliation_required. Tests inject a crash at this exact point to
    // prove the provider request already crossed the boundary before the result was checkpointed.
    await testPoint('before-checkpoint', record.stepNumber);
    await withTenant(ctx, async (tx) => {
      const agentRow =
        record.agentId === primaryRow.id ? primaryRow : record.agentId === reviewerRow?.id ? reviewerRow : null;

      const stepInserted = await tx
        .insert(runSteps)
        .values({
          orgId: ctx.orgId,
          projectId: ctx.projectId,
          runId,
          stepNumber: record.stepNumber,
          kind: record.kind,
          agentId: record.agentId,
          provider: record.response?.provider ?? agentRow?.provider ?? null,
          model: record.response?.model ?? agentRow?.model ?? null,
          verdict: record.verdict,
          verdictDetail: record.verdictDetail,
          succeeded: record.succeeded,
          errorMessage: record.errorMessage,
          latencyMs: record.response?.latencyMs ?? null,
          effectivePromptHash: record.effectivePromptHash,
        })
        .onConflictDoNothing()
        .returning({ id: runSteps.id });
      // Already persisted by a prior attempt (resume) → nothing more to do; never double-bill.
      if (stepInserted.length === 0) return;
      const runStepId = stepInserted[0]!.id;

      if (record.response) {
        await tx.insert(messages).values({
          orgId: ctx.orgId,
          projectId: ctx.projectId,
          taskId,
          runId,
          runStepId,
          role: record.kind === 'review' ? 'reviewer' : 'assistant',
          agentId: record.agentId,
          provider: record.response.provider,
          model: record.response.model,
          content: record.response.text,
        });

        // Invariant I8: bill even for steps whose run later fails. The billing row + the durable result
        // checkpoint + the reliability-state advance all commit in THIS one transaction, so a provider call
        // is recorded exactly once per (run, step) and a resume can prove it.
        const { usageEventId } = await recordUsage(tx, ctx, {
          taskId,
          runId,
          runStepId,
          provider: record.response.provider,
          model: record.response.model,
          usage: record.response.usage,
        });
        await tx
          .insert(runExecutionCheckpoints)
          .values({
            orgId: ctx.orgId,
            projectId: ctx.projectId,
            runId,
            executionAttemptId,
            stepNumber: record.stepNumber,
            stepKind: record.kind,
            provider: record.response.provider,
            model: record.response.model,
            responseText: record.response.text,
            inputTokens: record.response.usage.inputTokens,
            outputTokens: record.response.usage.outputTokens,
            usageEventId,
          })
          .onConflictDoNothing();
        await tx
          .update(runs)
          .set({ reliabilityState: 'result_checkpointed', updatedAt: new Date() })
          // Terminal-state guard: a late worker can never move a terminal run back to result_checkpointed.
          .where(and(eq(runs.id, runId), nonterminalReliability()));
        await writeAudit(tx, ctx, {
          action: 'run.provider_result_checkpointed',
          entityType: 'run',
          entityId: runId,
          detail: { stepNumber: record.stepNumber, kind: record.kind, provider: record.response.provider, model: record.response.model },
        });
      }
    });
    await testPoint('after-checkpoint', record.stepNumber);
    try {
      live?.step?.(record);
    } catch {
      /* observational only */
    }
  };

  const persistMalformed = async (stepNumber: number, reasons: readonly string[]): Promise<void> => {
    await withTenant(ctx, async (tx) => {
      await writeAudit(tx, ctx, {
        action: 'model.malformed_output',
        entityType: 'run',
        entityId: runId,
        detail: { stepNumber, reasons: [...reasons] },
      });
    });
  };

  // Hub P1d — the SHARED fail-closed provider-dispatch boundary, used by BOTH the engine steps (via the
  // resume hook below) and the post-run extraction steps. Re-checks lease ownership + exact pinned identity,
  // detects an uncertain prior dispatch (intent recorded, no result → reconciliation) and a cooperative
  // cancel, then records the durable dispatch INTENT — all atomically, so a throw rolls back to NO intent.
  // `kind` is free text (the engine passes a StepKind; extraction passes its reserved kind).
  async function guardProviderDispatch(stepNumber: number, kind: string): Promise<void> {
    // (1) Lease ownership, fail closed — a stale/reclaimed worker must never dispatch or bill.
    if (jobCtx && !(await jobCtx.ownsLease())) throw new LeaseLostSignal('lease_lost');
    // (2) Identity + uncertain-outcome + cancel + intent, atomically. On throw the tx rolls back → NO intent.
    await withTenant(ctx, async (tx) => {
      // Pinned-agent identity still holds (requested == actual), fail closed.
      const p = await getAssignableAgentById(tx, ctx, primaryRow.id, 'primary');
      if (!p) throw new LeaseLostSignal('identity_changed');
      if (reviewerRow) {
        const rv = await getAssignableAgentById(tx, ctx, reviewerRow.id, 'reviewer');
        if (!rv) throw new LeaseLostSignal('identity_changed');
      }
      const runRow = (
        await tx.select({ state: runs.reliabilityState }).from(runs).where(eq(runs.id, runId)).limit(1)
      )[0];
      const taskRow = (
        await tx.select({ status: tasks.status, cancelReason: tasks.cancelReason }).from(tasks).where(eq(tasks.id, taskId)).limit(1)
      )[0];
      // (a) Uncertain outcome WINS over cancel: a prior attempt recorded a dispatch intent for THIS step
      //     (the first uncheckpointed step) but no result — do not auto-call the provider again.
      if (runRow?.state === 'dispatching') throw new ReconciliationRequiredSignal(stepNumber);
      // (b) Cooperative cancel-requested: a cancelled task (queued cancel) or a running task carrying the
      //     cancel-request marker (cancelReason) — stop with zero provider calls, fabricate no result.
      const cancelRequested =
        taskRow?.status === 'cancelled' ||
        (taskRow?.status === 'running' && !!taskRow.cancelReason && taskRow.cancelReason.trim() !== '');
      if (cancelRequested) throw new RunCancelledSignal(stepNumber);
      // (c) Record the durable dispatch INTENT (state=dispatching). A crash after this point but before the
      //     result checkpoint is detected on resume as an uncertain outcome (branch a above). Terminal-guarded
      //     so a late worker can never regress a terminal run.
      await tx
        .update(runs)
        .set({ reliabilityState: 'dispatching', updatedAt: new Date() })
        .where(and(eq(runs.id, runId), nonterminalReliability()));
      await writeAudit(tx, ctx, {
        action: 'run.provider_dispatch_started',
        entityType: 'run',
        entityId: runId,
        detail: { stepNumber, kind },
      });
    });
  }

  // Hub P1d — the resume + dispatch boundary the engine calls before each provider step.
  const resume: ResumeHooks = {
    loadCheckpoint: async (stepNumber): Promise<CheckpointedStepResult | null> => {
      const rows = await withTenant(ctx, (tx) =>
        tx
          .select({
            provider: runExecutionCheckpoints.provider,
            model: runExecutionCheckpoints.model,
            responseText: runExecutionCheckpoints.responseText,
            inputTokens: runExecutionCheckpoints.inputTokens,
            outputTokens: runExecutionCheckpoints.outputTokens,
          })
          .from(runExecutionCheckpoints)
          .where(and(eq(runExecutionCheckpoints.runId, runId), eq(runExecutionCheckpoints.stepNumber, stepNumber)))
          .limit(1),
      );
      const r = rows[0];
      if (!r || r.responseText == null) return null;
      return {
        provider: (r.provider as ProviderId | null) ?? null,
        model: r.model,
        text: r.responseText,
        inputTokens: r.inputTokens ?? 0,
        outputTokens: r.outputTokens ?? 0,
      };
    },
    guardDispatch: async (stepNumber, kind): Promise<void> => {
      await testPoint('before-dispatch', stepNumber);
      await guardProviderDispatch(stepNumber, kind);
      await testPoint('after-intent', stepNumber);
    },
  };

  // Hub P1d — a post-run extraction step, made crash-safe by REUSING the engine's dispatch/checkpoint
  // machinery. Ensures the reserved-step provider result is durably checkpointed (fenced, at-most-once) BEFORE
  // the run is marked terminal. Returns the checkpointed extractor text to apply, or null when extraction was
  // cleanly SKIPPED (already resolved, or a known provider fault → fail-safe, the run still completes).
  //   * A checkpoint already present  → replay its text, NO provider call.
  //   * Fresh                          → lease + identity + uncertain + cancel guard → provider call →
  //                                      checkpoint result + usage atomically (idempotency-gated).
  //   * Crash after intent, no result  → resume detects state='dispatching' → ReconciliationRequiredSignal.
  const ensureExtractionCheckpoint = async (
    step: number,
    kind: 'decision_extract' | 'knowledge_extract',
    statusKind: 'decision' | 'knowledge',
    meta: { provider: ProviderId; model: string; system: string },
    buildUserTurn: () => string,
  ): Promise<string | null> => {
    await testPoint('before-extract-intent', step);
    // Already attempted for this run (succeeded/empty/failed) → skip entirely, NO provider call. This is the
    // (run, extraction-kind) idempotency key: a set status means the proposals were already applied (or the
    // step resolved empty/failed) on a prior attempt.
    const statusRow = (
      await withTenant(ctx, (tx) =>
        tx
          .select({ d: runs.candidateExtractionStatus, k: runs.knowledgeExtractionStatus })
          .from(runs)
          .where(eq(runs.id, runId))
          .limit(1),
      )
    )[0];
    const status = statusKind === 'decision' ? statusRow?.d : statusRow?.k;
    if (status != null) return null;

    // A durable checkpoint from a prior attempt → replay its text with NO provider call (no re-bill).
    const cp = await resume.loadCheckpoint(step);
    if (cp) return cp.text;

    // Fresh dispatch: fail-closed boundary (lease + identity + uncertain→reconciliation + cancel + intent).
    await guardProviderDispatch(step, kind);
    await testPoint('after-extract-intent', step);

    let resp: Awaited<ReturnType<ReturnType<typeof getProvider>['execute']>>;
    try {
      resp = await getProvider(meta.provider).execute({
        model: meta.model,
        system: meta.system,
        turns: [{ role: 'user', content: buildUserTurn() }],
        temperature: 0,
        maxOutputTokens: 1500,
        timeoutMs: env.PROVIDER_TIMEOUT_MS,
      });
    } catch (err) {
      // Classify the provider fault. Only a PROVABLY not-executed rejection (rejected before the model ran)
      // is FAIL-SAFE: clear the dispatch intent so a later resume does not falsely reconcile a call we KNOW
      // failed, mark extraction failed, and let the run complete (prior behavior). ANY ambiguous outcome —
      // timeout/transport after transmission, a generic 5xx that may post-date execution, or a
      // non-ProviderError we cannot reason about — PRESERVES the durable dispatch intent and fails the run
      // closed to reconciliation (the remote may have executed + charged); the provider call count stays
      // exactly one and no usage is fabricated. (A process CRASH is a separate path — the test hooks below
      // throw AFTER the provider returned, also leaving state='dispatching'.)
      const extractionProvider = getProvider(meta.provider);
      if (err instanceof ProviderError && assessProviderErrorOutcome(extractionProvider, err).status === 'not_executed') {
        await withTenant(ctx, async (tx) => {
          await tx
            .update(runs)
            .set({ reliabilityState: 'result_checkpointed', updatedAt: new Date() })
            .where(and(eq(runs.id, runId), nonterminalReliability()));
          await tx
            .update(runs)
            .set(statusKind === 'decision' ? { candidateExtractionStatus: 'failed' } : { knowledgeExtractionStatus: 'failed' })
            .where(eq(runs.id, runId));
        });
        log.warn('extraction provider rejected before processing (run unaffected)', {
          runId,
          step,
          kind: err.kind,
          err: err.message,
        });
        return null;
      }
      const sig = new AmbiguousProviderOutcomeSignal(err instanceof ProviderError ? err.kind : 'unknown');
      sig.stepNumber = step;
      throw sig;
    }

    // The provider request crossed the boundary; a crash HERE (before the checkpoint commits) is the durable
    // uncertain-outcome boundary for extraction (resume → state='dispatching' → reconciliation).
    await testPoint('before-extract-checkpoint', step);
    // Re-confirm ownership immediately before the durable write (the lease could have been reclaimed during
    // the provider call): a stale worker must not record usage or a checkpoint.
    if (jobCtx && !(await jobCtx.ownsLease())) throw new LeaseLostSignal('lease_lost');
    await withTenant(ctx, async (tx) => {
      // Idempotency gate: if this reserved step is already checkpointed, do nothing (no usage) — the winner
      // (a concurrent owner, or this same run on an earlier attempt) already recorded the one billable result.
      const exists = (
        await tx
          .select({ id: runExecutionCheckpoints.id })
          .from(runExecutionCheckpoints)
          .where(and(eq(runExecutionCheckpoints.runId, runId), eq(runExecutionCheckpoints.stepNumber, step)))
          .limit(1)
      )[0];
      if (exists) return;
      const { usageEventId } = await recordUsage(tx, ctx, {
        taskId,
        runId,
        runStepId: null,
        provider: meta.provider,
        model: resp.model,
        usage: resp.usage,
      });
      const ins = await tx
        .insert(runExecutionCheckpoints)
        .values({
          orgId: ctx.orgId,
          projectId: ctx.projectId,
          runId,
          executionAttemptId,
          stepNumber: step,
          stepKind: kind,
          provider: meta.provider,
          model: resp.model,
          responseText: resp.text,
          inputTokens: resp.usage.inputTokens,
          outputTokens: resp.usage.outputTokens,
          usageEventId,
        })
        .onConflictDoNothing()
        .returning({ id: runExecutionCheckpoints.id });
      // A concurrent owner won the (run, step) slot between our existence check and this insert → fail closed
      // (rolls back the usage we just recorded); the winner's single checkpoint + usage stand.
      if (ins.length === 0) throw new ConflictError('conflicting extraction checkpoint for this run step');
      await tx
        .update(runs)
        .set({ reliabilityState: 'result_checkpointed', updatedAt: new Date() })
        .where(and(eq(runs.id, runId), nonterminalReliability()));
      await writeAudit(tx, ctx, {
        action: 'run.provider_result_checkpointed',
        entityType: 'run',
        entityId: runId,
        detail: { stepNumber: step, kind },
      });
    });
    await testPoint('after-extract-checkpoint', step);
    return resp.text;
  };

  // Hub P1d — reliable post-run extraction (option A): checkpoint the extraction provider calls as reserved
  // reliability steps, then create proposals from those checkpoints — ALL before the run is marked terminal,
  // so no extraction provider call can ever fire outside the reliability state machine. Only for a run that
  // WILL COMPLETE (no surviving approvals); an awaiting-approval run never extracted (prior behavior). Throws
  // the same reliability signals as the engine so executeAndFinalize resolves them uniformly.
  // The in-transaction proposal fence: acquires the run_jobs row lock + confirms the current fencing token
  // owns the job, INSIDE the apply's transaction. A stale/reclaimed token throws here → the apply rolls back
  // before any proposal/usage/audit write, and the runner backs off. Undefined for direct callers.
  const extractionFenceTx: ((tx: DbTx) => Promise<void>) | undefined =
    jobCtx?.ownsLeaseTx != null
      ? async (tx: DbTx) => {
          if (!(await jobCtx.ownsLeaseTx!(tx))) throw new LeaseLostSignal('lease_lost');
        }
      : undefined;

  const runReliableExtraction = async (engineResult: Awaited<ReturnType<typeof executeRun>>): Promise<void> => {
    // Decision candidates.
    const accepted = await withTenant(ctx, (tx) =>
      tx
        .select({ id: decisions.id, title: decisions.title })
        .from(decisions)
        .where(and(eq(decisions.projectId, ctx.projectId), eq(decisions.orgId, ctx.orgId), eq(decisions.status, 'accepted'))),
    );
    const decisionRaw = await ensureExtractionCheckpoint(
      EXTRACTION_DECISION_STEP,
      'decision_extract',
      'decision',
      { provider: primaryRow.provider, model: primaryRow.model, system: EXTRACTION_SYSTEM },
      () => buildExtractionUserTurn(engineResult.consolidated, assembled.contextManifest, accepted),
    );
    if (decisionRaw != null) {
      // Apply proposals in ONE transaction that is lease-fenced INSIDE it (fenceTx) — idempotent + FAIL-SAFE.
      // A lost lease (stale token) propagates so the worker backs off (never a duplicate/completion); any other
      // apply error is swallowed (extraction never fails the run).
      try {
        await withTenant(ctx, (tx) => applyDecisionCandidatesFromText(tx, ctx, runId, decisionRaw, { fenceTx: extractionFenceTx }));
      } catch (err) {
        if (err instanceof LeaseLostSignal) throw err;
        log.warn('decision proposal apply failed (run unaffected)', { runId, errorClass: err instanceof Error ? err.name : 'unknown', recoverable: true });
      }
    }

    // Knowledge candidates.
    const citablePaths = [...new Set((assembled.retrievedSources ?? []).map((s) => s.relativePath))];
    const knowledgeRaw = await ensureExtractionCheckpoint(
      EXTRACTION_KNOWLEDGE_STEP,
      'knowledge_extract',
      'knowledge',
      { provider: primaryRow.provider, model: primaryRow.model, system: KNOWLEDGE_EXTRACTION_SYSTEM },
      () => buildKnowledgeExtractionUserTurn(engineResult.consolidated, citablePaths),
    );
    if (knowledgeRaw != null) {
      try {
        await withTenant(ctx, (tx) =>
          applyKnowledgeCandidatesFromText(tx, ctx, runId, knowledgeRaw, { provider: primaryRow.provider, model: primaryRow.model }, { fenceTx: extractionFenceTx }),
        );
      } catch (err) {
        if (err instanceof LeaseLostSignal) throw err;
        log.warn('knowledge proposal apply failed (run unaffected)', { runId, errorClass: err instanceof Error ? err.name : 'unknown', recoverable: true });
      }
    }
  };

  // GM delegation: ONLY the workspace's General Manager (projects.owner_agent_id) carries the
  // delegation contract in its system prompt, with the live roster of assignable employees.
  const gmInfo = await withTenant(ctx, async (tx) => {
    const proj = await tx
      .select({ ownerAgentId: projects.ownerAgentId, key: projects.key })
      .from(projects)
      .where(eq(projects.id, ctx.projectId))
      .limit(1);
    if (!proj[0] || proj[0].ownerAgentId !== primaryRow.id) return null;
    const roster = await tx
      .select({ name: agents.name })
      .from(agents)
      .where(and(eq(agents.projectId, ctx.projectId), eq(agents.enabled, true), eq(agents.role, 'primary'), sql`${agents.id} <> ${primaryRow.id}`));
    return { roster: roster.map((r) => r.name), projectKey: proj[0].key };
  });
  // Chief of Staff (owner directive: HQ sees everything): the HQ workspace's GM — and no one
  // else — gets the read-only organization-wide briefing as trusted operational state, plus the
  // cross-workspace delegation contract (whose entries become owner approvals, never direct tasks).
  const hqKey = resolveHqProjectKey();
  const isHqGm = Boolean(gmInfo && hqKey && gmInfo.projectKey === hqKey);
  let crossTargets: Awaited<ReturnType<typeof listDelegationTargets>> = [];
  let orgBriefing: string | null = null;
  if (isHqGm) {
    try {
      orgBriefing = await assembleOrgBriefing(ctx.userId, ctx.orgId);
      crossTargets = await listDelegationTargets(ctx.userId, ctx.orgId, ctx.projectId);
    } catch (err) {
      log.warn('org briefing assembly failed (run continues without it)', { errorClass: err instanceof Error ? err.name : 'unknown' });
    }
  }
  // Team briefing: EVERY General Manager's run (all workspaces, HQ included) carries live sight
  // of its own team's recent work, so the GM routes information instead of delegating blind.
  let teamBriefing: string | null = null;
  if (gmInfo) {
    try {
      teamBriefing = await withTenant(ctx, (tx) => assembleTeamBriefing(tx, ctx, { excludeTaskId: taskId }));
    } catch (err) {
      log.warn('team briefing assembly failed (run continues without it)', { errorClass: err instanceof Error ? err.name : 'unknown' });
    }
  }
  // Workspaces with a portfolio ledger (the Stocks desk) get the owner's real holdings in
  // every run, so research lands on what the owner actually owns. Null everywhere else.
  let portfolioBriefing: string | null = null;
  try {
    portfolioBriefing = await withTenant(ctx, (tx) => assemblePortfolioBriefing(tx, ctx));
  } catch (err) {
    log.warn('portfolio briefing assembly failed (run continues without it)', { errorClass: err instanceof Error ? err.name : 'unknown' });
  }
  // AccurateBids sight: configured workspaces (the owner's contracting business) see the live
  // read-only AccurateBids book in every run. Absent config or endpoint trouble → no snapshot.
  let accurateBidsSight: string | null = null;
  try {
    const sightKeys = sightEnabledKeys();
    if (sightKeys.length > 0) {
      const projRows = await withTenant(ctx, (tx) =>
        tx.select({ key: projects.key }).from(projects).where(eq(projects.id, ctx.projectId)).limit(1),
      );
      if (projRows[0] && sightKeys.includes(projRows[0].key)) {
        accurateBidsSight = await assembleAccurateBidsSight();
      }
    }
  } catch (err) {
    log.warn('accuratebids sight assembly failed (run continues without it)', { errorClass: err instanceof Error ? err.name : 'unknown' });
  }
  const primaryEngineAgent = toEngineAgent(primaryRow, task.modelTier);
  const primaryForRun = gmInfo
    ? { ...primaryEngineAgent, systemPrompt: `${primaryEngineAgent.systemPrompt}\n${buildDelegationRules(gmInfo.roster, crossTargets)}` }
    : primaryEngineAgent;
  const contextItemsForRun = [
    ...assembled.contextItems,
    ...(teamBriefing ? [{ title: 'Team briefing (this workspace)', content: teamBriefing, authority: AUTHORITY.HUB_STATE, kind: 'Team briefing' }] : []),
    ...(orgBriefing ? [{ title: 'Organization-wide briefing (headquarters)', content: orgBriefing, authority: AUTHORITY.HUB_STATE, kind: 'Organization briefing' }] : []),
    ...(portfolioBriefing ? [{ title: 'Owner portfolio snapshot (this workspace)', content: portfolioBriefing, authority: AUTHORITY.HUB_STATE, kind: 'Portfolio snapshot' }] : []),
    ...(accurateBidsSight ? [{ title: 'AccurateBids live snapshot (read-only)', content: accurateBidsSight, authority: AUTHORITY.HUB_STATE, kind: 'AccurateBids snapshot' }] : []),
  ];

  let result;
  try {
    result = await executeRun(
      {
        taskInput: task.input,
        contextItems: contextItemsForRun,
        operatingPriorities: assembled.operatingPriorities,
        objective: assembled.objective,
        freshnessComparison: assembled.freshnessComparison,
        primary: primaryForRun,
        reviewer: reviewerRow ? toEngineAgent(reviewerRow, task.modelTier) : null,
        perCallTimeoutMs: env.PROVIDER_TIMEOUT_MS,
        runDeadline: Date.now() + env.RUN_TIMEOUT_MS,
        provenanceExecutedAt,
        resume,
      },
      {
        onStep: persistStep,
        onMalformedOutput: persistMalformed,
        onDelta: live?.delta
          ? (kind, text) => {
              try {
                live.delta!(kind, text);
              } catch {
                /* observational only */
              }
            }
          : undefined,
      },
    );
  } catch (err) {
    // AMBIGUOUS provider outcome (timeout/transport/partial) during primary/review/revision → the remote may
    // have executed + charged: fail closed to reconciliation, never a rebill or a fabricated zero-cost result.
    if (err instanceof AmbiguousProviderOutcomeSignal) {
      return finalizeReconciliation(ctx, runId, taskId, err.stepNumber, 'ambiguous_provider_outcome');
    }
    if (err instanceof ReconciliationRequiredSignal) {
      return finalizeReconciliation(ctx, runId, taskId, err.stepNumber);
    }
    if (err instanceof RunCancelledSignal) {
      return finalizeCancelledOutcome(ctx, runId, taskId, err.stepNumber);
    }
    if (err instanceof LeaseLostSignal) {
      // The pinned employee changed underfoot → fail the run (no owner to defer to). A truly-lost lease
      // (a reclaimed job) propagates so the worker backs off WITHOUT touching the winner's run.
      if (err.reason === 'identity_changed') {
        return finalizeFailed(ctx, runId, taskId, 'Pinned employee is no longer assignable.', undefined, true);
      }
      throw err;
    }
    throw err; // an injected crash / unexpected error — leave whatever durably committed for a later resume.
  }

  if (!result.ok) {
    return finalizeFailed(ctx, runId, taskId, result.failureReason ?? 'Run failed.', jobCtx);
  }

  // Hub P1d — reliable post-run extraction is now PART of finalization (option A): the decision/knowledge
  // extraction provider calls are fenced + CHECKPOINTED here, BEFORE the terminal transition, so the run is
  // never reported completed while a required extraction call could still fire outside the reliability state
  // machine. Runs only when the run WILL COMPLETE (no surviving approval) — matching the prior gate, under
  // which extraction never ran for an awaiting_approval run.
  let willComplete = result.proposedActions.length === 0;
  if (!willComplete) {
    // Parity with the prior post-finalize `outcome.status === 'completed'` gate: if every proposed action is
    // suppressed as a duplicate the run still COMPLETES (→ extraction applies); a single surviving approval
    // makes it awaiting_approval (→ no extraction).
    willComplete = !(await withTenant(ctx, async (tx) => {
      for (const action of result.proposedActions) {
        if (!(await pendingDuplicateExists(tx, ctx, action.type, action.payloadSha256))) return true;
      }
      return false;
    }));
  }
  if (willComplete) {
    try {
      await runReliableExtraction(result);
    } catch (err) {
      // Extraction lives inside the reliability boundary now: an ambiguous provider outcome, an uncertain
      // extraction dispatch, a cooperative cancel at the boundary, or a lost lease resolves like an engine step.
      if (err instanceof AmbiguousProviderOutcomeSignal) {
        return finalizeReconciliation(ctx, runId, taskId, err.stepNumber, 'ambiguous_provider_outcome');
      }
      if (err instanceof ReconciliationRequiredSignal) {
        return finalizeReconciliation(ctx, runId, taskId, err.stepNumber);
      }
      if (err instanceof RunCancelledSignal) {
        return finalizeCancelledOutcome(ctx, runId, taskId, err.stepNumber);
      }
      if (err instanceof LeaseLostSignal) {
        if (err.reason === 'identity_changed') {
          return finalizeFailed(ctx, runId, taskId, 'Pinned employee is no longer assignable.', undefined, true);
        }
        throw err;
      }
      throw err; // an injected crash / unexpected error — leave whatever durably committed for a later resume.
    }
  }

  return finalizeCompleted(ctx, runId, taskId, result, primaryRow, jobCtx);
}

/** Reconstruct the outcome of an ALREADY-terminal run (idempotent-success paths). */
async function terminalOutcome(
  tx: DbTx,
  runId: string,
  taskId: string,
  state: ReliabilityState,
): Promise<RunOutcome> {
  if (state === 'completed') {
    const t = (await tx.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).limit(1))[0];
    return { runId, status: t?.status === 'awaiting_approval' ? 'awaiting_approval' : 'completed', failureReason: null };
  }
  if (state === 'cancelled') return { runId, status: 'cancelled', failureReason: null };
  if (state === 'reconciliation_required') {
    return { runId, status: 'reconciliation_required', failureReason: 'reconciliation_required' };
  }
  const r = (await tx.select({ err: runs.errorMessage }).from(runs).where(eq(runs.id, runId)).limit(1))[0];
  return { runId, status: 'failed', failureReason: r?.err ?? 'failed' };
}

/**
 * Idempotent finalization of a completed engine result. Two phases so a resume can prove where it stopped:
 * (1) checkpoint the consolidated result + reliability_state='finalizing'; (2) apply the terminal state
 * (approvals, run completed, task terminal, audits) atomically. Re-entry is safe: an already-terminal run
 * returns its existing outcome with NO provider call and NO duplicate usage/result/approval/audit; a
 * CONFLICTING checkpoint for the same run fails closed. Only the current lease owner may finalize.
 */
async function finalizeCompleted(
  ctx: TenantContext,
  runId: string,
  taskId: string,
  result: Awaited<ReturnType<typeof executeRun>>,
  primaryRow: AgentRow,
  jobCtx: RunJobContext | undefined,
): Promise<RunOutcome> {
  // Lease-owner-only: a stale worker whose lease was reclaimed must not overwrite the winner's outcome.
  if (jobCtx && !(await jobCtx.ownsLease())) throw new LeaseLostSignal('lease_lost');

  // Phase 1 — idempotency guard + finalizing marker + checkpointed result.
  const phase1 = await withTenant(ctx, async (tx) => {
    const run = (
      await tx
        .select({ state: runs.reliabilityState, checkpointed: runs.checkpointedResult })
        .from(runs)
        .where(eq(runs.id, runId))
        .limit(1)
    )[0];
    if (!run) throw new AppError('not_found', 'Run not found.');
    if (isTerminalReliability(run.state)) {
      return { done: true as const, outcome: await terminalOutcome(tx, runId, taskId, run.state!) };
    }
    if (run.checkpointed != null && run.checkpointed !== result.consolidated) {
      throw new ConflictError('Conflicting finalize checkpoint for this run.');
    }
    const resuming = run.state === 'finalizing';
    await tx
      .update(runs)
      .set({ checkpointedResult: result.consolidated, reliabilityState: 'finalizing', updatedAt: new Date() })
      .where(eq(runs.id, runId));
    if (resuming) {
      await writeAudit(tx, ctx, { action: 'run.finalization_resumed', entityType: 'run', entityId: runId, detail: {} });
    }
    return { done: false as const, outcome: null };
  });
  if (phase1.done) return phase1.outcome;

  // A crash HERE (finalizing marker committed, terminal not yet applied) is resolved on resume via the
  // finalization_resumed path — idempotently, with no duplicate approvals/usage/audits.
  await testPoint('after-finalizing-marker');

  // Phase 2 — atomic terminal apply. Because phase 1 short-circuits on a terminal run, this runs at most
  // once per successful finalize; a crash before its commit leaves reliability_state='finalizing' and a
  // resume redoes it cleanly (no duplicates — nothing committed).
  const outcome = await withTenant(ctx, async (tx) => {
    let authorizationsRequested = 0;
    for (const action of result.proposedActions) {
      if (await pendingDuplicateExists(tx, ctx, action.type, action.payloadSha256)) {
        await writeAudit(tx, ctx, {
          action: 'approval.duplicate_suppressed',
          entityType: 'task',
          entityId: taskId,
          detail: { actionType: action.type, summary: action.summary, payloadSha256: action.payloadSha256 },
        });
        continue;
      }
      const inserted = await tx
        .insert(approvals)
        .values({
          orgId: ctx.orgId,
          projectId: ctx.projectId,
          taskId,
          runId,
          actionType: action.type,
          payload: action.payload,
          payloadSha256: action.payloadSha256,
          summary: action.summary,
          status: 'pending',
          requestedBy: primaryRow.provider,
          expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
        })
        .returning({ id: approvals.id });
      authorizationsRequested += 1;
      await writeAudit(tx, ctx, {
        action: 'approval.requested',
        entityType: 'approval',
        entityId: inserted[0]!.id,
        detail: { actionType: action.type, summary: action.summary },
      });
    }

    // GM delegation — authority decided HERE, at the trust boundary: only the workspace's General
    // Manager (projects.owner_agent_id) may spawn work; a delegation block from anyone else is
    // dropped and audited. Delegated tasks are internal reversible work (they run automatically);
    // anything consequential a delegated employee proposes still lands in the approvals queue.
    let delegationsCreated = 0;
    if (result.delegatedTasks.length > 0) {
      const proj = await tx
        .select({ ownerAgentId: projects.ownerAgentId, key: projects.key })
        .from(projects)
        .where(eq(projects.id, ctx.projectId))
        .limit(1);
      if (proj[0]?.ownerAgentId !== primaryRow.id) {
        await writeAudit(tx, ctx, {
          action: 'task.delegation_rejected',
          entityType: 'task',
          entityId: taskId,
          detail: { reason: 'delegator_is_not_general_manager', delegatorAgentId: primaryRow.id, count: result.delegatedTasks.length },
        });
      } else {
        const ownKey = proj[0].key;
        const hqProjectKey = resolveHqProjectKey();
        const parent = await tx.select({ objectiveId: tasks.objectiveId }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
        for (const d of result.delegatedTasks.slice(0, MAX_DELEGATIONS_PER_RUN)) {
          // Cross-workspace delegation (v2): NEVER executed directly. Only headquarters' Chief of
          // Staff may propose one, and it becomes an org_delegation approval in the owner's Inbox —
          // on Okay, the executor creates the task for the target workspace's General Manager.
          if (d.workspace && d.workspace !== ownKey) {
            if (!hqProjectKey || ownKey !== hqProjectKey) {
              await writeAudit(tx, ctx, {
                action: 'task.delegation_rejected',
                entityType: 'task',
                entityId: taskId,
                detail: { reason: 'cross_workspace_requires_headquarters', workspace: d.workspace, title: d.title },
              });
              continue;
            }
            const payload = { targetProjectKey: d.workspace, title: d.title, instructions: d.instructions };
            const payloadSha256 = sha256Hex(canonicalJson(payload));
            if (await pendingDuplicateExists(tx, ctx, 'org_delegation', payloadSha256)) {
              await writeAudit(tx, ctx, {
                action: 'approval.duplicate_suppressed',
                entityType: 'task',
                entityId: taskId,
                detail: { actionType: 'org_delegation', summary: d.title, payloadSha256 },
              });
              continue;
            }
            const insertedApproval = await tx
              .insert(approvals)
              .values({
                orgId: ctx.orgId,
                projectId: ctx.projectId,
                taskId,
                runId,
                actionType: 'org_delegation',
                payload,
                payloadSha256,
                summary: `Delegate to ${d.workspace}: ${d.title}`,
                status: 'pending',
                requestedBy: primaryRow.provider,
                expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
              })
              .returning({ id: approvals.id });
            authorizationsRequested += 1;
            await writeAudit(tx, ctx, {
              action: 'approval.requested',
              entityType: 'approval',
              entityId: insertedApproval[0]!.id,
              detail: { actionType: 'org_delegation', summary: `Delegate to ${d.workspace}: ${d.title}` },
            });
            continue;
          }
          const assignee = (
            await tx
              .select({ id: agents.id, provider: agents.provider })
              .from(agents)
              .where(and(eq(agents.projectId, ctx.projectId), eq(agents.name, d.assignee), eq(agents.enabled, true), eq(agents.role, 'primary')))
              .limit(1)
          )[0];
          if (!assignee || assignee.id === primaryRow.id) {
            await writeAudit(tx, ctx, {
              action: 'task.delegation_rejected',
              entityType: 'task',
              entityId: taskId,
              detail: { reason: assignee ? 'gm_cannot_assign_itself' : 'assignee_not_assignable', assignee: d.assignee, title: d.title },
            });
            continue;
          }
          try {
            const newTaskId = await createTask(tx, ctx, {
              title: d.title,
              input: `Assignment from the General Manager:\n\n${d.instructions}`,
              providerSelection: assignee.provider,
              reviewEnabled: false,
              primaryAgentId: assignee.id,
              objectiveId: parent[0]?.objectiveId ?? null,
            });
            // Queue directly (mirrors enqueueRun; jobs.ts imports this module, so no back-import).
            await tx
              .insert(runJobs)
              .values({ orgId: ctx.orgId, projectId: ctx.projectId, taskId: newTaskId, status: 'queued', dispatchKind: 'standing' })
              .onConflictDoNothing();
            await writeAudit(tx, ctx, { action: 'run_job.enqueued', entityType: 'task', entityId: newTaskId, detail: { dispatchKind: 'standing', delegated: true } });
            await writeAudit(tx, ctx, {
              action: 'task.delegated',
              entityType: 'task',
              entityId: newTaskId,
              detail: { byAgentId: primaryRow.id, toAgentId: assignee.id, assignee: d.assignee, title: d.title, sourceTaskId: taskId, sourceRunId: runId },
            });
            delegationsCreated += 1;
          } catch (err) {
            // createTask validates BEFORE any insert, so a rejection leaves the transaction healthy.
            await writeAudit(tx, ctx, {
              action: 'task.delegation_rejected',
              entityType: 'task',
              entityId: taskId,
              detail: { reason: 'creation_failed', assignee: d.assignee, title: d.title, error: err instanceof Error ? err.message : 'unknown' },
            });
          }
        }
      }
    }

    // Deliverables to the workspace shelf: internal, reversible, audited (artifact.created inside
    // createTextArtifact). Any employee may save them; failures never fail the run's finalize.
    let artifactsCreated = 0;
    for (const a of result.runArtifacts) {
      try {
        await createTextArtifact(tx, ctx, { name: a.name, kind: a.kind, content: a.content, taskId, runId });
        artifactsCreated += 1;
      } catch (err) {
        log.warn('run artifact save failed (run unaffected)', { runId, name: a.name, errorClass: err instanceof Error ? err.name : 'unknown' });
      }
    }

    // Ask-the-owner: any employee's questions become open Inbox items (bounded, deduped, audited
    // inside createOwnerQuestions). Failures never fail the run's finalize.
    let questionsAsked = 0;
    if (result.ownerQuestions.length > 0) {
      try {
        questionsAsked = await createOwnerQuestions(tx, ctx, {
          taskId,
          runId,
          agentId: primaryRow.id,
          questions: result.ownerQuestions,
        });
      } catch (err) {
        log.warn('owner question save failed (run unaffected)', { runId, errorClass: err instanceof Error ? err.name : 'unknown' });
      }
    }

    const finalStatus = authorizationsRequested > 0 ? ('awaiting_approval' as const) : ('completed' as const);

    await tx
      .update(runs)
      .set({
        status: 'completed',
        consolidatedResult: result.consolidated,
        reliabilityState: 'completed',
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(runs.id, runId));
    await tx.update(tasks).set({ status: finalStatus, updatedAt: new Date() }).where(eq(tasks.id, taskId));

    await writeAudit(tx, ctx, {
      action: 'run.completed',
      entityType: 'run',
      entityId: runId,
      detail: { steps: result.steps.length, proposedActions: result.proposedActions.length, delegationsCreated, artifactsCreated, questionsAsked, finalStatus },
    });
    await writeAudit(tx, ctx, {
      action: 'run.finalization_completed',
      entityType: 'run',
      entityId: runId,
      detail: { finalStatus },
    });

    return { runId, status: finalStatus, failureReason: null as string | null };
  });

  await testPoint('after-finalize');
  return outcome;
}

/** Idempotent failed-finalization (engine failure or lost pinned identity). */
async function finalizeFailed(
  ctx: TenantContext,
  runId: string,
  taskId: string,
  reason: string,
  jobCtx: RunJobContext | undefined,
  skipOwnershipRecheck = false,
): Promise<RunOutcome> {
  if (!skipOwnershipRecheck && jobCtx && !(await jobCtx.ownsLease())) throw new LeaseLostSignal('lease_lost');
  return withTenant(ctx, async (tx) => {
    const run = (await tx.select({ state: runs.reliabilityState }).from(runs).where(eq(runs.id, runId)).limit(1))[0];
    if (run && isTerminalReliability(run.state)) return terminalOutcome(tx, runId, taskId, run.state!);
    await tx
      .update(runs)
      .set({ status: 'failed', reliabilityState: 'failed', errorMessage: reason, finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(runs.id, runId));
    await tx.update(tasks).set({ status: 'failed', updatedAt: new Date() }).where(eq(tasks.id, taskId));
    await writeAudit(tx, ctx, { action: 'run.failed', entityType: 'run', entityId: runId, detail: { reason } });
    log.warn('Run failed', { runId, failureClass: reason.split(/[\s(:]/, 1)[0] || 'unknown', recoverable: true });
    return { runId, status: 'failed', failureReason: reason };
  });
}

/**
 * Resolve an UNCERTAIN dispatch: a step was dispatched but its remote outcome is unknown — either detected on
 * resume (intent recorded, no result checkpoint after a crash) or observed IN-PROCESS as an ambiguous provider
 * outcome (`reason='ambiguous_provider_outcome'` — timeout/transport/partial). Either way: reconciliation is
 * required, ZERO automatic retry (in this process or after recovery), and NEITHER a fabricated result NOR any
 * usage/token/cost row is written — the external charge and remote completion are explicitly UNKNOWN. A
 * separate future recovery decision (never a silent rebill) resolves it.
 */
async function finalizeReconciliation(
  ctx: TenantContext,
  runId: string,
  taskId: string,
  stepNumber: number,
  reason: 'uncertain_dispatch_on_resume' | 'ambiguous_provider_outcome' = 'uncertain_dispatch_on_resume',
): Promise<RunOutcome> {
  return withTenant(ctx, async (tx) => {
    const run = (await tx.select({ state: runs.reliabilityState }).from(runs).where(eq(runs.id, runId)).limit(1))[0];
    if (run && isTerminalReliability(run.state)) return terminalOutcome(tx, runId, taskId, run.state!);
    await tx
      .update(runs)
      .set({
        status: 'failed',
        reliabilityState: 'reconciliation_required',
        errorMessage:
          'Uncertain provider outcome — a step was dispatched but its remote result and any external charge are unknown. Manual reconciliation required (no automatic retry, no rebill).',
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(runs.id, runId));
    await tx.update(tasks).set({ status: 'failed', updatedAt: new Date() }).where(eq(tasks.id, taskId));
    await writeAudit(tx, ctx, {
      action: 'run.uncertain_outcome_detected',
      entityType: 'run',
      entityId: runId,
      detail: { stepNumber, reason, remoteOutcome: 'unknown', externalChargeKnown: false },
    });
    return { runId, status: 'reconciliation_required', failureReason: 'reconciliation_required' };
  });
}

/** Resolve a cooperative cancel detected at a dispatch boundary (zero provider calls; no fabricated result). */
async function finalizeCancelledOutcome(
  ctx: TenantContext,
  runId: string,
  taskId: string,
  stepNumber: number,
): Promise<RunOutcome> {
  return withTenant(ctx, async (tx) => {
    const run = (await tx.select({ state: runs.reliabilityState }).from(runs).where(eq(runs.id, runId)).limit(1))[0];
    if (run && isTerminalReliability(run.state)) return terminalOutcome(tx, runId, taskId, run.state!);
    await tx
      .update(runs)
      .set({
        status: 'failed',
        reliabilityState: 'cancelled',
        errorMessage: 'Cancelled before dispatch.',
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(runs.id, runId));
    // Terminal-transition the task to cancelled; its cooperative cancel marker (cancelReason) is preserved.
    await tx.update(tasks).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(tasks.id, taskId));
    await writeAudit(tx, ctx, { action: 'run.cancelled', entityType: 'run', entityId: runId, detail: { stepNumber, reason: 'cancelled_before_dispatch' } });
    return { runId, status: 'cancelled', failureReason: null };
  });
}
