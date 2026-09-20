import { z } from 'zod';
import { AppError, toPublicMessage } from '@/lib/errors';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { ingestEvidence, type SignedEnvelope } from '@/domain/verification';
import { createDrizzleVerificationStore } from '@/domain/verification/drizzle-store';
import { envRunnerSecretSource, objectStoreArtifactStore } from '@/domain/verification/runtime-adapters';

/**
 * POST — ingest external-runner verification evidence (VER-002, Option A).
 *
 * The runner signs its submission with the project runner secret; this route
 * authenticates the caller's tenant, then hands the signed envelope to the
 * ingest orchestrator inside one tenant transaction (RLS + explicit org/project
 * filters preserve isolation). The Hub never runs commands — it only adjudicates.
 * Agent prose carries no valid signature and is rejected.
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
    const decision = await withTenant(ctx, (tx) =>
      ingestEvidence(
        {
          store: createDrizzleVerificationStore(tx),
          artifacts: objectStoreArtifactStore(ctx),
          secrets: envRunnerSecretSource(),
        },
        ctx,
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
