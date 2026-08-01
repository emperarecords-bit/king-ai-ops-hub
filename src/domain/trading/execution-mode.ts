import { PAPER_EXECUTION_MODE, type TradingCurrency, type TradingExecutionMode } from '@/types/trading';

/**
 * Stock Trading — the paper-only execution invariant. There is exactly ONE execution mode in this phase and it is
 * a compile-time + runtime constant. No code path may construct a non-paper mode, and no row may carry a live
 * brokerage destination. This module is the single choke point that other trading code asserts through.
 */

export class LiveTradingBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveTradingBlockedError';
  }
}

/** The immutable execution mode for the entire workspace. */
export const EXECUTION_MODE: TradingExecutionMode = PAPER_EXECUTION_MODE;
export const TRADING_CURRENCY: TradingCurrency = 'USD';

/** Fail-closed guard: only `paper` is ever acceptable; anything else throws. */
export function assertPaperExecution(mode: string): asserts mode is 'paper' {
  if (mode !== PAPER_EXECUTION_MODE) throw new LiveTradingBlockedError(`live/non-paper execution is not permitted (got ${JSON.stringify(mode)})`);
}

/** A brokerage/order "destination" must be the internal paper simulator — never an external/live venue. */
export const PAPER_DESTINATION = 'internal-paper-simulator' as const;
export function assertPaperDestination(dest: string): asserts dest is 'internal-paper-simulator' {
  if (dest !== PAPER_DESTINATION) throw new LiveTradingBlockedError(`only the internal paper simulator is an allowed order destination (got ${JSON.stringify(dest)})`);
}

/** Reject any field that would represent an external/live-order identifier (belt-and-suspenders on inputs). */
export function assertNoExternalOrderIdentity(input: Record<string, unknown>): void {
  for (const forbidden of ['brokerId', 'brokerAccountId', 'liveOrderId', 'externalOrderId', 'venue', 'routeTo']) {
    if (input[forbidden] !== undefined) throw new LiveTradingBlockedError(`external/live-order field ${forbidden} is not permitted in paper mode`);
  }
}
