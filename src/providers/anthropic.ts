import Anthropic, { APIError } from '@anthropic-ai/sdk';
import {
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
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    // maxRetries: 0 — retry policy belongs to the engine, once, uniformly.
    this.client = new Anthropic({ apiKey, maxRetries: 0 });
  }

  async execute(request: AgentRequest): Promise<AgentResponse> {
    const startedAt = Date.now();
    try {
      const message = await this.client.messages.create(
        {
          model: request.model,
          system: request.system,
          messages: request.turns.map((t) => ({ role: t.role, content: t.content })),
          temperature: request.temperature,
          max_tokens: request.maxOutputTokens,
          stream: false,
        },
        {
          timeout: request.timeoutMs,
          signal: request.signal,
        },
      );

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
