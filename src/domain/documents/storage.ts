import 'server-only';
import { stat } from 'node:fs/promises';
import { and, eq } from 'drizzle-orm';
import { type TenantContext } from '@/types/domain';
import { type DbTx } from '@/db/client';
import { projects } from '@/db/schema';

/**
 * Project Library storage boundary (O-21).
 *
 * Today the linked project folder is a LOCAL filesystem path (D-020): files are
 * discovered by walking the folder, modifications detected by a content hash,
 * and the extracted TEXT + hash are persisted in `documents` / `document_chunks`
 * (the binary is NOT stored). This works when the app runs on the same machine
 * as the folder.
 *
 * In the cloud the app cannot see a local machine's disk. This interface names
 * the seam a future cloud implementation (admin upload or a synced object-store
 * adapter) plugs into WITHOUT changing retrieval, hashing, archival, or
 * provenance. Slice 1 ships only the local adapter's status probe; a full cloud
 * ingestion adapter is deferred (see DEPLOYMENT.md → deferred risks).
 */
export interface StorageAdapter {
  readonly kind: 'local-folder' | 'object-store';
  /** Whether the workspace's source is reachable right now. */
  isAvailable(): Promise<boolean>;
}

export interface StorageStatus {
  linked: boolean;
  reachable: boolean;
  kind: 'local-folder' | 'none';
  /** Never the full path in logs — callers decide whether to surface it. */
  detail: string;
}

/**
 * Reports the workspace's storage status for the health check and the Documents
 * UI. Reachability is a plain stat; when a folder is linked but unreachable the
 * caller knows NOT to treat "no files found" as "all files deleted".
 */
export async function storageStatus(tx: DbTx, ctx: TenantContext): Promise<StorageStatus> {
  const rows = await tx
    .select({ path: projects.documentFolderPath })
    .from(projects)
    .where(and(eq(projects.id, ctx.projectId), eq(projects.orgId, ctx.orgId)))
    .limit(1);
  const path = rows[0]?.path ?? null;
  if (!path) return { linked: false, reachable: false, kind: 'none', detail: 'no folder linked' };
  try {
    const s = await stat(path);
    return {
      linked: true,
      reachable: s.isDirectory(),
      kind: 'local-folder',
      detail: s.isDirectory() ? 'reachable' : 'linked path is not a directory',
    };
  } catch {
    return { linked: true, reachable: false, kind: 'local-folder', detail: 'linked folder unreachable' };
  }
}
