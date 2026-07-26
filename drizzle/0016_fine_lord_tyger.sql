ALTER TABLE "objectives" ADD COLUMN "closed_by" uuid;--> statement-breakpoint
ALTER TABLE "objectives" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "objectives" ADD COLUMN "closure_reason" text;--> statement-breakpoint
ALTER TABLE "objectives" ADD CONSTRAINT "objectives_closed_by_profiles_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;