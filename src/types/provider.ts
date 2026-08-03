/**
 * Provider-neutral contract between the orchestration engine and the model
 * vendors. Nothing in this file may reference an SDK type — the adapters in
 * `src/providers` translate to and from these shapes.
 */

export const PROVIDER_IDS = ['openai', 'anthropic'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** A provider choice as the user expresses it on a task. */
export const PROVIDER_SELECTIONS = ['openai', 'anthropic', 'both'] as const;
export type ProviderSelection = (typeof PROVIDER_SELECTIONS)[number];

export interface ModelDescriptor {
  readonly id: string;
  readonly provider: ProviderId;
  readonly displayName: string;
  /** Hard cap the adapter will enforce on max_output_tokens. */
  readonly maxOutputTokens: number;
}

export type TurnRole = 'user' | 'assistant';

export interface Turn {
  readonly role: TurnRole;
  readonly content: string;
}

export interface AgentRequest {
  readonly model: string;
  readonly system: string;
  readonly turns: readonly Turn[];
  readonly temperature: number;
  readonly maxOutputTokens: number;
  /** Per-call wall clock budget, ms. The adapter must enforce it. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Integer USD micros. 1_000_000 micros = $1.00. Never a float. */
export interface Money {
  readonly usdMicros: bigint;
}

export interface AgentResponse {
  readonly provider: ProviderId;
  readonly model: string;
  readonly text: string;
  readonly usage: TokenUsage;
  /** Vendor's own stop reason, normalized to lowercase, for the audit record. */
  readonly stopReason: string;
  readonly latencyMs: number;
}

export type AgentEvent =
  | { readonly kind: 'delta'; readonly text: string }
  | { readonly kind: 'done'; readonly response: AgentResponse };

export const PROVIDER_ERROR_KINDS = [
  'rate_limited',
  'timeout',
  'invalid_request',
  'auth',
  'overloaded',
  'unknown',
] as const;
export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set([
  'rate_limited',
  'overloaded',
  'timeout',
]);

/**
 * Hub P1d — whether a provider error PROVES the request was not remotely executed.
 *   * `not_executed` — the request was rejected BEFORE the model ran (auth/validation/rate rejection). No
 *     model execution, no charge; it is a KNOWN failure that may follow fail-safe/bounded-retry policy.
 *   * `unknown` — the remote outcome is AMBIGUOUS: the request may have been received, processed, and
 *     charged (timeout after transmission, transport/connection loss, a generic 5xx that could post-date
 *     execution, a truncated/partial response, or any error we cannot reason about). Fail closed.
 */
export type RemoteOutcome = 'not_executed' | 'unknown';

/**
 * Kinds that PROVE non-execution (rejected before the model ran). Everything else — timeout, overloaded (a
 * generic 5xx is lumped here and may post-date execution), unknown — defaults to `unknown` (fail closed).
 * An adapter that KNOWS a specific error is a clean pre-processing rejection (e.g. Anthropic 529) passes
 * `remoteOutcome: 'not_executed'` explicitly.
 */
const NOT_EXECUTED_KINDS: ReadonlySet<ProviderErrorKind> = new Set([
  'auth',
  'rate_limited',
  'invalid_request',
]);

/**
 * The single error type the engine sees from any provider. Adapters map SDK
 * errors onto this taxonomy so retry policy is vendor-agnostic.
 */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly provider: ProviderId;
  readonly retryable: boolean;
  /** Hub P1d — whether the request is PROVABLY not remotely executed. Ambiguous outcomes ('unknown') must
   *  never be silently retried or reported as a clean zero-charge failure. Defaults fail-closed to 'unknown'
   *  unless the kind proves non-execution or the adapter overrides. */
  readonly remoteOutcome: RemoteOutcome;

  constructor(provider: ProviderId, kind: ProviderErrorKind, message: string, remoteOutcome?: RemoteOutcome) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.kind = kind;
    this.retryable = RETRYABLE.has(kind);
    this.remoteOutcome = remoteOutcome ?? (NOT_EXECUTED_KINDS.has(kind) ? 'not_executed' : 'unknown');
  }
}

export interface AIProvider {
  readonly id: ProviderId;
  execute(request: AgentRequest): Promise<AgentResponse>;
  stream?(request: AgentRequest): AsyncIterable<AgentEvent>;
  estimateCost?(model: string, usage: TokenUsage): Money;
  listModels(): readonly ModelDescriptor[];
}
