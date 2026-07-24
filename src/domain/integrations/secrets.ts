import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import { type TenantContext } from '@/types/domain';
import { AppError, NotFoundError, ValidationError } from '@/lib/errors';
import { serverEnv } from '@/lib/env.server';
import { encryptSecret, lastFour } from '@/lib/crypto';
import { type DbTx } from '@/db/client';
import { integrationSecrets } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';

/**
 * Project-scoped integration secrets: AES-256-GCM at rest, last-four display
 * only, never returned to any caller in plaintext. (Decryption lives with the
 * Phase 3+ executors that consume these; nothing in the UI path decrypts.)
 */

export interface SecretListRow {
  id: string;
  name: string;
  lastFour: string;
  keyVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export async function listSecrets(tx: DbTx, ctx: TenantContext): Promise<SecretListRow[]> {
  return tx
    .select({
      id: integrationSecrets.id,
      name: integrationSecrets.name,
      lastFour: integrationSecrets.lastFour,
      keyVersion: integrationSecrets.keyVersion,
      createdAt: integrationSecrets.createdAt,
      updatedAt: integrationSecrets.updatedAt,
    })
    .from(integrationSecrets)
    .where(
      and(eq(integrationSecrets.projectId, ctx.projectId), eq(integrationSecrets.orgId, ctx.orgId)),
    )
    .orderBy(desc(integrationSecrets.updatedAt));
}

export async function upsertSecret(
  tx: DbTx,
  ctx: TenantContext,
  args: { name: string; value: string },
): Promise<void> {
  if (ctx.projectRole !== 'admin') {
    throw new AppError('forbidden', 'Only project admins can manage secrets.');
  }
  const name = args.name.trim();
  if (!/^[a-z0-9_-]{2,64}$/i.test(name)) {
    throw new ValidationError(['Secret name must be 2-64 chars: letters, digits, _ or -.']);
  }
  if (args.value.length < 4 || args.value.length > 4096) {
    throw new ValidationError(['Secret value must be between 4 and 4096 characters.']);
  }

  const env = serverEnv();
  const key = Buffer.from(env.APP_ENCRYPTION_KEY, 'base64');
  const { serialized, keyVersion } = encryptSecret(
    args.value,
    key,
    env.APP_ENCRYPTION_KEY_VERSION,
  );

  await tx
    .insert(integrationSecrets)
    .values({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      name,
      ciphertext: serialized,
      keyVersion,
      lastFour: lastFour(args.value),
    })
    .onConflictDoUpdate({
      target: [integrationSecrets.projectId, integrationSecrets.name],
      set: {
        ciphertext: serialized,
        keyVersion,
        lastFour: lastFour(args.value),
        updatedAt: new Date(),
      },
    });

  // Audit records the NAME only — never value, never length.
  await writeAudit(tx, ctx, {
    action: 'secret.upserted',
    entityType: 'integration_secret',
    detail: { name },
  });
}

export async function deleteSecret(tx: DbTx, ctx: TenantContext, secretId: string): Promise<void> {
  if (ctx.projectRole !== 'admin') {
    throw new AppError('forbidden', 'Only project admins can manage secrets.');
  }
  const deleted = await tx
    .delete(integrationSecrets)
    .where(
      and(
        eq(integrationSecrets.id, secretId),
        eq(integrationSecrets.projectId, ctx.projectId),
        eq(integrationSecrets.orgId, ctx.orgId),
      ),
    )
    .returning({ name: integrationSecrets.name });
  if (deleted.length === 0) throw new NotFoundError('Secret');

  await writeAudit(tx, ctx, {
    action: 'secret.deleted',
    entityType: 'integration_secret',
    detail: { name: deleted[0]!.name },
  });
}
