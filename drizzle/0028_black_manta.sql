ALTER TABLE "ai_operations" ADD COLUMN "result_data" jsonb;--> statement-breakpoint
ALTER TABLE "ai_operations" ADD COLUMN "attempt" integer DEFAULT 1 NOT NULL;