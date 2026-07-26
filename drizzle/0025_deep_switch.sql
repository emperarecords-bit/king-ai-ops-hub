DROP INDEX "knowledge_injections_run_item_uq";--> statement-breakpoint
ALTER TABLE "knowledge_injections" ADD COLUMN "consumer_type" text DEFAULT 'task_run' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_injections" ADD COLUMN "consumer_id" uuid;--> statement-breakpoint
UPDATE "knowledge_injections" SET "consumer_id" = "run_id" WHERE "consumer_id" IS NULL AND "run_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_injections_consumer_item_uq" ON "knowledge_injections" USING btree ("consumer_type","consumer_id","knowledge_item_id");