import 'server-only';
import { and, eq, isNotNull } from 'drizzle-orm';
import { type ContentFidelity, type KnowledgeDisclosure, type TenantContext } from '@/types/domain';
import { type DbTx } from '@/db/client';
import { documentVersions, documents, knowledgeSources, projectMembers, runDocumentVersions } from '@/db/schema';

/**
 * Documents Portfolio (increment 1 of the interface). A SHARED, pure Document assessment + an
 * audience-safe aggregate loader. The Portfolio and (later) the Detail page consume `assessDocument`;
 * operational retrieval keeps its own domain contract and does NOT depend on these presentation groups.
 *
 * Principles:
 *  - Surfaces share the assessment; retrieval does not depend on presentation categories.
 *  - Audience-specific inventory is calculated from audience-visible records (restricted rows are dropped
 *    at the loader boundary for unauthorized viewers, and every count is computed AFTER that filtering).
 *  - Documents preserves source material; it does not establish that every claim within a source is true.
 */

export type CanonicalGroup = 'available' | 'processing' | 'unavailable' | 'historical';

export type LifecycleReason =
  | 'available'
  | 'available_newer_failed'
  | 'processing_upload'
  | 'indexing'
  | 'source_disconnected'
  | 'initial_indexing_failed'
  | 'unsupported_source'
  | 'no_current_version'
  | 'archived';

/** Operator-facing state wording — never a raw enum. */
export const STATE_LABEL: Record<LifecycleReason, string> = {
  available: 'Available',
  available_newer_failed: 'Available — newer version failed',
  processing_upload: 'Processing upload',
  indexing: 'Indexing',
  source_disconnected: 'Source disconnected',
  initial_indexing_failed: 'Initial indexing failed',
  unsupported_source: 'Unsupported source',
  no_current_version: 'No current version',
  archived: 'Archived',
};

/** Fidelity wording — "indexed" is never a substitute for fidelity. */
export const FIDELITY_LABEL: Record<ContentFidelity, string> = {
  byte_exact: 'Exact source retained',
  reconstructed_text: 'Reconstructed indexed text',
  unavailable: 'Source content unavailable',
};

export type AttentionCode =
  | 'initial_indexing_failed'
  | 'source_disconnected'
  | 'current_index_degraded'
  | 'reconstructed_evidence'
  | 'newer_version_failed';

export const ATTENTION_LABEL: Record<AttentionCode, string> = {
  initial_indexing_failed: 'Initial indexing failed — no usable version yet',
  source_disconnected: 'Linked source cannot currently be reached',
  current_index_degraded: 'Current version index is degraded',
  reconstructed_evidence: 'Reconstructed from indexed text; original bytes were not retained',
  newer_version_failed: 'A newer source version failed indexing; retrieval continues on the current version',
};

export type PortfolioLens = 'needs_attention' | 'restricted' | 'referenced_by_knowledge' | 'supplied_to_ai' | 'multiple_versions' | 'recently_changed' | 'integrity_concern';

export interface DocumentActionAvailability {
  retry: boolean;
  replace: boolean;
  /** Archive is a LOGICAL lifecycle action, available for either adapter (cloud or local) — a source's
   *  arrival channel does not redefine its lifecycle. */
  archive: boolean;
  /** Restore an intentionally-archived Document, also adapter-neutral (cloud completes immediately; local
   *  completes on the next refresh from a host that can reach the path). */
  restore: boolean;
  /** Classify an internal source as restricted (admin) — future disclosure authorization only; history intact. */
  restrict: boolean;
  /** Loosen a restricted source to internal (admin) — requires a reason at the server boundary. */
  declassify: boolean;
}

export interface PortfolioRecord {
  id: string;
  relativePath: string;
  source: string;
  group: CanonicalGroup;
  lifecycleReason: LifecycleReason;
  stateLabel: string;
  /** Current-version fidelity when there is a current version; else the latest observed version's. */
  fidelity: ContentFidelity | null;
  fidelityLabel: string | null;
  /** Present only for audience-visible records (the loader drops restricted rows for the unauthorized). */
  classification: KnowledgeDisclosure;
  versionCount: number;
  knowledgeRefCount: number;
  aiOperationCount: number;
  indexedAt: Date | null;
  /** A newer version than the current one exists in this state (informational). */
  newerVersionState: 'failed' | 'pending' | null;
  attention: { code: AttentionCode; label: string }[];
  lenses: PortfolioLens[];
  actions: DocumentActionAvailability;
}

/** The immutable facts one Document contributes, pre-aggregated (no per-record queries). */
export interface DocumentAssessmentInput {
  id: string;
  relativePath: string;
  source: string;
  status: string;
  disclosure: KnowledgeDisclosure;
  currentVersionId: string | null;
  indexedAt: Date | null;
  /** The current version's health (null when there is no current version row). */
  currentVersion: { id: string; contentFidelity: ContentFidelity; indexStatus: string; indexDegraded: boolean } | null;
  /** The most recently CREATED version (to detect a newer failed/pending version than current). */
  latestVersion: { id: string; contentFidelity: ContentFidelity; indexStatus: string; createdAt: Date } | null;
  versionCount: number;
  knowledgeRefCount: number;
  aiOperationCount: number;
  /** The most recent TRUSTWORTHY source-change time (see `latestSourceChangeAt`) — for the "recently
   *  changed" lens. Null when no genuine source change is known (e.g. only backfilled versions exist);
   *  infrastructure migration never makes a Document look recently changed. */
  lastSourceChangeAt: Date | null;
  viewerIsAdmin: boolean;
}

const RECENTLY_CHANGED_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The most recent time this Document's SOURCE MATERIAL genuinely changed, or null if unknown. A version
 * contributes a change time ONLY when it was created by a real ingestion observation — its `sourceChangeAt`
 * is set (preferring the source's own modified time, else the observation time). A version created by
 * infrastructure backfill / migration has `sourceChangeAt = null` and never counts: creating a retained
 * version row is not a business-source change. Re-observing the same content creates no new version, so it
 * advances nothing. Pure and deterministic — the sole input to the "recently changed" lens.
 */
export function latestSourceChangeAt(versions: ReadonlyArray<{ sourceChangeAt: Date | null }>): Date | null {
  let latest: Date | null = null;
  for (const v of versions) {
    if (v.sourceChangeAt && (!latest || v.sourceChangeAt > latest)) latest = v.sourceChangeAt;
  }
  return latest;
}

/**
 * Pure Document assessment. Derives the canonical group, a specific lifecycle reason, fidelity,
 * classification, attention reasons, reference summary, and permitted actions — with no I/O and no
 * dependency on retrieval. `now` is injected for deterministic "recently changed".
 */
export function assessDocument(d: DocumentAssessmentInput, now: Date): PortfolioRecord {
  const currentValid = !!d.currentVersion && d.currentVersion.id === d.currentVersionId && d.currentVersion.indexStatus === 'indexed';
  // A newer version than the current one (by creation) that is failed/pending — informational, and (for
  // failed) an attention reason. Never demotes a usable Document.
  const newerVersionState: 'failed' | 'pending' | null =
    currentValid && d.latestVersion && d.latestVersion.id !== d.currentVersionId
      ? d.latestVersion.indexStatus === 'failed'
        ? 'failed'
        : d.latestVersion.indexStatus === 'pending'
          ? 'pending'
          : null
      : null;

  let group: CanonicalGroup;
  let lifecycleReason: LifecycleReason;
  if (d.status === 'archived') {
    group = 'historical';
    lifecycleReason = 'archived';
  } else if (currentValid) {
    group = 'available';
    lifecycleReason = newerVersionState === 'failed' ? 'available_newer_failed' : 'available';
  } else if (d.status === 'uploaded' || d.status === 'queued') {
    group = 'processing';
    lifecycleReason = 'processing_upload';
  } else if (d.status === 'indexing') {
    group = 'processing';
    lifecycleReason = 'indexing';
  } else if (d.status === 'source_unavailable') {
    group = 'unavailable';
    lifecycleReason = 'source_disconnected';
  } else if (d.status === 'failed') {
    group = 'unavailable';
    lifecycleReason = 'initial_indexing_failed';
  } else if (d.status === 'unsupported') {
    group = 'unavailable';
    lifecycleReason = 'unsupported_source';
  } else {
    group = 'unavailable';
    lifecycleReason = 'no_current_version';
  }

  const fidelity: ContentFidelity | null = d.currentVersion?.contentFidelity ?? d.latestVersion?.contentFidelity ?? null;

  const attention: PortfolioRecord['attention'] = [];
  const addAttention = (code: AttentionCode) => attention.push({ code, label: ATTENTION_LABEL[code] });
  if (lifecycleReason === 'initial_indexing_failed') addAttention('initial_indexing_failed');
  if (lifecycleReason === 'source_disconnected') addAttention('source_disconnected');
  if (currentValid && d.currentVersion!.indexDegraded) addAttention('current_index_degraded');
  if (currentValid && d.currentVersion!.contentFidelity === 'reconstructed_text') addAttention('reconstructed_evidence');
  if (newerVersionState === 'failed') addAttention('newer_version_failed');

  const lenses: PortfolioLens[] = [];
  if (attention.length > 0) lenses.push('needs_attention');
  if (d.disclosure === 'restricted') lenses.push('restricted');
  if (d.knowledgeRefCount > 0) lenses.push('referenced_by_knowledge');
  if (d.aiOperationCount > 0) lenses.push('supplied_to_ai');
  if (d.versionCount > 1) lenses.push('multiple_versions');
  if (d.lastSourceChangeAt && now.getTime() - d.lastSourceChangeAt.getTime() <= RECENTLY_CHANGED_MS) lenses.push('recently_changed');
  if (currentValid && d.currentVersion!.indexDegraded) lenses.push('integrity_concern');

  // Retry/replace are cloud-specific ingestion capabilities (re-enqueue a cloud job / upload a new cloud
  // file); a local source re-ingests through folder refresh, not per-row buttons. Archive and restore are
  // LOGICAL lifecycle actions and are adapter-neutral — the source adapter determines ingestion, not
  // lifecycle. The server re-checks authorization + lifecycle on every action; these flags only gate the UI.
  const isCloud = d.source === 'cloud_upload';
  const actions: DocumentActionAvailability = {
    retry: isCloud && d.viewerIsAdmin && (d.status === 'failed' || d.status === 'source_unavailable'),
    // Replacement must NOT be an alternate restore path: an intentionally-archived source cannot be
    // replaced until it is explicitly restored (restore stays the one way back to active).
    replace: isCloud && d.viewerIsAdmin && d.status !== 'archived',
    archive: d.viewerIsAdmin && d.status !== 'archived',
    restore: d.viewerIsAdmin && d.status === 'archived',
    // Classification changes are admin-only and independent of lifecycle group. Server re-checks + audits.
    restrict: d.viewerIsAdmin && d.disclosure === 'workspace_internal',
    declassify: d.viewerIsAdmin && d.disclosure === 'restricted',
  };

  return {
    id: d.id,
    relativePath: d.relativePath,
    source: d.source,
    group,
    lifecycleReason,
    stateLabel: STATE_LABEL[lifecycleReason],
    fidelity,
    fidelityLabel: fidelity ? FIDELITY_LABEL[fidelity] : null,
    classification: d.disclosure,
    versionCount: d.versionCount,
    knowledgeRefCount: d.knowledgeRefCount,
    aiOperationCount: d.aiOperationCount,
    indexedAt: d.indexedAt,
    newerVersionState,
    attention,
    lenses,
    actions,
  };
}

export interface PortfolioView {
  isMember: boolean;
  viewerIsAdmin: boolean;
  groups: Record<CanonicalGroup, PortfolioRecord[]>;
  groupCounts: Record<CanonicalGroup, number>;
  lensCounts: Record<PortfolioLens, number>;
  total: number;
}

function emptyGroups(): Record<CanonicalGroup, PortfolioRecord[]> {
  return { available: [], processing: [], unavailable: [], historical: [] };
}

/** Whether this viewer may receive restricted Portfolio metadata (conservative v1: owner or project admin). */
function viewerMaySeeRestricted(ctx: TenantContext): boolean {
  return ctx.orgRole === 'owner' || ctx.projectRole === 'admin';
}

/**
 * Audience-safe aggregate Portfolio loader. Verifies membership, loads bounded per-Document facts in a
 * handful of bulk queries (no N+1, no object I/O), DROPS restricted Documents for an unauthorized viewer
 * BEFORE assessment, and computes every group/lens count from the audience-visible set only.
 */
export async function loadDocumentPortfolio(tx: DbTx, ctx: TenantContext, now: Date = new Date()): Promise<PortfolioView> {
  const viewerIsAdmin = ctx.projectRole === 'admin';
  const canSeeRestricted = viewerMaySeeRestricted(ctx);

  const member = (
    await tx.select({ userId: projectMembers.userId }).from(projectMembers).where(and(eq(projectMembers.projectId, ctx.projectId), eq(projectMembers.orgId, ctx.orgId), eq(projectMembers.userId, ctx.userId))).limit(1)
  )[0];
  if (!member) {
    return { isMember: false, viewerIsAdmin: false, groups: emptyGroups(), groupCounts: { available: 0, processing: 0, unavailable: 0, historical: 0 }, lensCounts: emptyLensCounts(), total: 0 };
  }

  const docs = await tx
    .select({ id: documents.id, relativePath: documents.relativePath, source: documents.source, status: documents.status, disclosure: documents.disclosure, currentVersionId: documents.currentVersionId, indexedAt: documents.indexedAt })
    .from(documents)
    .where(and(eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId)));

  // AUDIENCE FILTER FIRST: an unauthorized viewer never receives a restricted Document's identity or any
  // fact derived from it. Everything below aggregates over the visible set only.
  const visible = canSeeRestricted ? docs : docs.filter((d) => d.disclosure !== 'restricted');
  const visibleIds = new Set(visible.map((d) => d.id));
  if (visible.length === 0) {
    return { isMember: true, viewerIsAdmin, groups: emptyGroups(), groupCounts: { available: 0, processing: 0, unavailable: 0, historical: 0 }, lensCounts: emptyLensCounts(), total: 0 };
  }

  // Bulk-load all versions for the visible Documents.
  const versions = await tx
    .select({ id: documentVersions.id, documentId: documentVersions.documentId, contentFidelity: documentVersions.contentFidelity, indexStatus: documentVersions.indexStatus, indexDegraded: documentVersions.indexDegraded, createdAt: documentVersions.createdAt, sourceChangeAt: documentVersions.sourceChangeAt })
    .from(documentVersions)
    .where(and(eq(documentVersions.orgId, ctx.orgId), eq(documentVersions.projectId, ctx.projectId)));
  const versionsByDoc = new Map<string, typeof versions>();
  const versionToDoc = new Map<string, string>();
  for (const v of versions) {
    if (!visibleIds.has(v.documentId)) continue;
    versionToDoc.set(v.id, v.documentId);
    const arr = versionsByDoc.get(v.documentId) ?? [];
    arr.push(v);
    versionsByDoc.set(v.documentId, arr);
  }

  // Knowledge references: distinct knowledge_sources EXPLICITLY bound to one of this Document's versions.
  const kRefs = await tx
    .select({ id: knowledgeSources.id, documentVersionId: knowledgeSources.documentVersionId })
    .from(knowledgeSources)
    .where(and(eq(knowledgeSources.orgId, ctx.orgId), eq(knowledgeSources.projectId, ctx.projectId), isNotNull(knowledgeSources.documentVersionId)));
  const knowledgeCountByDoc = new Map<string, number>();
  for (const k of kRefs) {
    const docId = k.documentVersionId ? versionToDoc.get(k.documentVersionId) : undefined;
    if (docId) knowledgeCountByDoc.set(docId, (knowledgeCountByDoc.get(docId) ?? 0) + 1);
  }

  // AI operations: DISTINCT runs that received evidence from any of this Document's versions (deduped).
  const runRefs = await tx
    .select({ runId: runDocumentVersions.runId, documentVersionId: runDocumentVersions.documentVersionId })
    .from(runDocumentVersions)
    .where(and(eq(runDocumentVersions.orgId, ctx.orgId), eq(runDocumentVersions.projectId, ctx.projectId)));
  const runsByDoc = new Map<string, Set<string>>();
  for (const r of runRefs) {
    const docId = versionToDoc.get(r.documentVersionId);
    if (!docId) continue;
    const set = runsByDoc.get(docId) ?? new Set<string>();
    set.add(r.runId);
    runsByDoc.set(docId, set);
  }

  const groups = emptyGroups();
  const lensCounts = emptyLensCounts();
  for (const d of visible) {
    const vs = versionsByDoc.get(d.id) ?? [];
    const currentVersion = d.currentVersionId ? vs.find((v) => v.id === d.currentVersionId) ?? null : null;
    const latestVersion = vs.length > 0 ? vs.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)) : null;
    const record = assessDocument(
      {
        id: d.id,
        relativePath: d.relativePath,
        source: d.source,
        status: d.status,
        disclosure: d.disclosure,
        currentVersionId: d.currentVersionId,
        indexedAt: d.indexedAt,
        currentVersion: currentVersion ? { id: currentVersion.id, contentFidelity: currentVersion.contentFidelity, indexStatus: currentVersion.indexStatus, indexDegraded: currentVersion.indexDegraded } : null,
        latestVersion: latestVersion ? { id: latestVersion.id, contentFidelity: latestVersion.contentFidelity, indexStatus: latestVersion.indexStatus, createdAt: latestVersion.createdAt } : null,
        versionCount: vs.length,
        knowledgeRefCount: knowledgeCountByDoc.get(d.id) ?? 0,
        aiOperationCount: runsByDoc.get(d.id)?.size ?? 0,
        lastSourceChangeAt: latestSourceChangeAt(vs),
        viewerIsAdmin,
      },
      now,
    );
    groups[record.group].push(record);
    for (const lens of record.lenses) lensCounts[lens] += 1;
  }
  for (const g of Object.values(groups)) g.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return {
    isMember: true,
    viewerIsAdmin,
    groups,
    groupCounts: { available: groups.available.length, processing: groups.processing.length, unavailable: groups.unavailable.length, historical: groups.historical.length },
    lensCounts,
    total: visible.length,
  };
}

function emptyLensCounts(): Record<PortfolioLens, number> {
  return { needs_attention: 0, restricted: 0, referenced_by_knowledge: 0, supplied_to_ai: 0, multiple_versions: 0, recently_changed: 0, integrity_concern: 0 };
}
