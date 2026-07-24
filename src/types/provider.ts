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
 * The single error type the engine sees from any provider. Adapters map SDK
 * errors onto this taxonomy so retry policy is vendor-agnostic.
 */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly provider: ProviderId;
  readonly retryable: boolean;

  constructor(provider: ProviderId, kind: ProviderErrorKind, message: string) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.kind = kind;
    this.retryable = RETRYABLE.has(kind);
  }
}

export interface AIProvider {
  readonly id: ProviderId;
  execute(request: AgentRequest): Promise<AgentResponse>;
  stream?(request: AgentRequest): AsyncIterable<AgentEvent>;
  estimateCost?(model: string, usage: TokenUsage): Money;
  listModels(): readonly ModelDescriptor[];
}
