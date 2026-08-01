import { pgEnum } from 'drizzle-orm/pg-core';
import {
  INSTRUMENT_EXCHANGES,
  INSTRUMENT_KINDS,
  KILL_SWITCH_STATES,
  MARKET_SESSIONS,
  ORDER_SIDES,
  ORDER_TYPES,
  PAPER_ORDER_STATES,
  RESEARCH_EPISTEMIC_CLASSES,
  RESEARCH_NOTE_KINDS,
  RISK_CHECK_RESULTS,
  RISK_LIMIT_KINDS,
  THESIS_DIRECTIONS,
  THESIS_STATUSES,
  THESIS_TIME_HORIZONS,
  TIME_IN_FORCES,
  TRADING_CURRENCIES,
  TRADING_EXECUTION_MODES,
} from '@/types/trading';

/**
 * Stock Trading — Postgres enums projecting the trading unions in `src/types/trading.ts` (the source of truth).
 * `trading_execution_mode` and `trading_currency` are single-value enums, so a live/non-USD row is not even
 * representable at the database level.
 */

export const tradingExecutionModeEnum = pgEnum('trading_execution_mode', TRADING_EXECUTION_MODES);
export const tradingCurrencyEnum = pgEnum('trading_currency', TRADING_CURRENCIES);
export const instrumentKindEnum = pgEnum('instrument_kind', INSTRUMENT_KINDS);
export const instrumentExchangeEnum = pgEnum('instrument_exchange', INSTRUMENT_EXCHANGES);
export const orderSideEnum = pgEnum('order_side', ORDER_SIDES);
export const orderTypeEnum = pgEnum('order_type', ORDER_TYPES);
export const timeInForceEnum = pgEnum('time_in_force', TIME_IN_FORCES);
export const paperOrderStateEnum = pgEnum('paper_order_state', PAPER_ORDER_STATES);
export const researchEpistemicClassEnum = pgEnum('research_epistemic_class', RESEARCH_EPISTEMIC_CLASSES);
export const researchNoteKindEnum = pgEnum('research_note_kind', RESEARCH_NOTE_KINDS);
export const thesisDirectionEnum = pgEnum('thesis_direction', THESIS_DIRECTIONS);
export const thesisStatusEnum = pgEnum('thesis_status', THESIS_STATUSES);
export const thesisTimeHorizonEnum = pgEnum('thesis_time_horizon', THESIS_TIME_HORIZONS);
export const riskLimitKindEnum = pgEnum('risk_limit_kind', RISK_LIMIT_KINDS);
export const riskCheckResultEnum = pgEnum('risk_check_result', RISK_CHECK_RESULTS);
export const marketSessionEnum = pgEnum('market_session', MARKET_SESSIONS);
export const killSwitchStateEnum = pgEnum('kill_switch_state', KILL_SWITCH_STATES);
export const riskLimitWindowEnum = pgEnum('risk_limit_window', ['per_order', 'daily', 'weekly']);
