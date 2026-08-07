ALTER TABLE "agents" ADD COLUMN "review_rubric" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_review_rubric_bytes_ck" CHECK ("agents"."review_rubric" is null or octet_length("agents"."review_rubric") <= 8192);
