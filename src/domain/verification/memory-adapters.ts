/**
 * In-memory port adapters (VER-002) for unit tests and the acceptance demo.
 * They exercise the exact orchestrator logic used in production, without a DB or
 * object store. The Drizzle + object-store adapters implement the same ports.
 */
import type { EvidenceSubmission, IngestDecision, VerificationRequest } from './ingest-types';
import type { RunnerSecretSource, StoredArtifactStore, VerificationStore } from './ports';

const scope = (orgId: string, projectId: string, key: string) => `${orgId}|${projectId}|${key}`;

export class InMemoryVerificationStore implements VerificationStore {
  private readonly requests = new Map<string, VerificationRequest>();
  private readonly decisions = new Map<string, IngestDecision>();
  readonly evidence: { submission: EvidenceSubmission; decision: IngestDecision }[] = [];

  addRequest(req: VerificationRequest): void {
    this.requests.set(scope(req.orgId, req.projectId, req.id), req);
  }

  async getRequest(orgId: string, projectId: string, requestId: string): Promise<VerificationRequest | null> {
    return this.requests.get(scope(orgId, projectId, requestId)) ?? null;
  }

  async findDecisionByIdempotencyKey(orgId: string, projectId: string, key: string): Promise<IngestDecision | null> {
    return this.decisions.get(scope(orgId, projectId, key)) ?? null;
  }

  async saveEvidence(
    orgId: string,
    projectId: string,
    submission: EvidenceSubmission,
    decision: IngestDecision,
  ): Promise<IngestDecision> {
    const k = scope(orgId, projectId, submission.idempotencyKey);
    // Idempotent: the first decision for a key wins and never changes.
    const existing = this.decisions.get(k);
    if (existing) return existing;
    this.decisions.set(k, decision);
    this.evidence.push({ submission, decision });
    return decision;
  }
}

export class InMemoryArtifactStore implements StoredArtifactStore {
  private readonly objects = new Map<string, { bytes: Buffer; expired: boolean }>();

  put(storageKey: string, bytes: Buffer, expired = false): void {
    this.objects.set(storageKey, { bytes, expired });
  }

  /** Simulate tampering by replacing bytes under an existing key. */
  overwrite(storageKey: string, bytes: Buffer): void {
    const cur = this.objects.get(storageKey);
    this.objects.set(storageKey, { bytes, expired: cur?.expired ?? false });
  }

  async head(storageKey: string): Promise<{ sizeBytes: number; expired: boolean } | null> {
    const o = this.objects.get(storageKey);
    return o ? { sizeBytes: o.bytes.length, expired: o.expired } : null;
  }

  async get(storageKey: string): Promise<Buffer | null> {
    const o = this.objects.get(storageKey);
    return o && !o.expired ? o.bytes : null;
  }
}

export class StaticRunnerSecretSource implements RunnerSecretSource {
  constructor(private readonly secretsByProject: Map<string, string>) {}
  async getRunnerSecret(orgId: string, projectId: string): Promise<string | null> {
    return this.secretsByProject.get(`${orgId}|${projectId}`) ?? null;
  }
}
