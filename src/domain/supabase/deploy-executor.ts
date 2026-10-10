import { z } from 'zod';
import { sha256Hex } from '@/lib/crypto';
import { canonicalJson } from '@/orchestration/actions';
import { type GitHubRepoClient, type RepoRef } from '@/domain/github/client';
import {
  type SupabaseDeployClient,
  type SupabaseEdgeFunctionFile,
  type SupabaseProjectRef,
} from './client';
import { SupabaseApiError } from './live-client';
import {
  type Executor,
  type ExecutorAction,
  type ExecutorCapability,
  type ExecutorProvenance,
  type ExecutorResult,
} from '@/domain/execution/executor-contract';

export const SUPABASE_DEPLOY_EXECUTOR_ID = 'supabase_deploy';
export const SUPABASE_DEPLOY_EXECUTOR_VERSION = '1';

/**
 * Deploy bounds. The source is read from a linked repo at an immutable SHA; these caps keep a single edge-function
 * bundle sane and make a pathological or wrong `sourcePath` a `blocked` refusal, never a multi-megabyte deploy.
 */
export const SUPABASE_DEPLOY_LIMITS = Object.freeze({
  maxFiles: 50,
  maxFileBytes: 500_000,
  maxTotalBytes: 2_000_000,
});

/** A Supabase project ref — lowercase alphanumeric (the linked-project identifier). */
const projectRefSchema = z.string().regex(/^[a-z0-9]{16,40}$/);
/** Canonical `owner/repo`; must be a repository linked to this workspace. */
const repoSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/);
/** A FULL 40-hex commit SHA — "exact source SHA" means immutable: no branch, no abbreviation. */
const fullShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
/** Supabase edge-function slug rules (lowercase, digits, _ and -, not leading/trailing separators). */
const slugSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9_-]{0,58}[a-z0-9])?$/);
/** A bundle-relative path — no absolute, no traversal, no backslashes. */
const bundleRelPathSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(?!\/)(?!.*\.\.)(?!.*\\)[A-Za-z0-9._\-/]+$/);

/**
 * `deploy_edge_function` — deploy ONE edge function to a LINKED Supabase project from the EXACT bytes of a LINKED
 * GitHub repo at an immutable commit SHA. Operation-discriminated so later write variants extend the union without
 * reshaping the executor (mirrors the git_pr payload). Anything the model emits is hostile until it survives this
 * parse — extra keys and wrong shapes are refusals, never best-effort repairs.
 */
export const deployEdgeFunctionPayloadSchema = z
  .object({
    operation: z.literal('deploy_edge_function'),
    /** Target Supabase project (must be linked to this workspace). */
    projectRef: projectRefSchema,
    /** The edge function slug to deploy. */
    functionSlug: slugSchema,
    /** Source GitHub repo (must be linked to this workspace). */
    sourceRepo: repoSchema,
    /** Immutable commit SHA the bytes are read from. */
    sourceSha: fullShaSchema,
    /** Repo-relative directory holding the function bundle (e.g. "supabase/functions/approve-quote"). */
    sourcePath: z
      .string()
      .min(1)
      .max(300)
      .regex(/^(?!\/)(?!.*\.\.)(?!.*\\)[A-Za-z0-9._\-/]+$/),
    /** Bundle-relative entrypoint; must be present in the read file set. */
    entrypointPath: bundleRelPathSchema.default('index.ts'),
    /** Bundle-relative import map; optional, but must be present when set. */
    importMapPath: bundleRelPathSchema.optional(),
    /** Explicit — a deploy that forgets this would silently flip JWT verification. */
    verifyJwt: z.boolean(),
  })
  .strict();

export const supabaseDeployPayloadSchema = z.discriminatedUnion('operation', [deployEdgeFunctionPayloadSchema]);
export type SupabaseDeployPayload = z.infer<typeof supabaseDeployPayloadSchema>;
export type DeployEdgeFunctionPayload = z.infer<typeof deployEdgeFunctionPayloadSchema>;

/** The linked-repo shape the trusted dispatcher loads (same as git_pr's). */
export interface SupabaseDeployRepoLink {
  readonly installationId: bigint;
  readonly repoFullName: string;
  readonly defaultBranch: string;
}

export interface SupabaseDeployExecutorDeps {
  /** Read-only GitHub client — used to read the function source at the exact SHA. */
  readonly github: GitHubRepoClient;
  /** Supabase WRITE client — the single mutating surface. */
  readonly supabase: SupabaseDeployClient;
  /** The workspace's linked GitHub repos (loaded by the trusted dispatcher). */
  readonly loadRepoLinks: () => Promise<readonly SupabaseDeployRepoLink[]>;
  /** The workspace's linked Supabase projects (loaded by the trusted dispatcher). */
  readonly loadProjectLinks: () => Promise<readonly { readonly projectRef: string }[]>;
  readonly now?: () => Date;
}

const CAPABILITY: ExecutorCapability = Object.freeze({
  executorId: SUPABASE_DEPLOY_EXECUTOR_ID,
  contractVersion: '1',
  actionTypes: ['supabase_deploy'] as const,
  riskClasses: ['external_reversible'] as const,
  supportedModes: ['dry_run', 'live'] as const,
  enabledByDefault: false,
  externalSideEffects: true,
});

/** Deterministic digest binding exactly what gets deployed (sorted paths + per-file content hash + metadata). */
export function supabaseDeployContentDigest(
  payload: DeployEdgeFunctionPayload,
  files: ReadonlyArray<SupabaseEdgeFunctionFile>,
): string {
  const fileDigests = files
    .map((f) => ({ path: f.path, sha256: sha256Hex(f.content) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256Hex(
    canonicalJson({
      sourceRepo: payload.sourceRepo,
      sourceSha: payload.sourceSha,
      functionSlug: payload.functionSlug,
      entrypointPath: payload.entrypointPath,
      importMapPath: payload.importMapPath ?? null,
      verifyJwt: payload.verifyJwt,
      files: fileDigests,
    }),
  );
}

/**
 * The Supabase edge-function deploy executor (Phase 2C write slice). An approved `supabase_deploy` action deploys
 * ONE edge function to a LINKED project from the EXACT bytes of a LINKED repo at an immutable commit SHA. Reversible
 * by construction — Supabase keeps prior function versions, so redeploying the previous source SHA rolls it back;
 * hence external_reversible, never destructive_irreversible. Every pre-deploy check that can fail definitely and
 * before any side effect is `blocked` (not linked, no files, oversize, missing entrypoint) or a retryable `failed`
 * (could not read the source). The deploy call itself fails closed: a 4xx is a definite non-deploy (`failed`); a
 * 5xx/timeout is `ambiguous` with reconciliation required and is NEVER auto-retried. It never reads or returns a
 * secret — the Management token lives only in the client layer.
 */
export class SupabaseDeployExecutor implements Executor {
  readonly capability = CAPABILITY;

  constructor(private readonly deps: SupabaseDeployExecutorDeps) {}

  async execute(action: ExecutorAction): Promise<ExecutorResult> {
    const attemptedAt = (this.deps.now?.() ?? new Date()).toISOString();
    const result = (
      outcome: ExecutorResult['outcome'],
      message: string,
      preview: Record<string, unknown> | null,
      opts: { reconciliation?: ExecutorResult['reconciliation']; retryAllowed?: boolean } = {},
    ): ExecutorResult =>
      Object.freeze({
        outcome,
        reconciliation: opts.reconciliation ?? 'not_required',
        retryAllowed: opts.retryAllowed ?? false,
        message,
        preview: preview ? Object.freeze(preview) : null,
        provenance: this.provenance(action, attemptedAt),
      });

    if (action.actionType !== 'supabase_deploy') {
      return result('blocked', 'SupabaseDeployExecutor only executes supabase_deploy actions.', null);
    }
    // Defense in depth: the dispatcher already verified this, but the executor never trusts its caller.
    if (sha256Hex(canonicalJson(action.payload)) !== action.payloadSha256) {
      return result('blocked', 'Payload integrity re-verification failed at the executor.', null);
    }
    const parsed = supabaseDeployPayloadSchema.safeParse(action.payload);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      return result('blocked', `supabase_deploy payload is not executable: ${issues}`, null);
    }
    const payload = parsed.data;

    // The target project must be LINKED to this workspace (tenant boundary; the ref never escapes the link set).
    const projectLinks = await this.deps.loadProjectLinks();
    if (!projectLinks.some((l) => l.projectRef === payload.projectRef)) {
      return result('blocked', `Supabase project "${payload.projectRef}" is not linked to this workspace.`, null);
    }
    // The source repo must ALSO be linked (confines the deploy source to governed repositories).
    const repoLinks = await this.deps.loadRepoLinks();
    const repoLink = repoLinks.find((l) => l.repoFullName === payload.sourceRepo);
    if (!repoLink) {
      return result('blocked', `Source repository "${payload.sourceRepo}" is not linked to this workspace.`, null);
    }

    const sourcePath = payload.sourcePath.replace(/\/+$/, '');
    const prefix = `${sourcePath}/`;
    const target = {
      operation: 'deploy_edge_function',
      projectRef: payload.projectRef,
      functionSlug: payload.functionSlug,
      sourceRepo: payload.sourceRepo,
      sourceSha: payload.sourceSha,
      sourcePath,
      entrypointPath: payload.entrypointPath,
      importMapPath: payload.importMapPath ?? null,
      verifyJwt: payload.verifyJwt,
    };
    const repo: RepoRef = { installationId: repoLink.installationId, repoFullName: repoLink.repoFullName };

    // Read the repo tree at the EXACT SHA (read-only). This both verifies the commit exists and enumerates the
    // function's files. A read failure means no side effect occurred → retryable `failed`, never a blind deploy.
    let tree;
    try {
      tree = await this.deps.github.listTree(repo, payload.sourceSha);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      return result('failed', `No side effect occurred: could not read ${payload.sourceRepo}@${payload.sourceSha.slice(0, 7)}: ${detail}`, target, { retryAllowed: true });
    }
    const blobPaths = tree
      .filter((e) => e.type === 'blob' && (e.path === sourcePath || e.path.startsWith(prefix)))
      .map((e) => e.path);
    if (blobPaths.length === 0) {
      return result('blocked', `No files found under "${sourcePath}" in ${payload.sourceRepo}@${payload.sourceSha.slice(0, 7)} — nothing to deploy.`, target);
    }
    if (blobPaths.length > SUPABASE_DEPLOY_LIMITS.maxFiles) {
      return result('blocked', `"${sourcePath}" holds ${blobPaths.length} files (max ${SUPABASE_DEPLOY_LIMITS.maxFiles}) — refusing an oversized bundle; narrow the source path.`, target);
    }

    // Read each file's bytes at the SHA (read-only), mapping to bundle-relative paths. Any read failure is a
    // retryable failure with no side effect.
    const files: SupabaseEdgeFunctionFile[] = [];
    let totalBytes = 0;
    for (const path of blobPaths) {
      let content: string;
      try {
        content = await this.deps.github.readBlob(repo, payload.sourceSha, path);
      } catch (err) {
        const detail = err instanceof Error ? err.message : 'unknown error';
        return result('failed', `No side effect occurred: could not read "${path}" at ${payload.sourceSha.slice(0, 7)}: ${detail}`, target, { retryAllowed: true });
      }
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > SUPABASE_DEPLOY_LIMITS.maxFileBytes) {
        return result('blocked', `Source file "${path}" is ${bytes} bytes (max ${SUPABASE_DEPLOY_LIMITS.maxFileBytes}) — refusing to deploy.`, target);
      }
      totalBytes += bytes;
      if (totalBytes > SUPABASE_DEPLOY_LIMITS.maxTotalBytes) {
        return result('blocked', `The function bundle exceeds ${SUPABASE_DEPLOY_LIMITS.maxTotalBytes} bytes total — refusing to deploy.`, target);
      }
      const bundleRel = path === sourcePath ? path.split('/').pop()! : path.slice(prefix.length);
      files.push({ path: bundleRel, content });
    }

    // The declared entrypoint and import map must actually be in the read set — a deploy that points at a missing
    // entrypoint is a definite misconfiguration, blocked before any side effect.
    if (!files.some((f) => f.path === payload.entrypointPath)) {
      return result('blocked', `Entrypoint "${payload.entrypointPath}" is not among the ${files.length} files under "${sourcePath}".`, target);
    }
    if (payload.importMapPath && !files.some((f) => f.path === payload.importMapPath)) {
      return result('blocked', `Import map "${payload.importMapPath}" is not among the files under "${sourcePath}".`, target);
    }

    const contentDigest = supabaseDeployContentDigest(payload, files);
    const plan = {
      ...target,
      fileCount: files.length,
      totalBytes,
      paths: files.map((f) => f.path),
      contentDigest,
    };

    if (action.mode === 'dry_run') {
      return result('not_executed', `Dry run only. Would deploy "${payload.functionSlug}" to project ${payload.projectRef} from ${payload.sourceRepo}@${payload.sourceSha.slice(0, 7)} (${files.length} files, verify_jwt=${payload.verifyJwt}).`, { ...plan, wouldExecute: true });
    }

    const ref: SupabaseProjectRef = { projectRef: payload.projectRef };
    let deployed: { slug: string; version: number | null };
    try {
      deployed = await this.deps.supabase.deployEdgeFunction(ref, {
        slug: payload.functionSlug,
        entrypointPath: payload.entrypointPath,
        importMapPath: payload.importMapPath ?? null,
        verifyJwt: payload.verifyJwt,
        files,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      // 4xx = definite non-deploy (bad request / not found / forbidden): no retry here, no reconciliation.
      if (err instanceof SupabaseApiError && err.status >= 400 && err.status < 500) {
        return result('failed', `Supabase rejected the deploy before applying it (HTTP ${err.status}): ${detail}.`, plan, { retryAllowed: false });
      }
      // 5xx / timeout / transport: the deploy MAY have landed — ambiguous, reconcile before any retry.
      return result('ambiguous', `Deploy outcome is unknown after a transport/server error — "${payload.functionSlug}" may or may not have deployed: ${detail}. Reconcile (inspect the function version) before any retry.`, plan, { reconciliation: 'required', retryAllowed: false });
    }

    // Best-effort post-verify: re-read the function (failure to RE-READ does not un-deploy a confirmed deploy).
    let verifiedVersion: number | null = deployed.version;
    try {
      const after = await this.deps.supabase.getEdgeFunction(ref, payload.functionSlug);
      if (after && after.version !== null) verifiedVersion = after.version;
    } catch {
      /* verification is best effort */
    }
    return result('succeeded', `Deployed edge function "${payload.functionSlug}" to project ${payload.projectRef}${verifiedVersion !== null ? ` (version ${verifiedVersion})` : ''} from ${payload.sourceRepo}@${payload.sourceSha.slice(0, 7)}.`, {
      ...plan,
      deployed: true,
      version: verifiedVersion,
    });
  }

  private provenance(action: ExecutorAction, attemptedAt: string): Readonly<ExecutorProvenance> {
    return Object.freeze({
      contractVersion: '1' as const,
      executorId: this.capability.executorId,
      executorVersion: SUPABASE_DEPLOY_EXECUTOR_VERSION,
      actionType: action.actionType,
      riskClass: action.riskClass,
      actorId: action.authorization.actorId,
      orgId: action.orgId,
      projectId: action.projectId,
      approvalId: action.approvalId,
      taskId: action.taskId,
      runId: action.runId,
      correlationId: action.correlationId,
      idempotencyKey: action.idempotencyKey,
      payloadSha256: action.payloadSha256,
      mode: action.mode,
      attemptedAt,
      completedAt: (this.deps.now?.() ?? new Date()).toISOString(),
    });
  }
}
