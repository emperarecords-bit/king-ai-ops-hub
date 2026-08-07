import { APIError } from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  assessProviderErrorOutcome,
  ProviderError,
  type AIProvider,
  type AuthoritativeNotExecutedGuarantee,
  type ProviderErrorKind,
  type ProviderId,
} from '@/types/provider';
import { AnthropicProvider } from '@/providers/anthropic';
import { OpenAIProvider } from '@/providers/openai';

/**
 * Provider-error CLASSIFICATION — the structured `remoteOutcome` the whole run pipeline (engine + extraction)
 * keys off. Only errors PROVABLY rejected before the model ran are `not_executed`; everything else is
 * fail-closed `unknown`. In particular, Anthropic HTTP 529 is NOT a documented pre-processing rejection, so it
 * stays ambiguous (`unknown`) — the same as a generic 5xx — never a `not_executed` override.
 */

describe('ProviderError.remoteOutcome — the shared classification model', () => {
  const outcome = (kind: ProviderErrorKind) => new ProviderError('anthropic', kind, 'x').remoteOutcome;

  it('provably not-executed kinds classify not_executed', () => {
    expect(outcome('auth')).toBe('not_executed');
    expect(outcome('rate_limited')).toBe('not_executed');
    expect(outcome('invalid_request')).toBe('not_executed');
  });

  it('ambiguous kinds fail closed to unknown (overloaded / timeout / unknown)', () => {
    expect(outcome('overloaded')).toBe('unknown'); // a generic 5xx / 529 — may post-date execution
    expect(outcome('timeout')).toBe('unknown');
    expect(outcome('unknown')).toBe('unknown');
  });

  it('an explicit not_executed override is still honored where an adapter can prove it', () => {
    expect(new ProviderError('openai', 'overloaded', 'x', 'not_executed').remoteOutcome).toBe('not_executed');
  });

  it('rate_limited stays retryable (kind-based) while remaining not_executed', () => {
    const e = new ProviderError('anthropic', 'rate_limited', 'x');
    expect(e.retryable).toBe(true);
    expect(e.remoteOutcome).toBe('not_executed');
  });
});

function provider(id: ProviderId, authoritativeNotExecuted: AuthoritativeNotExecutedGuarantee): AIProvider {
  return {
    id,
    authoritativeNotExecuted,
    execute: async () => { throw new Error('not used'); },
    listModels: () => [],
  };
}

describe('authoritative non-execution guarantee boundary', () => {
  const guaranteed = provider('openai', {
    support: 'error_kinds',
    errorKinds: new Set(['rate_limited']),
    basis: 'test contract: scripted rejection occurs before dispatch',
  });
  const unsupported = provider('openai', { support: 'unsupported' });

  it('accepts not_executed only when the adapter capability covers the exact error kind', () => {
    const e = new ProviderError('openai', 'rate_limited', 'rejected');
    expect(assessProviderErrorOutcome(guaranteed, e)).toEqual({
      status: 'not_executed', basis: 'test contract: scripted rejection occurs before dispatch',
    });
  });

  it('fails closed when the adapter does not support authoritative proof', () => {
    const e = new ProviderError('openai', 'rate_limited', 'claimed rejection');
    expect(assessProviderErrorOutcome(unsupported, e)).toEqual({
      status: 'unknown', reason: 'unsupported_non_execution_proof',
    });
  });

  it.each(['timeout', 'overloaded', 'unknown'] as const)('%s remains ambiguous even with a bounded guarantee', (kind) => {
    expect(assessProviderErrorOutcome(guaranteed, new ProviderError('openai', kind, 'x')).status).toBe('unknown');
  });

  it('treats a generic network failure as an ambiguous unknown outcome', () => {
    const e = new ProviderError('openai', 'unknown', 'ECONNRESET after request transmission');
    expect(assessProviderErrorOutcome(guaranteed, e)).toEqual({
      status: 'unknown', reason: 'ambiguous_outcome',
    });
  });

  it('requires production adapters to opt in explicitly; OpenAI currently fails closed', () => {
    const e = new ProviderError('openai', 'rate_limited', 'claimed rejection');
    expect(assessProviderErrorOutcome(new OpenAIProvider('test-key'), e)).toEqual({
      status: 'unknown', reason: 'unsupported_non_execution_proof',
    });
  });

  it('rejects provider mismatch and malformed outcomes', () => {
    expect(assessProviderErrorOutcome(guaranteed, new ProviderError('anthropic', 'rate_limited', 'x'))).toEqual({
      status: 'unknown', reason: 'provider_mismatch',
    });
    const malformed = new ProviderError('openai', 'rate_limited', 'x') as ProviderError & { remoteOutcome: string };
    Object.defineProperty(malformed, 'remoteOutcome', { value: 'not-a-real-outcome' });
    expect(assessProviderErrorOutcome(guaranteed, malformed).status).toBe('unknown');
  });
});

/** Build an object that passes `instanceof APIError` with a specific HTTP status, to drive the real adapter. */
function apiError(status: number, message = ''): APIError {
  const e = Object.create(APIError.prototype) as APIError & { status: number; message: string };
  Object.assign(e, { status, message, name: 'APIError', headers: {}, error: {} });
  return e;
}

/** Run a status through the REAL AnthropicProvider.mapError via a mocked client. */
async function classifyAnthropic(status: number, message = ''): Promise<ProviderError> {
  const p = new AnthropicProvider('test-key');
  (p as unknown as { client: { messages: { create: () => Promise<never> } } }).client = {
    messages: {
      create: async () => {
        throw apiError(status, message);
      },
    },
  };
  try {
    await p.execute({ model: 'claude-x', system: 's', turns: [{ role: 'user', content: 'x' }], temperature: 0, maxOutputTokens: 10, timeoutMs: 1000 });
  } catch (err) {
    return err as ProviderError;
  }
  throw new Error('expected the adapter to throw');
}

describe('Anthropic adapter — HTTP status → structured classification', () => {
  it('529 overloaded is AMBIGUOUS (overloaded / unknown) — no not_executed override', async () => {
    const e = await classifyAnthropic(529);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.kind).toBe('overloaded');
    expect(e.remoteOutcome).toBe('unknown'); // the removed override: 529 no longer claims not-executed
  });

  it('a generic 500 is classified identically to 529 (overloaded / unknown)', async () => {
    const e = await classifyAnthropic(503);
    expect(e.kind).toBe('overloaded');
    expect(e.remoteOutcome).toBe('unknown');
  });

  it('429 remains a KNOWN not-executed rejection (rate_limited)', async () => {
    const e = await classifyAnthropic(429);
    expect(e.kind).toBe('rate_limited');
    expect(e.remoteOutcome).toBe('not_executed');
    expect(assessProviderErrorOutcome(new AnthropicProvider('test-key'), e)).toEqual({
      status: 'unknown', reason: 'unsupported_non_execution_proof',
    });
  });

  it('401 remains a KNOWN not-executed rejection (auth)', async () => {
    const e = await classifyAnthropic(401);
    expect(e.kind).toBe('auth');
    expect(e.remoteOutcome).toBe('not_executed');
  });

  it('400 remains a KNOWN not-executed rejection (invalid_request)', async () => {
    const e = await classifyAnthropic(400, 'bad params');
    expect(e.kind).toBe('invalid_request');
    expect(e.remoteOutcome).toBe('not_executed');
  });
});
