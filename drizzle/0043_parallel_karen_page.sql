ALTER TABLE "document_versions" ADD COLUMN "source_change_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "restore_requested_at" timestamp with time zone;