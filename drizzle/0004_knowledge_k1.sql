CREATE TYPE "public"."knowledge_kind" AS ENUM('standard', 'policy', 'decision', 'playbook', 'persona', 'template', 'brand', 'fact');--> statement-breakpoint
CREATE TYPE "public"."knowledge_scope" AS ENUM('org', 'project', 'department', 'employee');--> statement-breakpoint
CREATE TYPE "public"."knowledge_source" AS ENUM('manual', 'promoted_artifact', 'promoted_context');--> statement-breakpoint
CREATE TYPE "public"."knowledge_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TABLE "knowledge_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid,
	"scope" "knowledge_scope" DEFAULT 'project' NOT NULL,
	"department_id" uuid,
	"agent_id" uuid,
	"kind" "knowledge_kind" DEFAULT 'fact' NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"supersedes" uuid,
	"status" "knowledge_status" DEFAULT 'draft' NOT NULL,
	"source" "knowledge_source" DEFAULT 'manual' NOT NULL,
	"source_ref" uuid,
	"created_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_approved_by_profiles_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_org_project_status_idx" ON "knowledge_items" USING btree ("org_id","project_id","status");--> statement-breakpoint
CREATE INDEX "knowledge_project_kind_idx" ON "knowledge_items" USING btree ("project_id","kind");--> statement-breakpoint
CREATE INDEX "knowledge_supersedes_idx" ON "knowledge_items" USING btree ("supersedes");--> statement-breakpoint
-- K1 data migration: every approved context item becomes an active knowledge
-- fact with lineage back to its source row. Idempotent via the source_ref
-- guard so a re-run cannot duplicate. project_context_items stays in place,
-- read-only-by-convention, until K2 retires it.
insert into "knowledge_items"
  (org_id, project_id, scope, kind, title, body, version, status, source, source_ref, created_by, approved_by, approved_at, created_at)
select
  c.org_id, c.project_id, 'project', 'fact', c.title, c.content, 1, 'active', 'promoted_context', c.id,
  coalesce(c.created_by, (select m.user_id from memberships m where m.org_id = c.org_id and m.role = 'owner' limit 1)),
  c.created_by, c.updated_at, c.created_at
from "project_context_items" c
where c.status = 'approved'
  and not exists (select 1 from "knowledge_items" k where k.source_ref = c.id);
