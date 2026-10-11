CREATE TABLE "vercel_project_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"vercel_project_id" text NOT NULL,
	"vercel_team_id" text,
	"label" text,
	"linked_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vercel_project_links" ADD CONSTRAINT "vercel_project_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vercel_project_links" ADD CONSTRAINT "vercel_project_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vercel_project_links" ADD CONSTRAINT "vercel_project_links_linked_by_profiles_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vercel_project_links_project_id_uq" ON "vercel_project_links" USING btree ("project_id","vercel_project_id");--> statement-breakpoint
CREATE INDEX "vercel_project_links_org_project_idx" ON "vercel_project_links" USING btree ("org_id","project_id");