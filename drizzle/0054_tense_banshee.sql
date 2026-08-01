CREATE TYPE "public"."instrument_exchange" AS ENUM('XNAS', 'XNYS', 'ARCX', 'BATS', 'XASE');--> statement-breakpoint
CREATE TYPE "public"."instrument_kind" AS ENUM('equity', 'etf');--> statement-breakpoint
CREATE TYPE "public"."kill_switch_state" AS ENUM('armed', 'tripped');--> statement-breakpoint
CREATE TYPE "public"."market_session" AS ENUM('pre', 'open', 'post', 'closed', 'halted');--> statement-breakpoint
CREATE TYPE "public"."order_side" AS ENUM('buy', 'sell');--> statement-breakpoint
CREATE TYPE "public"."order_type" AS ENUM('market', 'limit');--> statement-breakpoint
CREATE TYPE "public"."paper_order_state" AS ENUM('draft', 'risk_pending', 'risk_rejected', 'pending_approval', 'approved', 'rejected', 'expired', 'fill_pending', 'simulated_filled', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."research_epistemic_class" AS ENUM('fact', 'forecast');--> statement-breakpoint
CREATE TYPE "public"."research_note_kind" AS ENUM('company', 'etf', 'sector', 'earnings', 'filing', 'news');--> statement-breakpoint
CREATE TYPE "public"."risk_check_result" AS ENUM('pass', 'fail');--> statement-breakpoint
CREATE TYPE "public"."risk_limit_kind" AS ENUM('max_symbol_position', 'max_sector_concentration', 'max_gross_exposure', 'daily_loss_limit', 'weekly_loss_limit');--> statement-breakpoint
CREATE TYPE "public"."risk_limit_window" AS ENUM('per_order', 'daily', 'weekly');--> statement-breakpoint
CREATE TYPE "public"."thesis_direction" AS ENUM('long');--> statement-breakpoint
CREATE TYPE "public"."thesis_status" AS ENUM('draft', 'active', 'invalidated', 'closed');--> statement-breakpoint
CREATE TYPE "public"."thesis_time_horizon" AS ENUM('intraday', 'swing', 'position', 'long_term');--> statement-breakpoint
CREATE TYPE "public"."time_in_force" AS ENUM('day');--> statement-breakpoint
CREATE TYPE "public"."trading_currency" AS ENUM('USD');--> statement-breakpoint
CREATE TYPE "public"."trading_execution_mode" AS ENUM('paper');--> statement-breakpoint
CREATE TABLE "instruments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"kind" "instrument_kind" NOT NULL,
	"exchange" "instrument_exchange" NOT NULL,
	"name" text NOT NULL,
	"currency" "trading_currency" DEFAULT 'USD' NOT NULL,
	"sector" text,
	"industry" text,
	"active" boolean DEFAULT true NOT NULL,
	"classification" "data_classification" DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instruments_tenant_uq" UNIQUE("org_id","project_id","id"),
	CONSTRAINT "instruments_symbol_uq" UNIQUE("org_id","project_id","symbol"),
	CONSTRAINT "instruments_currency_usd" CHECK ("instruments"."currency" = 'USD')
);
--> statement-breakpoint
CREATE TABLE "kill_switches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"state" "kill_switch_state" DEFAULT 'armed' NOT NULL,
	"reason" text,
	"tripped_by" uuid,
	"tripped_at" timestamp with time zone,
	"classification" "data_classification" DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kill_switches_one_per_workspace" UNIQUE("org_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "market_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"price_micros" bigint NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"session" "market_session" NOT NULL,
	"source" text NOT NULL,
	"stale_after_ms" integer DEFAULT 60000 NOT NULL,
	"classification" "data_classification" DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_quotes_price_pos" CHECK ("market_quotes"."price_micros" > 0)
);
--> statement-breakpoint
CREATE TABLE "paper_fills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"side" "order_side" NOT NULL,
	"qty" integer NOT NULL,
	"fill_price_micros" bigint NOT NULL,
	"quote_as_of" timestamp with time zone NOT NULL,
	"simulated_at" timestamp with time zone NOT NULL,
	"model" text NOT NULL,
	"classification" "data_classification" DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paper_fills_price_pos" CHECK ("paper_fills"."fill_price_micros" > 0),
	CONSTRAINT "paper_fills_qty_pos" CHECK ("paper_fills"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "paper_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"thesis_id" uuid,
	"side" "order_side" NOT NULL,
	"qty" integer NOT NULL,
	"order_type" "order_type" NOT NULL,
	"limit_price_micros" bigint,
	"time_in_force" time_in_force DEFAULT 'day' NOT NULL,
	"execution_mode" "trading_execution_mode" DEFAULT 'paper' NOT NULL,
	"destination" text DEFAULT 'internal-paper-simulator' NOT NULL,
	"state" "paper_order_state" DEFAULT 'draft' NOT NULL,
	"proposed_by_agent_id" uuid,
	"approval_id" uuid,
	"risk_check_id" uuid,
	"rejection_reason" text,
	"expires_at" timestamp with time zone,
	"classification" "data_classification" DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paper_orders_tenant_uq" UNIQUE("org_id","project_id","id"),
	CONSTRAINT "paper_orders_paper_only" CHECK ("paper_orders"."execution_mode" = 'paper'),
	CONSTRAINT "paper_orders_paper_destination" CHECK ("paper_orders"."destination" = 'internal-paper-simulator'),
	CONSTRAINT "paper_orders_qty_pos" CHECK ("paper_orders"."qty" > 0),
	CONSTRAINT "paper_orders_limit_price" CHECK (("paper_orders"."order_type" <> 'limit') or ("paper_orders"."limit_price_micros" is not null and "paper_orders"."limit_price_micros" > 0))
);
--> statement-breakpoint
CREATE TABLE "paper_portfolios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text DEFAULT 'Paper Portfolio' NOT NULL,
	"base_currency" "trading_currency" DEFAULT 'USD' NOT NULL,
	"execution_mode" "trading_execution_mode" DEFAULT 'paper' NOT NULL,
	"starting_cash_micros" bigint NOT NULL,
	"cash_micros" bigint NOT NULL,
	"classification" "data_classification" DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paper_portfolios_tenant_uq" UNIQUE("org_id","project_id","id"),
	CONSTRAINT "paper_portfolios_one_per_workspace" UNIQUE("org_id","project_id"),
	CONSTRAINT "paper_portfolios_paper_only" CHECK ("paper_portfolios"."execution_mode" = 'paper'),
	CONSTRAINT "paper_portfolios_usd_only" CHECK ("paper_portfolios"."base_currency" = 'USD'),
	CONSTRAINT "paper_portfolios_cash_nonneg" CHECK ("paper_portfolios"."cash_micros" >= 0)
);
--> statement-breakpoint
CREATE TABLE "paper_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"qty" integer DEFAULT 0 NOT NULL,
	"avg_cost_micros" bigint DEFAULT 0 NOT NULL,
	"realized_pnl_micros" bigint DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone,
	"classification" "data_classification" DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paper_positions_uq" UNIQUE("portfolio_id","instrument_id"),
	CONSTRAINT "paper_positions_long_only" CHECK ("paper_positions"."qty" >= 0)
);
--> statement-breakpoint
CREATE TABLE "research_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"instrument_id" uuid,
	"kind" "research_note_kind" NOT NULL,
	"epistemic_class" "research_epistemic_class" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"source_ref" text,
	"author_agent_id" uuid,
	"author_profile_id" uuid,
	"classification" "data_classification" DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "restricted_symbols" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"reason" text NOT NULL,
	"added_by" uuid,
	"classification" "data_classification" DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "restricted_symbols_uq" UNIQUE("org_id","project_id","symbol")
);
--> statement-breakpoint
CREATE TABLE "risk_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"result" "risk_check_result" NOT NULL,
	"nav_micros" bigint NOT NULL,
	"lines" jsonb NOT NULL,
	"evaluated_by_agent_id" uuid,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"classification" "data_classification" DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "risk_checks_tenant_uq" UNIQUE("org_id","project_id","id")
);
--> statement-breakpoint
CREATE TABLE "risk_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "risk_limit_kind" NOT NULL,
	"limit_bps" integer NOT NULL,
	"window" "risk_limit_window" NOT NULL,
	"overridable" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"changed_by" uuid,
	"classification" "data_classification" DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "risk_limits_uq" UNIQUE("org_id","project_id","kind"),
	CONSTRAINT "risk_limits_bps_range" CHECK ("risk_limits"."limit_bps" between 0 and 1000000),
	CONSTRAINT "risk_limits_not_overridable" CHECK ("risk_limits"."overridable" = false)
);
--> statement-breakpoint
CREATE TABLE "trade_theses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"direction" "thesis_direction" DEFAULT 'long' NOT NULL,
	"entry_price_micros" bigint,
	"target_price_micros" bigint,
	"invalidation_price_micros" bigint,
	"catalyst" text,
	"time_horizon" "thesis_time_horizon" NOT NULL,
	"conviction" integer DEFAULT 3 NOT NULL,
	"status" "thesis_status" DEFAULT 'draft' NOT NULL,
	"rationale" text NOT NULL,
	"author_agent_id" uuid,
	"created_by" uuid,
	"classification" "data_classification" DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trade_theses_tenant_uq" UNIQUE("org_id","project_id","id"),
	CONSTRAINT "trade_theses_direction_long" CHECK ("trade_theses"."direction" = 'long'),
	CONSTRAINT "trade_theses_conviction_range" CHECK ("trade_theses"."conviction" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "watchlist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"watchlist_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"note" text,
	"classification" "data_classification" DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watchlist_items_uq" UNIQUE("watchlist_id","instrument_id")
);
--> statement-breakpoint
CREATE TABLE "watchlists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_by" uuid,
	"classification" "data_classification" DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watchlists_tenant_uq" UNIQUE("org_id","project_id","id"),
	CONSTRAINT "watchlists_name_uq" UNIQUE("org_id","project_id","name")
);
--> statement-breakpoint
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kill_switches" ADD CONSTRAINT "kill_switches_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kill_switches" ADD CONSTRAINT "kill_switches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kill_switches" ADD CONSTRAINT "kill_switches_tripped_by_profiles_id_fk" FOREIGN KEY ("tripped_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_quotes" ADD CONSTRAINT "market_quotes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_quotes" ADD CONSTRAINT "market_quotes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_quotes" ADD CONSTRAINT "market_quotes_instrument_fk" FOREIGN KEY ("org_id","project_id","instrument_id") REFERENCES "public"."instruments"("org_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_fills" ADD CONSTRAINT "paper_fills_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_fills" ADD CONSTRAINT "paper_fills_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_fills" ADD CONSTRAINT "paper_fills_order_fk" FOREIGN KEY ("org_id","project_id","order_id") REFERENCES "public"."paper_orders"("org_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_fills" ADD CONSTRAINT "paper_fills_portfolio_fk" FOREIGN KEY ("org_id","project_id","portfolio_id") REFERENCES "public"."paper_portfolios"("org_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_fills" ADD CONSTRAINT "paper_fills_instrument_fk" FOREIGN KEY ("org_id","project_id","instrument_id") REFERENCES "public"."instruments"("org_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_orders" ADD CONSTRAINT "paper_orders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_orders" ADD CONSTRAINT "paper_orders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_orders" ADD CONSTRAINT "paper_orders_proposed_by_agent_id_agents_id_fk" FOREIGN KEY ("proposed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_orders" ADD CONSTRAINT "paper_orders_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_orders" ADD CONSTRAINT "paper_orders_portfolio_fk" FOREIGN KEY ("org_id","project_id","portfolio_id") REFERENCES "public"."paper_portfolios"("org_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_orders" ADD CONSTRAINT "paper_orders_instrument_fk" FOREIGN KEY ("org_id","project_id","instrument_id") REFERENCES "public"."instruments"("org_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_orders" ADD CONSTRAINT "paper_orders_thesis_fk" FOREIGN KEY ("org_id","project_id","thesis_id") REFERENCES "public"."trade_theses"("org_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_portfolios" ADD CONSTRAINT "paper_portfolios_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_portfolios" ADD CONSTRAINT "paper_portfolios_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_positions" ADD CONSTRAINT "paper_positions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_positions" ADD CONSTRAINT "paper_positions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_positions" ADD CONSTRAINT "paper_positions_portfolio_fk" FOREIGN KEY ("org_id","project_id","portfolio_id") REFERENCES "public"."paper_portfolios"("org_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_positions" ADD CONSTRAINT "paper_positions_instrument_fk" FOREIGN KEY ("org_id","project_id","instrument_id") REFERENCES "public"."instruments"("org_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_notes" ADD CONSTRAINT "research_notes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_notes" ADD CONSTRAINT "research_notes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_notes" ADD CONSTRAINT "research_notes_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_notes" ADD CONSTRAINT "research_notes_author_profile_id_profiles_id_fk" FOREIGN KEY ("author_profile_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_notes" ADD CONSTRAINT "research_notes_instrument_fk" FOREIGN KEY ("org_id","project_id","instrument_id") REFERENCES "public"."instruments"("org_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restricted_symbols" ADD CONSTRAINT "restricted_symbols_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restricted_symbols" ADD CONSTRAINT "restricted_symbols_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restricted_symbols" ADD CONSTRAINT "restricted_symbols_added_by_profiles_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_checks" ADD CONSTRAINT "risk_checks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_checks" ADD CONSTRAINT "risk_checks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_checks" ADD CONSTRAINT "risk_checks_evaluated_by_agent_id_agents_id_fk" FOREIGN KEY ("evaluated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_checks" ADD CONSTRAINT "risk_checks_order_fk" FOREIGN KEY ("org_id","project_id","order_id") REFERENCES "public"."paper_orders"("org_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_limits" ADD CONSTRAINT "risk_limits_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_limits" ADD CONSTRAINT "risk_limits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_limits" ADD CONSTRAINT "risk_limits_changed_by_profiles_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_theses" ADD CONSTRAINT "trade_theses_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_theses" ADD CONSTRAINT "trade_theses_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_theses" ADD CONSTRAINT "trade_theses_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_theses" ADD CONSTRAINT "trade_theses_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_theses" ADD CONSTRAINT "trade_theses_instrument_fk" FOREIGN KEY ("org_id","project_id","instrument_id") REFERENCES "public"."instruments"("org_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_watchlist_fk" FOREIGN KEY ("org_id","project_id","watchlist_id") REFERENCES "public"."watchlists"("org_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_instrument_fk" FOREIGN KEY ("org_id","project_id","instrument_id") REFERENCES "public"."instruments"("org_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlists" ADD CONSTRAINT "watchlists_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlists" ADD CONSTRAINT "watchlists_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlists" ADD CONSTRAINT "watchlists_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "instruments_sector_idx" ON "instruments" USING btree ("org_id","project_id","sector");--> statement-breakpoint
CREATE INDEX "market_quotes_instrument_asof_idx" ON "market_quotes" USING btree ("org_id","project_id","instrument_id","as_of");--> statement-breakpoint
CREATE INDEX "paper_fills_order_idx" ON "paper_fills" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "paper_orders_state_idx" ON "paper_orders" USING btree ("org_id","project_id","state");--> statement-breakpoint
CREATE INDEX "paper_orders_portfolio_idx" ON "paper_orders" USING btree ("portfolio_id");--> statement-breakpoint
CREATE INDEX "research_notes_instrument_idx" ON "research_notes" USING btree ("org_id","project_id","instrument_id");--> statement-breakpoint
CREATE INDEX "risk_checks_order_idx" ON "risk_checks" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "trade_theses_instrument_status_idx" ON "trade_theses" USING btree ("org_id","project_id","instrument_id","status");