import { describe, expect, it } from 'vitest';
import { providerSupportsModel, knownModel } from '@/providers/pricing';

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
