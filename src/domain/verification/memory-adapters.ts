/**
 * In-memory port adapters (VER-002) for unit tests and the acceptance demo.
 * They exercise the exact orchestrator logic used in production, without a DB or
 * object store. The Drizzle + object-store adapters implement the same ports.
 */
import { randomUUID } from 'node:crypto';
import type { CatalogResolver, ResolvedCatalog } from './catalog';
import type { EvidenceSubmission, IngestDecision, NewVerificationRequest, VerificationRequest } from './ingest-types';
import type {
  ContractListOptions,
  ContractSummary,
  ExclusiveArtifactWriter,
  NewUploadGrant,
  PriorEvidence,
  RunnerSecretSource,
  StageOptions,
  StagedArtifact,
  StoredArtifactStore,
  UploadGrant,
  UploadGrantEventType,
  UploadGrantStore,
  VerificationStore,
} from './ports';

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

  /** Atomic create-only: create the object, or report it already exists (never overwrite). */
  createOnly(storageKey: string, bytes: Buffer): 'created' | 'exists' {
    if (this.objects.has(storageKey)) return 'exists';
    this.objects.set(storageKey, { bytes, expired: false });
    return 'created';
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

// ─────────────────────────── VER-002 PR-4 — upload grants (in-memory) ───────────────────────────

interface GrantEvent {
  readonly type: UploadGrantEventType;
  readonly detail: string | null;
}

export class InMemoryUploadGrantStore implements UploadGrantStore {
  private readonly grants = new Map<string, UploadGrant>(); // by grantId
  private readonly byDedup = new Map<string, string>(); // dedup key → grantId
  private readonly events = new Map<string, GrantEvent[]>(); // grantId → events

  private dedupKey(orgId: string, projectId: string, requestId: string, attemptId: string, logicalPath: string): string {
    return scope(orgId, projectId, requestId, attemptId, logicalPath);
  }

  async findGrantByDedup(orgId: string, projectId: string, requestId: string, attemptId: string, logicalPath: string): Promise<UploadGrant | null> {
    const id = this.byDedup.get(this.dedupKey(orgId, projectId, requestId, attemptId, logicalPath));
    return id ? (this.grants.get(id) ?? null) : null;
  }

  async getGrantById(orgId: string, projectId: string, grantId: string): Promise<UploadGrant | null> {
    const g = this.grants.get(grantId);
    return g && g.orgId === orgId && g.projectId === projectId ? g : null;
  }

  async insertGrant(orgId: string, projectId: string, _createdBy: string | null, input: NewUploadGrant): Promise<{ grant: UploadGrant; inserted: boolean }> {
    const dk = this.dedupKey(orgId, projectId, input.requestId, input.attemptId, input.logicalPath);
    const existingId = this.byDedup.get(dk);
    if (existingId) return { grant: this.grants.get(existingId)!, inserted: false };
    const grant: UploadGrant = {
      id: randomUUID(),
      orgId,
      projectId,
      requestId: input.requestId,
      attemptId: input.attemptId,
      logicalPath: input.logicalPath,
      objectKey: input.objectKey,
      declaredSize: input.declaredSize,
      declaredSha256: input.declaredSha256,
      contentType: input.contentType,
      expiresAt: input.expiresAt.toISOString(),
      maxUploadMs: input.maxUploadMs,
      createdAt: new Date().toISOString(),
    };
    this.grants.set(grant.id, grant);
    this.byDedup.set(dk, grant.id);
    this.events.set(grant.id, []);
    return { grant, inserted: true };
  }

  async isUploaded(_orgId: string, _projectId: string, grantId: string): Promise<boolean> {
    return (this.events.get(grantId) ?? []).some((e) => e.type === 'uploaded');
  }

  async appendEvent(_orgId: string, _projectId: string, grantId: string, eventType: UploadGrantEventType, detail: string | null): Promise<void> {
    const list = this.events.get(grantId) ?? [];
    // 'uploaded' is idempotent: at most one completion event (mirrors the DB partial unique index).
    if (eventType === 'uploaded' && list.some((e) => e.type === 'uploaded')) return;
    list.push({ type: eventType, detail });
    this.events.set(grantId, list);
  }

  async findUploadedGrantForArtifact(orgId: string, projectId: string, requestId: string, attemptId: string, logicalPath: string): Promise<UploadGrant | null> {
    const g = await this.findGrantByDedup(orgId, projectId, requestId, attemptId, logicalPath);
    if (!g) return null;
    return (await this.isUploaded(orgId, projectId, g.id)) ? g : null;
  }

  /** Test helper: seed an already-`uploaded` grant binding an artifact to (contract, attempt, path). */
  seedUploaded(
    orgId: string,
    projectId: string,
    requestId: string,
    attemptId: string,
    a: { path: string; storageKey: string; sizeBytes: number; sha256: string },
  ): void {
    const dk = this.dedupKey(orgId, projectId, requestId, attemptId, a.path);
    if (this.byDedup.has(dk)) return; // idempotent (a submission may be signed more than once in a test)
    const grant: UploadGrant = {
      id: randomUUID(),
      orgId,
      projectId,
      requestId,
      attemptId,
      logicalPath: a.path,
      objectKey: a.storageKey,
      declaredSize: a.sizeBytes,
      declaredSha256: a.sha256,
      contentType: 'application/octet-stream',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxUploadMs: 60_000,
      createdAt: new Date().toISOString(),
    };
    this.grants.set(grant.id, grant);
    this.byDedup.set(dk, grant.id);
    this.events.set(grant.id, [{ type: 'uploaded', detail: null }]);
  }
}

/**
 * In-memory create-only writer backed by an InMemoryArtifactStore, so unit tests exercise the same
 * redeem orchestrator (stage → append → publish → discard) used in production, including the create-only
 * `exists` reconciliation path. Optional hooks let a test interrupt a stream between chunks.
 */
export class InMemoryExclusiveArtifactWriter implements ExclusiveArtifactWriter {
  constructor(
    private readonly artifacts: InMemoryArtifactStore,
    private readonly hooks: { onAppend?: (bytesSoFar: number) => void | Promise<void> } = {},
  ) {}

  async stage(finalKey: string, _opts?: StageOptions): Promise<StagedArtifact> {
    const chunks: Buffer[] = [];
    let published = false;
    let discarded = false;
    const artifacts = this.artifacts;
    const hooks = this.hooks;
    return {
      async append(chunk: Buffer): Promise<void> {
        if (discarded) throw new Error('append after discard');
        chunks.push(Buffer.from(chunk));
        if (hooks.onAppend) await hooks.onAppend(chunks.reduce((n, c) => n + c.length, 0));
      },
      async publish(): Promise<'created' | 'exists'> {
        published = true;
        return artifacts.createOnly(finalKey, Buffer.concat(chunks));
      },
      async discard(): Promise<void> {
        discarded = true;
        chunks.length = 0;
        void published;
      },
    };
  }
}
