import Anthropic, { APIError } from '@anthropic-ai/sdk';
import {
  type AgentEvent,
  type AgentRequest,
  type AgentResponse,
  type AIProvider,
  type Money,
  type ModelDescriptor,
  ProviderError,
  type TokenUsage,
} from '@/types/provider';
import { costForUsage, modelsForProvider } from './pricing';

/**
 * Anthropic adapter. Messages API.
 * The ONLY file that may import `@anthropic-ai/sdk`.
 */
export class AnthropicProvider implements AIProvider {
  readonly id = 'anthropic' as const;
  readonly authoritativeNotExecuted = { support: 'unsupported' } as const;
  private readonly client: Anthropic;
  /**
   * Models that rejected `temperature` as deprecated (Claude 5 family).
   * Learned adaptively: first request retries once without it, later requests
   * skip it up front. Process-lifetime cache only — cheap and self-healing.
   */
  private readonly noTemperatureModels = new Set<string>();

  constructor(apiKey: string) {
    // maxRetries: 0 — retry policy belongs to the engine, once, uniformly.
    this.client = new Anthropic({ apiKey, maxRetries: 0 });
  }

  async execute(request: AgentRequest): Promise<AgentResponse> {
    const startedAt = Date.now();
    try {
      const message = await this.createMessage(request);

      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      return {
        provider: 'anthropic',
        model: message.model,
        text,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
        },
        stopReason: (message.stop_reason ?? 'unknown').toLowerCase(),
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  private baseParams(request: AgentRequest, withTemperature: boolean) {
    return {
      model: request.model,
      system: request.system,
      messages: request.turns.map((t) => ({ role: t.role, content: t.content })),
      ...(withTemperature ? { temperature: request.temperature } : {}),
      max_tokens: request.maxOutputTokens,
    };
  }

  private isTemperatureDeprecated(err: unknown): boolean {
    return (
      err instanceof APIError && err.status === 400 && /temperature.*deprecated/i.test(err.message)
    );
  }

  /**
   * Sends the request, omitting `temperature` for models known to reject it.
   * On the first "temperature is deprecated" 400 for a model, records the
   * model and retries once without the parameter.
   */
  private async createMessage(request: AgentRequest): Promise<Anthropic.Message> {
    const send = (withTemperature: boolean) =>
      this.client.messages.create(
        { ...this.baseParams(request, withTemperature), stream: false },
        { timeout: request.timeoutMs, signal: request.signal },
      );

    if (this.noTemperatureModels.has(request.model)) {
      return send(false);
    }
    try {
      return await send(true);
    } catch (err) {
      if (this.isTemperatureDeprecated(err)) {
        this.noTemperatureModels.add(request.model);
        return send(false);
      }
      throw err;
    }
  }

  /**
   * Streaming variant: yields text deltas, then exactly one 'done' event whose
   * response matches what execute() would have returned. Usage comes from
   * message_start (input) and message_delta (output) events.
   */
  async *stream(request: AgentRequest): AsyncIterable<AgentEvent> {
    const startedAt = Date.now();
    try {
      const open = (withTemperature: boolean) =>
        this.client.messages.create(
          { ...this.baseParams(request, withTemperature), stream: true },
          { timeout: request.timeoutMs, signal: request.signal },
        );

      let stream: Awaited<ReturnType<typeof open>>;
      if (this.noTemperatureModels.has(request.model)) {
        stream = await open(false);
      } else {
        try {
          stream = await open(true);
        } catch (err) {
          if (this.isTemperatureDeprecated(err)) {
            this.noTemperatureModels.add(request.model);
            stream = await open(false);
          } else {
            throw err;
          }
        }
      }

      let text = '';
      let model = request.model;
      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason = 'unknown';

      for await (const event of stream) {
        if (event.type === 'message_start') {
          model = event.message.model;
          inputTokens = event.message.usage.input_tokens;
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          text += event.delta.text;
          yield { kind: 'delta', text: event.delta.text };
        } else if (event.type === 'message_delta') {
          outputTokens = event.usage.output_tokens;
          if (event.delta.stop_reason) stopReason = event.delta.stop_reason.toLowerCase();
        }
      }

      yield {
        kind: 'done',
        response: {
          provider: 'anthropic',
          model,
          text,
          usage: { inputTokens, outputTokens },
          stopReason,
          latencyMs: Date.now() - startedAt,
        },
      };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  estimateCost(model: string, usage: TokenUsage): Money {
    return costForUsage('anthropic', model, usage);
  }

  listModels(): readonly ModelDescriptor[] {
    return modelsForProvider('anthropic').map((m) => ({
      id: m.id,
      provider: 'anthropic',
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
        return new ProviderError('anthropic', 'auth', 'Anthropic rejected the API key.');
      }
      if (status === 429) {
        return new ProviderError('anthropic', 'rate_limited', 'Anthropic rate limit hit.');
      }
      if (status === 529) {
        // 529 overloaded is a temporary-overload signal, but Anthropic does NOT guarantee the request was
        // rejected before the model ran — so it stays AMBIGUOUS (remoteOutcome defaults to 'unknown'): never
        // auto-retried, the run fails closed to reconciliation. Same treatment as a generic 5xx below.
        return new ProviderError('anthropic', 'overloaded', 'Anthropic is overloaded.');
      }
      if (status === 400 || status === 404 || status === 422) {
        // Anthropic reports an empty credit balance as a 400. Same treatment
        // as OpenAI's insufficient_quota: non-retryable, say what to do.
        if (/credit balance/i.test(err.message)) {
          return new ProviderError(
            'anthropic',
            'auth',
            'Anthropic account has no API credits. Add credits under console.anthropic.com Billing.',
          );
        }
        return new ProviderError(
          'anthropic',
          'invalid_request',
          `Anthropic invalid request: ${err.message}`,
        );
      }
      if (status != null && status >= 500) {
        return new ProviderError('anthropic', 'overloaded', `Anthropic server error (${status}).`);
      }
      return new ProviderError('anthropic', 'unknown', `Anthropic error: ${err.message}`);
    }
    if (err instanceof Error && (err.name === 'AbortError' || /timed? ?out/i.test(err.message))) {
      return new ProviderError('anthropic', 'timeout', 'Anthropic call timed out.');
    }
    return new ProviderError(
      'anthropic',
      'unknown',
      err instanceof Error ? err.message : 'Unknown Anthropic failure.',
    );
  }
}
