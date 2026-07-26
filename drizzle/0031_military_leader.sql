CREATE TABLE "knowledge_disclosure_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"knowledge_item_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"rationale" text,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" text
);
--> statement-breakpoint
ALTER TABLE "knowledge_disclosure_grants" ADD CONSTRAINT "knowledge_disclosure_grants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_disclosure_grants" ADD CONSTRAINT "knowledge_disclosure_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_disclosure_grants" ADD CONSTRAINT "knowledge_disclosure_grants_knowledge_item_id_knowledge_items_id_fk" FOREIGN KEY ("knowledge_item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_disclosure_grants" ADD CONSTRAINT "knowledge_disclosure_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_disclosure_grants" ADD CONSTRAINT "knowledge_disclosure_grants_granted_by_profiles_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_disclosure_grants" ADD CONSTRAINT "knowledge_disclosure_grants_revoked_by_profiles_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_disclosure_grants_item_idx" ON "knowledge_disclosure_grants" USING btree ("knowledge_item_id");--> statement-breakpoint
CREATE INDEX "knowledge_disclosure_grants_lookup_idx" ON "knowledge_disclosure_grants" USING btree ("project_id","purpose","knowledge_item_id","agent_id");