import 'server-only';
import { eq, and } from 'drizzle-orm';
import { type TenantContext } from '@/types/domain';
import { type ProviderId } from '@/types/provider';
import { AppError } from '@/lib/errors';
import { serverEnv } from '@/lib/env.server';
import { log } from '@/lib/log';
import { withTenant } from '@/db/tenant';
import { approvals, messages, runs, runSteps, tasks } from '@/db/schema';
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
  type ModelTier,
  type RetrievedDocRef,
  type StepKind,
} from '@/types/domain';
import { findAgentForRole, type AgentRow } from '@/domain/agents/agents';
import { loadApprovedContext } from '@/domain/projects/context';
import { loadObjectiveForRun } from '@/domain/objectives/objectives';
import {
  retrieveRelevant,
  selectCoreReferences,
  selectProductionStatus,
} from '@/domain/documents/documents';
import { assembleProjectState } from '@/domain/state/project-state';
import { writeAudit } from '@/domain/audit/audit';
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

    // Isolation invariant I1: ONLY this project's approved context.
    const knowledge = await loadApprovedContext(tx, ctx);
    // Owner intent that frames the work (closes O-9); tenant-scoped, null when
    // the task serves no live objective.
    const objective = await loadObjectiveForRun(tx, ctx, task.objectiveId);
    // Balanced context package (O-14, CONTEXT-PACKAGE.md). Retrieval is
    // unchanged (D-020); we ADD a small quota of foundational references and a
    // production-status doc that relevance alone would crowd out, dedup them
    // against what retrieval already surfaced, and record WHY each part was
    // included. Every read below is tenant-scoped by the same I1 guard.
    const retrieved = await retrieveRelevant(tx, ctx, task.input, 5);
    const seen = new Set(retrieved.map((r) => r.relativePath));
    const coreRefs = await selectCoreReferences(tx, ctx, seen, 2);
    coreRefs.forEach((c) => seen.add(c.relativePath));
    const productionStatus = await selectProductionStatus(tx, ctx, seen);

    // Project State (O-15): operational Hub records for this workspace,
    // preferring the attached objective. The current task is excluded from its
    // own state. Tenant-scoped by the same I1 guard. Deduped by construction —
    // these are Hub records, not documents, so they cannot collide with the
    // document sources above.
    const projectState = await assembleProjectState(tx, ctx, task.objectiveId, taskId);

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
              timestamp: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
            },
          ]
        : []),
      ...knowledge.map((k) => ({
        ...k,
        authority: AUTHORITY.WORKSPACE_CONTROL,
        kind: 'Approved workspace control',
      })),
      ...retrieved.map((r) => ({
        title: r.relativePath,
        content: r.content,
        authority: AUTHORITY.PROJECT_DOCUMENT,
        kind: 'Linked project document',
      })),
      ...coreRefs.map((r) => ({
        title: r.relativePath,
        content: r.content,
        authority: AUTHORITY.PROJECT_DOCUMENT,
        kind: 'Linked project document (core reference)',
      })),
      ...(productionStatus
        ? [
            {
              title: productionStatus.relativePath,
              content: productionStatus.content,
              authority: AUTHORITY.PROJECT_DOCUMENT,
              kind: 'Linked project document (production status)',
            },
          ]
        : []),
    ];
    const retrievedRefs: RetrievedDocRef[] = retrieved.map((r) => ({
      relativePath: r.relativePath,
      chunkIndex: r.chunkIndex,
      rank: r.rank,
    }));

    // The manifest is the explainable record of the assembled package.
    const contextManifest: ContextManifestEntry[] = [
      ...(objective ? [{ source: 'objective' as const, label: objective.title }] : []),
      ...knowledge.map((k) => ({ source: 'charter' as const, label: k.title })),
      ...retrieved.map((r) => ({
        source: 'retrieved' as const,
        label: r.relativePath,
        detail: `chunk ${r.chunkIndex} · relevance ${r.rank.toFixed(3)}`,
      })),
      ...coreRefs.map((r) => ({
        source: 'core_reference' as const,
        label: r.relativePath,
        detail: r.coreType,
      })),
      ...(productionStatus
        ? [{ source: 'production_status' as const, label: productionStatus.relativePath }]
        : []),
      // Project State manifest entries (objective_progress / active_work /
      // blocker / recent_outcome / pending_review) are already shaped.
      ...projectState.manifest,
    ];

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
      })
      .returning({ id: runs.id });
    const runId = runInserted[0]!.id;

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

    return { task, runId, primaryRow, reviewerRow, contextItems, objective };
  });

  const { task, runId, primaryRow, reviewerRow, contextItems, objective } = preflight;

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
      objective,
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
  return withTenant(ctx, async (tx) => {
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

    // Proposed actions become PENDING approvals — never executions (I4).
    for (const action of result.proposedActions) {
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
      await writeAudit(tx, ctx, {
        action: 'approval.requested',
        entityType: 'approval',
        entityId: inserted[0]!.id,
        detail: { actionType: action.type, summary: action.summary },
      });
    }

    const finalStatus =
      result.proposedActions.length > 0 ? ('awaiting_approval' as const) : ('completed' as const);

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
}
