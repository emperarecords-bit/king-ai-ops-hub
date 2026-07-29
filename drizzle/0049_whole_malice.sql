ALTER TABLE "runs" ADD COLUMN "primary_prompt_hash" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "reviewer_prompt_hash" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "primary_effective_prompt_hash" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "reviewer_effective_prompt_hash" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "assembler_version" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "source_manifest" jsonb;