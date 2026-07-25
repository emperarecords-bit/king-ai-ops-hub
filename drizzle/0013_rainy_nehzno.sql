CREATE TYPE "public"."document_job_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."document_source" AS ENUM('local_folder', 'cloud_upload');--> statement-breakpoint
ALTER TYPE "public"."document_status" ADD VALUE 'uploaded';--> statement-breakpoint
ALTER TYPE "public"."document_status" ADD VALUE 'queued';--> statement-breakpoint
ALTER TYPE "public"."document_status" ADD VALUE 'indexing';--> statement-breakpoint
ALTER TYPE "public"."document_status" ADD VALUE 'unsupported';--> statement-breakpoint
ALTER TYPE "public"."document_status" ADD VALUE 'source_unavailable';--> statement-breakpoint
CREATE TABLE "document_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"status" "document_job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"leased_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "documents_project_path_uq";--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "source" "document_source" DEFAULT 'local_folder' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "object_key" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "mime_type" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "source_modified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "ingested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_jobs" ADD CONSTRAINT "document_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_jobs" ADD CONSTRAINT "document_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_jobs" ADD CONSTRAINT "document_jobs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_jobs_status_idx" ON "document_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "document_jobs_org_project_idx" ON "document_jobs" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_jobs_one_live_uq" ON "document_jobs" USING btree ("document_id") WHERE status in ('queued','running');--> statement-breakpoint
CREATE INDEX "documents_source_idx" ON "documents" USING btree ("project_id","source","source_id");--> statement-breakpoint
-- Identity rule (O-23), replacing the old single path-unique index:
--  * local_folder keeps (project_id, relative_path) unique — one row per path.
--  * cloud_upload is keyed by (project_id, source_id) — re-upload updates in
--    place, and "different source, same filename" never merges.
-- Both partial so the two adapters cannot collide on each other's identity.
CREATE UNIQUE INDEX "documents_local_path_uq" ON "documents" USING btree ("project_id","relative_path") WHERE source = 'local_folder';--> statement-breakpoint
CREATE UNIQUE INDEX "documents_cloud_source_uq" ON "documents" USING btree ("project_id","source_id") WHERE source = 'cloud_upload' AND source_id IS NOT NULL;