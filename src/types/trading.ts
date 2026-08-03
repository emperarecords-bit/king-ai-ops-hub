/**
 * Stock Trading workspace — P1 Foundations domain unions (source of truth; projected into Postgres enums by
 * `src/db/schema/trading-enums.ts`, mirroring the Hub convention).
 *
 * HARD PHASE INVARIANTS (enforced structurally + by tests):
 *   - executionMode is ALWAYS `paper`; there is no live-brokerage destination anywhere in the schema or code.
 *   - USD only; US-listed equities and UNLEVERAGED ETFs only; LONG-ONLY (buy-to-open / sell-to-close).
 *   - No shorting, options, margin, crypto, fractional shares, or external/live-order identifiers.
 */

/** The ONLY execution mode this workspace supports. Live is deliberately not representable. */
export const TRADING_EXECUTION_MODES = ['paper'] as const;
export type TradingExecutionMode = (typeof TRADING_EXECUTION_MODES)[number];
export const PAPER_EXECUTION_MODE: TradingExecutionMode = 'paper';

/** The only settlement/quote currency in P1. */
export const TRADING_CURRENCIES = ['USD'] as const;
export type TradingCurrency = (typeof TRADING_CURRENCIES)[number];

/** Supported instrument kinds — cash equities and unleveraged ETFs only. */
export const INSTRUMENT_KINDS = ['equity', 'etf'] as const;
export type InstrumentKind = (typeof INSTRUMENT_KINDS)[number];

/** Supported venues (US listings only in P1). */
export const INSTRUMENT_EXCHANGES = ['XNAS', 'XNYS', 'ARCX', 'BATS', 'XASE'] as const;
export type InstrumentExchange = (typeof INSTRUMENT_EXCHANGES)[number];

/** Long-only order sides: BUY opens/increases a long; SELL closes/reduces it. No short/cover. */
export const ORDER_SIDES = ['buy', 'sell'] as const;
export type OrderSide = (typeof ORDER_SIDES)[number];

export const ORDER_TYPES = ['market', 'limit'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

/** Time-in-force — day only in P1 (no GTC/extended-hours simulation yet). */
export const TIME_IN_FORCES = ['day'] as const;
export type TimeInForce = (typeof TIME_IN_FORCES)[number];

/**
 * Paper-order lifecycle. Terminal states: risk_rejected, rejected, expired, simulated_filled, cancelled.
 * `simulated_filled` is reachable ONLY through the guarded fill (see order-state-machine.ts).
 */
export const PAPER_ORDER_STATES = [
  'draft',
  'risk_pending',
  'risk_rejected',
  'pending_approval',
  'approved',
  'rejected',
  'expired',
  'fill_pending',
  'simulated_filled',
  'cancelled',
] as const;
export type PaperOrderState = (typeof PAPER_ORDER_STATES)[number];

/** Research provenance class — a note is a FACT or a FORECAST, never a recommendation (that is a thesis). */
export const RESEARCH_EPISTEMIC_CLASSES = ['fact', 'forecast'] as const;
export type ResearchEpistemicClass = (typeof RESEARCH_EPISTEMIC_CLASSES)[number];

export const RESEARCH_NOTE_KINDS = ['company', 'etf', 'sector', 'earnings', 'filing', 'news'] as const;
export type ResearchNoteKind = (typeof RESEARCH_NOTE_KINDS)[number];

/** Thesis direction — long only in P1. */
export const THESIS_DIRECTIONS = ['long'] as const;
export type ThesisDirection = (typeof THESIS_DIRECTIONS)[number];

export const THESIS_STATUSES = ['draft', 'active', 'invalidated', 'closed'] as const;
export type ThesisStatus = (typeof THESIS_STATUSES)[number];

export const THESIS_TIME_HORIZONS = ['intraday', 'swing', 'position', 'long_term'] as const;
export type ThesisTimeHorizon = (typeof THESIS_TIME_HORIZONS)[number];

/** Risk-limit kinds. All are HARD and non-overridable in the MVP. */
export const RISK_LIMIT_KINDS = [
  'max_symbol_position', // % of portfolio NAV in a single symbol
  'max_sector_concentration', // % of NAV in a single sector
  'max_gross_exposure', // gross exposure as % of NAV
  'daily_loss_limit', // max realized+unrealized loss over the trading day
  'weekly_loss_limit', // max realized+unrealized loss over the trailing week
] as const;
export type RiskLimitKind = (typeof RISK_LIMIT_KINDS)[number];

export const RISK_CHECK_RESULTS = ['pass', 'fail'] as const;
export type RiskCheckResult = (typeof RISK_CHECK_RESULTS)[number];

/** Market session state reported by the market-data adapter; drives market-closed rejection. */
export const MARKET_SESSIONS = ['pre', 'open', 'post', 'closed', 'halted'] as const;
export type MarketSession = (typeof MARKET_SESSIONS)[number];

export const KILL_SWITCH_STATES = ['armed', 'tripped'] as const;
export type KillSwitchState = (typeof KILL_SWITCH_STATES)[number];

/**
 * Trading audit actions (free-form audit `action` strings; the Hub audit `action` column is untyped text, but we
 * pin the vocabulary here and prove — via a test — that every proposed state transition maps to one of these).
 */
export const TRADING_AUDIT_ACTIONS = [
  'trading.signal.recorded',
  'trading.thesis.created',
  'trading.thesis.changed',
  'trading.proposal.created',
  'trading.proposal.risk_checked',
  'trading.proposal.risk_rejected',
  'trading.proposal.submitted_for_approval',
  'trading.proposal.approved',
  'trading.proposal.rejected',
  'trading.proposal.expired',
  'trading.proposal.cancelled',
  'trading.order.fill_dispatched',
  'trading.order.simulated_filled',
  'trading.risk_limit.changed',
  'trading.restricted_symbol.changed',
  'trading.kill_switch.tripped',
  'trading.kill_switch.reset',
] as const;
export type TradingAuditAction = (typeof TRADING_AUDIT_ACTIONS)[number];
