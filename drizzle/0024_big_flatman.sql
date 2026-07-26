CREATE TABLE "knowledge_injections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"knowledge_item_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"run_id" uuid,
	"task_id" uuid,
	"reason" text NOT NULL,
	"memory_text" text,
	"injected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_injections" ADD CONSTRAINT "knowledge_injections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_injections" ADD CONSTRAINT "knowledge_injections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_injections" ADD CONSTRAINT "knowledge_injections_knowledge_item_id_knowledge_items_id_fk" FOREIGN KEY ("knowledge_item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_injections" ADD CONSTRAINT "knowledge_injections_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_injections" ADD CONSTRAINT "knowledge_injections_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_injections_item_idx" ON "knowledge_injections" USING btree ("knowledge_item_id");--> statement-breakpoint
CREATE INDEX "knowledge_injections_org_project_idx" ON "knowledge_injections" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_injections_run_item_uq" ON "knowledge_injections" USING btree ("run_id","knowledge_item_id");