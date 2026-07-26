CREATE TYPE "public"."work_item_condition" AS ENUM('planned', 'moving', 'waiting', 'finished', 'stopped');--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "condition" "work_item_condition" DEFAULT 'planned' NOT NULL;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "waiting_on" text;