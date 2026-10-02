CREATE TYPE "public"."review_mode" AS ENUM('quick', 'reviewed');--> statement-breakpoint
CREATE TYPE "public"."review_outcome" AS ENUM('reviewed', 'omitted', 'required_unmet', 'optional_degraded');--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "requested_mode" "review_mode";--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "effective_mode" "review_mode";--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "review_required" boolean;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "review_policy_reason" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "review_forced" boolean;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "review_outcome" "review_outcome";--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "quick_exempt" boolean;