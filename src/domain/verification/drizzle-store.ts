/**
 * Drizzle-backed VerificationStore (VER-002). Bound to a single tenant tx so the
 * whole ingest (getRequest → idempotency → saveEvidence) is atomic. RLS enforces
 * isolation; every query also filters org+project explicitly (defense in depth).
 * Kept out of the module index so the pure logic stays DB-free for tests.
 */
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { DbTx } from '@/db/client';
import {
  githubRepoLinks,
  tasks,
  verificationEvidence,
  verificationRequests,
  verificationUploadGrantEvents,
  verificationUploadGrants,
} from '@/db/schema';
import type { ArtifactAvailability, CheckResult, RejectionCode, SubmittedArtifact, VerificationRequest } from './index';
import type {
  ContractSummary,
  NewUploadGrant,
  PriorEvidence,
  UploadGrant,
  UploadGrantEventType,
  UploadGrantStore,
  VerificationStore,
} from './ports';
import type { TaskVerificationStatus } from './types';

type EvidenceRow = typeof verificationEvidence.$inferSelect;
type RequestRow = typeof verificationRequests.$inferSelect;

function rowToRequest(row: RequestRow): VerificationRequest {
  return {
    id: row.id,
    orgId: row.orgId,
    projectId: row.projectId,
    taskId: row.taskId,
    repoFullName: row.repoFullName,
    expectedCommitSha: row.expectedCommitSha,
    requiredChecks: row.requiredChecks,
    requiredArtifacts: row.requiredArtifacts,
    allowDirty: row.allowDirty,
    catalogVersion: row.catalogVersion,
    catalogDigest: row.catalogDigest,
    createdBy: row.createdBy ?? '',
    createdAt: row.createdAt.toISOString(),
  };
}

function rowToPrior(row: EvidenceRow): PriorEvidence {
  return {
    submissionSha256: row.submissionSha256,
    decision: {
      accepted: row.accepted,
      rejection: row.rejectionCode ? { code: row.rejectionCode, message: row.reasons[0] ?? '' } : null,
      status: row.status as TaskVerificationStatus,
      deliverable: row.deliverable,
      idempotencyKey: row.idempotencyKey,
      checkEvaluation: null, // durable facts are status/reasons/artifactAvailability
      artifactAvailability: row.artifactAvailability,
      reasons: row.reasons,
      decidedAt: row.decidedAt.toISOString(),
      replayed: false,
    },
  };
}

export function createDrizzleVerificationStore(tx: DbTx): VerificationStore {
  return {
    async getRequest(orgId, projectId, requestId): Promise<VerificationRequest | null> {
      const row = (
        await tx
          .select()
          .from(verificationRequests)
          .where(
            and(
              eq(verificationRequests.orgId, orgId),
              eq(verificationRequests.projectId, projectId),
              eq(verificationRequests.id, requestId),
            ),
          )
          .limit(1)
      )[0];
      return row ? rowToRequest(row) : null;
    },

    async taskExistsInTenant(orgId, projectId, taskId): Promise<boolean> {
      const row = (
        await tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.orgId, orgId), eq(tasks.projectId, projectId), eq(tasks.id, taskId)))
          .limit(1)
      )[0];
      return Boolean(row);
    },

    async linkedRepoFullNames(orgId, projectId): Promise<string[]> {
      const rows = await tx
        .select({ repo: githubRepoLinks.repoFullName })
        .from(githubRepoLinks)
        .where(and(eq(githubRepoLinks.orgId, orgId), eq(githubRepoLinks.projectId, projectId)));
      return rows.map((r) => r.repo);
    },

    async findRequestByTaskCommit(orgId, projectId, taskId, commitSha): Promise<VerificationRequest | null> {
      const row = (
        await tx
          .select()
          .from(verificationRequests)
          .where(
            and(
              eq(verificationRequests.orgId, orgId),
              eq(verificationRequests.projectId, projectId),
              eq(verificationRequests.taskId, taskId),
              eq(verificationRequests.expectedCommitSha, commitSha),
            ),
          )
          .limit(1)
      )[0];
      return row ? rowToRequest(row) : null;
    },

    async createRequest(orgId, projectId, createdBy, input): Promise<{ request: VerificationRequest; inserted: boolean }> {
      const inserted = await tx
        .insert(verificationRequests)
        .values({
          orgId,
          projectId,
          taskId: input.taskId,
          repoFullName: input.repoFullName,
          expectedCommitSha: input.commitSha,
          requiredChecks: [...input.requiredChecks],
          requiredArtifacts: [...input.requiredArtifacts],
          allowDirty: input.allowDirty,
          catalogVersion: input.catalogVersion,
          catalogDigest: input.catalogDigest,
          createdBy,
        })
        // Race-safe: a concurrent create for the same (task, commit) makes this a no-op.
        .onConflictDoNothing({
          target: [
            verificationRequests.orgId,
            verificationRequests.projectId,
            verificationRequests.taskId,
            verificationRequests.expectedCommitSha,
          ],
        })
        .returning();
      if (inserted[0]) return { request: rowToRequest(inserted[0]), inserted: true };
      // Lost the race — return the WINNER so the caller can compare contracts.
      const winner = await this.findRequestByTaskCommit(orgId, projectId, input.taskId, input.commitSha);
      if (!winner) throw new Error('verification request insert was a no-op but no existing row was found');
      return { request: winner, inserted: false };
    },

    async findExisting(orgId, projectId, requestId, key): Promise<PriorEvidence | null> {
      const row = (
        await tx
          .select()
          .from(verificationEvidence)
          .where(
            and(
              eq(verificationEvidence.orgId, orgId),
              eq(verificationEvidence.projectId, projectId),
              eq(verificationEvidence.requestId, requestId),
              eq(verificationEvidence.idempotencyKey, key),
            ),
          )
          .limit(1)
      )[0];
      return row ? rowToPrior(row) : null;
    },

    async saveEvidence(orgId, projectId, submission, submissionSha256, decision): Promise<PriorEvidence> {
      await tx
        .insert(verificationEvidence)
        .values({
          orgId,
          projectId,
          taskId: submission.taskId,
          requestId: submission.requestId,
          repoFullName: submission.repoFullName,
          commitSha: submission.commitSha,
          dirty: submission.dirty,
          uncommittedChangesDigest: submission.uncommittedChangesDigest,
          runnerId: submission.runnerId,
          runId: submission.runId,
          attemptId: submission.attemptId,
          environment: submission.environment,
          source: submission.source,
          checks: [...submission.checks] as CheckResult[],
          artifacts: [...submission.artifacts] as SubmittedArtifact[],
          artifactAvailability: [...decision.artifactAvailability] as ArtifactAvailability[],
          idempotencyKey: submission.idempotencyKey,
          submissionSha256,
          accepted: decision.accepted,
          rejectionCode: (decision.rejection?.code ?? null) as RejectionCode | null,
          status: decision.status,
          deliverable: decision.deliverable,
          reasons: [...decision.reasons] as string[],
          decidedAt: new Date(decision.decidedAt),
        })
        // Idempotent persistence: a duplicate (request,key) is a no-op; the first record stands.
        .onConflictDoNothing({
          target: [
            verificationEvidence.orgId,
            verificationEvidence.projectId,
            verificationEvidence.requestId,
            verificationEvidence.idempotencyKey,
          ],
        });

      // Re-select the WINNER (ours, or a concurrent insert's) so the orchestrator
      // can detect a losing conflict by digest mismatch.
      const stored = await this.findExisting(orgId, projectId, submission.requestId, submission.idempotencyKey);
      return stored ?? { decision, submissionSha256 };
    },

    async listRequests(orgId, projectId, opts): Promise<ContractSummary[]> {
      const conds = [eq(verificationRequests.orgId, orgId), eq(verificationRequests.projectId, projectId)];
      if (opts.afterId) conds.push(gt(verificationRequests.id, opts.afterId));
      if (opts.openOnly) {
        // "open" = no ACCEPTED evidence yet (policy-neutral; does not encode a verdict).
        conds.push(
          sql`not exists (select 1 from ${verificationEvidence} e where e.org_id = ${orgId} and e.project_id = ${projectId} and e.request_id = ${verificationRequests.id} and e.accepted)`,
        );
      }
      const rows = await tx
        .select()
        .from(verificationRequests)
        .where(and(...conds))
        .orderBy(asc(verificationRequests.id)) // deterministic keyset order (by contract id)
        .limit(opts.limit);
      return this.summarize(orgId, projectId, rows);
    },

    async getRequestSummary(orgId, projectId, requestId): Promise<ContractSummary | null> {
      const row = (
        await tx
          .select()
          .from(verificationRequests)
          .where(
            and(
              eq(verificationRequests.orgId, orgId),
              eq(verificationRequests.projectId, projectId),
              eq(verificationRequests.id, requestId),
            ),
          )
          .limit(1)
      )[0];
      if (!row) return null;
      return (await this.summarize(orgId, projectId, [row]))[0] ?? null;
    },

    /** Attach policy-neutral evidence facts (accepted count, has-verified-complete) to a set of rows. */
    async summarize(orgId: string, projectId: string, rows: RequestRow[]): Promise<ContractSummary[]> {
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.id);
      const agg = await tx
        .select({
          requestId: verificationEvidence.requestId,
          acceptedCount: sql<number>`count(*) filter (where ${verificationEvidence.accepted})`,
          verifiedCount: sql<number>`count(*) filter (where ${verificationEvidence.accepted} and ${verificationEvidence.status} = 'verified_complete')`,
        })
        .from(verificationEvidence)
        .where(
          and(
            eq(verificationEvidence.orgId, orgId),
            eq(verificationEvidence.projectId, projectId),
            inArray(verificationEvidence.requestId, ids),
          ),
        )
        .groupBy(verificationEvidence.requestId);
      const byId = new Map(agg.map((a) => [a.requestId, a]));
      return rows.map((r) => {
        const a = byId.get(r.id);
        return {
          request: rowToRequest(r),
          acceptedEvidenceCount: Number(a?.acceptedCount ?? 0),
          hasVerifiedComplete: Number(a?.verifiedCount ?? 0) > 0,
        };
      });
    },
  } as VerificationStore & { summarize(orgId: string, projectId: string, rows: RequestRow[]): Promise<ContractSummary[]> };
}

// ─────────────────────────── VER-002 PR-4 — upload grants ───────────────────────────

type GrantRow = typeof verificationUploadGrants.$inferSelect;

function rowToGrant(row: GrantRow): UploadGrant {
  return {
    id: row.id,
    orgId: row.orgId,
    projectId: row.projectId,
    requestId: row.requestId,
    attemptId: row.attemptId,
    logicalPath: row.logicalPath,
    objectKey: row.objectKey,
    declaredSize: row.declaredSize,
    declaredSha256: row.declaredSha256,
    contentType: row.contentType,
    expiresAt: row.expiresAt.toISOString(),
    maxUploadMs: row.maxUploadMs,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createDrizzleUploadGrantStore(tx: DbTx): UploadGrantStore {
  const G = verificationUploadGrants;
  const E = verificationUploadGrantEvents;
  const store: UploadGrantStore = {
    async findGrantByDedup(orgId, projectId, requestId, attemptId, logicalPath): Promise<UploadGrant | null> {
      const row = (
        await tx
          .select()
          .from(G)
          .where(
            and(
              eq(G.orgId, orgId),
              eq(G.projectId, projectId),
              eq(G.requestId, requestId),
              eq(G.attemptId, attemptId),
              eq(G.logicalPath, logicalPath),
            ),
          )
          .limit(1)
      )[0];
      return row ? rowToGrant(row) : null;
    },

    async getGrantById(orgId, projectId, grantId): Promise<UploadGrant | null> {
      const row = (
        await tx
          .select()
          .from(G)
          .where(and(eq(G.orgId, orgId), eq(G.projectId, projectId), eq(G.id, grantId)))
          .limit(1)
      )[0];
      return row ? rowToGrant(row) : null;
    },

    async insertGrant(orgId, projectId, createdBy, input: NewUploadGrant): Promise<{ grant: UploadGrant; inserted: boolean }> {
      const inserted = await tx
        .insert(G)
        .values({
          orgId,
          projectId,
          requestId: input.requestId,
          attemptId: input.attemptId,
          logicalPath: input.logicalPath,
          objectKey: input.objectKey,
          declaredSize: input.declaredSize,
          declaredSha256: input.declaredSha256,
          contentType: input.contentType,
          expiresAt: input.expiresAt,
          maxUploadMs: input.maxUploadMs,
          createdBy,
        })
        // Race-safe on the dedup unique (org, project, request, attempt, logical_path).
        .onConflictDoNothing({ target: [G.orgId, G.projectId, G.requestId, G.attemptId, G.logicalPath] })
        .returning();
      if (inserted[0]) return { grant: rowToGrant(inserted[0]), inserted: true };
      const winner = await this.findGrantByDedup(orgId, projectId, input.requestId, input.attemptId, input.logicalPath);
      if (!winner) throw new Error('upload grant insert was a no-op but no existing row was found');
      return { grant: winner, inserted: false };
    },

    async isUploaded(orgId, projectId, grantId): Promise<boolean> {
      const row = (
        await tx
          .select({ id: E.id })
          .from(E)
          .where(and(eq(E.orgId, orgId), eq(E.projectId, projectId), eq(E.grantId, grantId), eq(E.eventType, 'uploaded')))
          .limit(1)
      )[0];
      return Boolean(row);
    },

    async appendEvent(orgId, projectId, grantId, eventType: UploadGrantEventType, detail): Promise<void> {
      await tx
        .insert(E)
        .values({ orgId, projectId, grantId, eventType, detail })
        // The 'uploaded' completion is idempotent via the partial unique index; a duplicate is a no-op.
        .onConflictDoNothing();
    },

    async findUploadedGrantForArtifact(orgId, projectId, requestId, attemptId, logicalPath): Promise<UploadGrant | null> {
      const row = (
        await tx
          .select()
          .from(G)
          .where(
            and(
              eq(G.orgId, orgId),
              eq(G.projectId, projectId),
              eq(G.requestId, requestId),
              eq(G.attemptId, attemptId),
              eq(G.logicalPath, logicalPath),
              sql`exists (select 1 from ${E} ev where ev.grant_id = ${G.id} and ev.event_type = 'uploaded')`,
            ),
          )
          .limit(1)
      )[0];
      return row ? rowToGrant(row) : null;
    },
  };
  return store;
}
