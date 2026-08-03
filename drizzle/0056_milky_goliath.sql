CREATE TABLE "run_execution_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"execution_attempt_id" uuid NOT NULL,
	"step_number" integer NOT NULL,
	"step_kind" text NOT NULL,
	"provider" text,
	"model" text,
	"response_text" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"usage_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_jobs" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run_jobs" ADD COLUMN "dispatch_kind" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "reliability_state" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "execution_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "checkpointed_result" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "schedule_occurrence_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run_execution_checkpoints" ADD CONSTRAINT "run_execution_checkpoints_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_execution_checkpoints" ADD CONSTRAINT "run_execution_checkpoints_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_execution_checkpoints" ADD CONSTRAINT "run_execution_checkpoints_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_execution_checkpoints_run_step_uq" ON "run_execution_checkpoints" USING btree ("run_id","step_number");--> statement-breakpoint
CREATE INDEX "run_execution_checkpoints_org_project_idx" ON "run_execution_checkpoints" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "run_execution_checkpoints_run_idx" ON "run_execution_checkpoints" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_schedule_occurrence_uq" ON "tasks" USING btree ("schedule_id","schedule_occurrence_at") WHERE schedule_id is not null and schedule_occurrence_at is not null;