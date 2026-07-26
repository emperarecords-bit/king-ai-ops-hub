CREATE TABLE "ai_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"operation_type" text NOT NULL,
	"subject_type" text,
	"subject_id" uuid,
	"idempotency_key" text,
	"status" text DEFAULT 'dispatched' NOT NULL,
	"provider" text,
	"model" text,
	"context_hash" text,
	"dispatched_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"result_ref" uuid,
	"error" text,
	"retry_of" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_operations" ADD CONSTRAINT "ai_operations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_operations" ADD CONSTRAINT "ai_operations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_operations" ADD CONSTRAINT "ai_operations_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_operations_org_project_type_idx" ON "ai_operations" USING btree ("org_id","project_id","operation_type");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_operations_idempotency_uq" ON "ai_operations" USING btree ("project_id","operation_type","idempotency_key");