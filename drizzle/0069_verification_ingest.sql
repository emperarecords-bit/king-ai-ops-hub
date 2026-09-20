-- VER-002 — external-runner evidence ingestion (Option A).
-- REVIEW ARTIFACT / NOT AUTO-APPLIED. This mirrors what `npm run db:generate`
-- produces from src/db/schema/verification-tables.ts. It is intentionally NOT in
-- meta/_journal.json, so `npm run db:migrate` will not run it. To apply for real,
-- regenerate from the schema (which also journals it) and review the diff.
-- Rollback: drizzle/0069_verification_ingest.rollback.sql.

CREATE TABLE IF NOT EXISTS "verification_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "repo_full_name" text NOT NULL,
  "expected_commit_sha" text NOT NULL,
  "required_checks" jsonb NOT NULL,
  "allow_dirty" boolean DEFAULT false NOT NULL,
  "created_by" uuid,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "verification_requests_tenant_id_uq" UNIQUE ("org_id", "project_id", "id")
);

CREATE TABLE IF NOT EXISTS "verification_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "request_id" uuid NOT NULL,
  "repo_full_name" text NOT NULL,
  "commit_sha" text NOT NULL,
  "dirty" boolean DEFAULT false NOT NULL,
  "uncommitted_changes_digest" text,
  "runner_id" text NOT NULL,
  "run_id" text NOT NULL,
  "attempt_id" text NOT NULL,
  "environment" text NOT NULL,
  "source" text NOT NULL,
  "checks" jsonb NOT NULL,
  "artifacts" jsonb NOT NULL,
  "artifact_availability" jsonb NOT NULL,
  "idempotency_key" text NOT NULL,
  "accepted" boolean NOT NULL,
  "rejection_code" text,
  "status" text NOT NULL,
  "deliverable" boolean DEFAULT false NOT NULL,
  "reasons" jsonb NOT NULL,
  "decided_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "verification_evidence_idempotency_uq" UNIQUE ("org_id", "project_id", "idempotency_key")
);

DO $$ BEGIN
  ALTER TABLE "verification_requests" ADD CONSTRAINT "verification_requests_org_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;
  ALTER TABLE "verification_requests" ADD CONSTRAINT "verification_requests_project_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade;
  ALTER TABLE "verification_requests" ADD CONSTRAINT "verification_requests_task_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE cascade;
  ALTER TABLE "verification_requests" ADD CONSTRAINT "verification_requests_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE set null;
  ALTER TABLE "verification_evidence" ADD CONSTRAINT "verification_evidence_org_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;
  ALTER TABLE "verification_evidence" ADD CONSTRAINT "verification_evidence_project_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade;
  ALTER TABLE "verification_evidence" ADD CONSTRAINT "verification_evidence_task_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE cascade;
  ALTER TABLE "verification_evidence" ADD CONSTRAINT "verification_evidence_request_fk" FOREIGN KEY ("request_id") REFERENCES "verification_requests"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "verification_requests_task_idx" ON "verification_requests" ("org_id", "project_id", "task_id");
CREATE INDEX IF NOT EXISTS "verification_evidence_task_idx" ON "verification_evidence" ("org_id", "project_id", "task_id");
CREATE INDEX IF NOT EXISTS "verification_evidence_request_idx" ON "verification_evidence" ("request_id");

-- RLS policies are added (guarded) in src/db/rls.sql, applied at bootstrap.
