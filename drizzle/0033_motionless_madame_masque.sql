CREATE TABLE "knowledge_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"knowledge_item_id" uuid NOT NULL,
	"suggested_by_run_id" uuid,
	"extraction_operation_id" uuid,
	"provider" text,
	"model" text,
	"prompt_version" text NOT NULL,
	"confidence" text DEFAULT 'low' NOT NULL,
	"reason" text,
	"suggested_scope_kind" "knowledge_scope_kind" DEFAULT 'workspace' NOT NULL,
	"suggested_scope_task_id" uuid,
	"suggested_scope_objective_id" uuid,
	"suggested_disclosure" "knowledge_disclosure" DEFAULT 'workspace_internal' NOT NULL,
	"suggested_as_of" timestamp with time zone,
	"suggested_review_after" timestamp with time zone,
	"suggested_expires_at" timestamp with time zone,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "disclosure" "knowledge_disclosure" DEFAULT 'workspace_internal' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "knowledge_extraction_status" "extraction_status";--> statement-breakpoint
ALTER TABLE "knowledge_proposals" ADD CONSTRAINT "knowledge_proposals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_proposals" ADD CONSTRAINT "knowledge_proposals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_proposals" ADD CONSTRAINT "knowledge_proposals_knowledge_item_id_knowledge_items_id_fk" FOREIGN KEY ("knowledge_item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_proposals" ADD CONSTRAINT "knowledge_proposals_suggested_by_run_id_runs_id_fk" FOREIGN KEY ("suggested_by_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_proposals" ADD CONSTRAINT "knowledge_proposals_extraction_operation_id_ai_operations_id_fk" FOREIGN KEY ("extraction_operation_id") REFERENCES "public"."ai_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_proposals" ADD CONSTRAINT "knowledge_proposals_suggested_scope_task_id_tasks_id_fk" FOREIGN KEY ("suggested_scope_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_proposals" ADD CONSTRAINT "knowledge_proposals_suggested_scope_objective_id_objectives_id_fk" FOREIGN KEY ("suggested_scope_objective_id") REFERENCES "public"."objectives"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_proposals" ADD CONSTRAINT "knowledge_proposals_reviewed_by_profiles_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_proposals_item_idx" ON "knowledge_proposals" USING btree ("knowledge_item_id");--> statement-breakpoint
CREATE INDEX "knowledge_proposals_review_idx" ON "knowledge_proposals" USING btree ("project_id","review_status");