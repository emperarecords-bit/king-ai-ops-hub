CREATE TABLE "decision_injections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"run_id" uuid,
	"task_id" uuid,
	"reason" text NOT NULL,
	"injected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "scope_task_id" uuid;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "decision_injections" ADD CONSTRAINT "decision_injections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_injections" ADD CONSTRAINT "decision_injections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_injections" ADD CONSTRAINT "decision_injections_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_injections" ADD CONSTRAINT "decision_injections_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_injections" ADD CONSTRAINT "decision_injections_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decision_injections_decision_idx" ON "decision_injections" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "decision_injections_org_project_idx" ON "decision_injections" USING btree ("org_id","project_id");--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_scope_task_id_tasks_id_fk" FOREIGN KEY ("scope_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;