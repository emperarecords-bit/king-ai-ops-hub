import { describe, expect, it } from 'vitest';
import { providerSupportsModel, knownModel, providerForModel, allModels, MODEL_PRICING } from '@/providers/pricing';

/** Provider/model validation guard for audited employee provisioning. */
describe('providerSupportsModel', () => {
  it('accepts models that belong to the provider', () => {
    expect(providerSupportsModel('openai', 'gpt-5.4-mini')).toBe(true);
    expect(providerSupportsModel('openai', 'gpt-5.4')).toBe(true);
    expect(providerSupportsModel('anthropic', 'claude-sonnet-5')).toBe(true);
    expect(providerSupportsModel('anthropic', 'claude-opus-4-8')).toBe(true);
  });
  it('rejects a model that belongs to the OTHER provider', () => {
    expect(providerSupportsModel('anthropic', 'gpt-5.4-mini')).toBe(false);
    expect(providerSupportsModel('openai', 'claude-sonnet-5')).toBe(false);
  });
  it('rejects unknown models', () => {
    expect(providerSupportsModel('openai', 'not-a-real-model')).toBe(false);
    expect(knownModel('not-a-real-model')).toBe(false);
  });
});

/** providerForModel — the authoritative pairing that keeps an agent's provider consistent with its model.
 *  Prevents the incident where a Claude model was left on provider=google, failing dispatch. */
describe('providerForModel', () => {
  it('returns the one provider that serves each model', () => {
    expect(providerForModel('claude-haiku-4-5-20251001')).toBe('anthropic');
    expect(providerForModel('claude-sonnet-5')).toBe('anthropic');
    expect(providerForModel('gpt-5.4-mini')).toBe('openai');
    expect(providerForModel('gemini-3.1-flash-lite')).toBe('google');
  });
  it('returns null for an unknown model', () => {
    expect(providerForModel('not-a-real-model')).toBeNull();
  });
  it('never disagrees with providerSupportsModel (a model + its own provider always matches)', () => {
    for (const id of Object.keys(MODEL_PRICING)) {
      const p = providerForModel(id)!;
      expect(providerSupportsModel(p, id)).toBe(true);
    }
  });
  it('a claude model is NOT served by google — the exact mismatch that stranded runs', () => {
    expect(providerSupportsModel('google', 'claude-haiku-4-5-20251001')).toBe(false);
    expect(providerForModel('claude-haiku-4-5-20251001')).not.toBe('google');
  });
});

/** allModels — the employee editor must offer every provider's models (grouped), not just one provider's. */
describe('allModels', () => {
  it('spans all providers so a cross-provider switch is possible', () => {
    const providers = new Set(allModels().map((m) => m.provider));
    expect(providers.has('anthropic')).toBe(true);
    expect(providers.has('openai')).toBe(true);
    expect(providers.has('google')).toBe(true);
    expect(allModels().length).toBe(Object.keys(MODEL_PRICING).length);
  });
  it('every listed model carries its correct provider', () => {
    for (const m of allModels()) expect(providerForModel(m.id)).toBe(m.provider);
  });
});
