import OpenAI, { APIError } from 'openai';
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
 * OpenAI adapter. Chat Completions API (see DECISIONS.md D-003).
 * The ONLY file that may import the `openai` package.
 */
export class OpenAIProvider implements AIProvider {
  readonly id = 'openai' as const;
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    // maxRetries: 0 — retry policy belongs to the engine, once, uniformly.
    this.client = new OpenAI({ apiKey, maxRetries: 0 });
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
          max_completion_tokens: request.maxOutputTokens,
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
        throw new ProviderError('openai', 'unknown', 'Empty completion from OpenAI.');
      }

      return {
        provider: 'openai',
        model: completion.model,
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
   * response matches what execute() would have returned (usage included via
   * stream_options so billing stays exact).
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
          max_completion_tokens: request.maxOutputTokens,
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
          provider: 'openai',
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
    return costForUsage('openai', model, usage);
  }

  listModels(): readonly ModelDescriptor[] {
    return modelsForProvider('openai').map((m) => ({
      id: m.id,
      provider: 'openai',
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
        return new ProviderError('openai', 'auth', 'OpenAI rejected the API key.');
      }
      if (status === 429) {
        // insufficient_quota also arrives as 429 but is NOT retryable: it means
        // the account has no API credit balance, and retrying just burns time.
        if (err.code === 'insufficient_quota') {
          return new ProviderError(
            'openai',
            'auth',
            'OpenAI account has no API credits (insufficient_quota). Add credits under platform.openai.com Billing.',
          );
        }
        return new ProviderError('openai', 'rate_limited', 'OpenAI rate limit hit.');
      }
      if (status === 400 || status === 404 || status === 422) {
        return new ProviderError('openai', 'invalid_request', `OpenAI invalid request: ${err.message}`);
      }
      if (status != null && status >= 500) {
        return new ProviderError('openai', 'overloaded', `OpenAI server error (${status}).`);
      }
      return new ProviderError('openai', 'unknown', `OpenAI error: ${err.message}`);
    }
    if (err instanceof Error && (err.name === 'AbortError' || /timed? ?out/i.test(err.message))) {
      return new ProviderError('openai', 'timeout', 'OpenAI call timed out.');
    }
    return new ProviderError(
      'openai',
      'unknown',
      err instanceof Error ? err.message : 'Unknown OpenAI failure.',
    );
  }
}
