CREATE TABLE "verification_storage_quota" (
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"cap_bytes" bigint NOT NULL,
	"reserved_bytes" bigint DEFAULT 0 NOT NULL,
	"committed_bytes" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_storage_quota_org_id_project_id_pk" PRIMARY KEY("org_id","project_id"),
	CONSTRAINT "verification_storage_quota_reserved_nonneg" CHECK (reserved_bytes >= 0),
	CONSTRAINT "verification_storage_quota_committed_nonneg" CHECK (committed_bytes >= 0),
	CONSTRAINT "verification_storage_quota_cap_nonneg" CHECK (cap_bytes >= 0)
);
--> statement-breakpoint
ALTER TABLE "verification_purge_job_objects" ADD COLUMN "quota_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_storage_quota" ADD CONSTRAINT "verification_storage_quota_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_storage_quota" ADD CONSTRAINT "verification_storage_quota_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;