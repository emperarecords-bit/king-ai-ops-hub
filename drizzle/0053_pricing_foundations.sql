CREATE TABLE "platform_pricing_state" (
	"singleton_key" text PRIMARY KEY NOT NULL,
	"current_pricing_schedule_id" uuid NOT NULL,
	"current_pricing_schedule_hash" text NOT NULL,
	"seeded_by_migration" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_pricing_state_singleton_ck" CHECK ("platform_pricing_state"."singleton_key" = 'GLOBAL')
);
--> statement-breakpoint
CREATE TABLE "pricing_schedule_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"provider" "provider_id" NOT NULL,
	"model" text NOT NULL,
	"input_unit_price_micros" bigint NOT NULL,
	"output_unit_price_micros" bigint NOT NULL,
	"token_unit_size" bigint NOT NULL,
	"unit_definition" text NOT NULL,
	"min_charge_micros" bigint,
	"max_output_tokens" integer NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "pricing_entries_token_unit_size_pos" CHECK ("pricing_schedule_entries"."token_unit_size" > 0),
	CONSTRAINT "pricing_entries_max_output_pos" CHECK ("pricing_schedule_entries"."max_output_tokens" > 0),
	CONSTRAINT "pricing_entries_prices_nonneg" CHECK ("pricing_schedule_entries"."input_unit_price_micros" >= 0 AND "pricing_schedule_entries"."output_unit_price_micros" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pricing_schedules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_pricing_version" text NOT NULL,
	"currency" text NOT NULL,
	"schedule_hash" text NOT NULL,
	"canonicalization_version" integer NOT NULL,
	"hash_algorithm" text NOT NULL,
	"seeded_by_migration" text NOT NULL,
	"seeded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_schedules_hash_uq" UNIQUE("schedule_hash"),
	CONSTRAINT "pricing_schedules_id_hash_uq" UNIQUE("id","schedule_hash")
);
--> statement-breakpoint
ALTER TABLE "platform_pricing_state" ADD CONSTRAINT "platform_pricing_state_schedule_fk" FOREIGN KEY ("current_pricing_schedule_id","current_pricing_schedule_hash") REFERENCES "public"."pricing_schedules"("id","schedule_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_schedule_entries" ADD CONSTRAINT "pricing_schedule_entries_schedule_id_pricing_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."pricing_schedules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_schedule_entries_schedule_model_uq" ON "pricing_schedule_entries" USING btree ("schedule_id","provider","model");--> statement-breakpoint
CREATE INDEX "pricing_schedule_entries_schedule_idx" ON "pricing_schedule_entries" USING btree ("schedule_id");
--> statement-breakpoint
-- P1a seed: one immutable pricing schedule from MODEL_PRICING (source 2026-07-24); gpt-5.2 excluded (delisted/unverified). valid_from is NULL (no source-defined effective start).
INSERT INTO "pricing_schedules" ("id","source_pricing_version","currency","schedule_hash","canonicalization_version","hash_algorithm","seeded_by_migration") VALUES ('f00d0053-0000-4000-8000-000000000001','2026-07-24','USD','1989db5b9300e5d09d61f482d5a728aa8c04e9a47a01c3d4636ef0ccd5fe77df',1,'sha256','0053_pricing_foundations');
--> statement-breakpoint
INSERT INTO "pricing_schedule_entries" ("schedule_id","provider","model","input_unit_price_micros","output_unit_price_micros","token_unit_size","unit_definition","min_charge_micros","max_output_tokens","valid_from","valid_until") VALUES
  ('f00d0053-0000-4000-8000-000000000001','anthropic','claude-haiku-4-5-20251001',1000000,5000000,1000000,'per_1m_tokens',NULL,64000,NULL,NULL),
  ('f00d0053-0000-4000-8000-000000000001','anthropic','claude-opus-4-8',5000000,25000000,1000000,'per_1m_tokens',NULL,64000,NULL,NULL),
  ('f00d0053-0000-4000-8000-000000000001','anthropic','claude-sonnet-5',2000000,10000000,1000000,'per_1m_tokens',NULL,64000,NULL,'2026-09-01T00:00:00.000Z'),
  ('f00d0053-0000-4000-8000-000000000001','openai','gpt-5.4',2500000,15000000,1000000,'per_1m_tokens',NULL,65536,NULL,NULL),
  ('f00d0053-0000-4000-8000-000000000001','openai','gpt-5.4-mini',750000,4500000,1000000,'per_1m_tokens',NULL,65536,NULL,NULL);
--> statement-breakpoint
INSERT INTO "platform_pricing_state" ("singleton_key","current_pricing_schedule_id","current_pricing_schedule_hash","seeded_by_migration") VALUES ('GLOBAL','f00d0053-0000-4000-8000-000000000001','1989db5b9300e5d09d61f482d5a728aa8c04e9a47a01c3d4636ef0ccd5fe77df','0053_pricing_foundations');

