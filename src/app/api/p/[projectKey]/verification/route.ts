import { z } from 'zod';
import { AppError, toPublicMessage } from '@/lib/errors';
import { requireRunnerOrTenant } from '@/domain/auth/guard';
import { withRunner, withTenant } from '@/db/tenant';
import type { DbTx } from '@/db/client';
import type { VerificationCaller } from '@/types/domain';
import { ingestEvidence, type SignedEnvelope } from '@/domain/verification';
import { createDrizzleVerificationStore } from '@/domain/verification/drizzle-store';
import { envRunnerSecretSource, objectStoreArtifactStore } from '@/domain/verification/runtime-adapters';

/**
 * POST — ingest external-runner verification evidence (VER-002, Option A).
 *
 * Authentication accepts EITHER a machine (runner) bearer credential OR a human session
 * (`requireRunnerOrTenant`); a runner is a machine principal with no invented user identity. The
 * signed envelope is then handed to the ingest orchestrator inside one tenant transaction (withRunner
 * for a machine, withTenant for a human — both stamp org/project GUCs, so RLS + explicit filters
 * preserve isolation). The Hub never runs commands — it only adjudicates. Agent prose carries no valid
 * signature and is rejected; an envelope declaring an unsupported signing-key version is rejected on
 * both paths.
 */
const checkSchema = z.object({
  name: z.string().min(1),
  status: z.enum(['passed', 'failed', 'skipped', 'cancelled', 'errored', 'missing']),
  command: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  detail: z.string().nullable(),
});
const artifactSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  storageKey: z.string().min(1),
});
const payloadSchema = z.object({
  requestId: z.string().uuid(),
  orgId: z.string().min(1),
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  repoFullName: z.string().min(1),
  commitSha: z.string().min(1),
  dirty: z.boolean(),
  uncommittedChangesDigest: z.string().nullable(),
  runnerId: z.string().min(1),
  runId: z.string().min(1),
  attemptId: z.string().min(1),
  environment: z.string().min(1),
  source: z.enum(['local_runner', 'github_actions']),
  checks: z.array(checkSchema),
  artifacts: z.array(artifactSchema),
  idempotencyKey: z.string().min(8),
  submittedAt: z.string(),
});
const envelopeSchema = z.object({
  runnerId: z.string().min(1),
  payload: payloadSchema,
  signature: z.string(),
  // Absent ⇒ treated as 'v1' (back-compat); an unsupported version is rejected during ingest.
  signingKeyVersion: z.string().optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ projectKey: string }> },
): Promise<Response> {
  const { projectKey } = await params;

  let caller: VerificationCaller;
  try {
    caller = await requireRunnerOrTenant(projectKey, req);
  } catch (err) {
    // unauthenticated → 401; ambiguous credentials (validation) → 400; anything else → 403.
    const code = err instanceof AppError ? err.code : null;
    const status = code === 'unauthenticated' ? 401 : code === 'validation' ? 400 : 403;
    return Response.json({ error: toPublicMessage(err) }, { status });
  }
  // Both principals carry the trusted (orgId, projectId); the runner has no user identity.
  const tenant = caller.kind === 'user' ? caller.tenant : caller.runner;
  const runInTenant = <T>(fn: (tx: DbTx) => Promise<T>): Promise<T> =>
    caller.kind === 'user' ? withTenant(caller.tenant, fn) : withRunner(caller.runner, fn);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  const parsed = envelopeSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'Invalid evidence envelope.', issues: parsed.error.flatten() }, { status: 400 });
  }
  const envelope = parsed.data as SignedEnvelope;

  try {
    const decision = await runInTenant((tx) =>
      ingestEvidence(
        {
          store: createDrizzleVerificationStore(tx),
          artifacts: objectStoreArtifactStore(tenant),
          secrets: envRunnerSecretSource(),
        },
        tenant,
        envelope,
      ),
    );
    // An unauthenticated submission is a 401; everything else (accepted or a
    // binding/check/artifact rejection) is a 200 carrying the decision.
    const httpStatus = decision.rejection?.code === 'unauthenticated' ? 401 : 200;
    return Response.json({ decision }, { status: httpStatus });
  } catch (err) {
    return Response.json({ error: toPublicMessage(err) }, { status: 500 });
  }
}
