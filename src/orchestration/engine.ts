import {
  type FreshnessComparison,
  type ReviewDetail,
  type ReviewVerdict,
  type StepKind,
} from '@/types/domain';
import {
  type AgentRequest,
  type AgentResponse,
  type AIProvider,
  ProviderError,
  type Turn,
} from '@/types/provider';
import {
  buildPrimarySystem,
  buildPrimaryUserTurn,
  buildReviewSystem,
  buildReviewUserTurn,
  buildRevisionUserTurn,
  type ContextItemForPrompt,
  type ObjectiveForPrompt,
  parseReviewDetail,
  stripIssuesBlock,
} from './prompts';
import { extractProposedActions, type ProposedAction, stripActionBlock } from './actions';

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

export interface EngineAgent {
  readonly agentId: string;
  readonly provider: AIProvider;
  readonly model: string;
  readonly systemPrompt: string;
  readonly temperature: number;
  readonly maxOutputTokens: number;
}

export interface EngineInput {
  readonly taskInput: string;
  readonly contextItems: readonly ContextItemForPrompt[];
  readonly objective?: ObjectiveForPrompt | null;
  /** Precomputed Hub-vs-document freshness relation (O-17), when applicable. */
  readonly freshnessComparison?: FreshnessComparison | null;
  readonly primary: EngineAgent;
  /** Absent → review disabled for this run. */
  readonly reviewer: EngineAgent | null;
  readonly perCallTimeoutMs: number;
  readonly runDeadline: number; // epoch ms; the whole run must finish by this
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
      const providerError =
        err instanceof ProviderError
          ? err
          : new ProviderError(
              agent.provider.id,
              'unknown',
              err instanceof Error ? err.message : 'Unknown provider failure.',
            );
      lastError = providerError;
      if (emitted || !providerError.retryable || attempt === MAX_RETRIES_PER_CALL) {
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
  const primarySystem = buildPrimarySystem(input.primary.systemPrompt);
  const primaryUserTurn = buildPrimaryUserTurn(
    input.taskInput,
    input.contextItems,
    input.objective,
    input.freshnessComparison,
  );
  const primaryTurns: Turn[] = [{ role: 'user', content: primaryUserTurn }];

  let primaryResponse: AgentResponse;
  try {
    primaryResponse = await callWithRetry(
      input.primary,
      primaryTurns,
      primarySystem,
      input.perCallTimeoutMs,
      input.runDeadline,
      sink.onDelta && ((text) => sink.onDelta!('primary', text)),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Primary call failed.';
    await record({
      kind: 'primary',
      agentId: input.primary.agentId,
      response: null,
      verdict: null,
      verdictDetail: null,
      succeeded: false,
      errorMessage: message,
    });
    return {
      ok: false,
      consolidated: '',
      proposedActions: [],
      steps,
      failureReason: `Primary model call failed: ${message}`,
    };
  }
  await record({
    kind: 'primary',
    agentId: input.primary.agentId,
    response: primaryResponse,
    verdict: null,
    verdictDetail: null,
    succeeded: true,
    errorMessage: null,
  });

  let reviewResponse: AgentResponse | null = null;
  let verdict: ReviewVerdict | null = null;
  let revisionResponse: AgentResponse | null = null;

  // --- Step 2: REVIEW (optional) -------------------------------------------
  if (input.reviewer) {
    const reviewSystem = buildReviewSystem(input.reviewer.systemPrompt);
    const reviewTurns: Turn[] = [
      { role: 'user', content: buildReviewUserTurn(input.taskInput, primaryResponse.text) },
    ];
    try {
      reviewResponse = await callWithRetry(
        input.reviewer,
        reviewTurns,
        reviewSystem,
        input.perCallTimeoutMs,
        input.runDeadline,
        sink.onDelta && ((text) => sink.onDelta!('review', text)),
      );
      const parsedReview = parseReviewDetail(reviewResponse.text);
      verdict = parsedReview.detail.verdict;
      if (parsedReview.malformedReasons.length > 0) {
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
      });
    } catch (err) {
      // A failed review degrades the run, it does not destroy the primary work.
      const message = err instanceof Error ? err.message : 'Review call failed.';
      await record({
        kind: 'review',
        agentId: input.reviewer.agentId,
        response: null,
        verdict: null,
        verdictDetail: null,
        succeeded: false,
        errorMessage: message,
      });
      reviewResponse = null;
      verdict = null;
    }

    // --- Step 3: REVISION (exactly one, only on 'revise') -------------------
    if (verdict === 'revise' && reviewResponse) {
      const revisionTurns: Turn[] = [
        { role: 'user', content: primaryUserTurn },
        { role: 'assistant', content: primaryResponse.text },
        { role: 'user', content: buildRevisionUserTurn(reviewResponse.text) },
      ];
      try {
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
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Revision call failed.';
        await record({
          kind: 'revision',
          agentId: input.primary.agentId,
          response: null,
          verdict: null,
          verdictDetail: null,
          succeeded: false,
          errorMessage: message,
        });
        revisionResponse = null; // fall back to the primary response
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
