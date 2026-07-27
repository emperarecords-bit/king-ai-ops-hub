ALTER TABLE "document_version_tombstones" ADD COLUMN "status" text DEFAULT 'object_cleanup_pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_version_tombstones" ADD COLUMN "assessment" jsonb;--> statement-breakpoint
ALTER TABLE "document_version_tombstones" ADD COLUMN "cleanup_error" text;--> statement-breakpoint
ALTER TABLE "document_version_tombstones" ADD COLUMN "cleanup_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "index_degraded" boolean DEFAULT false NOT NULL;