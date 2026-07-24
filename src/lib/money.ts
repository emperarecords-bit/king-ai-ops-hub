import { type Money, type TokenUsage } from '@/types/provider';

/**
 * All money is integer USD micros (D-004). These helpers are the only place
 * formatting or arithmetic on money happens.
 */

export const MICROS_PER_USD = 1_000_000n;

export function money(usdMicros: bigint): Money {
  return { usdMicros };
}

export function addMoney(a: Money, b: Money): Money {
  return { usdMicros: a.usdMicros + b.usdMicros };
}

export const ZERO_MONEY: Money = { usdMicros: 0n };

/**
 * tokens * microsPerMillionTokens / 1_000_000, in exact integer arithmetic.
 * Pricing tables quote micros per MILLION tokens so typical rates are integers
 * (e.g. $2.50/M input = 2_500_000 micros/M).
 */
export function costForTokens(tokens: number, microsPerMillionTokens: bigint): bigint {
  if (!Number.isInteger(tokens) || tokens < 0) {
    throw new Error(`Token count must be a non-negative integer, got ${tokens}`);
  }
  return (BigInt(tokens) * microsPerMillionTokens) / 1_000_000n;
}

export function usageCost(
  usage: TokenUsage,
  inputMicrosPerM: bigint,
  outputMicrosPerM: bigint,
): Money {
  return money(
    costForTokens(usage.inputTokens, inputMicrosPerM) +
      costForTokens(usage.outputTokens, outputMicrosPerM),
  );
}

/** "$1.2345" — four decimal places because per-call costs are tiny. */
export function formatMoney(m: Money): string {
  const negative = m.usdMicros < 0n;
  const abs = negative ? -m.usdMicros : m.usdMicros;
  const dollars = abs / MICROS_PER_USD;
  const fraction = abs % MICROS_PER_USD;
  // Two decimals for whole-dollar magnitudes, four when there are sub-cent parts.
  const fractionStr = (fraction * 10_000n) / MICROS_PER_USD;
  const padded = fractionStr.toString().padStart(4, '0');
  const trimmed = padded.endsWith('00') ? padded.slice(0, 2) : padded;
  return `${negative ? '-' : ''}$${dollars}.${trimmed}`;
}
