CREATE TABLE "verification_purge_job_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"version_id" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"last_error" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_purge_job_objects_job_key_uq" UNIQUE("job_id","object_key")
);
--> statement-breakpoint
CREATE TABLE "verification_purge_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"requested_by" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"object_count" bigint NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_purge_jobs_tenant_id_uq" UNIQUE("org_id","project_id","id")
);
--> statement-breakpoint
ALTER TABLE "verification_purge_job_objects" ADD CONSTRAINT "verification_purge_job_objects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_purge_job_objects" ADD CONSTRAINT "verification_purge_job_objects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_purge_job_objects" ADD CONSTRAINT "verification_purge_job_objects_job_id_verification_purge_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."verification_purge_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_purge_jobs" ADD CONSTRAINT "verification_purge_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_purge_jobs" ADD CONSTRAINT "verification_purge_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_purge_jobs" ADD CONSTRAINT "verification_purge_jobs_requested_by_profiles_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "verification_purge_job_objects_pending_idx" ON "verification_purge_job_objects" USING btree ("state","job_id");--> statement-breakpoint
CREATE INDEX "verification_purge_jobs_open_idx" ON "verification_purge_jobs" USING btree ("status","created_at");