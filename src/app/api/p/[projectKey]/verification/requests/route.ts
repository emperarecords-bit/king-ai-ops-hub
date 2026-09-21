import { z } from 'zod';
import { AppError, toPublicMessage } from '@/lib/errors';
import { requireRunnerOrTenant, requireTenant } from '@/domain/auth/guard';
import { serverEnv } from '@/lib/env.server';
import { withRunner, withTenant } from '@/db/tenant';
import type { DbTx } from '@/db/client';
import type { VerificationCaller } from '@/types/domain';
import { createVerificationRequest, fileCatalogResolver, type ContractSummary } from '@/domain/verification';
import { createDrizzleVerificationStore } from '@/domain/verification/drizzle-store';

/**
 * POST — create a verification REQUEST (the contract) for a task at an exact commit (VER-002).
 *
 * Authorization: `requireTenant` resolves the project key to the caller's tenant; only a member of
 * that project may create a contract in it. org/project/creator are taken from that context, NEVER the
 * body, so a caller cannot bind a contract to another tenant (the DB RLS with-check pins it too).
 *
 * Write permission: creating a verification contract is a project WRITE. The `admin` and `member` roles
 * may create one; the `viewer` (read-only) role may not. An authenticated non-member is rejected earlier
 * by requireTenant (403), because they have no access record for the project.
 *
 * The contract is immutable: creating one for a (task, commit) that already has an IDENTICAL contract
 * returns it (200, created:false); a DIFFERENT contract for the same (task, commit) is a 409 conflict.
 * There is no update route.
 */
const bodySchema = z.object({
  taskId: z.string().uuid(),
  repoFullName: z.string().min(1),
  commitSha: z.string().min(1),
  requiredChecks: z.array(z.string()),
  requiredArtifacts: z.array(z.string()).optional().default([]),
  allowDirty: z.boolean().optional().default(false),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ projectKey: string }> },
): Promise<Response> {
  const { projectKey } = await params;

  let ctx;
  try {
    ctx = await requireTenant(projectKey);
  } catch (err) {
    return Response.json(
      { error: toPublicMessage(err) },
      { status: err instanceof AppError && err.code === 'unauthenticated' ? 401 : 403 },
    );
  }

  // admin + member may create a verification contract; viewer (read-only) may not.
  if (ctx.projectRole === 'viewer') {
    return Response.json({ error: 'Viewers cannot create verification requests.' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'Invalid verification request.', issues: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const outcome = await withTenant(ctx, (tx) =>
      createVerificationRequest(createDrizzleVerificationStore(tx), fileCatalogResolver(), ctx, parsed.data),
    );
    if (outcome.rejection) {
      const code = outcome.rejection.code;
      const status =
        code === 'invalid_input'
          ? 400
          : code === 'task_not_in_project'
            ? 404
            : code === 'repo_not_authorized'
              ? 403
              : code === 'catalog_unavailable'
                ? 503 // no trusted catalog configured — fail closed, not the caller's fault
                : 409; // no_repo_binding, contract_conflict
      return Response.json({ error: outcome.rejection.message, code }, { status });
    }
    return Response.json({ request: outcome.request, created: outcome.created }, { status: outcome.created ? 201 : 200 });
  } catch (err) {
    return Response.json({ error: toPublicMessage(err) }, { status: 500 });
  }
}

/** Serialize a contract summary for retrieval — only the fields a caller needs (no secrets/evidence). */
function toContractView(s: ContractSummary): Record<string, unknown> {
  const r = s.request;
  return {
    id: r.id,
    taskId: r.taskId,
    repoFullName: r.repoFullName,
    expectedCommitSha: r.expectedCommitSha,
    requiredChecks: r.requiredChecks,
    requiredArtifacts: r.requiredArtifacts,
    allowDirty: r.allowDirty,
    catalogVersion: r.catalogVersion,
    catalogDigest: r.catalogDigest,
    createdAt: r.createdAt,
    // Policy-neutral facts (NOT a verdict): "open" means acceptedEvidenceCount === 0.
    acceptedEvidenceCount: s.acceptedEvidenceCount,
    hasVerifiedComplete: s.hasVerifiedComplete,
  };
}

const MAX_PAGE = 100;
const DEFAULT_PAGE = 50;
const CURSOR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET — list this PROJECT's verification contracts (VER-002 PR-3). Project-scoped: every credential
 * with read access to the project sees the same contracts (not a runner-specific assignment). Humans
 * (any member, incl. viewer) may always read; a MACHINE principal additionally requires the retrieval
 * control (`VERIFICATION_RUNNER_RETRIEVAL_ENABLED`) to be on. Bounded keyset pagination by contract id.
 * `?state=open` filters to contracts with no accepted evidence yet (a policy-neutral definition).
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ projectKey: string }> },
): Promise<Response> {
  const { projectKey } = await params;

  let caller: VerificationCaller;
  try {
    caller = await requireRunnerOrTenant(projectKey, req);
  } catch (err) {
    const code = err instanceof AppError ? err.code : null;
    const status = code === 'unauthenticated' ? 401 : code === 'validation' ? 400 : 403;
    return Response.json({ error: toPublicMessage(err) }, { status });
  }
  if (caller.kind === 'runner' && !serverEnv().VERIFICATION_RUNNER_RETRIEVAL_ENABLED) {
    return Response.json({ error: 'Machine contract retrieval is disabled.' }, { status: 403 });
  }
  const tenant = caller.kind === 'user' ? caller.tenant : caller.runner;
  const runInTenant = <T>(fn: (tx: DbTx) => Promise<T>): Promise<T> =>
    caller.kind === 'user' ? withTenant(caller.tenant, fn) : withRunner(caller.runner, fn);

  const url = new URL(req.url);
  const openOnly = url.searchParams.get('state') === 'open';
  const afterId = url.searchParams.get('cursor') || null;
  // Validate the cursor as a UUID BEFORE it reaches the uuid column — a malformed cursor is a client
  // error (400), not a database-driven 500.
  if (afterId !== null && !CURSOR_RE.test(afterId)) {
    return Response.json({ error: 'Invalid pagination cursor.' }, { status: 400 });
  }
  const limitRaw = Number(url.searchParams.get('limit') ?? DEFAULT_PAGE);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), MAX_PAGE) : DEFAULT_PAGE;

  try {
    const summaries = await runInTenant((tx) =>
      createDrizzleVerificationStore(tx).listRequests(tenant.orgId, tenant.projectId, { limit, afterId, openOnly }),
    );
    const items = summaries.map(toContractView);
    // nextCursor is the last id only when the page was full (more may remain).
    const nextCursor = summaries.length === limit ? summaries[summaries.length - 1]!.request.id : null;
    return Response.json({ items, nextCursor }, { status: 200 });
  } catch (err) {
    return Response.json({ error: toPublicMessage(err) }, { status: 500 });
  }
}
