CREATE TABLE "document_version_tombstones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"content_fidelity" text NOT NULL,
	"object_key" text,
	"object_deleted" boolean DEFAULT false NOT NULL,
	"reason" text,
	"purged_by" uuid,
	"purged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_version_tombstones" ADD CONSTRAINT "document_version_tombstones_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_version_tombstones" ADD CONSTRAINT "document_version_tombstones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_version_tombstones" ADD CONSTRAINT "document_version_tombstones_purged_by_profiles_id_fk" FOREIGN KEY ("purged_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_version_tombstones_version_uq" ON "document_version_tombstones" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "document_version_tombstones_doc_idx" ON "document_version_tombstones" USING btree ("document_id");