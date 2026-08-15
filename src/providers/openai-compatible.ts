import OpenAI, { APIError } from 'openai';
import {
  type AgentEvent,
  type AgentRequest,
  type AgentResponse,
  type AIProvider,
  type Money,
  type ModelDescriptor,
  ProviderError,
  type ProviderId,
  type TokenUsage,
} from '@/types/provider';
import { costForUsage, modelsForProvider } from './pricing';

/**
 * Generic adapter for vendors that expose an OpenAI-compatible Chat Completions
 * endpoint (Google Gemini via its compat surface, DeepSeek). Besides openai.ts,
 * this is the only file that may import the `openai` package — it reuses the
 * SDK purely as an HTTP client against a different baseURL.
 *
 * Differences from the native OpenAI adapter, both deliberate:
 *   * `max_tokens` instead of `max_completion_tokens` — the compat vendors
 *     accept the classic parameter; the newer one is OpenAI-specific.
 *   * Error mapping keys off HTTP status only; vendor-specific error codes
 *     (e.g. OpenAI's insufficient_quota refinement) don't translate.
 */
export interface OpenAICompatibleConfig {
  readonly id: ProviderId;
  /** Human vendor name for error messages, e.g. 'Gemini'. Never a secret. */
  readonly label: string;
  readonly baseURL: string;
  readonly apiKey: string;
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly id: ProviderId;
  readonly authoritativeNotExecuted = { support: 'unsupported' } as const;
  private readonly label: string;
  private readonly client: OpenAI;

  constructor(config: OpenAICompatibleConfig) {
    this.id = config.id;
    this.label = config.label;
    // maxRetries: 0 — retry policy belongs to the engine, once, uniformly.
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, maxRetries: 0 });
  }

  async execute(request: AgentRequest): Promise<AgentResponse> {
    const startedAt = Date.now();
    try {
      const completion = await this.client.chat.completions.create(
        {
          model: request.model,
          messages: [
            { role: 'system', content: request.system },
            ...request.turns.map((t) => ({ role: t.role, content: t.content })),
          ],
          temperature: request.temperature,
          max_tokens: request.maxOutputTokens,
          n: 1,
          stream: false,
        },
        {
          timeout: request.timeoutMs,
          signal: request.signal,
        },
      );

      const choice = completion.choices[0];
      if (!choice?.message) {
        throw new ProviderError(this.id, 'unknown', `Empty completion from ${this.label}.`);
      }

      return {
        provider: this.id,
        model: completion.model ?? request.model,
        text: choice.message.content ?? '',
        usage: {
          inputTokens: completion.usage?.prompt_tokens ?? 0,
          outputTokens: completion.usage?.completion_tokens ?? 0,
        },
        stopReason: (choice.finish_reason ?? 'unknown').toLowerCase(),
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  /**
   * Streaming variant: yields text deltas, then exactly one 'done' event whose
   * response matches what execute() would have returned. `include_usage` is
   * honored by both compat vendors; if a vendor omits usage the zeros fall
   * through to costForUsage's conservative fallback pricing.
   */
  async *stream(request: AgentRequest): AsyncIterable<AgentEvent> {
    const startedAt = Date.now();
    try {
      const stream = await this.client.chat.completions.create(
        {
          model: request.model,
          messages: [
            { role: 'system', content: request.system },
            ...request.turns.map((t) => ({ role: t.role, content: t.content })),
          ],
          temperature: request.temperature,
          max_tokens: request.maxOutputTokens,
          n: 1,
          stream: true,
          stream_options: { include_usage: true },
        },
        {
          timeout: request.timeoutMs,
          signal: request.signal,
        },
      );

      let text = '';
      let model = request.model;
      let stopReason = 'unknown';
      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

      for await (const chunk of stream) {
        if (chunk.model) model = chunk.model;
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          text += delta;
          yield { kind: 'delta', text: delta };
        }
        const finish = chunk.choices[0]?.finish_reason;
        if (finish) stopReason = finish.toLowerCase();
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
          };
        }
      }

      yield {
        kind: 'done',
        response: {
          provider: this.id,
          model,
          text,
          usage,
          stopReason,
          latencyMs: Date.now() - startedAt,
        },
      };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  estimateCost(model: string, usage: TokenUsage): Money {
    return costForUsage(this.id, model, usage);
  }

  listModels(): readonly ModelDescriptor[] {
    return modelsForProvider(this.id).map((m) => ({
      id: m.id,
      provider: this.id,
      displayName: m.displayName,
      maxOutputTokens: m.maxOutputTokens,
    }));
  }

  /** Map SDK errors to the shared taxonomy. Never leak header contents. */
  private mapError(err: unknown): ProviderError {
    if (err instanceof ProviderError) return err;
    if (err instanceof APIError) {
      const status = err.status;
      if (status === 401 || status === 403) {
        return new ProviderError(this.id, 'auth', `${this.label} rejected the API key.`);
      }
      if (status === 429) {
        return new ProviderError(this.id, 'rate_limited', `${this.label} rate limit hit.`);
      }
      if (status === 400 || status === 404 || status === 422) {
        return new ProviderError(this.id, 'invalid_request', `${this.label} invalid request: ${err.message}`);
      }
      if (status != null && status >= 500) {
        return new ProviderError(this.id, 'overloaded', `${this.label} server error (${status}).`);
      }
      return new ProviderError(this.id, 'unknown', `${this.label} error: ${err.message}`);
    }
    if (err instanceof Error && (err.name === 'AbortError' || /timed? ?out/i.test(err.message))) {
      return new ProviderError(this.id, 'timeout', `${this.label} call timed out.`);
    }
    return new ProviderError(
      this.id,
      'unknown',
      err instanceof Error ? err.message : `Unknown ${this.label} failure.`,
    );
  }
}
