CREATE TABLE "verification_upload_grant_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_upload_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"attempt_id" text NOT NULL,
	"logical_path" text NOT NULL,
	"object_key" text NOT NULL,
	"declared_size" bigint NOT NULL,
	"declared_sha256" text NOT NULL,
	"content_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_upload_ms" bigint NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_upload_grants_tenant_id_uq" UNIQUE("org_id","project_id","id"),
	CONSTRAINT "verification_upload_grants_dedup_uq" UNIQUE("org_id","project_id","request_id","attempt_id","logical_path"),
	CONSTRAINT "verification_upload_grants_object_key_uq" UNIQUE("org_id","project_id","object_key")
);
--> statement-breakpoint
ALTER TABLE "verification_upload_grant_events" ADD CONSTRAINT "verification_upload_grant_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_upload_grant_events" ADD CONSTRAINT "verification_upload_grant_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_upload_grant_events" ADD CONSTRAINT "verification_upload_grant_events_grant_id_verification_upload_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."verification_upload_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_upload_grants" ADD CONSTRAINT "verification_upload_grants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_upload_grants" ADD CONSTRAINT "verification_upload_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_upload_grants" ADD CONSTRAINT "verification_upload_grants_request_id_verification_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."verification_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_upload_grants" ADD CONSTRAINT "verification_upload_grants_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "verification_upload_grant_events_grant_idx" ON "verification_upload_grant_events" USING btree ("org_id","project_id","grant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "verification_upload_grant_events_uploaded_uq" ON "verification_upload_grant_events" USING btree ("grant_id") WHERE event_type = 'uploaded';--> statement-breakpoint
CREATE INDEX "verification_upload_grants_request_idx" ON "verification_upload_grants" USING btree ("org_id","project_id","request_id");