import 'server-only';
import { eq, and } from 'drizzle-orm';
import { type TenantContext } from '@/types/domain';
import { type ProviderId } from '@/types/provider';
import { AppError } from '@/lib/errors';
import { serverEnv } from '@/lib/env.server';
import { log } from '@/lib/log';
import { withTenant } from '@/db/tenant';
import { approvals, messages, projects, runs, runSteps, tasks } from '@/db/schema';
import { getProvider, otherProvider } from '@/providers/registry';
import {
  executeRun,
  type EngineAgent,
  type StepRecord,
} from '@/orchestration/engine';
import { AUTHORITY } from '@/orchestration/prompts';
import { resolveModelForTier } from '@/orchestration/routing';
import {
  type ContextManifestEntry,
  type Freshness,
  type ModelTier,
  type RetrievedDocRef,
  type RunSourceSnapshot,
  type StepKind,
} from '@/types/domain';
import { agentExecutionFingerprint, findAgentForRole, type AgentRow } from '@/domain/agents/agents';
import { assembleCurrentOperatingPriorities } from '@/domain/prompts/effective-prompt';
import { computeActivityClassification } from '@/domain/classification/classification';
import { ASSEMBLER_VERSION, assembleEffectivePrompt } from '@/orchestration/prompts';
import { sha256Hex } from '@/lib/crypto';
import { selectRelevantKnowledge, logKnowledgeApplications } from '@/domain/knowledge/knowledge';
import { loadObjectiveForRun } from '@/domain/objectives/objectives';
import { assembleDocumentSources } from '@/domain/documents/retrieval-mode';
import { writeRunVersionEvidence } from '@/domain/documents/references';
import { assembleProjectState } from '@/domain/state/project-state';
import { assembleTaskGraph } from '@/domain/dependencies/graph-context';
import { assembleDecisionMemory, logDecisionInjections, objectiveTaskIds } from '@/domain/decisions/decisions';
import { extractCandidatesForRun, type ExtractFn } from '@/domain/decisions/extraction';
import { extractKnowledgeForRun } from '@/domain/knowledge/extraction';
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
 *   preflight (budget, rate limit, agent + context resolution)
 *   → engine.executeRun (primary → review → one revision → consolidate)
 *   → per step: run_steps + messages + usage_events, committed AS THEY HAPPEN
 *   → action proposals → approvals (pending) with expiry
 *   → task status + audit
 *
 * Step persistence uses its own withTenant transaction per step on purpose: a
 * crash mid-run must not roll back the record of money already spent (I8) or
 * messages already produced (I7).
 */

const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export interface RunOutcome {
  readonly runId: string;
  readonly status: 'completed' | 'awaiting_approval' | 'failed';
  readonly failureReason: string | null;
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
    provider: getProvider(row.provider),
    // D-014: flagship tier overrides the configured model per provider.
    model: resolveModelForTier(tier, row.provider, row.model),
    systemPrompt: row.systemPrompt,
    temperature: row.temperatureMilli / 1000,
    maxOutputTokens: row.maxOutputTokens,
  };
}

/** Which vendor is primary / reviewer for this task's provider selection. */
export function resolveProviderPair(selection: 'openai' | 'anthropic' | 'both', reviewEnabled: boolean): {
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

export async function startRun(
  ctx: TenantContext,
  taskId: string,
  live?: RunLiveEvents,
): Promise<RunOutcome> {
  const env = serverEnv();

  const nowIso = new Date().toISOString();

  // ---- Preflight, one transaction -----------------------------------------
  const preflight = await withTenant(ctx, async (tx) => {
    const taskRows = await tx
      .select()
      .from(tasks)
      .where(
        and(eq(tasks.id, taskId), eq(tasks.projectId, ctx.projectId), eq(tasks.orgId, ctx.orgId)),
      )
      .limit(1);
    const task = taskRows[0];
    if (!task) throw new AppError('not_found', 'Task not found.');
    if (task.status === 'running') {
      throw new AppError('run_invalid_state', 'This task already has a run in progress.');
    }

    await consumeRateLimit(tx, `runs:user:${ctx.userId}`, env.RATE_LIMIT_RUNS_PER_MINUTE);
    await consumeRateLimit(tx, `runs:project:${ctx.projectId}`, env.RATE_LIMIT_RUNS_PER_MINUTE);
    await assertWithinBudget(tx, ctx.projectId);

    const pair = resolveProviderPair(task.providerSelection, task.reviewEnabled);
    const primaryRow = await findAgentForRole(tx, ctx, 'primary', pair.primary);
    if (!primaryRow) {
      throw new AppError(
        'validation',
        `No enabled primary agent configured for ${pair.primary} in this project.`,
      );
    }
    let reviewerRow: AgentRow | null = null;
    if (pair.reviewer) {
      reviewerRow = await findAgentForRole(tx, ctx, 'reviewer', pair.reviewer);
      if (!reviewerRow) {
        throw new AppError(
          'validation',
          `Review is enabled but no reviewer agent is configured for ${pair.reviewer}.`,
        );
      }
    }

    // Owner intent that frames the work (closes O-9); tenant-scoped, null when
    // the task serves no live objective.
    const objective = await loadObjectiveForRun(tx, ctx, task.objectiveId);
    // Isolation invariant I1: ONLY this project's ACTIVE knowledge — and now RELEVANCE-GATED, not
    // wholesale charter. Approval permits a record to be used; relevance (shared subject with the
    // task + objective) decides whether it belongs in THIS run. Unrelated active knowledge is omitted.
    const knowledgeQuery = [task.input, objective?.title, objective?.description].filter(Boolean).join(' ');
    const knowledge = await selectRelevantKnowledge(tx, ctx, {
      queryText: knowledgeQuery,
      consumerType: 'task_run', // purpose (current operational fact) is derived from this
      currentTaskId: taskId,
      currentObjectiveId: task.objectiveId,
      // Restricted Knowledge is disclosed only if EVERY agent that will consume this run's context is
      // granted. Both the primary and (when present) the reviewer read the same context package.
      consumerAgentIds: [primaryRow.id, reviewerRow?.id].filter((id): id is string => !!id),
    });
    // Balanced context package (O-14, CONTEXT-PACKAGE.md). Retrieval is
    // unchanged (D-020); we ADD a small quota of foundational references and a
    // production-status doc that relevance alone would crowd out, dedup them
    // against what retrieval already surfaced, and record WHY each part was
    // included. Every read below is tenant-scoped by the same I1 guard.
    // Retrieval runs under the workspace's server-authoritative mode (Stage C2): legacy or shadow →
    // legacy is authoritative (shadow also compares the versioned path, non-authoritatively); versioned →
    // the current-version path is authoritative and the run writes version-bound evidence below.
    // Disclosure authorization is derived server-side from the operation (task_run) and its consuming
    // agents (primary + reviewer) — the same identities that gate restricted Knowledge. Restricted
    // Documents reach the prompt only when every consumer holds a live matching grant; otherwise the
    // versioned path withholds them inside retrieval.
    const docSources = await assembleDocumentSources(tx, ctx, task.input, 5, {
      consumerType: 'task_run',
      consumerAgentIds: [primaryRow.id, reviewerRow?.id].filter((id): id is string => !!id),
    });
    const retrieved = docSources.retrieved;
    const coreRefs = docSources.coreRefs;
    const productionStatus = docSources.productionStatus;

    // Project State (O-15): operational Hub records for this workspace,
    // preferring the attached objective. The current task is excluded from its
    // own state. Tenant-scoped by the same I1 guard. Deduped by construction —
    // these are Hub records, not documents, so they cannot collide with the
    // document sources above.
    const projectState = await assembleProjectState(tx, ctx, task.objectiveId, taskId);
    // Task Dependency Graph (O-18): bounded neighborhood of explicit, recorded
    // dependencies for THIS task — prerequisites, dependents, blockers, what it
    // unlocks, cycles. Level-1 Hub state; tenant-scoped by the same I1 guard.
    const taskGraph = await assembleTaskGraph(tx, ctx, taskId);
    // Decision Memory (O-19): accepted organizational decisions relevant to
    // this run, ranked by task/objective/document/recency, bounded to 10.
    // Level-1 Hub state; superseded decisions are never retrieved.
    const objTaskIds = await objectiveTaskIds(tx, ctx, task.objectiveId);
    const decisionMemory = await assembleDecisionMemory(tx, ctx, {
      currentTaskId: taskId,
      currentObjectiveId: task.objectiveId,
      objectiveTaskIds: objTaskIds,
      docPaths: new Set(retrieved.map((r) => r.relativePath)),
    });

    // Document freshness (O-17): indexed-file mtime (medium confidence) plus an
    // explicit parsed "as of" date when present (high confidence). Never infers
    // dates from prose, file creation, or the run clock.
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

    // Authority-labeled context (O-16). Hub state is Level 1, approved
    // knowledge Level 2, project documents Level 3 — the prompt builder groups
    // and labels these so the model treats Hub state as the current record.
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
        ? [
            {
              ...taskGraph.contextItem,
              authority: AUTHORITY.HUB_STATE,
              kind: 'Task dependency graph',
            },
          ]
        : []),
      ...(decisionMemory.contextItem
        ? [
            {
              ...decisionMemory.contextItem,
              authority: AUTHORITY.HUB_STATE,
              kind: 'Decision memory',
            },
          ]
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
    ];

    // Precompute the Hub-vs-document freshness relation (O-17). The
    // production-status document is the operational-claim surface — find it
    // wherever it landed (its dedicated slot OR the retrieved set, since
    // retrieval may surface it first and dedup it out of the slot). Null when
    // either side lacks a usable date.
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

    // IMMUTABLE source snapshot (source-integrity): the exact evidence supplied to THIS run — every
    // citable document at the version, disclosure, and chunk text the model actually received. Later
    // Knowledge extraction cites against this, never re-reading live documents. Covers everything the
    // model could ground a claim on: retrieved chunks, core references, and the production-status doc.
    const suppliedSources = [...retrieved, ...coreRefs, ...(productionStatus ? [productionStatus] : [])];
    const retrievedSources: RunSourceSnapshot[] = suppliedSources.map((r) => ({
      relativePath: r.relativePath,
      sha256: r.sha256,
      disclosure: r.disclosure,
      chunkIndex: r.chunkIndex,
      rank: r.rank,
      excerpt: r.content,
      // Present only under the versioned path — the exact immutable version this evidence came from.
      documentVersionId: r.documentVersionId,
    }));

    // The manifest is the explainable record of the assembled package.
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
      // Project State manifest entries (objective_progress / active_work /
      // blocker / recent_outcome / pending_review) are already shaped, incl.
      // freshness on objective_progress.
      ...projectState.manifest,
      // Task-graph manifest entry (O-18) carries node/edge/root/cycle metadata.
      ...taskGraph.manifest,
      // Decision-memory manifest entries (O-19): title/status/task/date.
      ...decisionMemory.manifest,
    ];

    // HUB-008 — the trusted Current Operating Priorities block (active objectives/criteria/milestones), and
    // the immutable reproducibility identity of the effective prompts. Built with the SAME canonical
    // assembler the engine uses, so the persisted effective-prompt hash equals what is dispatched.
    const priorities = await assembleCurrentOperatingPriorities(tx, ctx, taskId);
    const operatingPriorities = priorities.text;
    const primaryAssembled = assembleEffectivePrompt({
      variant: 'primary', agentSystemPrompt: primaryRow.systemPrompt, taskInput: task.input,
      contextItems, objective, freshnessComparison, operatingPriorities,
    });
    const approvedPolicies = contextItems.filter((i) => i.kind === 'Decision memory');
    const reviewerAssembled = reviewerRow
      ? assembleEffectivePrompt({ variant: 'review', agentSystemPrompt: reviewerRow.systemPrompt, taskInput: task.input, primaryResponse: '', approvedPolicies, operatingPriorities })
      : null;
    // Manifest objective snapshot: hash an IMMUTABLE content snapshot that includes the title AND each
    // criterion's label, target, and unit. `loadObjectiveForRun` intentionally strips targets from the
    // rendered prompt (it lists unmet criterion labels), so we source the full criteria from the active
    // objective in the operating priorities when this run's objective is one of them; otherwise (e.g. a
    // task tied to a now-closed objective) we hash the loaded objective title/description/criteria labels.
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

    // HUB-009 — resolve the run's data classification BEFORE dispatch from the effective classification of
    // {project, task, performing agents} (seed > demo > live) and snapshot it immutably on the run. A later
    // reclassification of any parent never rewrites this. run_steps/messages inherit this run snapshot.
    const projectRow = (
      await tx.select({ classification: projects.classification }).from(projects).where(eq(projects.id, ctx.projectId)).limit(1)
    )[0];
    const runClassification = computeActivityClassification({
      projectClassification: projectRow?.classification,
      taskClassification: task.classification,
      performerClassifications: [primaryRow.classification, reviewerRow?.classification ?? null],
    }).classification;

    const runInserted = await tx
      .insert(runs)
      .values({
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        taskId,
        status: 'running',
        primaryAgentId: primaryRow.id,
        reviewerAgentId: reviewerRow?.id ?? null,
        retrievedDocuments: retrievedRefs.length > 0 ? retrievedRefs : null,
        contextManifest: contextManifest.length > 0 ? contextManifest : null,
        retrievedSources: retrievedSources.length > 0 ? retrievedSources : null,
        // HUB-008 reproducibility — captured immutably at dispatch (a later prompt edit can't rewrite it).
        primaryConfigHash: agentExecutionFingerprint(primaryRow),
        reviewerConfigHash: reviewerRow ? agentExecutionFingerprint(reviewerRow) : null,
        primaryPromptHash: sha256Hex(primaryRow.systemPrompt),
        reviewerPromptHash: reviewerRow ? sha256Hex(reviewerRow.systemPrompt) : null,
        primaryEffectivePromptHash: sha256Hex(`${primaryAssembled.system}\n${primaryAssembled.userTurn}`),
        reviewerEffectivePromptHash: reviewerAssembled ? sha256Hex(`${reviewerAssembled.system}\n${reviewerAssembled.userTurn}`) : null,
        assemblerVersion: ASSEMBLER_VERSION,
        sourceManifest,
        classification: runClassification,
      })
      .returning({ id: runs.id });
    const runId = runInserted[0]!.id;

    // Versioned-path evidence (Stage C2): the normalized run→version relationships are written HERE, in
    // the same durable operation that created the run and BEFORE provider dispatch — so a successful run
    // can never end with a Document excerpt in its prompt but no durable version relationship. The
    // immutable JSON snapshot (retrievedSources, with documentVersionId) is the historical representation;
    // these rows are the referential-integrity relationship. Idempotent.
    if (docSources.versioned) {
      await writeRunVersionEvidence(
        tx,
        ctx,
        runId,
        suppliedSources
          .filter((r): r is typeof r & { documentVersionId: string } => !!r.documentVersionId)
          .map((r) => ({ documentVersionId: r.documentVersionId, chunkIndex: r.chunkIndex, rank: r.rank, disclosure: r.disclosure, retrievalReason: 'run_context' })),
      );
    }

    // The honest reverse trail: record which decisions and knowledge were INJECTED into this run
    // (supplied, not "influenced").
    await logDecisionInjections(tx, ctx, { runId, taskId, injected: decisionMemory.injected });
    await logKnowledgeApplications(tx, ctx, { consumerType: 'task_run', consumerId: runId, runId, taskId, injected: knowledge });

    await tx
      .update(tasks)
      .set({ status: 'running', updatedAt: new Date() })
      .where(eq(tasks.id, taskId));

    // The user's brief becomes the first immutable message of the run.
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

    return { task, runId, primaryRow, reviewerRow, contextItems, objective, freshnessComparison, operatingPriorities };
  });

  const { task, runId, primaryRow, reviewerRow, contextItems, objective, freshnessComparison, operatingPriorities } =
    preflight;

  // ---- Engine execution ----------------------------------------------------
  // Each step commits its own transaction: a mid-run crash must not erase the
  // record of tokens already bought or messages already produced.
  const persistStep = async (record: StepRecord): Promise<void> => {
    await withTenant(ctx, async (tx) => {
      const agentRow =
        record.agentId === primaryRow.id
          ? primaryRow
          : record.agentId === reviewerRow?.id
            ? reviewerRow
            : null;

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
        .returning({ id: runSteps.id });
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

        // Invariant I8: bill even for steps whose run later fails.
        await recordUsage(tx, ctx, {
          taskId,
          runId,
          runStepId,
          provider: record.response.provider,
          model: record.response.model,
          usage: record.response.usage,
        });
      }
    });
    // Notify AFTER the step is durably persisted; observer errors are the
    // observer's problem, never the run's.
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

  const result = await executeRun(
    {
      taskInput: task.input,
      contextItems,
      operatingPriorities,
      objective,
      freshnessComparison,
      primary: toEngineAgent(primaryRow, task.modelTier),
      reviewer: reviewerRow ? toEngineAgent(reviewerRow, task.modelTier) : null,
      perCallTimeoutMs: env.PROVIDER_TIMEOUT_MS,
      runDeadline: Date.now() + env.RUN_TIMEOUT_MS,
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

  // ---- Finalize ------------------------------------------------------------
  const outcome = await withTenant(ctx, async (tx) => {
    if (!result.ok) {
      await tx
        .update(runs)
        .set({
          status: 'failed',
          errorMessage: result.failureReason,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(runs.id, runId));
      await tx
        .update(tasks)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(eq(tasks.id, taskId));
      await writeAudit(tx, ctx, {
        action: 'run.failed',
        entityType: 'run',
        entityId: runId,
        detail: { reason: result.failureReason },
      });
      log.warn('Run failed', { runId, reason: result.failureReason });
      return { runId, status: 'failed' as const, failureReason: result.failureReason };
    }

    // Proposed actions become PENDING approvals — never executions (I4). An exact duplicate of an
    // already-pending authorization (same action type + canonical payload hash) is suppressed so the
    // operator can never be asked to authorize the same external action twice.
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

    // The task holds at the gate only if it actually raised a pending authorization. If every
    // proposal was an exact duplicate of one already pending, there is nothing new to authorize.
    const finalStatus =
      authorizationsRequested > 0 ? ('awaiting_approval' as const) : ('completed' as const);

    await tx
      .update(runs)
      .set({
        status: 'completed',
        consolidatedResult: result.consolidated,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(runs.id, runId));
    await tx
      .update(tasks)
      .set({ status: finalStatus, updatedAt: new Date() })
      .where(eq(tasks.id, taskId));

    await writeAudit(tx, ctx, {
      action: 'run.completed',
      entityType: 'run',
      entityId: runId,
      detail: {
        steps: result.steps.length,
        proposedActions: result.proposedActions.length,
        finalStatus,
      },
    });

    return { runId, status: finalStatus, failureReason: null };
  });

  // ---- AI decision-candidate extraction (O-20) ----------------------------
  // Separate, bounded, ONE structured call on the primary provider AFTER the
  // task is completed. Fail-safe: any error records a 'failed' extraction
  // status and is swallowed — the completed task is never affected. Idempotent
  // via runs.candidate_extraction_status. Skipped when a run awaits approval or
  // failed (only extract from a cleanly completed conclusion).
  if (outcome.status === 'completed') {
    try {
      await withTenant(ctx, async (tx) => {
        const extract: ExtractFn = async (system, user) => {
          const provider = getProvider(primaryRow.provider);
          const resp = await provider.execute({
            model: primaryRow.model, // standard tier — a cheap bounded call
            system,
            turns: [{ role: 'user', content: user }],
            temperature: 0,
            maxOutputTokens: 1500,
            timeoutMs: env.PROVIDER_TIMEOUT_MS,
          });
          await recordUsage(tx, ctx, {
            taskId,
            runId: outcome.runId,
            runStepId: null,
            provider: primaryRow.provider,
            model: resp.model,
            usage: resp.usage,
          });
          return resp.text;
        };
        await extractCandidatesForRun(tx, ctx, outcome.runId, extract);
        // Knowledge extraction is INDEPENDENT of decision extraction — its own guard, its own operation,
        // and equally fail-safe. Proposals land quarantined; nothing is trusted or used without a human.
        await extractKnowledgeForRun(tx, ctx, outcome.runId, extract, { provider: primaryRow.provider, model: primaryRow.model });
      });
    } catch (err) {
      log.warn('candidate extraction transaction failed (task unaffected)', {
        runId: outcome.runId,
        err: err instanceof Error ? err.message : err,
      });
    }
  }

  return outcome;
}
