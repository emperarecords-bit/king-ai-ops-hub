ALTER TYPE "public"."document_status" ADD VALUE 'purge_quarantined';--> statement-breakpoint
CREATE TABLE "document_purge_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"scope" jsonb,
	"fingerprint" text NOT NULL,
	"retention_ms" integer,
	"retention_until" timestamp with time zone,
	"objects_total" integer DEFAULT 0 NOT NULL,
	"objects_deleted" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"reason" text,
	"proposed_by" uuid,
	"authorized_by" uuid,
	"cancelled_by" uuid,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"authorized_at" timestamp with time zone,
	"database_purged_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_purge_operations" ADD CONSTRAINT "document_purge_operations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_purge_operations" ADD CONSTRAINT "document_purge_operations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_purge_operations" ADD CONSTRAINT "document_purge_operations_proposed_by_profiles_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_purge_operations" ADD CONSTRAINT "document_purge_operations_authorized_by_profiles_id_fk" FOREIGN KEY ("authorized_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_purge_operations" ADD CONSTRAINT "document_purge_operations_cancelled_by_profiles_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_purge_operations_live_doc_uq" ON "document_purge_operations" USING btree ("org_id","project_id","document_id") WHERE status not in ('completed','failed','cancelled');--> statement-breakpoint
CREATE INDEX "document_purge_operations_org_project_idx" ON "document_purge_operations" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "document_purge_operations_status_idx" ON "document_purge_operations" USING btree ("status");