import 'server-only';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { type ContentFidelity, type KnowledgeDisclosure, type RunSourceSnapshot, type TenantContext } from '@/types/domain';
import { type DbTx } from '@/db/client';
import { documentChunks, documentVersions, documents, knowledgeSources, runDocumentVersions, runs } from '@/db/schema';
import { type ObjectStore, ObjectNotFoundError } from './object-store';

/**
 * Documents increment 1, Stage D1/D2 — EXACT historical version retrieval, separate from current
 * retrieval. Given a trusted server context and a reference to a specific immutable version (by id, or by
 * a Knowledge/run relationship, or a legacy identity+hash), it returns THAT version or explains precisely
 * why it cannot — it NEVER substitutes the current or a newer version.
 *
 * Principle: exact historical retrieval either returns the requested version or explains why that exact
 * version cannot be returned. It never substitutes a newer source.
 */

export type ExactVersionRef =
  | { kind: 'versionId'; versionId: string }
  | { kind: 'knowledgeSource'; knowledgeSourceId: string }
  | { kind: 'runVersion'; runId: string; documentVersionId: string }
  | { kind: 'runSnapshot'; runId: string; relativePath: string; sha256: string }
  | { kind: 'legacy'; relativePath: string; sha256: string };

export interface VersionRow {
  id: string;
  orgId: string;
  projectId: string;
  documentId: string;
  sha256: string;
  sizeBytes: number;
  mimeType: string | null;
  objectKey: string | null;
  contentFidelity: ContentFidelity;
  indexStatus: string;
  disclosureSnapshot: KnowledgeDisclosure;
}

const VERSION_COLS = {
  id: documentVersions.id,
  orgId: documentVersions.orgId,
  projectId: documentVersions.projectId,
  documentId: documentVersions.documentId,
  sha256: documentVersions.sha256,
  sizeBytes: documentVersions.sizeBytes,
  mimeType: documentVersions.mimeType,
  objectKey: documentVersions.objectKey,
  contentFidelity: documentVersions.contentFidelity,
  indexStatus: documentVersions.indexStatus,
  disclosureSnapshot: documentVersions.disclosureSnapshot,
} as const;

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function versionById(tx: DbTx, ctx: TenantContext, versionId: string): Promise<VersionRow | null> {
  const rows = (await tx.select(VERSION_COLS).from(documentVersions).where(eq(documentVersions.id, versionId)).limit(1)) as VersionRow[];
  const v = rows[0];
  // Cross-tenant version ids are never resolvable — they read as missing, not as another workspace's data.
  if (!v || v.orgId !== ctx.orgId || v.projectId !== ctx.projectId) return null;
  return v;
}

export type ResolutionState = 'found' | 'missing' | 'version_mismatch' | 'unsupported';
export interface ResolvedRef {
  state: ResolutionState;
  version?: VersionRow;
}

/**
 * Resolve a reference to the EXACT immutable version it names — pure resolution, no authorization and no
 * content. A supplied identity+hash that does not identify the same immutable version is `version_mismatch`
 * (never silently upgraded to the current version).
 */
export async function resolveExactVersion(tx: DbTx, ctx: TenantContext, ref: ExactVersionRef): Promise<ResolvedRef> {
  switch (ref.kind) {
    case 'versionId': {
      const v = await versionById(tx, ctx, ref.versionId);
      return v ? { state: 'found', version: v } : { state: 'missing' };
    }
    case 'knowledgeSource': {
      const ks = (
        await tx
          .select({ documentVersionId: knowledgeSources.documentVersionId, sourceType: knowledgeSources.sourceType, sourceVersionHash: knowledgeSources.sourceVersionHash })
          .from(knowledgeSources)
          .where(and(eq(knowledgeSources.id, ref.knowledgeSourceId), eq(knowledgeSources.orgId, ctx.orgId), eq(knowledgeSources.projectId, ctx.projectId)))
          .limit(1)
      )[0];
      if (!ks) return { state: 'missing' };
      if (ks.sourceType !== 'document') return { state: 'unsupported' };
      // No bound version: the cited exact version predates versioning / was overwritten → unavailable-by-ref.
      if (!ks.documentVersionId) return { state: 'unsupported' };
      const v = await versionById(tx, ctx, ks.documentVersionId);
      if (!v) return { state: 'missing' };
      // The bound version must still match the cited hash — otherwise the citation identity disagrees.
      if (ks.sourceVersionHash && v.sha256 !== ks.sourceVersionHash) return { state: 'version_mismatch' };
      return { state: 'found', version: v };
    }
    case 'runVersion': {
      const rel = (
        await tx
          .select({ id: runDocumentVersions.id })
          .from(runDocumentVersions)
          .where(and(eq(runDocumentVersions.runId, ref.runId), eq(runDocumentVersions.documentVersionId, ref.documentVersionId), eq(runDocumentVersions.orgId, ctx.orgId), eq(runDocumentVersions.projectId, ctx.projectId)))
          .limit(1)
      )[0];
      if (!rel) return { state: 'missing' };
      const v = await versionById(tx, ctx, ref.documentVersionId);
      return v ? { state: 'found', version: v } : { state: 'missing' };
    }
    case 'runSnapshot': {
      const run = (
        await tx.select({ retrievedSources: runs.retrievedSources }).from(runs).where(and(eq(runs.id, ref.runId), eq(runs.orgId, ctx.orgId), eq(runs.projectId, ctx.projectId))).limit(1)
      )[0];
      if (!run) return { state: 'missing' };
      const snaps = (run.retrievedSources as RunSourceSnapshot[] | null) ?? [];
      const snap = snaps.find((s) => s.relativePath === ref.relativePath && s.sha256 === ref.sha256);
      if (!snap) return { state: 'missing' };
      if (snap.documentVersionId) {
        const v = await versionById(tx, ctx, snap.documentVersionId);
        if (!v) return { state: 'missing' };
        if (v.sha256 !== ref.sha256) return { state: 'version_mismatch' };
        return { state: 'found', version: v };
      }
      // A legacy snapshot without a version id → resolve by (doc path, hash) below.
      return resolveExactVersion(tx, ctx, { kind: 'legacy', relativePath: ref.relativePath, sha256: ref.sha256 });
    }
    case 'legacy': {
      const doc = (
        await tx.select({ id: documents.id }).from(documents).where(and(eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId), eq(documents.relativePath, ref.relativePath))).limit(1)
      )[0];
      if (!doc) return { state: 'missing' };
      const v = (await tx.select(VERSION_COLS).from(documentVersions).where(and(eq(documentVersions.documentId, doc.id), eq(documentVersions.sha256, ref.sha256))).limit(1)) as VersionRow[];
      // The exact cited hash has no retained version → the historical identity is known but unavailable.
      return v[0] ? { state: 'found', version: v[0] } : { state: 'version_mismatch' };
    }
    default:
      return { state: 'unsupported' };
  }
}

// ---- D2: fidelity-aware inspection ---------------------------------------------------------------

export type InspectionState = 'resolved' | 'inaccessible' | 'unavailable' | 'missing' | 'version_mismatch' | 'unsupported' | 'integrity_failure';

export interface InspectionChunk {
  chunkIndex: number;
  content: string;
  locator: string | null;
  contentHash: string | null;
}

export interface HistoricalInspection {
  state: InspectionState;
  versionId?: string;
  documentId?: string;
  fidelity?: ContentFidelity;
  /** The version's content hash — exposed only when authorized (and, for `unavailable`, when permitted). */
  versionHash?: string;
  mimeType?: string | null;
  sizeBytes?: number;
  /** byte_exact only: exact retained bytes, verified against the hash. */
  bytes?: Buffer;
  downloadable?: boolean;
  /** byte_exact + reconstructed_text: version-specific chunks (ordering + locators preserved). */
  chunks?: InspectionChunk[];
  /** reconstructed_text: the mandatory reconstruction qualification. */
  qualification?: string;
  detail?: string;
}

export const RECONSTRUCTION_QUALIFICATION = 'Reconstructed from indexed text; original source bytes were not retained.';

async function versionChunks(tx: DbTx, versionId: string): Promise<InspectionChunk[]> {
  const rows = await tx
    .select({ chunkIndex: documentChunks.chunkIndex, content: documentChunks.content, locator: documentChunks.locator, contentHash: documentChunks.contentHash })
    .from(documentChunks)
    .where(eq(documentChunks.documentVersionId, versionId))
    .orderBy(documentChunks.chunkIndex);
  return rows;
}

/**
 * Inspect a resolved version at its fidelity, for an ALREADY-AUTHORIZED consumer/viewer. `authorized`
 * gates everything: an unauthorized request returns `inaccessible` with no content or sensitive metadata.
 * `revealHash` allows the (authorized) caller to see the expected hash of an `unavailable` version.
 */
export async function inspectResolvedVersion(
  tx: DbTx,
  store: ObjectStore,
  v: VersionRow,
  opts: { authorized: boolean; revealHash?: boolean },
): Promise<HistoricalInspection> {
  if (!opts.authorized) return { state: 'inaccessible' };

  if (v.contentFidelity === 'unavailable') {
    return { state: 'unavailable', versionId: v.id, documentId: v.documentId, fidelity: 'unavailable', versionHash: opts.revealHash ? v.sha256 : undefined, downloadable: false, detail: 'No exact or reconstructed evidence remains for this historical version.' };
  }

  if (v.contentFidelity === 'byte_exact') {
    if (!v.objectKey) {
      return { state: 'integrity_failure', versionId: v.id, documentId: v.documentId, fidelity: 'byte_exact', detail: 'byte_exact version has no retained object' };
    }
    let bytes: Buffer;
    try {
      bytes = await store.get(v.objectKey);
    } catch (err) {
      const detail = err instanceof ObjectNotFoundError ? 'retained object is missing' : 'retained object is unreadable';
      return { state: 'integrity_failure', versionId: v.id, documentId: v.documentId, fidelity: 'byte_exact', detail };
    }
    // Re-verify the bytes at retrieval — never serve as byte-exact if the object no longer hashes correctly.
    if (sha256Hex(bytes) !== v.sha256) {
      return { state: 'integrity_failure', versionId: v.id, documentId: v.documentId, fidelity: 'byte_exact', versionHash: v.sha256, detail: 'retained object hash does not match the recorded version hash' };
    }
    return {
      state: 'resolved',
      versionId: v.id,
      documentId: v.documentId,
      fidelity: 'byte_exact',
      versionHash: v.sha256,
      mimeType: v.mimeType,
      sizeBytes: v.sizeBytes,
      bytes,
      downloadable: true,
      chunks: await versionChunks(tx, v.id),
    };
  }

  // reconstructed_text — inspectable indexed text only; no exact download, no synthesized original file.
  return {
    state: 'resolved',
    versionId: v.id,
    documentId: v.documentId,
    fidelity: 'reconstructed_text',
    versionHash: v.sha256,
    downloadable: false,
    chunks: await versionChunks(tx, v.id),
    qualification: RECONSTRUCTION_QUALIFICATION,
  };
}

/**
 * The one-call exact historical retrieval: resolve the reference, then inspect at fidelity for an
 * authorized consumer/viewer. Maps a resolution failure straight through (missing / version_mismatch /
 * unsupported) without ever substituting the current version.
 */
export async function retrieveExactHistorical(
  tx: DbTx,
  ctx: TenantContext,
  store: ObjectStore,
  ref: ExactVersionRef,
  opts: { authorized: boolean; revealHash?: boolean },
): Promise<HistoricalInspection> {
  const resolved = await resolveExactVersion(tx, ctx, ref);
  if (resolved.state !== 'found' || !resolved.version) return { state: resolved.state as Exclude<ResolutionState, 'found'> };
  return inspectResolvedVersion(tx, store, resolved.version, opts);
}

// ---- D8: exact-version evidence relationships ---------------------------------------------------

export interface RunSuppliedEvidence {
  /** The exact text supplied to the provider for this version (authoritative for WHAT WAS SENT). */
  suppliedFromSnapshot: { chunkIndex: number; excerpt: string; sha256: string }[];
  /** The retained Document Version this evidence was SELECTED FROM (authoritative for the source). */
  version: ResolvedRef;
}

/**
 * Resolve a run's evidence for one version, keeping the two authorities DISTINCT: the immutable run
 * snapshot (exact supplied prompt text) vs. the retained Document Version (the source evidence it was
 * selected from). Later source corruption may affect the version's current inspectability but never
 * rewrites what the run snapshot recorded was sent.
 */
export async function resolveRunSuppliedEvidence(tx: DbTx, ctx: TenantContext, runId: string, versionId: string): Promise<RunSuppliedEvidence | null> {
  const run = (await tx.select({ retrievedSources: runs.retrievedSources }).from(runs).where(and(eq(runs.id, runId), eq(runs.orgId, ctx.orgId), eq(runs.projectId, ctx.projectId))).limit(1))[0];
  if (!run) return null;
  const snaps = (run.retrievedSources as RunSourceSnapshot[] | null) ?? [];
  const supplied = snaps.filter((s) => s.documentVersionId === versionId).map((s) => ({ chunkIndex: s.chunkIndex, excerpt: s.excerpt, sha256: s.sha256 }));
  const version = await resolveExactVersion(tx, ctx, { kind: 'versionId', versionId });
  return { suppliedFromSnapshot: supplied, version };
}
