import { describe, expect, it } from 'vitest';
import { opsChatTurnCostMicros, WEB_SEARCH_COST_MICROS } from '@/domain/opschat/usage';
import { costForUsage } from '@/providers/pricing';

describe('opsChatTurnCostMicros', () => {
  const usage = { inputTokens: 32_172, outputTokens: 1_112 };
  const tokens = costForUsage('anthropic', 'claude-sonnet-5', usage).usdMicros;

  it('is the token cost at the versioned price table plus $0.01 per web search', () => {
    expect(WEB_SEARCH_COST_MICROS).toBe(10_000n);
    expect(opsChatTurnCostMicros('anthropic', 'claude-sonnet-5', usage, 0)).toBe(tokens);
    expect(opsChatTurnCostMicros('anthropic', 'claude-sonnet-5', usage, 3)).toBe(tokens + 30_000n);
  });

  it('treats a missing, negative or fractional search count safely', () => {
    expect(opsChatTurnCostMicros('anthropic', 'claude-sonnet-5', usage, Number.NaN)).toBe(tokens);
    expect(opsChatTurnCostMicros('anthropic', 'claude-sonnet-5', usage, -2)).toBe(tokens);
    expect(opsChatTurnCostMicros('anthropic', 'claude-sonnet-5', usage, 2.9)).toBe(tokens + 20_000n);
  });
});
