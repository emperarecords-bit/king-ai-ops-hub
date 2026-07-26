ALTER TABLE "ai_operations" ADD COLUMN "knowledge_purpose" text;--> statement-breakpoint
ALTER TABLE "knowledge_disclosure_grants" ADD COLUMN "agent_execution_fingerprint" text NOT NULL;