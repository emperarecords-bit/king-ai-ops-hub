CREATE TYPE "public"."run_job_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "run_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"status" "run_job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 1 NOT NULL,
	"leased_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_jobs" ADD CONSTRAINT "run_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_jobs" ADD CONSTRAINT "run_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_jobs" ADD CONSTRAINT "run_jobs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_jobs_active_task_uq" ON "run_jobs" USING btree ("task_id") WHERE status in ('queued','running');--> statement-breakpoint
CREATE INDEX "run_jobs_claimable_idx" ON "run_jobs" USING btree ("status","leased_until");--> statement-breakpoint
CREATE INDEX "run_jobs_org_project_idx" ON "run_jobs" USING btree ("org_id","project_id");