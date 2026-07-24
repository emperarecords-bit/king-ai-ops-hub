import { and, desc, eq } from 'drizzle-orm';
import { type ArtifactKind, type TenantContext } from '@/types/domain';
import { sha256Hex } from '@/lib/crypto';
import { type DbTx } from '@/db/client';
import { artifacts } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';

/**
 * Text-kind artifacts stored inline; kind='file' blob storage is Phase 4
 * (Supabase Storage, per-project prefixes, signed URLs).
 */

export interface ArtifactListRow {
  id: string;
  name: string;
  kind: ArtifactKind;
  sizeBytes: number;
  sha256: string;
  taskId: string | null;
  createdAt: Date;
}

export async function listArtifacts(tx: DbTx, ctx: TenantContext): Promise<ArtifactListRow[]> {
  return tx
    .select({
      id: artifacts.id,
      name: artifacts.name,
      kind: artifacts.kind,
      sizeBytes: artifacts.sizeBytes,
      sha256: artifacts.sha256,
      taskId: artifacts.taskId,
      createdAt: artifacts.createdAt,
    })
    .from(artifacts)
    .where(and(eq(artifacts.projectId, ctx.projectId), eq(artifacts.orgId, ctx.orgId)))
    .orderBy(desc(artifacts.createdAt));
}

export async function createTextArtifact(
  tx: DbTx,
  ctx: TenantContext,
  args: {
    name: string;
    kind: Exclude<ArtifactKind, 'file'>;
    content: string;
    taskId?: string | null;
    runId?: string | null;
  },
): Promise<string> {
  const inserted = await tx
    .insert(artifacts)
    .values({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      taskId: args.taskId ?? null,
      runId: args.runId ?? null,
      name: args.name,
      kind: args.kind,
      content: args.content,
      sha256: sha256Hex(args.content),
      sizeBytes: Buffer.byteLength(args.content, 'utf8'),
    })
    .returning({ id: artifacts.id });

  const id = inserted[0]!.id;
  await writeAudit(tx, ctx, {
    action: 'artifact.created',
    entityType: 'artifact',
    entityId: id,
    detail: { name: args.name, kind: args.kind },
  });
  return id;
}
