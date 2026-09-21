import { z } from 'zod';
import { AppError, toPublicMessage } from '@/lib/errors';
import { requireTenant } from '@/domain/auth/guard';
import { serverEnv } from '@/lib/env.server';
import { insertRunnerKey } from '@/db/runner-keys';
import {
  defaultRunnerKeyExpiry,
  generateRunnerCredential,
  hashRunnerSecret,
} from '@/domain/auth/runner-credential';

/**
 * POST — issue a per-project runner (machine) credential (VER-002 PR-2).
 *
 * Authorization: human session, **project admin only** (member/viewer → 403). Behind the default-off
 * issuance control (`VERIFICATION_RUNNER_KEYS_ISSUANCE_ENABLED`); while off, issuance is refused.
 * The plaintext credential (`keyId.secret`) is returned EXACTLY ONCE; only a scrypt hash + per-
 * credential salt are stored. Default expiry is 90 days.
 */
const bodySchema = z.object({ label: z.string().max(200).optional() });

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
  if (ctx.projectRole !== 'admin') {
    return Response.json({ error: 'Only a project admin may issue runner credentials.' }, { status: 403 });
  }
  if (!serverEnv().VERIFICATION_RUNNER_KEYS_ISSUANCE_ENABLED) {
    return Response.json({ error: 'Runner credential issuance is disabled.' }, { status: 403 });
  }

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine — label is optional */
  }
  const parsed = bodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return Response.json({ error: 'Invalid request.', issues: parsed.error.flatten() }, { status: 400 });
  }

  const { keyId, secret } = generateRunnerCredential();
  const { hash, salt } = hashRunnerSecret(secret);
  const expiresAt = defaultRunnerKeyExpiry(new Date());
  try {
    await insertRunnerKey(ctx, { keyId, secretHash: hash, secretSalt: salt, label: parsed.data.label ?? '', expiresAt });
  } catch (err) {
    return Response.json({ error: toPublicMessage(err) }, { status: 500 });
  }
  // Returned ONCE — the secret is never retrievable again.
  return Response.json(
    { keyId, credential: `${keyId}.${secret}`, expiresAt: expiresAt.toISOString() },
    { status: 201 },
  );
}
