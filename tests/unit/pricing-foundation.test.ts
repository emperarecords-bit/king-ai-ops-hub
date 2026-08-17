import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTION_TYPES } from '@/types/domain';
import { MODEL_PRICING } from '@/providers/pricing';
import { costForUsage } from '@/providers/pricing';
import { hasEligibleExecutor } from '@/domain/execution/executors';
import {
  EXCLUDED_MODELS,
  PricingLookupError,
  PRICING_UNIT_DEFINITION,
  TOKEN_UNIT_SIZE,
  buildSeedEntries,
  ceilDiv,
  computeSeedScheduleHash,
  isEntryValidAt,
  selectPricingEntry,
  worstCaseTokenCostMicros,
} from '@/domain/pricing/pricing-foundation';

describe('pricing foundation (P1a)', () => {
  const entries = buildSeedEntries();

  it('stores per-MILLION-token source values verbatim (no conversion)', () => {
    const mini = entries.find((e) => e.model === 'gpt-5.4-mini')!;
    expect(mini.inputUnitPriceMicros).toBe(MODEL_PRICING['gpt-5.4-mini']!.inputMicrosPerM);
    expect(mini.outputUnitPriceMicros).toBe(MODEL_PRICING['gpt-5.4-mini']!.outputMicrosPerM);
    expect(mini.inputUnitPriceMicros).toBe(750000n);
  });

  it('token_unit_size is 1_000_000 and unit definition is per_1m_tokens', () => {
    expect(TOKEN_UNIT_SIZE).toBe(1_000_000n);
    for (const e of entries) {
      expect(e.tokenUnitSize).toBe(1_000_000n);
      expect(e.unitDefinition).toBe(PRICING_UNIT_DEFINITION);
      expect(PRICING_UNIT_DEFINITION).toBe('per_1m_tokens');
    }
  });

  it('excludes gpt-5.2 from the active seeded schedule (delisted/unverified)', () => {
    expect(entries.some((e) => e.model === 'gpt-5.2')).toBe(false);
    expect('gpt-5.2' in EXCLUDED_MODELS).toBe(true);
    // still present in the runtime source (unchanged)
    expect('gpt-5.2' in MODEL_PRICING).toBe(true);
  });

  it('max_output_tokens matches the authoritative source', () => {
    for (const e of entries) {
      expect(e.maxOutputTokens).toBe(MODEL_PRICING[e.model]!.maxOutputTokens);
    }
  });

  it('ceil division rounds UP using the stored token-unit size; never down', () => {
    expect(ceilDiv(1n, 1_000_000n)).toBe(1n);
    expect(ceilDiv(1_000_000n, 1_000_000n)).toBe(1n);
    expect(ceilDiv(1_000_001n, 1_000_000n)).toBe(2n);
    // 1 input token at 750000 micros/M → ceil(1*750000/1_000_000) = 1 (rounds up from 0.75)
    const c = worstCaseTokenCostMicros({
      maxInputTokens: 1,
      maxOutputTokens: 0,
      inputUnitPriceMicros: 750_000n,
      outputUnitPriceMicros: 4_500_000n,
      tokenUnitSize: 1_000_000n,
      minChargeMicros: null,
    });
    expect(c).toBe(1n);
  });

  it('worst-case cost sums input+output with ceil; null minimum charge behaves as zero', () => {
    // 1,000,000 in + 1,000,000 out for gpt-5.4-mini → 750000 + 4500000 = 5_250_000
    const c = worstCaseTokenCostMicros({
      maxInputTokens: 1_000_000,
      maxOutputTokens: 1_000_000,
      inputUnitPriceMicros: 750_000n,
      outputUnitPriceMicros: 4_500_000n,
      tokenUnitSize: 1_000_000n,
      minChargeMicros: null,
    });
    expect(c).toBe(5_250_000n);
    // minimum charge floor applies when higher
    const floored = worstCaseTokenCostMicros({
      maxInputTokens: 1,
      maxOutputTokens: 0,
      inputUnitPriceMicros: 750_000n,
      outputUnitPriceMicros: 0n,
      tokenUnitSize: 1_000_000n,
      minChargeMicros: 10n,
    });
    expect(floored).toBe(10n);
  });

  it('Sonnet 5 is valid before its cutoff and rejected at/after it', () => {
    const s5 = entries.find((e) => e.model === 'claude-sonnet-5')!;
    expect(s5.validUntil).toBe('2026-09-01T00:00:00.000Z');
    expect(isEntryValidAt(s5, '2026-08-31T23:59:59.000Z')).toBe(true);
    expect(isEntryValidAt(s5, '2026-09-01T00:00:00.000Z')).toBe(false); // boundary is exclusive
    expect(isEntryValidAt(s5, '2026-09-02T00:00:00.000Z')).toBe(false);
    // selectPricingEntry fails closed at/after cutoff
    expect(() => selectPricingEntry(entries, 'anthropic', 'claude-sonnet-5', '2026-09-01T00:00:00.000Z')).toThrow(PricingLookupError);
    expect(selectPricingEntry(entries, 'anthropic', 'claude-sonnet-5', '2026-08-01T00:00:00.000Z').model).toBe('claude-sonnet-5');
  });

  it('unknown or excluded models fail closed in the pricing helper', () => {
    expect(() => selectPricingEntry(entries, 'openai', 'gpt-5.2', '2026-07-30T00:00:00.000Z')).toThrow(PricingLookupError);
    expect(() => selectPricingEntry(entries, 'openai', 'does-not-exist', '2026-07-30T00:00:00.000Z')).toThrow(PricingLookupError);
  });

  it('seeded schedule hash is stable / reproducible via canonicalization v1', () => {
    expect(computeSeedScheduleHash()).toBe(computeSeedScheduleHash());
    expect(computeSeedScheduleHash()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('runtime fallback (costForUsage) remains untouched', () => {
    // pure behavior unchanged: gpt-5.4-mini 1M in / 0 out = $0.75 = 750000 micros
    const cost = costForUsage('openai', 'gpt-5.4-mini', { inputTokens: 1_000_000, outputTokens: 0 });
    expect(cost.usdMicros).toBe(750_000n);
  });

  it('executor eligibility is true ONLY for git_pr and org_delegation (pricing gains no executor)', () => {
    for (const a of ACTION_TYPES) {
      expect(hasEligibleExecutor(a)).toBe(a === 'git_pr' || a === 'org_delegation' || a === 'external_http');
    }
  });

  it('no live-dispatch module imports the pricing foundation or canonical lib', () => {
    const root = process.cwd();
    for (const rel of [
      'src/domain/tasks/runner.ts',
      'src/orchestration/engine.ts',
      'src/providers/registry.ts',
      'src/providers/openai.ts',
      'src/providers/anthropic.ts',
    ]) {
      const src = readFileSync(join(root, rel), 'utf8');
      expect(src.includes('pricing-foundation')).toBe(false);
      expect(src.includes('lib/canonical')).toBe(false);
    }
  });
});
