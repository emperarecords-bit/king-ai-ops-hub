CREATE TYPE "public"."data_classification" AS ENUM('live', 'demo', 'seed');--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "classification" "data_classification" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "classification" "data_classification" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "objectives" ADD COLUMN "classification" "data_classification" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "classification" "data_classification" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "classification" "data_classification";--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "classification" "data_classification" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "classification" "data_classification";--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "classification" "data_classification" DEFAULT 'live' NOT NULL;