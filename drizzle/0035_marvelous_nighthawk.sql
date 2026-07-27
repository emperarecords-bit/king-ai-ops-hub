CREATE TYPE "public"."content_fidelity" AS ENUM('byte_exact', 'reconstructed_text', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."document_index_status" AS ENUM('pending', 'indexed', 'failed');--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"mime_type" text,
	"object_key" text,
	"content_fidelity" "content_fidelity" DEFAULT 'unavailable' NOT NULL,
	"source_revision_id" text,
	"source_modified_at" timestamp with time zone,
	"ingested_at" timestamp with time zone,
	"indexed_at" timestamp with time zone,
	"index_status" "document_index_status" DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"disclosure_snapshot" "knowledge_disclosure" DEFAULT 'workspace_internal' NOT NULL,
	"parser_version" text,
	"ingestion_operation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"chunk_index" integer DEFAULT -1 NOT NULL,
	"retrieval_reason" text,
	"rank" integer,
	"disclosure_snapshot" "knowledge_disclosure" DEFAULT 'workspace_internal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_chunks" ADD COLUMN "document_version_id" uuid;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD COLUMN "locator" text;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD COLUMN "parser_version" text;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "current_version_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN "document_version_id" uuid;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_document_versions" ADD CONSTRAINT "run_document_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_document_versions" ADD CONSTRAINT "run_document_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_document_versions" ADD CONSTRAINT "run_document_versions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_document_versions" ADD CONSTRAINT "run_document_versions_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_versions_document_idx" ON "document_versions" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_document_sha_uq" ON "document_versions" USING btree ("document_id","sha256");--> statement-breakpoint
CREATE INDEX "run_document_versions_run_idx" ON "run_document_versions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "run_document_versions_version_idx" ON "run_document_versions" USING btree ("document_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_document_versions_uq" ON "run_document_versions" USING btree ("run_id","document_version_id","chunk_index");--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_chunks_version_idx" ON "document_chunks" USING btree ("document_version_id");--> statement-breakpoint
CREATE INDEX "documents_current_version_idx" ON "documents" USING btree ("current_version_id");