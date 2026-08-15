import { describe, expect, it } from 'vitest';
import { APIError } from 'openai';
import { OpenAICompatibleProvider } from '@/providers/openai-compatible';
import { otherProvider } from '@/providers/registry';
import { resolveModelForTier } from '@/orchestration/routing';
import { costForUsage, knownModel, modelsForProvider, providerSupportsModel } from '@/providers/pricing';
import { PROVIDER_IDS, type ProviderError } from '@/types/provider';

/**
 * Multi-provider expansion (2026-08-15): google (Gemini) and deepseek join as
 * first-class providers via the OpenAI-compatible adapter. These tests pin the
 * catalog, tier routing, cross-vendor review pairing, and the adapter's error
 * taxonomy — the pieces the engine's retry/budget policies depend on.
 */

function makeProvider(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: 'google',
    label: 'Gemini',
    baseURL: 'https://example.invalid/v1/',
    apiKey: 'test-key-not-real',
  });
}

describe('model catalog — google and deepseek rows', () => {
  it('registers both models per new provider', () => {
    expect(modelsForProvider('google').map((m) => m.id).sort()).toEqual([
      'gemini-3.1-flash-lite',
      'gemini-3.1-pro-preview',
    ]);
    expect(modelsForProvider('deepseek').map((m) => m.id).sort()).toEqual([
      'deepseek-chat',
      'deepseek-reasoner',
    ]);
  });

  it('rejects cross-vendor pairs for the new providers', () => {
    expect(providerSupportsModel('google', 'gemini-3.1-flash-lite')).toBe(true);
    expect(providerSupportsModel('google', 'gpt-5.4')).toBe(false);
    expect(providerSupportsModel('deepseek', 'deepseek-chat')).toBe(true);
    expect(providerSupportsModel('deepseek', 'gemini-3.1-pro-preview')).toBe(false);
    expect(providerSupportsModel('openai', 'deepseek-chat')).toBe(false);
    expect(knownModel('gemini-3.1-flash-lite')).toBe(true);
  });

  it('prices gemini-3.1-flash-lite usage exactly (integer micros)', () => {
    // 1M input at $0.30 + 1M output at $2.50 = $2.80 exactly.
    const cost = costForUsage('google', 'gemini-3.1-flash-lite', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost.usdMicros).toBe(2_800_000n);
  });

  it('unknown-model fallback prices at the most expensive rate for the provider', () => {
    const cost = costForUsage('deepseek', 'deepseek-experimental-unknown', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    // Falls back to deepseek-reasoner ($0.55 + $2.19).
    expect(cost.usdMicros).toBe(2_740_000n);
  });
});

describe('tier routing for the new providers', () => {
  it('flagship overrides to the vendor flagship; standard keeps the configured model', () => {
    expect(resolveModelForTier('flagship', 'google', 'gemini-3.1-flash-lite')).toBe('gemini-3.1-pro-preview');
    expect(resolveModelForTier('flagship', 'deepseek', 'deepseek-chat')).toBe('deepseek-reasoner');
    expect(resolveModelForTier('standard', 'google', 'gemini-3.1-flash-lite')).toBe('gemini-3.1-flash-lite');
    expect(resolveModelForTier('standard', 'deepseek', 'deepseek-chat')).toBe('deepseek-chat');
  });
});

describe('cross-vendor review pairing (D-005)', () => {
  it('never pairs a provider with itself', () => {
    for (const id of PROVIDER_IDS) {
      expect(otherProvider(id)).not.toBe(id);
    }
  });

  it('preserves the original openai/anthropic pairing in both directions', () => {
    expect(otherProvider('openai')).toBe('anthropic');
    expect(otherProvider('anthropic')).toBe('openai');
  });
});

describe('OpenAICompatibleProvider', () => {
  it('carries its configured id into listModels and errors', () => {
    const provider = makeProvider();
    expect(provider.id).toBe('google');
    expect(provider.listModels().every((m) => m.provider === 'google')).toBe(true);
  });

  it('declares no authoritative non-execution proof (fail-closed reliability)', () => {
    expect(makeProvider().authoritativeNotExecuted).toEqual({ support: 'unsupported' });
  });

  it('estimates cost through the shared pricing table', () => {
    const cost = makeProvider().estimateCost('gemini-3.1-pro-preview', {
      inputTokens: 500_000,
      outputTokens: 100_000,
    });
    // 0.5M * $2.50 + 0.1M * $15.00 = $1.25 + $1.50 = $2.75.
    expect(cost.usdMicros).toBe(2_750_000n);
  });

  it('maps HTTP statuses onto the shared error taxonomy', async () => {
    const provider = makeProvider();
    // Reach the private mapper through execute() against APIError instances.
    const mapped = (status: number | undefined, message = 'x'): ProviderError => {
      const err = new APIError(status, { error: { message } }, message, new Headers());
      // @ts-expect-error — exercising the private mapper directly keeps the test hermetic (no HTTP).
      return provider.mapError(err);
    };
    expect(mapped(401).kind).toBe('auth');
    expect(mapped(403).kind).toBe('auth');
    expect(mapped(429).kind).toBe('rate_limited');
    expect(mapped(400).kind).toBe('invalid_request');
    expect(mapped(404).kind).toBe('invalid_request');
    expect(mapped(500).kind).toBe('overloaded');
    expect(mapped(503).kind).toBe('overloaded');
    expect(mapped(undefined).kind).toBe('unknown');
    // Provider identity rides along for assessProviderErrorOutcome's mismatch guard.
    expect(mapped(401).provider).toBe('google');
    // Ambiguous outcomes fail closed; clean rejections prove non-execution.
    expect(mapped(500).remoteOutcome).toBe('unknown');
    expect(mapped(401).remoteOutcome).toBe('not_executed');
  });

  it('maps abort/timeout errors to the timeout kind', () => {
    const provider = makeProvider();
    const abort = new Error('The operation was aborted.');
    abort.name = 'AbortError';
    // @ts-expect-error — private mapper, as above.
    expect(provider.mapError(abort).kind).toBe('timeout');
  });
});
