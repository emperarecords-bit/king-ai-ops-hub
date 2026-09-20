/**
 * VER-002 persistence — external-runner evidence ingestion.
 *
 * Two tenant-scoped tables. `verification_requests` is the CONTRACT (created
 * before results, pinning the exact commit + required checks). `verification_evidence`
 * is the idempotent record of each submitted bundle and its decision. Both are
 * added to the RLS tenant loop in src/db/rls.sql (guarded by to_regclass) and
 * are ONLY reached through withTenant — never bypassing project isolation.
 *
 * This schema is provided for review. No migration is applied here; see
 * drizzle/0069_verification_ingest.sql (+ .rollback.sql) for the DDL/rollback.
 */
import { boolean, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, profiles, projects, tasks } from './tables';
import type { ArtifactAvailability, CheckResult, RejectionCode, SubmittedArtifact } from '@/domain/verification';

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`);
const updatedAt = timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`);

export const verificationRequests = pgTable(
  'verification_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    repoFullName: text('repo_full_name').notNull(),
    /** The exact commit this contract verifies. Stale-commit evidence is rejected. */
    expectedCommitSha: text('expected_commit_sha').notNull(),
    /** Every check that must PASS, declared before any results arrive. */
    requiredChecks: jsonb('required_checks').$type<string[]>().notNull(),
    allowDirty: boolean('allow_dirty').notNull().default(false),
    createdBy: uuid('created_by').references(() => profiles.id, { onDelete: 'set null' }),
    createdAt,
    updatedAt,
  },
  (t) => [
    unique('verification_requests_tenant_id_uq').on(t.orgId, t.projectId, t.id),
    index('verification_requests_task_idx').on(t.orgId, t.projectId, t.taskId),
  ],
);

export const verificationEvidence = pgTable(
  'verification_evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    requestId: uuid('request_id')
      .notNull()
      .references(() => verificationRequests.id, { onDelete: 'cascade' }),
    repoFullName: text('repo_full_name').notNull(),
    commitSha: text('commit_sha').notNull(),
    dirty: boolean('dirty').notNull().default(false),
    uncommittedChangesDigest: text('uncommitted_changes_digest'),
    runnerId: text('runner_id').notNull(),
    runId: text('run_id').notNull(),
    attemptId: text('attempt_id').notNull(),
    environment: text('environment').notNull(),
    source: text('source').notNull(),
    checks: jsonb('checks').$type<CheckResult[]>().notNull(),
    artifacts: jsonb('artifacts').$type<SubmittedArtifact[]>().notNull(),
    artifactAvailability: jsonb('artifact_availability').$type<ArtifactAvailability[]>().notNull(),
    /** Idempotency guard: a duplicate key never changes the stored decision. */
    idempotencyKey: text('idempotency_key').notNull(),
    accepted: boolean('accepted').notNull(),
    rejectionCode: text('rejection_code').$type<RejectionCode>(),
    status: text('status').notNull(),
    deliverable: boolean('deliverable').notNull().default(false),
    reasons: jsonb('reasons').$type<string[]>().notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
    createdAt,
  },
  (t) => [
    unique('verification_evidence_idempotency_uq').on(t.orgId, t.projectId, t.idempotencyKey),
    index('verification_evidence_task_idx').on(t.orgId, t.projectId, t.taskId),
    index('verification_evidence_request_idx').on(t.requestId),
  ],
);
