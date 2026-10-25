import { describe, expect, it, vi } from 'vitest';
import {
  runCouncil,
  REVIEWER_MODEL,
  COUNCIL_MAX_REVIEWER_TOKENS,
  COUNCIL_MAX_SYNTHESIS_TOKENS,
  COUNCIL_REVIEWER_TIMEOUT_MS,
  COUNCIL_SYNTHESIS_TIMEOUT_MS,
  COUNCIL_OVERALL_TIMEOUT_MS,
} from '@/domain/opschat/council';
import { FLAGSHIP_MODELS } from '@/orchestration/routing';
import { knownModel, providerForModel } from '@/providers/pricing';
import { type AIProvider, type ProviderId } from '@/types/provider';

/**
 * Owner decision 2026-10-22: the Council runs on the TOP model per vendor, with output caps and time sized for
 * reasoning models (whose thinking counts against the output budget — a 700-token cap risked EMPTY conclusions).
 */

const SYNTH = JSON.stringify({ agreement: [], disagreements: [], recommendation: 'Proceed.', risks: [], confidence: 'high', ownerDecisionNeeded: [] });

describe('Council models', () => {
  it('is exactly the flagship model per vendor', () => {
    expect(REVIEWER_MODEL).toEqual({
      anthropic: 'claude-opus-4-8',
      openai: 'gpt-5.4',
      google: 'gemini-3.1-pro-preview',
      deepseek: 'deepseek-reasoner',
    });
    expect(REVIEWER_MODEL).toBe(FLAGSHIP_MODELS); // one source of truth with task-tier routing
  });

  it('every Council model is priced (spend is metered) and belongs to its own vendor', () => {
    for (const [vendor, model] of Object.entries(REVIEWER_MODEL)) {
      expect(knownModel(model), model).toBe(true);
      expect(providerForModel(model)).toBe(vendor);
    }
  });

  it('caps and time leave room to reason, inside one bounded overall deadline', () => {
    expect(COUNCIL_MAX_REVIEWER_TOKENS).toBeGreaterThanOrEqual(4_000);
    expect(COUNCIL_MAX_SYNTHESIS_TOKENS).toBeGreaterThanOrEqual(4_000);
    expect(COUNCIL_OVERALL_TIMEOUT_MS).toBeGreaterThanOrEqual(COUNCIL_REVIEWER_TIMEOUT_MS + COUNCIL_SYNTHESIS_TIMEOUT_MS);
    expect(COUNCIL_OVERALL_TIMEOUT_MS).toBeLessThanOrEqual(5 * 60_000); // still hard-bounded
  });

  it('each reviewer and the synthesis are called with their vendor flagship, caps and timeouts', async () => {
    const calls: Array<{ vendor: ProviderId; model: string; maxOutputTokens: number; timeoutMs: number; synth: boolean }> = [];
    const make = (vendor: ProviderId): AIProvider =>
      ({
        id: vendor,
        listModels: () => [],
        execute: vi.fn(async (req: { system: string; model: string; maxOutputTokens: number; timeoutMs: number }) => {
          const synth = req.system.includes('COUNCIL SYNTHESISER');
          calls.push({ vendor, model: req.model, maxOutputTokens: req.maxOutputTokens, timeoutMs: req.timeoutMs, synth });
          return { provider: vendor, model: req.model, text: synth ? SYNTH : `conclusion from ${vendor}`, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn', latencyMs: 1 };
        }),
      }) as unknown as AIProvider;
    const providers: Partial<Record<ProviderId, AIProvider>> = { anthropic: make('anthropic'), openai: make('openai'), google: make('google') };
    const getProvider = (id: ProviderId): AIProvider => {
      const p = providers[id];
      if (!p) throw new Error('not configured');
      return p;
    };

    await runCouncil({ question: 'Q', primaryAnswer: 'A', context: 'C' }, { getProvider });

    const reviewers = calls.filter((c) => !c.synth);
    expect(reviewers.map((c) => c.model).sort()).toEqual(['claude-opus-4-8', 'gemini-3.1-pro-preview', 'gpt-5.4']);
    for (const c of reviewers) {
      expect(c.maxOutputTokens).toBe(COUNCIL_MAX_REVIEWER_TOKENS);
      expect(c.timeoutMs).toBe(COUNCIL_REVIEWER_TIMEOUT_MS);
    }
    const synth = calls.filter((c) => c.synth);
    expect(synth).toEqual([
      { vendor: 'anthropic', model: 'claude-opus-4-8', maxOutputTokens: COUNCIL_MAX_SYNTHESIS_TOKENS, timeoutMs: COUNCIL_SYNTHESIS_TIMEOUT_MS, synth: true },
    ]);
  });
});
