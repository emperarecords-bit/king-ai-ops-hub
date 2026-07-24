CREATE TYPE "public"."cadence" AS ENUM('daily', 'weekly', 'monthly');--> statement-breakpoint
CREATE TABLE "task_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"objective_id" uuid,
	"title" text NOT NULL,
	"input" text NOT NULL,
	"provider_selection" "provider_selection" NOT NULL,
	"review_enabled" boolean DEFAULT true NOT NULL,
	"model_tier" "model_tier" DEFAULT 'standard' NOT NULL,
	"flagship_category" "flagship_category",
	"cadence" "cadence" NOT NULL,
	"at_hour" integer DEFAULT 6 NOT NULL,
	"weekday" integer,
	"monthday" integer,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "schedule_id" uuid;--> statement-breakpoint
ALTER TABLE "task_schedules" ADD CONSTRAINT "task_schedules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_schedules" ADD CONSTRAINT "task_schedules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_schedules" ADD CONSTRAINT "task_schedules_objective_id_objectives_id_fk" FOREIGN KEY ("objective_id") REFERENCES "public"."objectives"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_schedules" ADD CONSTRAINT "task_schedules_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_schedules_due_idx" ON "task_schedules" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "task_schedules_org_project_idx" ON "task_schedules" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "task_schedules_objective_idx" ON "task_schedules" USING btree ("objective_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_schedule_id_task_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."task_schedules"("id") ON DELETE set null ON UPDATE no action;