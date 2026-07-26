CREATE TYPE "public"."knowledge_disclosure" AS ENUM('workspace_internal', 'restricted');--> statement-breakpoint
CREATE TYPE "public"."knowledge_epistemic_basis" AS ENUM('observed', 'human_asserted', 'extracted', 'summarized', 'inferred');--> statement-breakpoint
CREATE TYPE "public"."knowledge_scope_kind" AS ENUM('task', 'objective', 'workspace');--> statement-breakpoint
CREATE TYPE "public"."knowledge_verification" AS ENUM('unverified', 'human_confirmed', 'source_supported', 'system_verified', 'disputed');--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD COLUMN "epistemic_basis" "knowledge_epistemic_basis" DEFAULT 'human_asserted' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD COLUMN "verification" "knowledge_verification" DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD COLUMN "as_of" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD COLUMN "review_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD COLUMN "scope_kind" "knowledge_scope_kind" DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD COLUMN "scope_task_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD COLUMN "scope_objective_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD COLUMN "disclosure" "knowledge_disclosure" DEFAULT 'workspace_internal' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_scope_task_id_tasks_id_fk" FOREIGN KEY ("scope_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_scope_objective_id_objectives_id_fk" FOREIGN KEY ("scope_objective_id") REFERENCES "public"."objectives"("id") ON DELETE set null ON UPDATE no action;