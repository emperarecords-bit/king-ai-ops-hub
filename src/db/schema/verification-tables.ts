/**
 * VER-002 persistence — external-runner evidence ingestion.
 *
 * Two tenant-scoped tables. `verification_requests` is the CONTRACT (created
 * before results, pinning the exact commit + required checks). `verification_evidence`
 * is the idempotent record of each submitted bundle and its decision. Both are
 * added to the RLS tenant loop in src/db/rls.sql (guarded by to_regclass) and
 * are ONLY reached through withTenant — never bypassing project isolation.
 *
 * The DDL is journaled at drizzle/0071_verification_ingest.sql (generated from this
 * schema via `npm run db:generate`, so it can never drift). The RLS policies +
 * append-only/immutability triggers are applied separately by src/db/rls.sql after
 * migrations (guarded by to_regclass), as with every other tenant table.
 */
import { bigint, boolean, check, index, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, profiles, projects, tasks } from './tables';
import type { ArtifactAvailability, CheckResult, RejectionCode, SubmittedArtifact } from '@/types/verification';

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`);
const updatedAt = timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`);

export const verificationRequests = pgTable(
  'verification_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Parent FKs are ON DELETE RESTRICT (not cascade): the verification CONTRACT is an immutable,
    // auditable record, so deleting its org/project/task is BLOCKED while a contract exists — even a
    // contract with no evidence yet. Removing a contract is only possible through the governed
    // retention path (a later slice); until then there is no application delete path by design.
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),
    repoFullName: text('repo_full_name').notNull(),
    /** The exact commit this contract verifies. Stale-commit evidence is rejected. */
    expectedCommitSha: text('expected_commit_sha').notNull(),
    /** Every check that must PASS, declared before any results arrive. */
    requiredChecks: jsonb('required_checks').$type<string[]>().notNull(),
    /** The trusted command-catalog identity pinned at creation (server-resolved, never caller-supplied).
     *  Legacy rows carry the 'unpinned' sentinel and are rejected at ingest (fail closed). Immutable. */
    catalogVersion: text('catalog_version').notNull().default('unpinned'),
    catalogDigest: text('catalog_digest').notNull().default('unpinned'),
    /** Artifact paths that MUST be present and available, declared before execution. */
    requiredArtifacts: jsonb('required_artifacts').$type<string[]>().notNull().default([]),
    allowDirty: boolean('allow_dirty').notNull().default(false),
    createdBy: uuid('created_by').references(() => profiles.id, { onDelete: 'set null' }),
    createdAt,
    updatedAt,
  },
  (t) => [
    unique('verification_requests_tenant_id_uq').on(t.orgId, t.projectId, t.id),
    // One contract per (tenant, task, exact commit): makes create idempotent and race-safe, and turns a
    // second create with a DIFFERENT contract for the same task+commit into an explicit conflict.
    unique('verification_requests_task_commit_uq').on(t.orgId, t.projectId, t.taskId, t.expectedCommitSha),
    index('verification_requests_task_idx').on(t.orgId, t.projectId, t.taskId),
  ],
);

export const verificationEvidence = pgTable(
  'verification_evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Parent FKs are ON DELETE RESTRICT (not cascade): adjudicated evidence is append-only, so a
    // parent delete must never cascade rows away. With the append-only trigger in place a cascade
    // would abort mid-delete anyway; RESTRICT makes the block explicit and early. Evidence is removed
    // only through the governed retention path (a later slice), not by cascading a parent delete.
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),
    requestId: uuid('request_id')
      .notNull()
      .references(() => verificationRequests.id, { onDelete: 'restrict' }),
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
    /** Idempotency guard: a duplicate (request,key) never changes the stored decision. */
    idempotencyKey: text('idempotency_key').notNull(),
    /** Canonical digest of the original submission — identical retries match; different content conflicts. */
    submissionSha256: text('submission_sha256').notNull(),
    accepted: boolean('accepted').notNull(),
    rejectionCode: text('rejection_code').$type<RejectionCode>(),
    status: text('status').notNull(),
    deliverable: boolean('deliverable').notNull().default(false),
    reasons: jsonb('reasons').$type<string[]>().notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
    createdAt,
  },
  (t) => [
    // Idempotency is bound to the verification request, not just the project.
    unique('verification_evidence_idempotency_uq').on(t.orgId, t.projectId, t.requestId, t.idempotencyKey),
    index('verification_evidence_task_idx').on(t.orgId, t.projectId, t.taskId),
    index('verification_evidence_request_idx').on(t.requestId),
  ],
);

/**
 * VER-002 PR-2 — per-project machine (runner) credentials. A CI runner authenticates to ONE project
 * with a bearer `keyId.secret`; only the scrypt hash + per-credential salt are stored (the plaintext
 * is shown once at issuance). The pre-tenant lookup that resolves a bearer before any tenant context
 * exists goes through a hardened SECURITY DEFINER function (src/db/rls.sql), never a broad grant —
 * app_server reaches its own rows only under RLS (issuance/revocation run with the admin's tenant
 * context). This is the BEARER credential; it is deliberately separate from the HMAC *signing* key
 * (a bearer revocation is not a signing-key retirement, and vice versa).
 */
export const verificationRunnerKeys = pgTable(
  'verification_runner_keys',
  {
    /** keyId — the public half of the bearer credential `keyId.secret`. */
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** scrypt hash of the secret, hex. Never the plaintext. */
    secretHash: text('secret_hash').notNull(),
    /** Per-credential random salt, hex (separate salt per credential). */
    secretSalt: text('secret_salt').notNull(),
    label: text('label').notNull().default(''),
    createdBy: uuid('created_by').references(() => profiles.id, { onDelete: 'set null' }),
    createdAt,
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    /** 90-day default expiry is set by the issuer; the column itself is required. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => profiles.id, { onDelete: 'set null' }),
  },
  (t) => [index('verification_runner_keys_project_idx').on(t.orgId, t.projectId)],
);

/**
 * VER-002 PR-4 — artifact UPLOAD grants (mechanism only; uploads disabled by default).
 *
 * IMMUTABLE metadata written once when a runner requests a grant for one required artifact of one
 * attempt of one contract. The row binds (tenant, contract, attempt, logical path) to a single
 * server-derived object key + the DECLARED size and sha256, plus a short TTL (`expiresAt`, governs when
 * an upload may START) and a recorded `maxUploadMs` (T_max — recorded ONLY; no mechanism enforces it
 * yet, and it never authorizes quota reclamation). No column is mutated after insert; lifecycle is the
 * append-only events table below. The dedup key (org, project, request, attempt, logical_path) makes an
 * identical re-request idempotent and a changed declaration a conflict — one object per (attempt, path).
 */
export const verificationUploadGrants = pgTable(
  'verification_upload_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    requestId: uuid('request_id')
      .notNull()
      .references(() => verificationRequests.id, { onDelete: 'restrict' }),
    /** The runner-declared attempt id (validated to a strict opaque token before it is placed in a key). */
    attemptId: text('attempt_id').notNull(),
    /** The logical artifact path (a `requiredArtifacts` entry of the contract). */
    logicalPath: text('logical_path').notNull(),
    /** The server-derived canonical object key the runner may write exactly once. */
    objectKey: text('object_key').notNull(),
    /** Declared byte length; the upload is rejected unless the streamed bytes total exactly this. */
    declaredSize: bigint('declared_size', { mode: 'number' }).notNull(),
    /** Declared sha256 (hex); the upload is rejected unless the streamed bytes hash to exactly this. */
    declaredSha256: text('declared_sha256').notNull(),
    contentType: text('content_type').notNull().default('application/octet-stream'),
    /** When a NEW upload may start (short TTL). See maxUploadMs note for the quota limitation. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** T_max — recorded only; UNPROVEN (nothing enforces a max upload duration), never a reclaim trigger. */
    maxUploadMs: bigint('max_upload_ms', { mode: 'number' }).notNull(),
    createdBy: uuid('created_by').references(() => profiles.id, { onDelete: 'set null' }),
    createdAt,
  },
  (t) => [
    unique('verification_upload_grants_tenant_id_uq').on(t.orgId, t.projectId, t.id),
    // Dedup: one grant per (tenant, contract, attempt, logical path). Identical re-request returns this
    // same row; a changed size/digest for the same key is a conflict (enforced in the app before insert).
    unique('verification_upload_grants_dedup_uq').on(t.orgId, t.projectId, t.requestId, t.attemptId, t.logicalPath),
    // A derived object key is unique within a tenant (defense in depth against key reuse).
    unique('verification_upload_grants_object_key_uq').on(t.orgId, t.projectId, t.objectKey),
    index('verification_upload_grants_request_idx').on(t.orgId, t.projectId, t.requestId),
  ],
);

/**
 * VER-002 PR-4 — append-only lifecycle events for upload grants. Current state is DERIVED from events,
 * never by UPDATE-in-place: a grant is "uploaded" iff an `uploaded` event exists (a later
 * `redemption_failed` can NEVER undo completion). The partial unique index guarantees at most one
 * `uploaded` event per grant, so concurrent completion recording is idempotent. RLS + revoke
 * update/delete + the append-only trigger (src/db/rls.sql) keep it immutable.
 */
export const verificationUploadGrantEvents = pgTable(
  'verification_upload_grant_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    grantId: uuid('grant_id')
      .notNull()
      .references(() => verificationUploadGrants.id, { onDelete: 'restrict' }),
    /** 'uploaded' (completion) | 'redemption_failed' (informational; cannot undo a completion). */
    eventType: text('event_type').notNull(),
    detail: text('detail'),
    createdAt,
  },
  (t) => [
    index('verification_upload_grant_events_grant_idx').on(t.orgId, t.projectId, t.grantId),
    // At most one completion event per grant → idempotent concurrent completion recording.
    uniqueIndex('verification_upload_grant_events_uploaded_uq')
      .on(t.grantId)
      .where(sql`event_type = 'uploaded'`),
  ],
);

/**
 * VER-002 PR-7 — the recoverable retention lifecycle (docs/verification/external-runner-design.md §3.2).
 *
 * Immutable is not eternal. PR-1 made `verification_evidence` genuinely append-only and flipped its
 * parents to RESTRICT, which closed the deletion path entirely: a project holding evidence currently
 * cannot be deleted at all. This is the sanctioned way back, and it is deliberately NOT a cascade.
 *
 * The ordering is the whole point. `app.purge_verification_evidence()` records the job and its exact
 * object identifiers in the SAME transaction that removes the evidence references, so the keys to clean
 * up are durably committed BEFORE the only pointer to them disappears. A crash immediately afterwards
 * loses nothing: the worker resumes from the recorded list.
 *
 * Unlike every other table in this module these two are NOT append-only — the worker must mark objects
 * `deleted` as it confirms each one, and must be able to record a failed attempt and retry. src/db/rls.sql
 * therefore grants UPDATE to the retention role ONLY, leaves `app_server` with SELECT alone, and gives
 * the DELETE grant on `verification_evidence` exclusively to that role.
 */
/**
 * VER-002 PR-6 — the aggregate storage quota, one row per tenant (design §4.6).
 *
 * This row IS the serialization point. Issuing grants must not oversubscribe a project under concurrency,
 * and the way §4.6 specifies that is a single conditional UPDATE that fails atomically rather than a
 * read-then-write: `set reserved_bytes = reserved_bytes + n where reserved_bytes + committed_bytes + n <=
 * cap_bytes`. Zero rows updated means "would exceed the cap" — there is no window between the check and
 * the increment because they are the same statement.
 *
 * TWO COUNTERS, NOT ONE, and the distinction is the whole of Gate B. `reserved_bytes` is bytes that may
 * still land; `committed_bytes` is bytes that have landed and now occupy storage. Finalize moves a grant
 * from the first to the second and **changes the total not at all** — finalize frees nothing. Quota for
 * landed bytes is released only when the object is actually deleted, which is retention's job (§3.2).
 *
 * WHAT IS DELIBERATELY ABSENT: any path that releases a reservation on a timer or on URL expiry. S3
 * evaluates a presigned URL's expiry at request START, so a PUT begun just before expiry can keep
 * writing afterwards; releasing then would let those bytes exceed the cap. Gate B defers all timed
 * reclamation until a hard total-upload deadline is demonstrably enforced, so an un-finalized
 * reservation is held until it is finalized or an operator acts. See the SUPERSEDED IN PART BY GATE B
 * admonition on §4.6 — its "confirmed-absent after a drain window" text is retracted, not implemented.
 */
export const verificationStorageQuota = pgTable(
  'verification_storage_quota',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    /** The aggregate cap for this project, in bytes. Seeded on first reserve from the configured default. */
    capBytes: bigint('cap_bytes', { mode: 'number' }).notNull(),
    /** Bytes that may still land: granted but not yet finalized. Never released by a timer. */
    reservedBytes: bigint('reserved_bytes', { mode: 'number' }).notNull().default(0),
    /** Bytes that HAVE landed and occupy storage. Freed only by retention deleting the object. */
    committedBytes: bigint('committed_bytes', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
    createdAt,
  },
  (t) => [
    // One row per tenant, and it is the row every reservation contends on.
    primaryKey({ columns: [t.orgId, t.projectId] }),
    // Belt for the arithmetic: a bug that drove either counter negative would silently hand out free
    // quota, so the database refuses it outright rather than trusting the application's clamping.
    check('verification_storage_quota_reserved_nonneg', sql`reserved_bytes >= 0`),
    check('verification_storage_quota_committed_nonneg', sql`committed_bytes >= 0`),
    check('verification_storage_quota_cap_nonneg', sql`cap_bytes >= 0`),
  ],
);

export const verificationPurgeJobs = pgTable(
  'verification_purge_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    /** 'retention_expiry' (age-based policy) | 'erasure_request' (explicit, tenant-offboarding). */
    reason: text('reason').notNull(),
    /** The authorizing human, when there is one. NULL for an automated age-based expiry. */
    requestedBy: uuid('requested_by').references(() => profiles.id, { onDelete: 'set null' }),
    /** 'open' until EVERY listed object is confirmed gone, then 'complete'. Never complete early. */
    status: text('status').notNull().default('open'),
    /** How many objects this job must account for; the completion check compares against confirmed deletes. */
    objectCount: bigint('object_count', { mode: 'number' }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt,
  },
  (t) => [
    unique('verification_purge_jobs_tenant_id_uq').on(t.orgId, t.projectId, t.id),
    // The worker's claim query: open jobs, oldest first.
    index('verification_purge_jobs_open_idx').on(t.status, t.createdAt),
  ],
);

/**
 * VER-002 PR-7 — one row per object a purge job must delete, with its own retry state.
 *
 * Why a child table rather than a JSON list on the job: §3.2 requires that each object be marked deleted
 * individually, that transient failures be RETRIED, and that a job count as complete only once every
 * listed object is confirmed gone. Per-object rows make "resume exactly where the crash left off" a
 * primary-key lookup instead of a read-modify-write over a blob.
 *
 * `versionId` is NULL for conditional-create keys (deleted outright) and set for pinned versions, which
 * may only be removed once any Object-Lock retention has lapsed. The uniqueness is on (job, object key)
 * rather than including `versionId`, because Postgres treats NULLs as distinct and a nullable column in
 * a UNIQUE constraint would silently permit duplicate pending rows for the same key.
 */
export const verificationPurgeJobObjects = pgTable(
  'verification_purge_job_objects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => verificationPurgeJobs.id, { onDelete: 'restrict' }),
    /** The exact storage key recorded before the evidence reference was removed. */
    objectKey: text('object_key').notNull(),
    /** Pinned version to delete, or NULL for a conditional-create key removed outright. */
    versionId: text('version_id'),
    /**
     * VER-002 PR-6 ↔ PR-7 SEAM. Committed bytes to return to the quota when this object is confirmed
     * gone. Resolved at purge time from the object's own upload GRANT (declared_size), NOT from the
     * evidence artifact's sizeBytes, and 0 when no grant matches.
     *
     * Why the grant and not the artifact: committed_bytes was CREDITED from the grant's declared_size at
     * finalize, so refunding anything else would drift the counter. Evidence can also reference an object
     * that never went through a grant at all (a pre-PR-4 row, or a direct ingest), and refunding bytes
     * that were never charged would hand out free quota. 0 is the correct refund for "never charged".
     */
    quotaBytes: bigint('quota_bytes', { mode: 'number' }).notNull().default(0),
    /** 'pending' | 'deleted'. There is no 'failed' terminal state — a failure is a retry, not an end. */
    state: text('state').notNull().default('pending'),
    attempts: bigint('attempts', { mode: 'number' }).notNull().default(0),
    lastError: text('last_error'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt,
  },
  (t) => [
    unique('verification_purge_job_objects_job_key_uq').on(t.jobId, t.objectKey),
    // The worker's per-job scan for outstanding objects.
    index('verification_purge_job_objects_pending_idx').on(t.state, t.jobId),
  ],
);

