CREATE TABLE "object_cleanup_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"object_size" integer,
	"object_sha256" text,
	"fingerprint" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"object_deleted" boolean DEFAULT false NOT NULL,
	"references_checked" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"reason" text,
	"proposed_by" uuid,
	"authorized_by" uuid,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"authorized_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "object_cleanup_operations" ADD CONSTRAINT "object_cleanup_operations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_cleanup_operations" ADD CONSTRAINT "object_cleanup_operations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_cleanup_operations" ADD CONSTRAINT "object_cleanup_operations_proposed_by_profiles_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_cleanup_operations" ADD CONSTRAINT "object_cleanup_operations_authorized_by_profiles_id_fk" FOREIGN KEY ("authorized_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "object_cleanup_operations_live_key_uq" ON "object_cleanup_operations" USING btree ("org_id","project_id","object_key") WHERE status in ('proposed','authorized');--> statement-breakpoint
CREATE INDEX "object_cleanup_operations_org_project_idx" ON "object_cleanup_operations" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "object_cleanup_operations_status_idx" ON "object_cleanup_operations" USING btree ("status");