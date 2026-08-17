CREATE TABLE "brokerage_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"broker" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brokerage_accounts_project_name_uniq" UNIQUE("project_id","name"),
	CONSTRAINT "brokerage_accounts_status_chk" CHECK ("brokerage_accounts"."status" in ('active','closed'))
);
--> statement-breakpoint
CREATE TABLE "portfolio_trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"quantity" numeric(20, 8) NOT NULL,
	"price" numeric(20, 8) NOT NULL,
	"fees" numeric(20, 8) DEFAULT '0' NOT NULL,
	"traded_at" timestamp with time zone NOT NULL,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portfolio_trades_side_chk" CHECK ("portfolio_trades"."side" in ('buy','sell')),
	CONSTRAINT "portfolio_trades_quantity_chk" CHECK ("portfolio_trades"."quantity" > 0),
	CONSTRAINT "portfolio_trades_price_chk" CHECK ("portfolio_trades"."price" >= 0),
	CONSTRAINT "portfolio_trades_fees_chk" CHECK ("portfolio_trades"."fees" >= 0)
);
--> statement-breakpoint
CREATE TABLE "symbol_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"price" numeric(20, 8) NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"source" text DEFAULT 'stooq' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "symbol_quotes_project_symbol_uniq" UNIQUE("project_id","symbol")
);
--> statement-breakpoint
ALTER TABLE "brokerage_accounts" ADD CONSTRAINT "brokerage_accounts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brokerage_accounts" ADD CONSTRAINT "brokerage_accounts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brokerage_accounts" ADD CONSTRAINT "brokerage_accounts_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_trades" ADD CONSTRAINT "portfolio_trades_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_trades" ADD CONSTRAINT "portfolio_trades_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_trades" ADD CONSTRAINT "portfolio_trades_account_id_brokerage_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."brokerage_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_trades" ADD CONSTRAINT "portfolio_trades_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "symbol_quotes" ADD CONSTRAINT "symbol_quotes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "symbol_quotes" ADD CONSTRAINT "symbol_quotes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brokerage_accounts_project_idx" ON "brokerage_accounts" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "portfolio_trades_account_symbol_idx" ON "portfolio_trades" USING btree ("account_id","symbol");--> statement-breakpoint
CREATE INDEX "portfolio_trades_project_traded_idx" ON "portfolio_trades" USING btree ("project_id","traded_at");--> statement-breakpoint
CREATE INDEX "symbol_quotes_org_idx" ON "symbol_quotes" USING btree ("org_id");