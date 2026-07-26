CREATE TABLE "knowledge_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"knowledge_item_id" uuid NOT NULL,
	"knowledge_version" integer NOT NULL,
	"source_type" text NOT NULL,
	"source_ref" text NOT NULL,
	"source_label" text NOT NULL,
	"source_version_hash" text,
	"source_date" timestamp with time zone,
	"transformation" text NOT NULL,
	"locator" text,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_verification_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"knowledge_item_id" uuid NOT NULL,
	"knowledge_version" integer NOT NULL,
	"judgment" text NOT NULL,
	"verifier" uuid,
	"relied_on_source_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resolution_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rationale" text,
	"limitations" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_knowledge_item_id_knowledge_items_id_fk" FOREIGN KEY ("knowledge_item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_added_by_profiles_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_verification_events" ADD CONSTRAINT "knowledge_verification_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_verification_events" ADD CONSTRAINT "knowledge_verification_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_verification_events" ADD CONSTRAINT "knowledge_verification_events_knowledge_item_id_knowledge_items_id_fk" FOREIGN KEY ("knowledge_item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_verification_events" ADD CONSTRAINT "knowledge_verification_events_verifier_profiles_id_fk" FOREIGN KEY ("verifier") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_sources_item_version_idx" ON "knowledge_sources" USING btree ("knowledge_item_id","knowledge_version");--> statement-breakpoint
CREATE INDEX "knowledge_verification_events_item_version_idx" ON "knowledge_verification_events" USING btree ("knowledge_item_id","knowledge_version");