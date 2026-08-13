import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { type TenantContext } from '@/types/domain';
import { ForbiddenError, ValidationError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { apiTokens } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';
import { generateTokenSecret } from './token-secret';
import { MCP_TOOL_NAMES, type McpToolName } from './tool-names';

/**
 * MCP API-token lifecycle (Phase 5). Mint / list / revoke run under the caller's `withTenant`, so RLS confines
 * every row to the caller's project. Minting and revoking are project-admin only. The plaintext secret is
 * returned exactly once, from `mintApiToken`, and never stored (only its SHA-256 hash is; see token-secret.ts).
 */

const mintSchema = z.object({
  name: z.string().trim().min(1, 'Token name is required').max(120),
  scopes: z
    .array(z.enum(MCP_TOOL_NAMES))
    .min(1, 'A token must grant at least one tool')
    .transform((s) => Array.from(new Set(s))),
  expiresAt: z.date().nullable().default(null),
});

export type MintApiTokenInput = z.input<typeof mintSchema>;

export interface MintedApiToken {
  readonly id: string;
  /** The plaintext token — shown once here, never retrievable again. */
  readonly secret: string;
  readonly prefix: string;
  readonly lastFour: string;
  readonly scopes: McpToolName[];
}

export interface ApiTokenSummary {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly lastFour: string;
  readonly scopes: McpToolName[];
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly expiresAt: Date | null;
}

function requireProjectAdmin(ctx: TenantContext): void {
  if (ctx.projectRole !== 'admin') {
    throw new ForbiddenError('minting or revoking API tokens requires the project admin role');
  }
}

/** Mint a token bound to the caller's (org, project), acting as the caller. Returns the secret ONCE. */
export async function mintApiToken(
  tx: DbTx,
  ctx: TenantContext,
  input: MintApiTokenInput,
): Promise<MintedApiToken> {
  requireProjectAdmin(ctx);
  const parsed = mintSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message));
  const { name, scopes, expiresAt } = parsed.data;

  const minted = generateTokenSecret();
  const inserted = await tx
    .insert(apiTokens)
    .values({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      name,
      tokenHash: minted.tokenHash,
      prefix: minted.prefix,
      lastFour: minted.lastFour,
      scopes,
      createdBy: ctx.userId,
      expiresAt,
    })
    .returning({ id: apiTokens.id });
  const id = inserted[0]!.id;

  // Audit records identity + non-secret descriptors ONLY — never the secret or its hash.
  await writeAudit(tx, ctx, {
    action: 'api_token.minted',
    entityType: 'api_token',
    entityId: id,
    detail: { name, scopes, prefix: minted.prefix, lastFour: minted.lastFour },
  });

  return { id, secret: minted.secret, prefix: minted.prefix, lastFour: minted.lastFour, scopes };
}

/** Soft-revoke a token (sets revoked_at). Idempotent: returns false if it was missing or already revoked. */
export async function revokeApiToken(tx: DbTx, ctx: TenantContext, tokenId: string): Promise<boolean> {
  requireProjectAdmin(ctx);
  const now = new Date();
  const updated = await tx
    .update(apiTokens)
    .set({ revokedAt: now, updatedAt: now })
    .where(and(eq(apiTokens.id, tokenId), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id });
  if (updated.length === 0) return false;
  await writeAudit(tx, ctx, {
    action: 'api_token.revoked',
    entityType: 'api_token',
    entityId: tokenId,
  });
  return true;
}

/** List the project's tokens (non-secret fields only). The token hash is never selected. */
export async function listApiTokens(tx: DbTx, ctx: TenantContext): Promise<ApiTokenSummary[]> {
  const rows = await tx
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      prefix: apiTokens.prefix,
      lastFour: apiTokens.lastFour,
      scopes: apiTokens.scopes,
      createdBy: apiTokens.createdBy,
      createdAt: apiTokens.createdAt,
      lastUsedAt: apiTokens.lastUsedAt,
      revokedAt: apiTokens.revokedAt,
      expiresAt: apiTokens.expiresAt,
    })
    .from(apiTokens)
    .where(eq(apiTokens.projectId, ctx.projectId))
    .orderBy(desc(apiTokens.createdAt));
  return rows.map((r) => ({ ...r, scopes: (r.scopes ?? []) as McpToolName[] }));
}
