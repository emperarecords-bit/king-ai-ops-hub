ALTER TABLE "runs" ADD COLUMN "requested_primary_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "requested_reviewer_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "task_schedules" ADD COLUMN "assigned_primary_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "task_schedules" ADD COLUMN "assigned_reviewer_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "assigned_primary_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "assigned_reviewer_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_tenant_id_uq" UNIQUE("org_id","project_id","id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_requested_primary_agent_fk" FOREIGN KEY ("org_id","project_id","requested_primary_agent_id") REFERENCES "public"."agents"("org_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_requested_reviewer_agent_fk" FOREIGN KEY ("org_id","project_id","requested_reviewer_agent_id") REFERENCES "public"."agents"("org_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_schedules" ADD CONSTRAINT "task_schedules_assigned_primary_agent_fk" FOREIGN KEY ("org_id","project_id","assigned_primary_agent_id") REFERENCES "public"."agents"("org_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_schedules" ADD CONSTRAINT "task_schedules_assigned_reviewer_agent_fk" FOREIGN KEY ("org_id","project_id","assigned_reviewer_agent_id") REFERENCES "public"."agents"("org_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_primary_agent_fk" FOREIGN KEY ("org_id","project_id","assigned_primary_agent_id") REFERENCES "public"."agents"("org_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_reviewer_agent_fk" FOREIGN KEY ("org_id","project_id","assigned_reviewer_agent_id") REFERENCES "public"."agents"("org_id","project_id","id") ON DELETE restrict ON UPDATE no action;
