ALTER TABLE "agents" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "reports_to_id" uuid;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "owner_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "owner_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "owner_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_reports_to_id_agents_id_fk" FOREIGN KEY ("reports_to_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;