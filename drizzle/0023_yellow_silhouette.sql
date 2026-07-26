ALTER TABLE "decision_injections" ADD COLUMN "memory_text" text;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "suggested_applicability" "decision_applicability";--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "suggested_scope" "decision_scope";--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "suggested_scope_task_id" uuid;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_suggested_scope_task_id_tasks_id_fk" FOREIGN KEY ("suggested_scope_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "decision_injections_run_decision_uq" ON "decision_injections" USING btree ("run_id","decision_id");