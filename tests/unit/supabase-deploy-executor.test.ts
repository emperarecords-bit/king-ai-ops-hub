import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@/orchestration/actions';
import { sha256Hex } from '@/lib/crypto';
import { validateExecutorResult, type ExecutorAction } from '@/domain/execution/executor-contract';
import {
  SupabaseDeployExecutor,
  SUPABASE_DEPLOY_LIMITS,
  supabaseDeployContentDigest,
  deployEdgeFunctionPayloadSchema,
  type SupabaseDeployRepoLink,
} from '@/domain/supabase/deploy-executor';
import { type GitHubRepoClient, type RepoTreeEntry } from '@/domain/github/client';
import { type SupabaseDeployClient, type SupabaseEdgeFunctionDeploySpec } from '@/domain/supabase/client';
import { SupabaseApiError } from '@/domain/supabase/live-client';

/**
 * Phase 2C write slice — the supabase_deploy executor. It deploys ONE edge function to a LINKED project from the
 * EXACT bytes of a LINKED repo at an immutable SHA. Fully mocked (no network): we prove the tenant/link boundary,
 * the exact-SHA + source-read discipline, the pre-deploy refusals, and the failure/ambiguity contract.
 */

const REPO_LINK: SupabaseDeployRepoLink = { installationId: 1n, repoFullName: 'emperarecords-bit/accuratebids', defaultBranch: 'main' };
const PROJECT_REF = 'bblnywrcdsfdasytkzps';
const SHA = 'a'.repeat(40);
const SRC = 'supabase/functions/approve-quote';

function basePayload(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation: 'deploy_edge_function',
    projectRef: PROJECT_REF,
    functionSlug: 'approve-quote',
    sourceRepo: REPO_LINK.repoFullName,
    sourceSha: SHA,
    sourcePath: SRC,
    entrypointPath: 'index.ts',
    verifyJwt: false,
    ...o,
  };
}

function action(payload: Record<string, unknown>, mode: 'dry_run' | 'live' = 'live'): ExecutorAction {
  const payloadSha256 = sha256Hex(canonicalJson(payload));
  return {
    contractVersion: '1', actionType: 'supabase_deploy', payload, payloadSha256,
    riskClass: 'external_reversible', orgId: 'org', projectId: 'project', approvalId: 'approval', taskId: 'task',
    runId: null, correlationId: 'corr', idempotencyKey: '1234567890123456', mode,
    authorization: { actorId: 'actor', orgId: 'org', projectId: 'project', projectRole: 'admin', resolvedAt: '2026-10-10T12:00:00.000Z', source: 'trusted_server' },
    confirmation: { required: true, confirmedBy: 'actor', confirmedAt: '2026-10-10T11:59:00.000Z', expiresAt: '2026-10-10T12:05:00.000Z', payloadSha256 },
  };
}

interface BuildOpts {
  tree?: RepoTreeEntry[];
  blobs?: Record<string, string>;
  treeError?: unknown;
  blobError?: unknown;
  deployError?: unknown;
  deployResult?: { slug: string; version: number | null };
  afterVersion?: number | null;
  projectLinks?: readonly { projectRef: string }[];
  repoLinks?: readonly SupabaseDeployRepoLink[];
}

const DEFAULT_TREE: RepoTreeEntry[] = [
  { path: `${SRC}/index.ts`, type: 'blob', size: 40 },
  { path: `${SRC}/_shared/util.ts`, type: 'blob', size: 20 },
  { path: 'supabase/functions/other/index.ts', type: 'blob', size: 10 },
  { path: SRC, type: 'tree', size: null },
];

function build(opts: BuildOpts = {}) {
  const deployCalls: SupabaseEdgeFunctionDeploySpec[] = [];
  const blobs = opts.blobs ?? { [`${SRC}/index.ts`]: 'export default () => {}', [`${SRC}/_shared/util.ts`]: 'export const x = 1' };
  const github: GitHubRepoClient = {
    listTree: async () => { if (opts.treeError) throw opts.treeError; return opts.tree ?? DEFAULT_TREE; },
    readBlob: async (_r, _ref, path: string) => { if (opts.blobError) throw opts.blobError; return blobs[path] ?? ''; },
    listPullRequests: async () => [], getPullRequest: async () => ({}) as never, getRefChecks: async () => ({}) as never,
    createBranch: async () => {}, commitToBranch: async () => {}, openPullRequest: async () => ({ prNumber: 1 }),
    mergePullRequest: async () => ({ merged: true, mergeCommitSha: null }), getWorkflowRun: async () => ({}) as never,
    rerunFailedWorkflowJobs: async () => {},
  } as GitHubRepoClient;
  const supabase: SupabaseDeployClient = {
    deployEdgeFunction: async (_ref, spec) => { deployCalls.push(spec); if (opts.deployError) throw opts.deployError; return opts.deployResult ?? { slug: spec.slug, version: 5 }; },
    getEdgeFunction: async () => (opts.afterVersion === undefined ? { slug: 'approve-quote', name: 'approve-quote', status: 'ACTIVE', version: 6, verifyJwt: false, updatedAt: null } : opts.afterVersion === null ? null : { slug: 'approve-quote', name: 'approve-quote', status: 'ACTIVE', version: opts.afterVersion, verifyJwt: false, updatedAt: null }),
  };
  const executor = new SupabaseDeployExecutor({
    github,
    supabase,
    loadRepoLinks: async () => opts.repoLinks ?? [REPO_LINK],
    loadProjectLinks: async () => opts.projectLinks ?? [{ projectRef: PROJECT_REF }],
  });
  return { executor, deployCalls };
}

describe('supabase_deploy payload schema', () => {
  it('rejects a non-40-hex SHA (a branch or abbreviated SHA is not an exact source)', () => {
    expect(deployEdgeFunctionPayloadSchema.safeParse(basePayload({ sourceSha: 'main' })).success).toBe(false);
    expect(deployEdgeFunctionPayloadSchema.safeParse(basePayload({ sourceSha: 'a'.repeat(7) })).success).toBe(false);
    expect(deployEdgeFunctionPayloadSchema.safeParse(basePayload({ sourceSha: 'A'.repeat(40) })).success).toBe(false);
    expect(deployEdgeFunctionPayloadSchema.safeParse(basePayload()).success).toBe(true);
  });
  it('rejects a traversal source path and requires verifyJwt', () => {
    expect(deployEdgeFunctionPayloadSchema.safeParse(basePayload({ sourcePath: '../secrets' })).success).toBe(false);
    const { verifyJwt, ...noJwt } = basePayload() as Record<string, unknown>;
    void verifyJwt;
    expect(deployEdgeFunctionPayloadSchema.safeParse(noJwt).success).toBe(false);
  });
});

describe('SupabaseDeployExecutor — boundary refusals (no side effect)', () => {
  it('blocks when the target project is not linked to the workspace', async () => {
    const { executor, deployCalls } = build({ projectLinks: [] });
    const r = await executor.execute(action(basePayload()));
    expect(r.outcome).toBe('blocked');
    expect(r.message).toMatch(/not linked/i);
    expect(deployCalls).toHaveLength(0);
  });

  it('blocks when the source repo is not linked', async () => {
    const { executor, deployCalls } = build({ repoLinks: [] });
    const r = await executor.execute(action(basePayload()));
    expect(r.outcome).toBe('blocked');
    expect(r.message).toMatch(/not linked/i);
    expect(deployCalls).toHaveLength(0);
  });

  it('blocks a payload-hash mismatch before anything else', async () => {
    const { executor } = build();
    const act = action(basePayload());
    const tampered = { ...act, payload: { ...act.payload, functionSlug: 'evil' } };
    const r = await executor.execute(tampered);
    expect(r.outcome).toBe('blocked');
    expect(r.message).toMatch(/integrity/i);
  });

  it('blocks when the source path holds no files', async () => {
    const { executor, deployCalls } = build({ tree: [{ path: 'elsewhere/x.ts', type: 'blob', size: 5 }] });
    const r = await executor.execute(action(basePayload()));
    expect(r.outcome).toBe('blocked');
    expect(r.message).toMatch(/no files/i);
    expect(deployCalls).toHaveLength(0);
  });

  it('blocks when the declared entrypoint is absent from the read set', async () => {
    const { executor, deployCalls } = build();
    const r = await executor.execute(action(basePayload({ entrypointPath: 'main.ts' })));
    expect(r.outcome).toBe('blocked');
    expect(r.message).toMatch(/entrypoint/i);
    expect(deployCalls).toHaveLength(0);
  });

  it('blocks an oversized single file', async () => {
    const big = 'x'.repeat(SUPABASE_DEPLOY_LIMITS.maxFileBytes + 1);
    const { executor, deployCalls } = build({ blobs: { [`${SRC}/index.ts`]: big, [`${SRC}/_shared/util.ts`]: 'ok' } });
    const r = await executor.execute(action(basePayload()));
    expect(r.outcome).toBe('blocked');
    expect(r.message).toMatch(/bytes/i);
    expect(deployCalls).toHaveLength(0);
  });

  it('fails (retryable, no side effect) when the source tree cannot be read', async () => {
    const { executor, deployCalls } = build({ treeError: new Error('boom') });
    const r = await executor.execute(action(basePayload()));
    expect(r.outcome).toBe('failed');
    expect(r.retryAllowed).toBe(true);
    expect(deployCalls).toHaveLength(0);
  });
});

describe('SupabaseDeployExecutor — dry run + live', () => {
  it('dry run never deploys and reports the plan', async () => {
    const { executor, deployCalls } = build();
    const act = action(basePayload(), 'dry_run');
    const r = validateExecutorResult(act, executor.capability, await executor.execute(act));
    expect(r.outcome).toBe('not_executed');
    expect(r.preview).toMatchObject({ functionSlug: 'approve-quote', fileCount: 2, wouldExecute: true });
    expect(deployCalls).toHaveLength(0);
  });

  it('live deploy sends bundle-RELATIVE paths + verify_jwt, verifies the version, and returns the content digest', async () => {
    const { executor, deployCalls } = build({ afterVersion: 7 });
    const act = action(basePayload({ verifyJwt: true }));
    const r = validateExecutorResult(act, executor.capability, await executor.execute(act));
    expect(r.outcome).toBe('succeeded');
    expect(deployCalls).toHaveLength(1);
    expect(deployCalls[0]!.verifyJwt).toBe(true);
    expect(deployCalls[0]!.files.map((f) => f.path).sort()).toEqual(['_shared/util.ts', 'index.ts']);
    expect(r.preview).toMatchObject({ deployed: true, version: 7 });
    expect(typeof (r.preview as { contentDigest?: unknown }).contentDigest).toBe('string');
  });

  it('a 4xx from Supabase is a definite non-deploy (failed, no retry, no reconciliation)', async () => {
    const { executor } = build({ deployError: new SupabaseApiError('deploy edge function', 400) });
    const r = await executor.execute(action(basePayload()));
    expect(r.outcome).toBe('failed');
    expect(r.retryAllowed).toBe(false);
    expect(r.reconciliation).toBe('not_required');
  });

  it('a 5xx / transport error is ambiguous and requires reconciliation, never auto-retried', async () => {
    const { executor } = build({ deployError: new SupabaseApiError('deploy edge function', 503) });
    const r = await executor.execute(action(basePayload()));
    expect(r.outcome).toBe('ambiguous');
    expect(r.reconciliation).toBe('required');
    expect(r.retryAllowed).toBe(false);
  });

  it('refuses to execute an action that is not supabase_deploy', async () => {
    const { executor } = build();
    const act = { ...action(basePayload()), actionType: 'git_pr' as const };
    const r = await executor.execute(act);
    expect(r.outcome).toBe('blocked');
  });
});

describe('supabaseDeployContentDigest — binds exactly what is deployed', () => {
  it('changes when verify_jwt flips or a file content changes', () => {
    const payloadA = deployEdgeFunctionPayloadSchema.parse(basePayload({ verifyJwt: false }));
    const payloadB = deployEdgeFunctionPayloadSchema.parse(basePayload({ verifyJwt: true }));
    const files = [{ path: 'index.ts', content: 'a' }];
    const d1 = supabaseDeployContentDigest(payloadA, files);
    const d2 = supabaseDeployContentDigest(payloadB, files);
    const d3 = supabaseDeployContentDigest(payloadA, [{ path: 'index.ts', content: 'b' }]);
    expect(d1).not.toBe(d2);
    expect(d1).not.toBe(d3);
  });
});
