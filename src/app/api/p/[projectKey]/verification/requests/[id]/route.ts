import { AppError, toPublicMessage } from '@/lib/errors';
import { requireRunnerOrTenant } from '@/domain/auth/guard';
import { serverEnv } from '@/lib/env.server';
import { withRunner, withTenant } from '@/db/tenant';
import type { DbTx } from '@/db/client';
import type { VerificationCaller } from '@/types/domain';
import { createDrizzleVerificationStore } from '@/domain/verification/drizzle-store';

/**
 * GET — one verification contract by id (VER-002 PR-3). Project-scoped, read-only. Humans (any member)
 * may read; a MACHINE principal additionally requires `VERIFICATION_RUNNER_RETRIEVAL_ENABLED`. Returns
 * only contract fields + policy-neutral evidence facts — never secrets or evidence rows. A contract in
 * another tenant (or absent) is a 404.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ projectKey: string; id: string }> },
): Promise<Response> {
  const { projectKey, id } = await params;

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
  if (!UUID_RE.test(id)) {
    return Response.json({ error: 'Invalid contract id.' }, { status: 400 });
  }
  const tenant = caller.kind === 'user' ? caller.tenant : caller.runner;
  const runInTenant = <T>(fn: (tx: DbTx) => Promise<T>): Promise<T> =>
    caller.kind === 'user' ? withTenant(caller.tenant, fn) : withRunner(caller.runner, fn);

  try {
    const s = await runInTenant((tx) =>
      createDrizzleVerificationStore(tx).getRequestSummary(tenant.orgId, tenant.projectId, id),
    );
    if (!s) return Response.json({ error: 'Contract not found.' }, { status: 404 });
    const r = s.request;
    return Response.json(
      {
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
        acceptedEvidenceCount: s.acceptedEvidenceCount,
        hasVerifiedComplete: s.hasVerifiedComplete,
      },
      { status: 200 },
    );
  } catch (err) {
    return Response.json({ error: toPublicMessage(err) }, { status: 500 });
  }
}
