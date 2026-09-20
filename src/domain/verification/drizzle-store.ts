/**
 * Drizzle-backed VerificationStore (VER-002). Bound to a single tenant tx so the
 * whole ingest (getRequest → idempotency → saveEvidence) is atomic. RLS enforces
 * isolation; every query also filters org+project explicitly (defense in depth).
 * Kept out of the module index so the pure logic stays DB-free for tests.
 */
import { and, eq } from 'drizzle-orm';
import type { DbTx } from '@/db/client';
import { verificationEvidence, verificationRequests } from '@/db/schema';
import type { ArtifactAvailability, CheckResult, RejectionCode, SubmittedArtifact, VerificationRequest } from './index';
import type { PriorEvidence, VerificationStore } from './ports';
import type { TaskVerificationStatus } from './types';

type EvidenceRow = typeof verificationEvidence.$inferSelect;

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
      if (!row) return null;
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
        createdBy: row.createdBy ?? '',
        createdAt: row.createdAt.toISOString(),
      };
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
  };
}
