CREATE TYPE "public"."decision_confidence" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."extraction_status" AS ENUM('succeeded', 'failed', 'empty');--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "suggested_by_run_id" uuid;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "suggestion_confidence" "decision_confidence";--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "suggestion_reason" text;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "candidate_extraction_status" "extraction_status";--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_reviewed_by_profiles_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;