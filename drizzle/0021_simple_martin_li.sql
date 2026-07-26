CREATE TYPE "public"."decision_applicability" AS ENUM('record', 'guidance');--> statement-breakpoint
CREATE TYPE "public"."decision_scope" AS ENUM('task', 'objective', 'workspace');--> statement-breakpoint
ALTER TYPE "public"."decision_status" ADD VALUE 'retired';--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "applicability" "decision_applicability" DEFAULT 'guidance' NOT NULL;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "scope" "decision_scope" DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "scope_objective_id" uuid;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "effective_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_scope_objective_id_objectives_id_fk" FOREIGN KEY ("scope_objective_id") REFERENCES "public"."objectives"("id") ON DELETE set null ON UPDATE no action;