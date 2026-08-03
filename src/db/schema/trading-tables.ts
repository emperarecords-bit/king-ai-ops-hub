import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { dataClassificationEnum } from './enums';
import { agents, approvals, organizations, profiles, projects } from './tables';
import {
  instrumentExchangeEnum,
  instrumentKindEnum,
  killSwitchStateEnum,
  marketSessionEnum,
  orderSideEnum,
  orderTypeEnum,
  paperOrderStateEnum,
  researchEpistemicClassEnum,
  researchNoteKindEnum,
  riskCheckResultEnum,
  riskLimitKindEnum,
  riskLimitWindowEnum,
  thesisDirectionEnum,
  thesisStatusEnum,
  thesisTimeHorizonEnum,
  timeInForceEnum,
  tradingCurrencyEnum,
  tradingExecutionModeEnum,
} from './trading-enums';

/**
 * Stock Trading — P1 Foundations schema. Every table is tenant-scoped by (org_id, project_id), carries the Hub
 * `classification`, and uses the shared `...timestamps`. HARD phase invariants are enforced at the database level
 * with single-value enums (execution mode = paper, currency = USD) and CHECK constraints.
 *
 * TENANT-BOUND RELATIONSHIPS: every trading→trading reference is a COMPOSITE foreign key on
 * (org_id, project_id, parent_id) → parent(org_id, project_id, id), so a child can never reference a parent in
 * another workspace (not merely a bare single-column UUID FK). Trading-owned parents therefore expose a
 * UNIQUE(org_id, project_id, id) candidate key. References to Hub tables that lack a compatible composite key
 * (approvals, agents) are tenant-bound by narrow constraint triggers in `src/db/rls.sql`.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};
const orgId = () =>
  uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });
const projectId = () =>
  uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' });
const classification = () => dataClassificationEnum('classification').notNull().default('live');
const microsCol = (name: string) => bigint(name, { mode: 'bigint' });
/** UNIQUE(org_id, project_id, id) candidate key so children can bind composite FKs. */
const tenantId = (t: { orgId: unknown; projectId: unknown; id: unknown }, name: string) =>
  unique(name).on(t.orgId as never, t.projectId as never, t.id as never);

// 1. Instruments — US-listed equities and unleveraged ETFs only; USD only. --------------------------------------
export const instruments = pgTable(
  'instruments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgId(),
    projectId: projectId(),
    symbol: text('symbol').notNull(),
    kind: instrumentKindEnum('kind').notNull(),
    exchange: instrumentExchangeEnum('exchange').notNull(),
    name: text('name').notNull(),
    currency: tradingCurrencyEnum('currency').notNull().default('USD'),
    sector: text('sector'),
    industry: text('industry'),
    active: boolean('active').notNull().default(true),
    classification: classification(),
    ...timestamps,
  },
  (t) => [
    tenantId(t, 'instruments_tenant_uq'),
    unique('instruments_symbol_uq').on(t.orgId, t.projectId, t.symbol),
    index('instruments_sector_idx').on(t.orgId, t.projectId, t.sector),
    check('instruments_currency_usd', sql`${t.currency} = 'USD'`),
  ],
);

// 2. Watchlists -------------------------------------------------------------------------------------------------
export const watchlists = pgTable(
  'watchlists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgId(),
    projectId: projectId(),
    name: text('name').notNull(),
    description: text('description'),
    createdBy: uuid('created_by').references(() => profiles.id, { onDelete: 'set null' }),
    classification: classification(),
    ...timestamps,
  },
  (t) => [tenantId(t, 'watchlists_tenant_uq'), unique('watchlists_name_uq').on(t.orgId, t.projectId, t.name)],
);

// 3. Watchlist items --------------------------------------------------------------------------------------------
export const watchlistItems = pgTable(
  'watchlist_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgId(),
    projectId: projectId(),
    watchlistId: uuid('watchlist_id').notNull(),
    instrumentId: uuid('instrument_id').notNull(),
    note: text('note'),
    classification: classification(),
    ...timestamps,
  },
  (t) => [
    unique('watchlist_items_uq').on(t.watchlistId, t.instrumentId),
    foreignKey({ columns: [t.orgId, t.projectId, t.watchlistId], foreignColumns: [watchlists.orgId, watchlists.projectId, watchlists.id], name: 'watchlist_items_watchlist_fk' }).onDelete('cascade'),
    foreignKey({ columns: [t.orgId, t.projectId, t.instrumentId], foreignColumns: [instruments.orgId, instruments.projectId, instruments.id], name: 'watchlist_items_instrument_fk' }).onDelete('cascade'),
  ],
);

// 4. Market quotes ----------------------------------------------------------------------------------------------
export const marketQuotes = pgTable(
  'market_quotes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgId(),
    projectId: projectId(),
    instrumentId: uuid('instrument_id').notNull(),
    priceMicros: microsCol('price_micros').notNull(),
    asOf: timestamp('as_of', { withTimezone: true }).notNull(),
    session: marketSessionEnum('session').notNull(),
    source: text('source').notNull(),
    staleAfterMs: integer('stale_after_ms').notNull().default(60000),
    classification: classification(),
    ...timestamps,
  },
  (t) => [
    index('market_quotes_instrument_asof_idx').on(t.orgId, t.projectId, t.instrumentId, t.asOf),
    foreignKey({ columns: [t.orgId, t.projectId, t.instrumentId], foreignColumns: [instruments.orgId, instruments.projectId, instruments.id], name: 'market_quotes_instrument_fk' }).onDelete('cascade'),
    check('market_quotes_price_pos', sql`${t.priceMicros} > 0`),
  ],
);

// 5. Research notes (facts vs forecasts) — instrument optional (sector notes) -----------------------------------
export const researchNotes = pgTable(
  'research_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgId(),
    projectId: projectId(),
    instrumentId: uuid('instrument_id'),
    kind: researchNoteKindEnum('kind').notNull(),
    epistemicClass: researchEpistemicClassEnum('epistemic_class').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    sourceRef: text('source_ref'),
    authorAgentId: uuid('author_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    authorProfileId: uuid('author_profile_id').references(() => profiles.id, { onDelete: 'set null' }),
    classification: classification(),
    ...timestamps,
  },
  (t) => [
    index('research_notes_instrument_idx').on(t.orgId, t.projectId, t.instrumentId),
    // Nullable composite FK: MATCH SIMPLE skips the check when instrument_id is null (sector notes); when set it is
    // tenant-bound. NO ACTION on delete (a referenced instrument must be detached before deletion).
    foreignKey({ columns: [t.orgId, t.projectId, t.instrumentId], foreignColumns: [instruments.orgId, instruments.projectId, instruments.id], name: 'research_notes_instrument_fk' }),
  ],
);

// 6. Trade theses -----------------------------------------------------------------------------------------------
export const tradeTheses = pgTable(
  'trade_theses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgId(),
    projectId: projectId(),
    instrumentId: uuid('instrument_id').notNull(),
    direction: thesisDirectionEnum('direction').notNull().default('long'),
    entryPriceMicros: microsCol('entry_price_micros'),
    targetPriceMicros: microsCol('target_price_micros'),
    invalidationPriceMicros: microsCol('invalidation_price_micros'),
    catalyst: text('catalyst'),
    timeHorizon: thesisTimeHorizonEnum('time_horizon').notNull(),
    conviction: integer('conviction').notNull().default(3),
    status: thesisStatusEnum('status').notNull().default('draft'),
    rationale: text('rationale').notNull(),
    authorAgentId: uuid('author_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => profiles.id, { onDelete: 'set null' }),
    classification: classification(),
    ...timestamps,
  },
  (t) => [
    tenantId(t, 'trade_theses_tenant_uq'),
    index('trade_theses_instrument_status_idx').on(t.orgId, t.projectId, t.instrumentId, t.status),
    foreignKey({ columns: [t.orgId, t.projectId, t.instrumentId], foreignColumns: [instruments.orgId, instruments.projectId, instruments.id], name: 'trade_theses_instrument_fk' }).onDelete('cascade'),
    check('trade_theses_direction_long', sql`${t.direction} = 'long'`),
    check('trade_theses_conviction_range', sql`${t.conviction} between 1 and 5`),
  ],
);

// 7. Paper portfolio (one per workspace) ------------------------------------------------------------------------
export const paperPortfolios = pgTable(
  'paper_portfolios',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgId(),
    projectId: projectId(),
    name: text('name').notNull().default('Paper Portfolio'),
    baseCurrency: tradingCurrencyEnum('base_currency').notNull().default('USD'),
    executionMode: tradingExecutionModeEnum('execution_mode').notNull().default('paper'),
    startingCashMicros: microsCol('starting_cash_micros').notNull(),
    cashMicros: microsCol('cash_micros').notNull(),
    classification: classification(),
    ...timestamps,
  },
  (t) => [
    tenantId(t, 'paper_portfolios_tenant_uq'),
    unique('paper_portfolios_one_per_workspace').on(t.orgId, t.projectId),
    check('paper_portfolios_paper_only', sql`${t.executionMode} = 'paper'`),
    check('paper_portfolios_usd_only', sql`${t.baseCurrency} = 'USD'`),
    check('paper_portfolios_cash_nonneg', sql`${t.cashMicros} >= 0`),
  ],
);

// 8. Paper positions --------------------------------------------------------------------------------------------
export const paperPositions = pgTable(
  'paper_positions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgId(),
    projectId: projectId(),
    portfolioId: uuid('portfolio_id').notNull(),
    instrumentId: uuid('instrument_id').notNull(),
    qty: integer('qty').notNull().default(0),
    avgCostMicros: microsCol('avg_cost_micros')
      .notNull()
      .default(sql`0`),
    realizedPnlMicros: microsCol('realized_pnl_micros')
      .notNull()
      .default(sql`0`),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    classification: classification(),
    ...timestamps,
  },
  (t) => [
    unique('paper_positions_uq').on(t.portfolioId, t.instrumentId),
    foreignKey({ columns: [t.orgId, t.projectId, t.portfolioId], foreignColumns: [paperPortfolios.orgId, paperPortfolios.projectId, paperPortfolios.id], name: 'paper_positions_portfolio_fk' }).onDelete('cascade'),
    foreignKey({ columns: [t.orgId, t.projectId, t.instrumentId], foreignColumns: [instruments.orgId, instruments.projectId, instruments.id], name: 'paper_positions_instrument_fk' }).onDelete('cascade'),
    check('paper_positions_long_only', sql`${t.qty} >= 0`),
  ],
);

// 9. Paper-order proposals --------------------------------------------------------------------------------------
export const paperOrders = pgTable(
  'paper_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgId(),
    projectId: projectId(),
    portfolioId: uuid('portfolio_id').notNull(),
    instrumentId: uuid('instrument_id').notNull(),
    thesisId: uuid('thesis_id'),
    side: orderSideEnum('side').notNull(),
    qty: integer('qty').notNull(),
    orderType: orderTypeEnum('order_type').notNull(),
    limitPriceMicros: microsCol('limit_price_micros'),
    timeInForce: timeInForceEnum('time_in_force').notNull().default('day'),
    executionMode: tradingExecutionModeEnum('execution_mode').notNull().default('paper'),
    destination: text('destination').notNull().default('internal-paper-simulator'),
    state: paperOrderStateEnum('state').notNull().default('draft'),
    proposedByAgentId: uuid('proposed_by_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    // Human approval decision recorded in the shared approvals table (reused). Tenant-bound by trigger (rls.sql).
    approvalId: uuid('approval_id').references(() => approvals.id, { onDelete: 'set null' }),
    riskCheckId: uuid('risk_check_id'),
    rejectionReason: text('rejection_reason'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    classification: classification(),
    ...timestamps,
  },
  (t) => [
    tenantId(t, 'paper_orders_tenant_uq'),
    index('paper_orders_state_idx').on(t.orgId, t.projectId, t.state),
    index('paper_orders_portfolio_idx').on(t.portfolioId),
    foreignKey({ columns: [t.orgId, t.projectId, t.portfolioId], foreignColumns: [paperPortfolios.orgId, paperPortfolios.projectId, paperPortfolios.id], name: 'paper_orders_portfolio_fk' }).onDelete('cascade'),
    foreignKey({ columns: [t.orgId, t.projectId, t.instrumentId], foreignColumns: [instruments.orgId, instruments.projectId, instruments.id], name: 'paper_orders_instrument_fk' }).onDelete('cascade'),
    foreignKey({ columns: [t.orgId, t.projectId, t.thesisId], foreignColumns: [tradeTheses.orgId, tradeTheses.projectId, tradeTheses.id], name: 'paper_orders_thesis_fk' }),
    check('paper_orders_paper_only', sql`${t.executionMode} = 'paper'`),
    check('paper_orders_paper_destination', sql`${t.destination} = 'internal-paper-simulator'`),
    check('paper_orders_qty_pos', sql`${t.qty} > 0`),
    check('paper_orders_limit_price', sql`(${t.orderType} <> 'limit') or (${t.limitPriceMicros} is not null and ${t.limitPriceMicros} > 0)`),
  ],
);

// 10. Paper fills (simulated only) ------------------------------------------------------------------------------
export const paperFills = pgTable(
  'paper_fills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgId(),
    projectId: projectId(),
    orderId: uuid('order_id').notNull(),
    portfolioId: uuid('portfolio_id').notNull(),
    instrumentId: uuid('instrument_id').notNull(),
    side: orderSideEnum('side').notNull(),
    qty: integer('qty').notNull(),
    fillPriceMicros: microsCol('fill_price_micros').notNull(),
    quoteAsOf: timestamp('quote_as_of', { withTimezone: true }).notNull(),
    simulatedAt: timestamp('simulated_at', { withTimezone: true }).notNull(),
    model: text('model').notNull(),
    classification: classification(),
    ...timestamps,
  },
  (t) => [
    index('paper_fills_order_idx').on(t.orderId),
    foreignKey({ columns: [t.orgId, t.projectId, t.orderId], foreignColumns: [paperOrders.orgId, paperOrders.projectId, paperOrders.id], name: 'paper_fills_order_fk' }).onDelete('cascade'),
    foreignKey({ columns: [t.orgId, t.projectId, t.portfolioId], foreignColumns: [paperPortfolios.orgId, paperPortfolios.projectId, paperPortfolios.id], name: 'paper_fills_portfolio_fk' }).onDelete('cascade'),
    foreignKey({ columns: [t.orgId, t.projectId, t.instrumentId], foreignColumns: [instruments.orgId, instruments.projectId, instruments.id], name: 'paper_fills_instrument_fk' }).onDelete('cascade'),
    check('paper_fills_price_pos', sql`${t.fillPriceMicros} > 0`),
    check('paper_fills_qty_pos', sql`${t.qty} > 0`),
  ],
);

// 11. Risk limits (hard, non-overridable in the MVP) ------------------------------------------------------------
export const riskLimits = pgTable(
  'risk_limits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgId(),
    projectId: projectId(),
    kind: riskLimitKindEnum('kind').notNull(),
    limitBps: integer('limit_bps').notNull(),
    window: riskLimitWindowEnum('window').notNull(),
    overridable: boolean('overridable').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    version: integer('version').notNull().default(1),
    changedBy: uuid('changed_by').references(() => profiles.id, { onDelete: 'set null' }),
    classification: classification(),
    ...timestamps,
  },
  (t) => [
    unique('risk_limits_uq').on(t.orgId, t.projectId, t.kind),
    check('risk_limits_bps_range', sql`${t.limitBps} between 0 and 1000000`),
    check('risk_limits_not_overridable', sql`${t.overridable} = false`),
  ],
);

// 12. Restricted symbols ----------------------------------------------------------------------------------------
export const restrictedSymbols = pgTable(
  'restricted_symbols',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgId(),
    projectId: projectId(),
    symbol: text('symbol').notNull(),
    reason: text('reason').notNull(),
    addedBy: uuid('added_by').references(() => profiles.id, { onDelete: 'set null' }),
    classification: classification(),
    ...timestamps,
  },
  (t) => [unique('restricted_symbols_uq').on(t.orgId, t.projectId, t.symbol)],
);

// 13. Risk checks (per-proposal evaluation record) --------------------------------------------------------------
export const riskChecks = pgTable(
  'risk_checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgId(),
    projectId: projectId(),
    orderId: uuid('order_id').notNull(),
    result: riskCheckResultEnum('result').notNull(),
    navMicros: microsCol('nav_micros').notNull(),
    lines: jsonb('lines').notNull(),
    evaluatedByAgentId: uuid('evaluated_by_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull().defaultNow(),
    classification: classification(),
    ...timestamps,
  },
  (t) => [
    tenantId(t, 'risk_checks_tenant_uq'),
    index('risk_checks_order_idx').on(t.orderId),
    foreignKey({ columns: [t.orgId, t.projectId, t.orderId], foreignColumns: [paperOrders.orgId, paperOrders.projectId, paperOrders.id], name: 'risk_checks_order_fk' }).onDelete('cascade'),
  ],
);

// 14. Kill switch (one per workspace) ---------------------------------------------------------------------------
export const killSwitches = pgTable(
  'kill_switches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgId(),
    projectId: projectId(),
    state: killSwitchStateEnum('state').notNull().default('armed'),
    reason: text('reason'),
    trippedBy: uuid('tripped_by').references(() => profiles.id, { onDelete: 'set null' }),
    trippedAt: timestamp('tripped_at', { withTimezone: true }),
    classification: classification(),
    ...timestamps,
  },
  (t) => [unique('kill_switches_one_per_workspace').on(t.orgId, t.projectId)],
);
