ALTER TABLE "verification_evidence" DROP CONSTRAINT "verification_evidence_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "verification_evidence" DROP CONSTRAINT "verification_evidence_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "verification_evidence" DROP CONSTRAINT "verification_evidence_task_id_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "verification_evidence" DROP CONSTRAINT "verification_evidence_request_id_verification_requests_id_fk";
--> statement-breakpoint
ALTER TABLE "verification_requests" DROP CONSTRAINT "verification_requests_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "verification_requests" DROP CONSTRAINT "verification_requests_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "verification_requests" DROP CONSTRAINT "verification_requests_task_id_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "verification_evidence" ADD CONSTRAINT "verification_evidence_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_evidence" ADD CONSTRAINT "verification_evidence_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_evidence" ADD CONSTRAINT "verification_evidence_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_evidence" ADD CONSTRAINT "verification_evidence_request_id_verification_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."verification_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD CONSTRAINT "verification_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD CONSTRAINT "verification_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD CONSTRAINT "verification_requests_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;