/**
 * In-memory port adapters (VER-002) for unit tests and the acceptance demo.
 * They exercise the exact orchestrator logic used in production, without a DB or
 * object store. The Drizzle + object-store adapters implement the same ports.
 */
import { randomUUID } from 'node:crypto';
import type { CatalogResolver, ResolvedCatalog } from './catalog';
import type { EvidenceSubmission, IngestDecision, NewVerificationRequest, VerificationRequest } from './ingest-types';
import type { ContractListOptions, ContractSummary, PriorEvidence, RunnerSecretSource, StoredArtifactStore, VerificationStore } from './ports';

const scope = (orgId: string, projectId: string, ...parts: string[]) => [orgId, projectId, ...parts].join('|');

export class InMemoryVerificationStore implements VerificationStore {
  private readonly requests = new Map<string, VerificationRequest>();
  private readonly tasks = new Set<string>();
  private readonly repos = new Map<string, Set<string>>();
  // Keyed by (org, project, requestId, idempotencyKey) — idempotency is bound to the request.
  private readonly records = new Map<string, PriorEvidence>();
  readonly evidence: { submission: EvidenceSubmission; decision: IngestDecision }[] = [];
  // Parallel metadata for policy-neutral evidence counts (tenant + requestId + accepted/verified).
  private readonly evidenceMeta: { orgId: string; projectId: string; requestId: string; accepted: boolean; verified: boolean }[] = [];

  addRequest(req: VerificationRequest): void {
    this.requests.set(scope(req.orgId, req.projectId, req.id), req);
  }

  /** Test helper: declare a task as existing in a tenant. */
  addTask(orgId: string, projectId: string, taskId: string): void {
    this.tasks.add(scope(orgId, projectId, taskId));
  }

  /** Test helper: declare a repository as linked (authorized) for a project. */
  addRepo(orgId: string, projectId: string, repoFullName: string): void {
    const key = scope(orgId, projectId);
    const set = this.repos.get(key) ?? new Set<string>();
    set.add(repoFullName);
    this.repos.set(key, set);
  }

  async linkedRepoFullNames(orgId: string, projectId: string): Promise<string[]> {
    return [...(this.repos.get(scope(orgId, projectId)) ?? [])];
  }

  async getRequest(orgId: string, projectId: string, requestId: string): Promise<VerificationRequest | null> {
    return this.requests.get(scope(orgId, projectId, requestId)) ?? null;
  }

  async taskExistsInTenant(orgId: string, projectId: string, taskId: string): Promise<boolean> {
    return this.tasks.has(scope(orgId, projectId, taskId));
  }

  async findRequestByTaskCommit(orgId: string, projectId: string, taskId: string, commitSha: string): Promise<VerificationRequest | null> {
    for (const r of this.requests.values()) {
      if (r.orgId === orgId && r.projectId === projectId && r.taskId === taskId && r.expectedCommitSha === commitSha) return r;
    }
    return null;
  }

  async createRequest(
    orgId: string,
    projectId: string,
    createdBy: string,
    input: NewVerificationRequest,
  ): Promise<{ request: VerificationRequest; inserted: boolean }> {
    const existing = await this.findRequestByTaskCommit(orgId, projectId, input.taskId, input.commitSha);
    if (existing) return { request: existing, inserted: false };
    const request: VerificationRequest = {
      id: randomUUID(),
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
      createdAt: new Date().toISOString(),
    };
    this.requests.set(scope(orgId, projectId, request.id), request);
    return { request, inserted: true };
  }

  private summary(orgId: string, projectId: string, request: VerificationRequest): ContractSummary {
    let acceptedEvidenceCount = 0;
    let hasVerifiedComplete = false;
    for (const m of this.evidenceMeta) {
      if (m.orgId === orgId && m.projectId === projectId && m.requestId === request.id && m.accepted) {
        acceptedEvidenceCount += 1;
        if (m.verified) hasVerifiedComplete = true;
      }
    }
    return { request, acceptedEvidenceCount, hasVerifiedComplete };
  }

  async listRequests(orgId: string, projectId: string, opts: ContractListOptions): Promise<ContractSummary[]> {
    const all = [...this.requests.values()]
      .filter((r) => r.orgId === orgId && r.projectId === projectId)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); // deterministic keyset order by id
    const out: ContractSummary[] = [];
    for (const r of all) {
      if (opts.afterId && r.id <= opts.afterId) continue;
      const s = this.summary(orgId, projectId, r);
      if (opts.openOnly && s.acceptedEvidenceCount > 0) continue;
      out.push(s);
      if (out.length >= opts.limit) break;
    }
    return out;
  }

  async getRequestSummary(orgId: string, projectId: string, requestId: string): Promise<ContractSummary | null> {
    const r = this.requests.get(scope(orgId, projectId, requestId));
    return r ? this.summary(orgId, projectId, r) : null;
  }

  async findExisting(orgId: string, projectId: string, requestId: string, key: string): Promise<PriorEvidence | null> {
    return this.records.get(scope(orgId, projectId, requestId, key)) ?? null;
  }

  async saveEvidence(
    orgId: string,
    projectId: string,
    submission: EvidenceSubmission,
    submissionSha256: string,
    decision: IngestDecision,
  ): Promise<PriorEvidence> {
    const k = scope(orgId, projectId, submission.requestId, submission.idempotencyKey);
    // Idempotent: the first record for a key wins and never changes (mirrors the
    // DB unique constraint + onConflictDoNothing).
    const existing = this.records.get(k);
    if (existing) return existing;
    const record: PriorEvidence = { decision, submissionSha256 };
    this.records.set(k, record);
    this.evidence.push({ submission, decision });
    this.evidenceMeta.push({
      orgId,
      projectId,
      requestId: submission.requestId,
      accepted: decision.accepted,
      verified: decision.status === 'verified_complete',
    });
    return record;
  }
}

/**
 * In-memory catalog resolver for tests: register versions and set the current one (per project or a
 * default). Mirrors the trusted file resolver's contract without touching the filesystem.
 */
export class InMemoryCatalogResolver implements CatalogResolver {
  private readonly versions = new Map<string, ResolvedCatalog>();
  private defaultVersion: string | null = null;
  private readonly perProject = new Map<string, string>();

  addVersion(cat: ResolvedCatalog): void {
    this.versions.set(cat.version, cat);
  }
  setDefault(version: string): void {
    this.defaultVersion = version;
  }
  setForProject(projectId: string, version: string): void {
    this.perProject.set(projectId, version);
  }
  current(projectId: string): ResolvedCatalog | null {
    const v = this.perProject.get(projectId) ?? this.defaultVersion;
    return v ? this.versions.get(v) ?? null : null;
  }
  byVersion(version: string): ResolvedCatalog | null {
    return this.versions.get(version) ?? null;
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
