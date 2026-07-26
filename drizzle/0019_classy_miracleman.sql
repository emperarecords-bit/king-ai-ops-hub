ALTER TABLE "tasks" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "closed_by" uuid;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "closure_reason" text;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_closed_by_profiles_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;