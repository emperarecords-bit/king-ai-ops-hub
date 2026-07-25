CREATE TYPE "public"."dependency_kind" AS ENUM('blocks', 'prerequisite');--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"prerequisite_task_id" uuid NOT NULL,
	"dependent_task_id" uuid NOT NULL,
	"kind" "dependency_kind" DEFAULT 'prerequisite' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_prerequisite_task_id_tasks_id_fk" FOREIGN KEY ("prerequisite_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_dependent_task_id_tasks_id_fk" FOREIGN KEY ("dependent_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_dependencies_edge_uq" ON "task_dependencies" USING btree ("project_id","prerequisite_task_id","dependent_task_id");--> statement-breakpoint
CREATE INDEX "task_dependencies_dependent_idx" ON "task_dependencies" USING btree ("project_id","dependent_task_id");--> statement-breakpoint
CREATE INDEX "task_dependencies_prerequisite_idx" ON "task_dependencies" USING btree ("project_id","prerequisite_task_id");--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_no_self_edge" CHECK ("prerequisite_task_id" <> "dependent_task_id");
