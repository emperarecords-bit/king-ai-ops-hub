/**
 * Drizzle-backed VerificationStore (VER-002). Bound to a single tenant tx so the
 * whole ingest (getRequest → idempotency → saveEvidence) is atomic. RLS enforces
 * isolation; every query also filters org+project explicitly (defense in depth).
 * Kept out of the module index so the pure logic stays DB-free for tests.
 */
import { and, eq } from 'drizzle-orm';
import type { DbTx } from '@/db/client';
import { verificationEvidence, verificationRequests } from '@/db/schema';
import type {
  ArtifactAvailability,
  CheckResult,
  IngestDecision,
  RejectionCode,
  SubmittedArtifact,
  VerificationRequest,
} from './index';
import type { VerificationStore } from './ports';
import type { TaskVerificationStatus } from './types';

type EvidenceRow = typeof verificationEvidence.$inferSelect;

function rowToDecision(row: EvidenceRow): IngestDecision {
  return {
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
        allowDirty: row.allowDirty,
        createdBy: row.createdBy ?? '',
        createdAt: row.createdAt.toISOString(),
      };
    },

    async findDecisionByIdempotencyKey(orgId, projectId, key): Promise<IngestDecision | null> {
      const row = (
        await tx
          .select()
          .from(verificationEvidence)
          .where(
            and(
              eq(verificationEvidence.orgId, orgId),
              eq(verificationEvidence.projectId, projectId),
              eq(verificationEvidence.idempotencyKey, key),
            ),
          )
          .limit(1)
      )[0];
      return row ? rowToDecision(row) : null;
    },

    async saveEvidence(orgId, projectId, submission, decision): Promise<IngestDecision> {
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
          accepted: decision.accepted,
          rejectionCode: (decision.rejection?.code ?? null) as RejectionCode | null,
          status: decision.status,
          deliverable: decision.deliverable,
          reasons: [...decision.reasons] as string[],
          decidedAt: new Date(decision.decidedAt),
        })
        // Idempotent persistence: a duplicate key is a no-op; the first decision stands.
        .onConflictDoNothing({
          target: [verificationEvidence.orgId, verificationEvidence.projectId, verificationEvidence.idempotencyKey],
        });

      const stored = await this.findDecisionByIdempotencyKey(orgId, projectId, submission.idempotencyKey);
      return stored ?? decision;
    },
  };
}
