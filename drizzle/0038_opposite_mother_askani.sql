CREATE TYPE "public"."retrieval_mode" AS ENUM('legacy', 'shadow', 'versioned');--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "retrieval_mode" "retrieval_mode" DEFAULT 'legacy' NOT NULL;