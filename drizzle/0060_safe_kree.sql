CREATE TABLE "github_repo_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"installation_id" bigint NOT NULL,
	"repo_full_name" text NOT NULL,
	"default_branch" text NOT NULL,
	"linked_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_repo_links" ADD CONSTRAINT "github_repo_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_repo_links" ADD CONSTRAINT "github_repo_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_repo_links" ADD CONSTRAINT "github_repo_links_linked_by_profiles_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "github_repo_links_project_repo_uq" ON "github_repo_links" USING btree ("project_id","repo_full_name");--> statement-breakpoint
CREATE INDEX "github_repo_links_org_project_idx" ON "github_repo_links" USING btree ("org_id","project_id");