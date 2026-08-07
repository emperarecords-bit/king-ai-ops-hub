import {
  type FreshnessComparison,
  type ReviewDetail,
  type ReviewVerdict,
  type StepKind,
} from '@/types/domain';
import {
  assessProviderErrorOutcome,
  type AgentRequest,
  type AgentResponse,
  type AIProvider,
  type ProviderId,
  ProviderError,
  type Turn,
} from '@/types/provider';
import {
  assembleEffectivePrompt,
  buildRevisionUserTurn,
  type ContextItemForPrompt,
  type ObjectiveForPrompt,
  parseReviewDetail,
  stripIssuesBlock,
} from './prompts';
import { canonicalReviewRubric, reviewRubricHash } from '@/domain/agents/reviewer-rubric';
import { extractProposedActions, type ProposedAction, stripActionBlock } from './actions';
import { sha256Hex } from '@/lib/crypto';

/**
 * The run state machine (ARCHITECTURE.md §6, DECISIONS.md D-006).
 *
 * Fixed sequence, no loops:  primary → [review → [revision]] → consolidate.
 * MAX_STEPS and MAX_REVISIONS are structural constants — the reviewer's output
 * selects a verdict, never a control path outside this table. Consolidation is
 * deterministic string assembly, not a model call.
 *
 * Persistence is injected via RunSink so this module has no DB dependency and
 * tests can drive it with fakes.
 */

export const MAX_STEPS = 4;
export const MAX_REVISIONS = 1;
export const MAX_RETRIES_PER_CALL = 2;

/**
 * Hub P1d — reliability signals. These are NOT provider failures: they abort the whole attempt so the
 * RUNNER can resolve them durably, and must never be recorded as a failed step or degrade the run. The
 * base class lets the engine's per-call catch tell them apart from a `ProviderError` (a real, retryable
 * provider fault) and re-throw them unchanged.
 */
export class RunReliabilitySignal extends Error {}

/** A prior attempt recorded a dispatch INTENT for this step but no result checkpoint (dispatched, outcome
 *  unknown after a crash). We must NOT auto-call the provider again — a human reconciles. */
export class ReconciliationRequiredSignal extends RunReliabilitySignal {
  constructor(readonly stepNumber: number) {
    super(`reconciliation_required (step ${stepNumber})`);
    this.name = 'ReconciliationRequiredSignal';
  }
}

/** A cooperative cancel was requested at a dispatch boundary BEFORE this step dispatched — stop with zero
 *  provider calls; no result is fabricated. */
export class RunCancelledSignal extends RunReliabilitySignal {
  constructor(readonly stepNumber: number) {
    super(`run_cancelled (step ${stepNumber})`);
    this.name = 'RunCancelledSignal';
  }
}

/** The worker no longer owns the job lease (it was reclaimed) or the pinned agent identity no longer holds.
 *  A stale worker must NOT advance or finalize — the reclaiming worker is the winner. */
export class LeaseLostSignal extends RunReliabilitySignal {
  constructor(readonly reason: 'lease_lost' | 'identity_changed' = 'lease_lost') {
    super(reason);
    this.name = 'LeaseLostSignal';
  }
}

/**
 * Hub P1d — a provider call ended with an AMBIGUOUS remote outcome (timeout/transport loss after the request
 * was transmitted, a generic 5xx that may post-date execution, or a partially-streamed response): the request
 * may have been received, processed, and CHARGED. It must NEVER be silently retried or downgraded to a normal
 * failed step; the durable dispatch intent stays intact and the runner fails the run closed to
 * `reconciliation_required` (no rebill, no fabricated cost, provider call count stays exactly one). Distinct
 * from a KNOWN pre-processing rejection (`ProviderError` with `remoteOutcome==='not_executed'`), which may
 * follow fail-safe / bounded-retry policy. `stepNumber` is filled in by the engine (or the extraction path)
 * for the reconciliation audit.
 */
export class AmbiguousProviderOutcomeSignal extends RunReliabilitySignal {
  stepNumber = 0;
  constructor(
    readonly providerKind: string,
    readonly startedStreaming = false,
  ) {
    super(`ambiguous_provider_outcome (${providerKind}${startedStreaming ? ', partial-stream' : ''})`);
    this.name = 'AmbiguousProviderOutcomeSignal';
  }
}

/** The durable checkpoint of a step's provider result, replayed on resume so the provider is not called
 *  (or billed) a second time. */
export interface CheckpointedStepResult {
  readonly provider: ProviderId | null;
  readonly model: string | null;
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * Hub P1d — the resume + checkpoint boundary. Injected by the runner so the engine stays persistence-free
 * and tests drive it with fakes. `loadCheckpoint` returns a prior attempt's durable result for a step (so
 * the provider is skipped on resume); `guardDispatch` runs the fail-closed boundary BEFORE a real provider
 * call — lease-ownership + agent-identity re-check, uncertain-outcome (reconciliation) detection,
 * cancellation, and recording the durable dispatch intent. It THROWS a RunReliabilitySignal to abort.
 */
export interface ResumeHooks {
  loadCheckpoint(stepNumber: number): Promise<CheckpointedStepResult | null>;
  guardDispatch(stepNumber: number, kind: StepKind): Promise<void>;
}

/** Reconstruct an AgentResponse from a durable checkpoint so downstream consolidation/verdict parsing is
 *  byte-identical to the original attempt, with NO provider call. */
function responseFromCheckpoint(cp: CheckpointedStepResult): AgentResponse {
  return {
    provider: (cp.provider ?? 'openai') as ProviderId,
    model: cp.model ?? '',
    text: cp.text,
    usage: { inputTokens: cp.inputTokens, outputTokens: cp.outputTokens },
    stopReason: 'stop',
    latencyMs: 0,
  };
}

export interface EngineAgent {
  readonly agentId: string;
  readonly displayName?: string;
  readonly provider: AIProvider;
  readonly model: string;
  readonly systemPrompt: string;
  readonly reviewRubric?: string | null;
  readonly temperature: number;
  readonly maxOutputTokens: number;
}

export interface EngineInput {
  readonly taskInput: string;
  readonly contextItems: readonly ContextItemForPrompt[];
  /** HUB-008 — the trusted Current Operating Priorities block (active objectives/criteria/milestones). */
  readonly operatingPriorities?: string | null;
  readonly objective?: ObjectiveForPrompt | null;
  /** Precomputed Hub-vs-document freshness relation (O-17), when applicable. */
  readonly freshnessComparison?: FreshnessComparison | null;
  readonly primary: EngineAgent;
  /** Absent → review disabled for this run. */
  readonly reviewer: EngineAgent | null;
  readonly perCallTimeoutMs: number;
  readonly runDeadline: number; // epoch ms; the whole run must finish by this
  /** Stable run timestamp used for immutable reviewer provenance, including checkpoint replay. */
  readonly provenanceExecutedAt?: string;
  /** Hub P1d — resume + checkpoint boundary. Absent ⇒ legacy single-attempt behavior (no checkpoints,
   *  no dispatch guard): the engine runs exactly as before. */
  readonly resume?: ResumeHooks | null;
}

export interface StepRecord {
  readonly stepNumber: number;
  readonly kind: StepKind;
  readonly agentId: string | null;
  readonly response: AgentResponse | null;
  readonly verdict: ReviewVerdict | null;
  /** Structured review outcome (review steps only). */
  readonly verdictDetail: ReviewDetail | null;
  readonly succeeded: boolean;
  readonly errorMessage: string | null;
  /**
   * HUB-008 — sha256 of THIS step's exact dispatched request (system + ordered turns), so each step
   * (including the revision, whose request carries reviewer feedback + the prior response) has its own
   * verifiable identity. Null for the deterministic consolidate step (no model call).
   */
  readonly effectivePromptHash: string | null;
}

/**
 * Canonical, deterministic hash of one model request (system + ordered turns). Distinct from the
 * run-level effective-prompt hash: this pins the EXACT per-step dispatch, revision turns included.
 */
export function stepEffectivePromptHash(system: string, turns: readonly Turn[]): string {
  return sha256Hex([system, ...turns.map((t) => `[${t.role}]\n${t.content}`)].join('\n\n'));
}

/** The engine reports each step as it completes; the caller persists. */
export interface RunSink {
  onStep(record: StepRecord): Promise<void>;
  onMalformedOutput(stepNumber: number, reasons: readonly string[]): Promise<void>;
  /**
   * Live text deltas for the step currently executing. Optional: when present
   * AND the provider implements stream(), calls stream; otherwise execute().
   * Purely observational — the run's stored results never depend on it.
   */
  onDelta?(kind: StepKind, text: string): void;
}

export interface EngineResult {
  readonly ok: boolean;
  readonly consolidated: string;
  readonly proposedActions: readonly ProposedAction[];
  readonly steps: readonly StepRecord[];
  readonly failureReason: string | null;
}

function remainingBudget(deadline: number): number {
  return deadline - Date.now();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One provider call with the engine's uniform retry policy: at most
 * MAX_RETRIES_PER_CALL retries, retryable kinds only, exponential backoff with
 * jitter, all inside the run deadline.
 */
async function callWithRetry(
  agent: EngineAgent,
  turns: readonly Turn[],
  system: string,
  perCallTimeoutMs: number,
  deadline: number,
  onDelta?: (text: string) => void,
): Promise<AgentResponse> {
  let lastError: ProviderError | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES_PER_CALL; attempt += 1) {
    const budget = remainingBudget(deadline);
    if (budget <= 0) {
      throw new ProviderError(agent.provider.id, 'timeout', 'Run deadline exhausted.');
    }
    const request: AgentRequest = {
      model: agent.model,
      system,
      turns,
      temperature: agent.temperature,
      maxOutputTokens: agent.maxOutputTokens,
      timeoutMs: Math.min(perCallTimeoutMs, budget),
    };
    // Track whether THIS attempt already surfaced text to the observer: a
    // retry after visible partial output would duplicate it downstream, so a
    // mid-stream failure is terminal even for retryable error kinds.
    let emitted = false;
    try {
      if (onDelta && agent.provider.stream) {
        let response: AgentResponse | null = null;
        for await (const event of agent.provider.stream(request)) {
          if (event.kind === 'delta') {
            emitted = true;
            onDelta(event.text);
          } else {
            response = event.response;
          }
        }
        if (!response) {
          throw new ProviderError(
            agent.provider.id,
            'unknown',
            'Stream ended without a final response.',
          );
        }
        return response;
      }
      return await agent.provider.execute(request);
    } catch (err) {
      // A reliability signal is never a provider fault — propagate unchanged (defensive; execute/stream throw
      // ProviderError, not signals).
      if (err instanceof RunReliabilitySignal) throw err;
      const providerError =
        err instanceof ProviderError
          ? err
          : new ProviderError(
              agent.provider.id,
              'unknown',
              err instanceof Error ? err.message : 'Unknown provider failure.',
            );
      lastError = providerError;
      // AMBIGUOUS outcome — the request may have been received, processed, and CHARGED: a timeout/transport
      // loss after transmission, a generic 5xx that may post-date execution, OR any partial stream already
      // surfaced (the provider began responding). NEVER retry it in-process and NEVER downgrade it to a normal
      // failed step: escalate so the runner fails the run closed to reconciliation, with the provider call
      // count frozen at exactly this one attempt.
      const remoteAssessment = assessProviderErrorOutcome(agent.provider, providerError);
      if (emitted || remoteAssessment.status !== 'not_executed') {
        throw new AmbiguousProviderOutcomeSignal(providerError.kind, emitted);
      }
      // KNOWN pre-processing rejection (provably not executed): bounded retry per the existing policy, else
      // surface the ProviderError as a normal failed step.
      if (!providerError.retryable || attempt === MAX_RETRIES_PER_CALL) {
        throw providerError;
      }
      const backoff = Math.min(2 ** attempt * 1_000, 8_000) * (0.5 + Math.random() * 0.5);
      if (backoff >= remainingBudget(deadline)) throw providerError;
      await sleep(backoff);
    }
  }
  // Unreachable, but the type system cannot know the loop always throws/returns.
  throw lastError ?? new ProviderError(agent.provider.id, 'unknown', 'Retry loop exit.');
}

/**
 * Deterministic consolidation — assembles the final result from stored step
 * outputs. No model call: the consolidated result is reproducible from the
 * message history alone.
 */
export function consolidate(args: {
  primaryText: string;
  reviewText: string | null;
  verdict: ReviewVerdict | null;
  revisionText: string | null;
}): string {
  const finalBody =
    args.revisionText != null && args.revisionText.length > 0
      ? args.revisionText
      : args.primaryText;

  const sections: string[] = [stripActionBlock(finalBody)];

  if (args.verdict != null && args.reviewText != null) {
    sections.push(
      `---\n**Review summary** (verdict: ${args.verdict})\n\n${stripIssuesBlock(stripActionBlock(args.reviewText))}`,
    );
    if (args.revisionText != null) {
      sections.push('*The result above incorporates one revision addressing this review.*');
    } else if (args.verdict === 'approve') {
      sections.push('*The reviewer approved the original response; no revision was needed.*');
    } else if (args.verdict === 'reject') {
      sections.push(
        '*The reviewer rejected the response and no revision was produced. Treat the result with caution.*',
      );
    }
  }

  return sections.join('\n\n');
}

export async function executeRun(input: EngineInput, sink: RunSink): Promise<EngineResult> {
  const steps: StepRecord[] = [];
  let stepNumber = 0;

  const record = async (partial: Omit<StepRecord, 'stepNumber'>): Promise<StepRecord> => {
    stepNumber += 1;
    if (stepNumber > MAX_STEPS) {
      // Structural invariant I5. If this throws, the engine itself is broken.
      throw new Error(`Step budget exceeded: ${stepNumber} > ${MAX_STEPS}`);
    }
    const full: StepRecord = { ...partial, stepNumber };
    steps.push(full);
    await sink.onStep(full);
    return full;
  };

  // --- Step 1: PRIMARY ------------------------------------------------------
  // ONE canonical assembler (HUB-008) — no flat concatenation path in the engine.
  const primaryAssembled = assembleEffectivePrompt({
    variant: 'primary',
    agentSystemPrompt: input.primary.systemPrompt,
    taskInput: input.taskInput,
    contextItems: input.contextItems,
    objective: input.objective,
    freshnessComparison: input.freshnessComparison,
    operatingPriorities: input.operatingPriorities,
  });
  const primarySystem = primaryAssembled.system;
  const primaryUserTurn = primaryAssembled.userTurn;
  const primaryTurns: Turn[] = [{ role: 'user', content: primaryUserTurn }];
  const primaryStepHash = stepEffectivePromptHash(primarySystem, primaryTurns);

  let primaryResponse: AgentResponse;
  // Hub P1d — a prior attempt may have already checkpointed the primary result; replay it with NO provider
  // call (and NO re-bill). Otherwise run the fail-closed dispatch boundary, then the provider.
  const primaryCheckpoint = input.resume ? await input.resume.loadCheckpoint(1) : null;
  if (primaryCheckpoint) {
    primaryResponse = responseFromCheckpoint(primaryCheckpoint);
  } else {
    try {
      if (input.resume) await input.resume.guardDispatch(1, 'primary');
      primaryResponse = await callWithRetry(
        input.primary,
        primaryTurns,
        primarySystem,
        input.perCallTimeoutMs,
        input.runDeadline,
        sink.onDelta && ((text) => sink.onDelta!('primary', text)),
      );
    } catch (err) {
      // AMBIGUOUS provider outcome → escalate (tag the step) so the run fails closed to reconciliation; NEVER
      // a "failed primary" (the request may have executed + charged).
      if (err instanceof AmbiguousProviderOutcomeSignal) {
        err.stepNumber = stepNumber + 1;
        throw err;
      }
      // A reliability signal (reconciliation / cancellation / lease loss) or an injected crash is NOT a
      // provider fault: propagate it so the runner resolves the attempt durably, never a "failed primary".
      if (!(err instanceof ProviderError)) throw err;
      const message = err.message;
      await record({
        kind: 'primary',
        agentId: input.primary.agentId,
        response: null,
        verdict: null,
        verdictDetail: null,
        succeeded: false,
        errorMessage: message,
        effectivePromptHash: primaryStepHash,
      });
      return {
        ok: false,
        consolidated: '',
        proposedActions: [],
        steps,
        failureReason: `Primary model call failed: ${message}`,
      };
    }
  }
  await record({
    kind: 'primary',
    agentId: input.primary.agentId,
    response: primaryResponse,
    verdict: null,
    verdictDetail: null,
    succeeded: true,
    errorMessage: null,
    effectivePromptHash: primaryStepHash,
  });

  let reviewResponse: AgentResponse | null = null;
  let verdict: ReviewVerdict | null = null;
  let revisionResponse: AgentResponse | null = null;

  // --- Step 2: REVIEW (optional) -------------------------------------------
  if (input.reviewer) {
    // Context parity (EV-009): give the reviewer the same approved organizational
    // policy the primary saw (the accepted-decision context items, labelled
    // 'Decision memory' by the runner) AND the same Current Operating Priorities.
    const approvedPolicies = input.contextItems.filter((i) => i.kind === 'Decision memory');
    const reviewAssembled = assembleEffectivePrompt({
      variant: 'review',
      agentSystemPrompt: input.reviewer.systemPrompt,
      taskInput: input.taskInput,
      primaryResponse: primaryResponse.text,
      approvedPolicies,
      operatingPriorities: input.operatingPriorities,
      reviewerRubric: input.reviewer.reviewRubric,
    });
    const reviewSystem = reviewAssembled.system;
    const reviewTurns: Turn[] = [{ role: 'user', content: reviewAssembled.userTurn }];
    const reviewStepHash = stepEffectivePromptHash(reviewSystem, reviewTurns);
    const reviewStepNo = stepNumber + 1; // the number record() will assign to this step
    const reviewCheckpoint = input.resume ? await input.resume.loadCheckpoint(reviewStepNo) : null;
    if (reviewCheckpoint) {
      // Resume: the reviewer already ran and was checkpointed — replay it (no provider call, no re-bill).
      reviewResponse = responseFromCheckpoint(reviewCheckpoint);
    } else {
      try {
        if (input.resume) await input.resume.guardDispatch(reviewStepNo, 'review');
        reviewResponse = await callWithRetry(
          input.reviewer,
          reviewTurns,
          reviewSystem,
          input.perCallTimeoutMs,
          input.runDeadline,
          sink.onDelta && ((text) => sink.onDelta!('review', text)),
        );
      } catch (err) {
        // AMBIGUOUS reviewer outcome → escalate to reconciliation (the reviewer may have executed + charged);
        // do NOT degrade the run as if the review cleanly failed.
        if (err instanceof AmbiguousProviderOutcomeSignal) {
          err.stepNumber = reviewStepNo;
          throw err;
        }
        // Reliability signal / injected crash → propagate (never a "failed review").
        if (!(err instanceof ProviderError)) throw err;
        // A failed review degrades the run, it does not destroy the primary work.
        const message = err.message;
        await record({
          kind: 'review',
          agentId: input.reviewer.agentId,
          response: null,
          verdict: null,
          verdictDetail: null,
          succeeded: false,
          errorMessage: message,
          effectivePromptHash: reviewStepHash,
        });
        reviewResponse = null;
        verdict = null;
      }
    }
    if (reviewResponse) {
      const parsedReview = parseReviewDetail(reviewResponse.text, primaryResponse.text, {
        reviewerAgentId: input.reviewer.agentId,
        reviewerDisplayName: input.reviewer.displayName ?? input.reviewer.agentId,
        provider: reviewResponse.provider,
        model: reviewResponse.model,
        rubricHash: reviewRubricHash(input.reviewer.reviewRubric),
        rubricSnapshot: canonicalReviewRubric(input.reviewer.reviewRubric) || null,
        executedAt: input.provenanceExecutedAt ?? new Date().toISOString(),
      });
      verdict = parsedReview.detail.verdict;
      // Only report malformed output on a FRESH review — a replayed checkpoint must not re-audit it.
      if (!reviewCheckpoint && parsedReview.malformedReasons.length > 0) {
        // stepNumber not yet advanced for this step; report against the next.
        await sink.onMalformedOutput(stepNumber + 1, parsedReview.malformedReasons);
      }
      await record({
        kind: 'review',
        agentId: input.reviewer.agentId,
        response: reviewResponse,
        verdict,
        verdictDetail: parsedReview.detail,
        succeeded: true,
        errorMessage: null,
        effectivePromptHash: reviewStepHash,
      });
    }

    // --- Step 3: REVISION (exactly one, only on 'revise') -------------------
    if (verdict === 'revise' && reviewResponse) {
      const revisionTurns: Turn[] = [
        { role: 'user', content: primaryUserTurn },
        { role: 'assistant', content: primaryResponse.text },
        { role: 'user', content: buildRevisionUserTurn(reviewResponse.text) },
      ];
      // The revision's identity is NOT the initial primary request — it includes the reviewer feedback
      // and the prior primary response, so it gets its own per-step hash over the full three-turn request.
      const revisionStepHash = stepEffectivePromptHash(primarySystem, revisionTurns);
      const revisionStepNo = stepNumber + 1;
      const revisionCheckpoint = input.resume ? await input.resume.loadCheckpoint(revisionStepNo) : null;
      if (revisionCheckpoint) {
        revisionResponse = responseFromCheckpoint(revisionCheckpoint);
        await record({
          kind: 'revision',
          agentId: input.primary.agentId,
          response: revisionResponse,
          verdict: null,
          verdictDetail: null,
          succeeded: true,
          errorMessage: null,
          effectivePromptHash: revisionStepHash,
        });
      } else {
        try {
          if (input.resume) await input.resume.guardDispatch(revisionStepNo, 'revision');
          revisionResponse = await callWithRetry(
            input.primary,
            revisionTurns,
            primarySystem,
            input.perCallTimeoutMs,
            input.runDeadline,
            sink.onDelta && ((text) => sink.onDelta!('revision', text)),
          );
          await record({
            kind: 'revision',
            agentId: input.primary.agentId,
            response: revisionResponse,
            verdict: null,
            verdictDetail: null,
            succeeded: true,
            errorMessage: null,
            effectivePromptHash: revisionStepHash,
          });
        } catch (err) {
          // AMBIGUOUS revision outcome → escalate to reconciliation (may have executed + charged); do NOT
          // fall back to the primary as if the revision cleanly failed.
          if (err instanceof AmbiguousProviderOutcomeSignal) {
            err.stepNumber = revisionStepNo;
            throw err;
          }
          if (!(err instanceof ProviderError)) throw err;
          const message = err.message;
          await record({
            kind: 'revision',
            agentId: input.primary.agentId,
            response: null,
            verdict: null,
            verdictDetail: null,
            succeeded: false,
            errorMessage: message,
            effectivePromptHash: revisionStepHash,
          });
          revisionResponse = null; // fall back to the primary response
        }
      }
    }
  }

  // --- Step 4: CONSOLIDATE (deterministic, no model call) -------------------
  const consolidated = consolidate({
    primaryText: primaryResponse.text,
    reviewText: reviewResponse?.text ?? null,
    verdict,
    revisionText: revisionResponse?.text ?? null,
  });
  await record({
    kind: 'consolidate',
    agentId: null,
    response: null,
    verdict: null,
    verdictDetail: null,
    succeeded: true,
    errorMessage: null,
    effectivePromptHash: null, // deterministic string assembly, no model request
  });

  // --- Action extraction (TB-4) --------------------------------------------
  // Actions come from the FINAL body only — a rejected draft's proposals die
  // with the draft.
  const finalText = revisionResponse?.text ?? primaryResponse.text;
  const extraction = extractProposedActions(finalText);
  if (extraction.rejected.length > 0) {
    await sink.onMalformedOutput(stepNumber, extraction.rejected);
  }

  return {
    ok: true,
    consolidated,
    proposedActions: extraction.actions,
    steps,
    failureReason: null,
  };
}
