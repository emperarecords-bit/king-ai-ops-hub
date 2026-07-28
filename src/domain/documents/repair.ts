import 'server-only';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { type TenantContext } from '@/types/domain';
import { type DbTx } from '@/db/client';
import { documentChunks, documentVersions, documents } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';
import { type ObjectStore, ObjectNotFoundError } from './object-store';
import { chunkText } from './documents';
import { type DocIntegrityFinding, type DocumentIntegrityAudit, auditDocument, rebuildVersionChunksFromBytes } from './integrity';

/**
 * Documents REPAIR — a SEPARATELY GATED, bounded, representation-safe capability. It is NOT integrity
 * (audit observes; repair mutates) and NOT cleanup/purge (no deletion, no fidelity change, no historical
 * rewrite). Every repair is a deliberate operator act on ONE exact document + ONE exact proposal, previewed
 * before mutation, bound to the observed state, idempotent, verified afterward, and recorded append-only.
 *
 * The ONLY repair type in this increment is `rebuild_chunks`: restore a byte_exact version's corrupted
 * chunk TEXT from its OWN retained, hash-verified bytes — applied only when the reparse reproduces the
 * historical chunk manifest EXACTLY (same count + per-chunk content hash). It never alters source bytes,
 * never rewrites the immutable version identity (hash/objectKey/fidelity), never manufactures evidence, and
 * never touches chunk indexes/locators/hashes. When identity cannot be proven it refuses / marks degraded —
 * never a "best guess". Cleanup, purge, object/version deletion, and fidelity change remain OUT of scope.
 */

export type RepairType = 'rebuild_chunks';

export interface RepairTarget {
  type: RepairType;
  versionId: string;
}

export type RepairExpectation = 'would_repair' | 'already_consistent' | 'would_mark_degraded' | 'refuse';

export interface RepairPreview {
  type: RepairType;
  applicable: boolean;
  documentId: string;
  versionId: string;
  whatIsWrong: string;
  proposedMutation: string;
  whySafe: string;
  whatUnchanged: string;
  expectation: RepairExpectation;
  /** Binds a later execute to the EXACT state observed at preview; execution refuses if it changed. */
  fingerprint: string;
  refusalReason?: string;
}

export type RepairOutcome = 'repaired' | 'no_change_needed' | 'marked_degraded' | 'refused';

/**
 * The THIRD, separate verification dimension: how far the post-repair document-wide integrity re-audit got.
 * Kept distinct from "repair applied" and "targeted finding resolved" so a limited or failed broader audit
 * is NEVER read as "integrity fully restored".
 *   healthy               — the broader re-audit completed and found nothing wrong;
 *   other_findings_remain — the re-audit completed but OTHER (untargeted) findings remain;
 *   limited               — the re-audit could not verify some bytes (e.g. object store unreachable);
 *   failed                — the re-audit itself could not be produced;
 *   not_verified          — no post-repair audit was applicable (e.g. the repair was refused).
 */
export type BroaderIntegrity = 'healthy' | 'other_findings_remain' | 'limited' | 'failed' | 'not_verified';

/** Maps the raw post-repair audit outcome onto the honest broader-verification dimension. */
export function broaderIntegrityOf(after: DocumentIntegrityAudit['outcome'] | null): BroaderIntegrity {
  switch (after) {
    case 'healthy': return 'healthy';
    case 'partially_verified': return 'limited';
    case 'audit_failed': return 'failed';
    case 'degraded': return 'other_findings_remain';
    case 'unavailable': return 'other_findings_remain';
    default: return 'not_verified';
  }
}

export interface RepairResult {
  type: RepairType;
  versionId: string;
  outcome: RepairOutcome;
  detail: string;
  /** Before/after document-scoped integrity outcomes (post-repair verification). */
  beforeOutcome: DocumentIntegrityAudit['outcome'] | null;
  afterOutcome: DocumentIntegrityAudit['outcome'] | null;
  targetedFindingResolved: boolean;
  /** The separate third dimension — the broader re-audit's reach, never conflated with the targeted result. */
  broaderIntegrity: BroaderIntegrity;
  /** True if the repair introduced a NEW higher-severity finding (a regression). */
  regressed: boolean;
}

function sha256Hex(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

/** A content fingerprint of a version's chunk manifest + object identity — the exact state a repair binds to. */
async function versionRepairFingerprint(tx: DbTx, ctx: TenantContext, versionId: string): Promise<string | null> {
  const v = (await tx.select({ id: documentVersions.id, sha256: documentVersions.sha256, objectKey: documentVersions.objectKey, contentFidelity: documentVersions.contentFidelity }).from(documentVersions).where(and(eq(documentVersions.id, versionId), eq(documentVersions.orgId, ctx.orgId), eq(documentVersions.projectId, ctx.projectId))).limit(1))[0];
  if (!v) return null;
  const chunks = await tx.select({ chunkIndex: documentChunks.chunkIndex, content: documentChunks.content, contentHash: documentChunks.contentHash }).from(documentChunks).where(eq(documentChunks.documentVersionId, versionId)).orderBy(documentChunks.chunkIndex);
  const manifest = chunks.map((c) => `${c.chunkIndex}:${c.contentHash ?? ''}:${sha256Hex(Buffer.from(c.content, 'utf8'))}`).join('|');
  return sha256Hex(Buffer.from(`${v.sha256}|${v.objectKey ?? ''}|${v.contentFidelity}|${manifest}`, 'utf8'));
}

/** The finding categories this increment can repair, mapped to their repair type. */
export function repairTypeForFinding(f: DocIntegrityFinding): RepairType | null {
  return f.category === 'chunk_content_hash_mismatch' ? 'rebuild_chunks' : null;
}

/** Load + tenancy/ownership check for a target version that MUST belong to the requested document. */
async function requireTargetVersion(tx: DbTx, ctx: TenantContext, documentId: string, versionId: string) {
  const v = (await tx.select({ id: documentVersions.id, documentId: documentVersions.documentId, orgId: documentVersions.orgId, projectId: documentVersions.projectId, sha256: documentVersions.sha256, objectKey: documentVersions.objectKey, contentFidelity: documentVersions.contentFidelity, parserVersion: documentVersions.parserVersion }).from(documentVersions).where(eq(documentVersions.id, versionId)).limit(1))[0];
  // Fail closed on ambiguous / cross-tenant / cross-document identity — never repair the wrong thing.
  if (!v || v.orgId !== ctx.orgId || v.projectId !== ctx.projectId || v.documentId !== documentId) return null;
  const doc = (await tx.select({ id: documents.id }).from(documents).where(and(eq(documents.id, documentId), eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId))).limit(1))[0];
  return doc ? v : null;
}

const REPAIR_PARSER = 'chunk-v1';

/**
 * PREVIEW a repair without mutating anything. Reports the exact affected version, what is wrong, the
 * proposed mutation, why it is safe, what stays unchanged, and the expected outcome — plus a fingerprint
 * that binds a later execute to this exact state.
 */
export async function previewRepair(tx: DbTx, ctx: TenantContext, store: ObjectStore, documentId: string, target: RepairTarget): Promise<RepairPreview | null> {
  const v = await requireTargetVersion(tx, ctx, documentId, target.versionId);
  if (!v) return null; // existence-neutral: not this document / workspace
  const fingerprint = (await versionRepairFingerprint(tx, ctx, target.versionId))!;
  const base: RepairPreview = {
    type: 'rebuild_chunks', applicable: false, documentId, versionId: target.versionId,
    whatIsWrong: 'One or more stored text chunks no longer match their recorded manifest hash.',
    proposedMutation: 'Restore the affected chunk text from this version’s own retained, hash-verified bytes — chunk indexes, locators, hashes, and count are unchanged.',
    whySafe: 'The change is applied ONLY if re-parsing the exact retained source reproduces the historical chunk manifest identically; otherwise nothing is written.',
    whatUnchanged: 'Source bytes, the immutable version hash/objectKey/fidelity, chunk indexes/locators/hashes, historical snapshots, and disclosure are never modified.',
    expectation: 'refuse', fingerprint,
  };
  if (v.contentFidelity !== 'byte_exact' || !v.objectKey) return { ...base, refusalReason: 'This version has no retained exact bytes to rebuild from.' };

  const manifest = await tx.select({ id: documentChunks.id, chunkIndex: documentChunks.chunkIndex, content: documentChunks.content, contentHash: documentChunks.contentHash, parserVersion: documentChunks.parserVersion }).from(documentChunks).where(eq(documentChunks.documentVersionId, target.versionId)).orderBy(documentChunks.chunkIndex);
  if (manifest.length === 0) return { ...base, expectation: 'would_mark_degraded', refusalReason: 'No chunk manifest exists to prove an identical rebuild; the version would be marked index-degraded instead.' };
  if (manifest.some((m) => (m.parserVersion ?? REPAIR_PARSER) !== REPAIR_PARSER) || (v.parserVersion ?? REPAIR_PARSER) !== REPAIR_PARSER) return { ...base, expectation: 'would_mark_degraded', refusalReason: 'The parser version differs from the historical manifest; the version would be marked index-degraded instead.' };

  let bytes: Buffer;
  try {
    bytes = await store.get(v.objectKey);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) return { ...base, refusalReason: 'The retained source object is missing; there is nothing safe to rebuild from.' };
    return { ...base, refusalReason: 'Object storage was not reachable to preview this repair.' };
  }
  if (sha256Hex(bytes) !== v.sha256) return { ...base, refusalReason: 'The retained bytes do not match the recorded hash, so they cannot be trusted as the source of truth.' };

  const rebuilt = chunkText(bytes.toString('utf8'));
  const matches = rebuilt.length === manifest.length && manifest.every((m, i) => m.contentHash && m.contentHash === sha256Hex(Buffer.from(rebuilt[i]!, 'utf8')));
  if (!matches) return { ...base, expectation: 'would_mark_degraded', refusalReason: 'Re-parsing does not reproduce the historical manifest exactly; the version would be marked index-degraded instead of guessing.' };
  const anyDiff = manifest.some((m, i) => m.content !== rebuilt[i]);
  return { ...base, applicable: true, expectation: anyDiff ? 'would_repair' : 'already_consistent' };
}

/**
 * EXECUTE a previewed repair. Binds to the fingerprint observed at preview (refuses if the state changed),
 * runs the representation-safe rebuild, RE-RUNS the document-scoped integrity audit to verify the targeted
 * finding was resolved without introducing a higher-severity finding, and records append-only evidence.
 * Idempotent: a completed repair repeated makes no further change.
 */
export async function executeRepair(tx: DbTx, ctx: TenantContext, store: ObjectStore, documentId: string, target: RepairTarget, expectedFingerprint: string): Promise<RepairResult | null> {
  const v = await requireTargetVersion(tx, ctx, documentId, target.versionId);
  if (!v) return null;

  const nowFingerprint = await versionRepairFingerprint(tx, ctx, target.versionId);
  if (nowFingerprint !== expectedFingerprint) {
    // Concurrency: the observed state changed since preview → refuse (no mutation).
    return { type: 'rebuild_chunks', versionId: target.versionId, outcome: 'refused', detail: 'The document changed since the repair was previewed. Re-run the audit and preview again.', beforeOutcome: null, afterOutcome: null, targetedFindingResolved: false, broaderIntegrity: 'not_verified', regressed: false };
  }

  const before = await auditDocument(tx, ctx, store, documentId);
  const highBefore = countHigh(before);

  // Representation-safe rebuild; suppress its nested audit so this repair produces ONE canonical event.
  const rebuild = await rebuildVersionChunksFromBytes(tx, ctx, store, target.versionId, { recordAudit: false });

  const outcome: RepairOutcome =
    rebuild.state === 'repaired' ? 'repaired'
    : rebuild.state === 'no_change_needed' ? 'no_change_needed'
    : (rebuild.state === 'no_manifest' || rebuild.state === 'parser_mismatch' || rebuild.state === 'manifest_mismatch') ? 'marked_degraded'
    : 'refused';

  const after = await auditDocument(tx, ctx, store, documentId);
  // The targeted check (chunk content_hash vs text) is DB-only, so it stays reliable even when the broader
  // re-audit could not verify bytes. The broader dimension is reported SEPARATELY and never conflated.
  const targetedFindingResolved = !(after?.findings ?? []).some((f) => f.category === 'chunk_content_hash_mismatch' && f.versionId === target.versionId);
  const broaderIntegrity = (outcome === 'repaired' || outcome === 'no_change_needed') ? broaderIntegrityOf(after?.outcome ?? null) : 'not_verified';
  const regressed = countHigh(after) > highBefore;

  await writeAudit(tx, ctx, {
    action: 'document.repair_executed',
    entityType: 'document',
    entityId: documentId,
    // Metadata-only: identifiers, types, and before/after outcomes — never content, bytes, or raw paths.
    detail: { type: 'rebuild_chunks', versionId: target.versionId, outcome, rebuildState: rebuild.state, chunks: rebuild.chunks ?? null, beforeOutcome: before?.outcome ?? null, afterOutcome: after?.outcome ?? null, targetedFindingResolved, broaderIntegrity, regressed },
  });

  return {
    type: 'rebuild_chunks', versionId: target.versionId, outcome,
    detail: outcome === 'repaired' || outcome === 'no_change_needed'
      // Three honest, SEPARATE dimensions: what the repair did · the targeted finding · the broader re-audit.
      ? `${outcome === 'repaired' ? 'Chunk text restored from the version’s retained bytes' : 'The stored chunk text already matched the retained bytes'} and ${targetedFindingResolved ? 'the targeted finding was resolved' : 'the targeted finding was NOT resolved'}. ${broaderVerificationSentence(broaderIntegrity)}`
      : outcome === 'marked_degraded' ? 'A faithful rebuild could not be proven; the version was marked index-degraded rather than guessing.'
      : 'The repair was refused; nothing was changed.',
    beforeOutcome: before?.outcome ?? null, afterOutcome: after?.outcome ?? null, targetedFindingResolved, broaderIntegrity, regressed,
  };
}

/** Honest sentence for the broader (document-wide) re-audit dimension — never claims full restoration when limited/failed. */
export function broaderVerificationSentence(b: BroaderIntegrity): string {
  switch (b) {
    case 'healthy': return 'Broader integrity verification was healthy.';
    case 'other_findings_remain': return 'Broader integrity verification completed, but other unresolved findings remain.';
    case 'limited': return 'Broader integrity verification was limited.';
    case 'failed': return 'Broader integrity verification failed.';
    default: return 'Broader integrity was not verified.';
  }
}

function countHigh(a: DocumentIntegrityAudit | null): number {
  return (a?.findings ?? []).filter((f) => f.severity === 'high').length;
}
