CREATE TYPE "public"."decision_status" AS ENUM('proposed', 'accepted', 'superseded', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."decision_type" AS ENUM('operational', 'creative', 'continuity', 'technical', 'process', 'other');--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"rationale" text DEFAULT '' NOT NULL,
	"supporting_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"originating_task_id" uuid,
	"originating_run_id" uuid,
	"author_id" uuid,
	"author_label" text NOT NULL,
	"decision_type" "decision_type" DEFAULT 'operational' NOT NULL,
	"status" "decision_status" DEFAULT 'proposed' NOT NULL,
	"superseded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_originating_task_id_tasks_id_fk" FOREIGN KEY ("originating_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_author_id_profiles_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decisions_org_project_status_idx" ON "decisions" USING btree ("org_id","project_id","status");--> statement-breakpoint
CREATE INDEX "decisions_originating_task_idx" ON "decisions" USING btree ("originating_task_id");--> statement-breakpoint
CREATE INDEX "decisions_superseded_by_idx" ON "decisions" USING btree ("superseded_by");--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_superseded_by_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."decisions"("id") ON DELETE set null;
