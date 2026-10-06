import { describe, expect, it, vi } from 'vitest';
import {
  runCouncil,
  CouncilUnavailableError,
  COUNCIL_MAX_REVIEWERS,
  COUNCIL_MAX_REVIEWER_TOKENS,
  COUNCIL_MAX_SYNTHESIS_TOKENS,
  COUNCIL_REVIEWER_TIMEOUT_MS,
  COUNCIL_QUORUM,
  type CouncilInput,
} from '@/domain/opschat/council';
import { type AIProvider, type ProviderId } from '@/types/provider';

/**
 * Ops Chat Council domain. Exercises the REAL runCouncil with INJECTED FAKE
 * providers (deps.getProvider) — no real model call, no spend. Verifies reviewer
 * fan-out, hard caps, quorum/graceful-degradation, safe failure, and that the
 * result carries no executable/action capability.
 */

const VALID_SYNTHESIS = JSON.stringify({
  agreement: ['both reviewers agree the answer is supported'],
  disagreements: [],
  recommendation: 'Proceed, but verify the failing run first.',
  risks: ['one run is still failing'],
  confidence: 'high',
  ownerDecisionNeeded: ['whether to re-run now'],
});

function resp(id: ProviderId, model: string, text: string) {
  return { provider: id, model, text, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn', latencyMs: 1 };
}

const isSynthesis = (system: string): boolean => system.includes('COUNCIL SYNTHESISER');

interface FakeOpts {
  /** Reviewer calls on this provider throw (synthesis still works). */
  failReviewer?: boolean;
  /** Override synthesis output text (default: valid JSON). */
  synthesisText?: string;
}

function makeProvider(id: ProviderId, opts: FakeOpts): AIProvider {
  const execute = vi.fn(async (req: { system: string; model: string }) => {
    if (isSynthesis(req.system)) return resp(id, req.model, opts.synthesisText ?? VALID_SYNTHESIS);
    if (opts.failReviewer) throw new Error('provider unavailable');
    return resp(id, req.model, `conclusion from ${id}`);
  });
  return { id, execute, listModels: () => [] } as unknown as AIProvider;
}

/** Build a getProvider over the given configured vendors; unknown ids throw. */
function makeGetProvider(config: Partial<Record<ProviderId, FakeOpts>>): {
  getProvider: (id: ProviderId) => AIProvider;
  providers: Partial<Record<ProviderId, AIProvider>>;
} {
  const providers: Partial<Record<ProviderId, AIProvider>> = {};
  for (const [id, opts] of Object.entries(config)) providers[id as ProviderId] = makeProvider(id as ProviderId, opts!);
  return {
    providers,
    getProvider: (id: ProviderId) => {
      const p = providers[id];
      if (!p) throw new Error(`Provider '${id}' is not configured.`);
      return p;
    },
  };
}

const INPUT: CouncilInput = {
  question: 'How is AccurateBids doing?',
  primaryAnswer: 'AccurateBids is healthy; one run failed in the last 24h.',
  context: 'WORKSPACES: AccurateBids health=Healthy; runsFailed24h=1',
};

function reviewerExecuteCalls(providers: Partial<Record<ProviderId, AIProvider>>): number {
  let n = 0;
  for (const p of Object.values(providers)) {
    const ex = (p as unknown as { execute: { mock: { calls: Array<[{ system: string }]> } } }).execute;
    for (const [req] of ex.mock.calls) if (!isSynthesis(req.system)) n++;
  }
  return n;
}
function allCalls(providers: Partial<Record<ProviderId, AIProvider>>): Array<{ system: string; model: string; maxOutputTokens: number; timeoutMs: number }> {
  const out: Array<{ system: string; model: string; maxOutputTokens: number; timeoutMs: number }> = [];
  for (const p of Object.values(providers)) {
    const ex = (p as unknown as { execute: { mock: { calls: Array<[{ system: string; model: string; maxOutputTokens: number; timeoutMs: number }]> } } }).execute;
    for (const [req] of ex.mock.calls) out.push(req);
  }
  return out;
}

describe('runCouncil — fan-out and synthesis', () => {
  it('runs reviewers + synthesis and returns a structured result', async () => {
    const { getProvider, providers } = makeGetProvider({ anthropic: {}, openai: {}, google: {} });
    const result = await runCouncil(INPUT, { getProvider });

    expect(result.synthesis.recommendation).toContain('Proceed');
    expect(result.synthesis.confidence).toBe('high');
    expect(result.reviewers.length).toBe(3);
    expect(result.reviewers.every((r) => r.ok)).toBe(true);
    expect(result.degraded).toBe(false);
    // Exactly 3 reviewer calls (one per role) — no retries.
    expect(reviewerExecuteCalls(providers)).toBe(3);
  });

  it('never exceeds the hard reviewer cap', async () => {
    const { getProvider } = makeGetProvider({ anthropic: {}, openai: {}, google: {}, deepseek: {} });
    const result = await runCouncil(INPUT, { getProvider });
    expect(result.reviewers.length).toBeLessThanOrEqual(COUNCIL_MAX_REVIEWERS);
  });

  it('enforces per-reviewer and synthesis token/timeout caps', async () => {
    const { getProvider, providers } = makeGetProvider({ anthropic: {}, openai: {} });
    await runCouncil(INPUT, { getProvider });
    const calls = allCalls(providers);
    const reviewerCalls = calls.filter((c) => !isSynthesis(c.system));
    const synthCalls = calls.filter((c) => isSynthesis(c.system));
    expect(reviewerCalls.length).toBeGreaterThan(0);
    for (const c of reviewerCalls) {
      expect(c.maxOutputTokens).toBe(COUNCIL_MAX_REVIEWER_TOKENS);
      expect(c.timeoutMs).toBe(COUNCIL_REVIEWER_TIMEOUT_MS);
    }
    expect(synthCalls.length).toBe(1);
    expect(synthCalls[0]!.maxOutputTokens).toBe(COUNCIL_MAX_SYNTHESIS_TOKENS);
  });

  it('uses only two vendors when only two are configured (no third required)', async () => {
    const { getProvider } = makeGetProvider({ anthropic: {}, openai: {} });
    const result = await runCouncil(INPUT, { getProvider });
    const vendors = new Set(result.reviewers.map((r) => r.provider));
    expect(result.reviewers.length).toBe(3); // three roles
    expect([...vendors].every((v) => v === 'anthropic' || v === 'openai')).toBe(true);
    expect(result.synthesis.confidence).toBe('high');
  });
});

describe('runCouncil — graceful degradation and safe failure', () => {
  it('degrades gracefully when one reviewer fails but quorum holds', async () => {
    // 3 distinct vendors; google reviewer fails. 2 succeed (>= quorum) → degraded.
    const { getProvider } = makeGetProvider({ anthropic: {}, openai: {}, google: { failReviewer: true } });
    const result = await runCouncil(INPUT, { getProvider });
    expect(result.degraded).toBe(true);
    expect(result.reviewers.filter((r) => r.ok).length).toBeGreaterThanOrEqual(COUNCIL_QUORUM);
    expect(result.reviewers.some((r) => !r.ok)).toBe(true);
    expect(result.synthesis.recommendation).toContain('Proceed');
  });

  it('attempts each reviewer only once even on failure (no retry storm)', async () => {
    const { getProvider, providers } = makeGetProvider({ anthropic: {}, openai: {}, google: { failReviewer: true } });
    await runCouncil(INPUT, { getProvider });
    expect(reviewerExecuteCalls(providers)).toBe(3); // 3 roles, one attempt each
  });

  it('fails safe (CouncilUnavailableError) when quorum is not reached', async () => {
    // 3 vendors, two reviewers fail → only 1 success (< quorum 2).
    const { getProvider } = makeGetProvider({
      anthropic: {},
      openai: { failReviewer: true },
      google: { failReviewer: true },
    });
    await expect(runCouncil(INPUT, { getProvider })).rejects.toBeInstanceOf(CouncilUnavailableError);
  });

  it('fails safe when ALL reviewers fail', async () => {
    const { getProvider } = makeGetProvider({
      anthropic: { failReviewer: true },
      openai: { failReviewer: true },
    });
    await expect(runCouncil(INPUT, { getProvider })).rejects.toBeInstanceOf(CouncilUnavailableError);
  });

  it('fails safe when NO providers are configured', async () => {
    const { getProvider } = makeGetProvider({});
    await expect(runCouncil(INPUT, { getProvider })).rejects.toBeInstanceOf(CouncilUnavailableError);
  });

  it('fails safe when synthesis returns unusable (non-JSON) output', async () => {
    const { getProvider } = makeGetProvider({
      anthropic: { synthesisText: 'the council could not agree, sorry' },
      openai: {},
    });
    await expect(runCouncil(INPUT, { getProvider })).rejects.toBeInstanceOf(CouncilUnavailableError);
  });
});

describe('runCouncil — review-only guarantee (no action capability)', () => {
  it('the result object carries only advisory fields — no executable/proposal/action', async () => {
    const { getProvider } = makeGetProvider({ anthropic: {}, openai: {} });
    const result = await runCouncil(INPUT, { getProvider });
    expect(Object.keys(result).sort()).toEqual(['degraded', 'reviewers', 'synthesis']);
    // No function/callable escaped into the result, and no action/proposal field.
    const json = JSON.parse(JSON.stringify(result));
    expect(json).not.toHaveProperty('proposal');
    expect(json).not.toHaveProperty('action');
    expect(Object.keys(json.synthesis).sort()).toEqual([
      'agreement',
      'confidence',
      'disagreements',
      'ownerDecisionNeeded',
      'recommendation',
      'risks',
    ]);
  });
});
