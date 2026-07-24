CREATE TYPE "public"."flagship_category" AS ENUM('architecture', 'security', 'database_design', 'major_refactoring', 'product_strategy', 'complex_reasoning', 'release_review');--> statement-breakpoint
CREATE TYPE "public"."model_tier" AS ENUM('standard', 'flagship');--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "model_tier" "model_tier" DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "flagship_category" "flagship_category";