CREATE TABLE "verification_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"repo_full_name" text NOT NULL,
	"commit_sha" text NOT NULL,
	"dirty" boolean DEFAULT false NOT NULL,
	"uncommitted_changes_digest" text,
	"runner_id" text NOT NULL,
	"run_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"environment" text NOT NULL,
	"source" text NOT NULL,
	"checks" jsonb NOT NULL,
	"artifacts" jsonb NOT NULL,
	"artifact_availability" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"submission_sha256" text NOT NULL,
	"accepted" boolean NOT NULL,
	"rejection_code" text,
	"status" text NOT NULL,
	"deliverable" boolean DEFAULT false NOT NULL,
	"reasons" jsonb NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_evidence_idempotency_uq" UNIQUE("org_id","project_id","request_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "verification_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"repo_full_name" text NOT NULL,
	"expected_commit_sha" text NOT NULL,
	"required_checks" jsonb NOT NULL,
	"required_artifacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allow_dirty" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_requests_tenant_id_uq" UNIQUE("org_id","project_id","id")
);
--> statement-breakpoint
ALTER TABLE "verification_evidence" ADD CONSTRAINT "verification_evidence_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_evidence" ADD CONSTRAINT "verification_evidence_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_evidence" ADD CONSTRAINT "verification_evidence_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_evidence" ADD CONSTRAINT "verification_evidence_request_id_verification_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."verification_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD CONSTRAINT "verification_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD CONSTRAINT "verification_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD CONSTRAINT "verification_requests_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD CONSTRAINT "verification_requests_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "verification_evidence_task_idx" ON "verification_evidence" USING btree ("org_id","project_id","task_id");--> statement-breakpoint
CREATE INDEX "verification_evidence_request_idx" ON "verification_evidence" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "verification_requests_task_idx" ON "verification_requests" USING btree ("org_id","project_id","task_id");