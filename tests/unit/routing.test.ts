import { describe, expect, it } from 'vitest';
import { resolveModelForTier } from '@/orchestration/routing';

describe('model tier routing (D-014)', () => {
  it('standard tier keeps the agent-configured model', () => {
    expect(resolveModelForTier('standard', 'openai', 'gpt-5.2-mini')).toBe('gpt-5.2-mini');
    expect(resolveModelForTier('standard', 'anthropic', 'claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  it('flagship tier overrides to the flagship model per provider', () => {
    expect(resolveModelForTier('flagship', 'openai', 'gpt-5.2-mini')).toBe('gpt-5.2');
    expect(resolveModelForTier('flagship', 'anthropic', 'claude-sonnet-5')).toBe('claude-opus-4-8');
  });

  it('flagship override ignores whatever the agent had configured', () => {
    // Even a mis-configured agent cannot escape the tier mapping.
    expect(resolveModelForTier('flagship', 'openai', 'gpt-5.2')).toBe('gpt-5.2');
    expect(resolveModelForTier('flagship', 'anthropic', 'claude-haiku-4-5-20251001')).toBe(
      'claude-opus-4-8',
    );
  });

  it('standard tier never silently upgrades cost', () => {
    // A cheap configured model stays cheap unless a human chose flagship.
    expect(resolveModelForTier('standard', 'anthropic', 'claude-haiku-4-5-20251001')).toBe(
      'claude-haiku-4-5-20251001',
    );
  });
});
