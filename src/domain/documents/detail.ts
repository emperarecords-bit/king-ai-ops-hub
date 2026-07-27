import 'server-only';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { type ContentFidelity, type KnowledgeDisclosure, type TenantContext } from '@/types/domain';
import { type DbTx } from '@/db/client';
import { agents, auditLogs, documentVersionTombstones, documentVersions, documents, knowledgeItems, knowledgeSources, knowledgeVerificationEvents, runDocumentVersions, runs } from '@/db/schema';
import {
  type CanonicalGroup,
  type DocumentActionAvailability,
  FIDELITY_LABEL,
  assessDocument,
} from './portfolio';
import {
  type ClassificationAcrossTime,
  assessDocumentViewerAccess,
  classificationAcrossTime,
} from './viewer-access';

/**
 * Documents Detail — the SHARED, audience-safe read-only Detail loader (increment 2, Part 1). It answers
 * the Detail primary question — "what exactly is this source, which version am I inspecting, who may access
 * it, what relies on it, and what actions are safe now?" — by COMPOSING the established surfaces rather than
 * re-deciding anything:
 *   - access is decided ONCE by `assessDocumentViewerAccess` (current logical disclosure; role-based; never
 *     an AI grant). A component or client can never select its own access decision.
 *   - lifecycle/state/fidelity/attention/actions come from the shared `assessDocument`.
 *   - classification-across-time comes from `classificationAcrossTime` (four distinct facts kept apart).
 *   - evidence RELEASE (preview/bytes/download/chunks) is NOT performed here — this loader reports only what
 *     the viewer MAY inspect; the actual release goes through the shared gated `loadInspectableVersion` in
 *     the Part-2 route, so a direct URL can never bypass authorization or auditing.
 *
 * Principles carried forward:
 *   - Audience-specific inventory/metadata is calculated from audience-visible records: an unauthorized
 *     viewer receives a bounded denial that reveals neither the source's existence nor any of its metadata.
 *   - Current Document state and historical version state are separate.
 *   - Infrastructure migration is not a source change: version-row creation time is NEVER presented as a
 *     source-change time.
 *   - Attachment does not establish support: a Knowledge relationship is "relied upon" only where a support
 *     judgment recorded it; otherwise it is supplemental.
 *   - "Supplied," never "used/followed/influenced," for run relationships.
 */

export type DetailAccessReason = 'not_a_member' | 'restricted_not_permitted';

/** Existence-neutral denial — carries no identity, path, metadata, or aggregate counts. */
export interface DocumentDetailDenied {
  found: false;
  reason: DetailAccessReason;
  message: string;
}

export type InspectCapabilityReason = 'ok' | 'unauthorized' | 'unavailable' | 'not_indexed' | 'tombstoned';

/** What a viewer MAY inspect for a version — capability only; release happens through the gated loader. */
export interface VersionInspectionCapability {
  canInspect: boolean;
  /** Text/preview is available (byte_exact or reconstructed_text, indexed, authorized). */
  preview: boolean;
  /** Exact original bytes may be downloaded (byte_exact only). Reconstructed text is never a fake original. */
  download: boolean;
  reason: InspectCapabilityReason;
}

export interface DetailVersion {
  id: string;
  /** 1 = oldest observed … deterministic (createdAt, then id) — a stable reading order, not a change claim. */
  ordinal: number;
  isCurrent: boolean;
  isLatestObserved: boolean;
  isLatestSuccessful: boolean;
  /** Created after the current version (a newer observation) — informational; never demotes the current. */
  newerThanCurrent: boolean;
  fidelity: ContentFidelity;
  fidelityLabel: string;
  indexStatus: string;
  indexDegraded: boolean;
  /** Trustworthy source-change time (null when unknown). NEVER the version-row creation time. */
  sourceChangeAt: Date | null;
  ingestedAt: Date | null;
  /** Version-row creation — technical provenance behind progressive disclosure, not a source-change claim. */
  createdAt: Date;
  /** Historical classification recorded AT INGEST — never rewritten by a later reclassification. */
  disclosureSnapshot: KnowledgeDisclosure;
  /** Exact content identity — authorized viewers only; the UI reveals it via progressive disclosure. */
  versionHash: string | null;
  tombstoned: boolean;
  inspect: VersionInspectionCapability;
  /** RECORDED integrity conditions only (no object I/O here) — a full store audit is a later on-demand action. */
  integrity: { degraded: boolean; byteExactMissingObject: boolean };
}

export interface DetailKnowledgeRef {
  knowledgeSourceId: string;
  knowledgeItemId: string;
  knowledgeItemTitle: string;
  knowledgeVersion: number;
  /** The transformation role recorded on the citation: quoted | extracted | summarized | inferred. */
  role: string;
  /** Recorded as relied-upon in a support judgment for this item (else supplemental — attachment alone
   *  never establishes support). */
  reliedUpon: boolean;
  /** The exact immutable version the citation is bound to (null: cited version predates versioning). */
  documentVersionId: string | null;
  versionHash: string | null;
  /** Whether that exact cited version is currently inspectable to this viewer. */
  currentlyInspectable: boolean;
}

export interface DetailRunVersionSupply {
  documentVersionId: string;
  versionHash: string | null;
  /** Distinct supplied CHUNKS (excludes the version-level sentinel) — a "supplied chunk summary". */
  suppliedChunkCount: number;
  /** The disclosure classification recorded AT DISPATCH — a historical fact. */
  dispatchDisclosureSnapshot: KnowledgeDisclosure;
}

/** One AI operation (run) that was SUPPLIED evidence from this Document — deduplicated by run. */
export interface DetailRunRef {
  runId: string;
  runStatus: string;
  /** When the run was dispatched. */
  dispatchAt: Date | null;
  /** Provider/model of the primary agent (member-visible provenance). Null when not recorded. */
  provider: string | null;
  model: string | null;
  /** The exact version(s) of THIS Document supplied to the run (evidence remains even if the run failed). */
  suppliedVersions: DetailRunVersionSupply[];
}

export interface DetailHistoryEntry {
  action: string;
  at: Date;
  actorId: string | null;
  /** Technical detail behind progressive disclosure. */
  detail: unknown;
}

export interface DocumentDetail {
  found: true;
  /** Whether this Document is currently restricted, and whether this viewer is cleared for restricted content. */
  restricted: boolean;
  viewerCanInspectRestricted: boolean;
  // 1. Source identity
  identity: {
    documentId: string;
    relativePath: string;
    source: string;
    kind: string;
    lifecycleGroup: CanonicalGroup;
    stateLabel: string;
    classification: KnowledgeDisclosure;
    /** Whether the source is currently reachable/usable (not source_unavailable). */
    sourceConnected: boolean;
  };
  // 2. Current version — the four distinct facts kept apart
  current: {
    versionId: string | null;
    fidelity: ContentFidelity | null;
    fidelityLabel: string | null;
    indexStatus: string | null;
    indexDegraded: boolean;
    sourceModifiedAt: Date | null;
    ingestedAt: Date | null;
    versionHash: string | null;
    /** A newer version than current exists in this state (informational). */
    newerVersion: 'failed' | 'pending' | null;
    latestObservedVersionId: string | null;
    latestSuccessfulVersionId: string | null;
  };
  // 5. Classification across time (for the current version)
  classification: ClassificationAcrossTime;
  // 3. Version history
  versions: DetailVersion[];
  // 6. Knowledge relationships (explicit, version-bound)
  knowledge: DetailKnowledgeRef[];
  // 7. AI operation relationships (deduplicated by run; "supplied")
  aiOperations: DetailRunRef[];
  aiOperationCount: number;
  // 9. Audit & lifecycle history
  history: DetailHistoryEntry[];
  /** Attention reasons (shared assessment). */
  attention: { code: string; label: string }[];
  /** Safe lifecycle actions (shared assessment): retry/replace/archive/restore. Privileged Detail actions
   *  (integrity execution, purge) are NOT part of this increment. */
  actions: DocumentActionAvailability;
}

export type DocumentDetailView = DocumentDetail | DocumentDetailDenied;

const DENIAL_MESSAGE = 'This source is not available to your account.';

function inspectCapability(
  v: { fidelity: ContentFidelity; indexStatus: string; objectKey: string | null },
  authorized: boolean,
  tombstoned: boolean,
): VersionInspectionCapability {
  if (tombstoned) return { canInspect: false, preview: false, download: false, reason: 'tombstoned' };
  if (!authorized) return { canInspect: false, preview: false, download: false, reason: 'unauthorized' };
  if (v.fidelity === 'unavailable') return { canInspect: false, preview: false, download: false, reason: 'unavailable' };
  if (v.indexStatus !== 'indexed') return { canInspect: false, preview: false, download: false, reason: 'not_indexed' };
  if (v.fidelity === 'byte_exact') return { canInspect: true, preview: true, download: true, reason: 'ok' };
  // reconstructed_text — indexed text may be previewed; the original bytes are never downloadable.
  return { canInspect: true, preview: true, download: false, reason: 'ok' };
}

/**
 * Load the audience-safe read-only Detail view for one Document. Decides access ONCE (never re-decided by a
 * caller), and on denial returns a bounded, existence-neutral result carrying no identity or metadata. On
 * success, loads the Document's facts in a bounded set of bulk queries (no N+1, no object I/O), reusing the
 * shared assessment for lifecycle/actions and the classification-across-time helper. Evidence RELEASE is not
 * performed here — `inspect` capability flags say only what MAY be inspected; the gated route releases it.
 */
export async function loadDocumentDetail(tx: DbTx, ctx: TenantContext, documentId: string): Promise<DocumentDetailView> {
  // Access is decided by the shared authorization surface (membership + current logical disclosure). A
  // non-member or an ordinary member facing a restricted source gets a bounded denial that never reveals
  // whether the source exists.
  const access = await assessDocumentViewerAccess(tx, ctx, documentId);
  if (!access.canInspect) {
    return { found: false, reason: access.reason as DetailAccessReason, message: DENIAL_MESSAGE };
  }

  const doc = (
    await tx
      .select({
        id: documents.id,
        relativePath: documents.relativePath,
        source: documents.source,
        kind: documents.kind,
        status: documents.status,
        disclosure: documents.disclosure,
        currentVersionId: documents.currentVersionId,
        indexedAt: documents.indexedAt,
        sourceModifiedAt: documents.sourceModifiedAt,
      })
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId)))
      .limit(1)
  )[0];
  // assessDocumentViewerAccess already proved membership + existence; a race here is treated as denial.
  if (!doc) return { found: false, reason: 'not_a_member', message: DENIAL_MESSAGE };

  const versionRows = await tx
    .select({
      id: documentVersions.id,
      documentId: documentVersions.documentId,
      sha256: documentVersions.sha256,
      objectKey: documentVersions.objectKey,
      contentFidelity: documentVersions.contentFidelity,
      indexStatus: documentVersions.indexStatus,
      indexDegraded: documentVersions.indexDegraded,
      disclosureSnapshot: documentVersions.disclosureSnapshot,
      sourceChangeAt: documentVersions.sourceChangeAt,
      ingestedAt: documentVersions.ingestedAt,
      createdAt: documentVersions.createdAt,
    })
    .from(documentVersions)
    .where(and(eq(documentVersions.orgId, ctx.orgId), eq(documentVersions.projectId, ctx.projectId), eq(documentVersions.documentId, documentId)));

  const versionIds = versionRows.map((v) => v.id);
  const tombstoneVersionIds = new Set<string>();
  if (versionIds.length > 0) {
    const tombs = await tx
      .select({ versionId: documentVersionTombstones.versionId })
      .from(documentVersionTombstones)
      .where(and(eq(documentVersionTombstones.orgId, ctx.orgId), eq(documentVersionTombstones.projectId, ctx.projectId), inArray(documentVersionTombstones.versionId, versionIds)));
    for (const t of tombs) tombstoneVersionIds.add(t.versionId);
  }

  // Deterministic reading order: oldest first by (createdAt, id). Stable — never a source-change claim.
  const ordered = [...versionRows].sort((a, b) => (a.createdAt.getTime() - b.createdAt.getTime()) || a.id.localeCompare(b.id));
  const currentVersion = doc.currentVersionId ? versionRows.find((v) => v.id === doc.currentVersionId) ?? null : null;
  const currentValid = !!currentVersion && currentVersion.indexStatus === 'indexed';
  const latestObserved = ordered.length > 0 ? ordered[ordered.length - 1]! : null;
  const latestSuccessful = [...ordered].reverse().find((v) => v.indexStatus === 'indexed') ?? null;
  const currentCreatedAt = currentVersion?.createdAt ?? null;
  // A newer-than-current version that is failed/pending (informational; never demotes a usable current).
  let newerVersion: 'failed' | 'pending' | null = null;
  if (currentValid && latestObserved && latestObserved.id !== currentVersion!.id && currentCreatedAt && latestObserved.createdAt > currentCreatedAt) {
    if (latestObserved.indexStatus === 'failed') newerVersion = 'failed';
    else if (latestObserved.indexStatus === 'pending') newerVersion = 'pending';
  }

  const versions: DetailVersion[] = ordered.map((v, i) => {
    const tombstoned = tombstoneVersionIds.has(v.id);
    const inspect = inspectCapability({ fidelity: v.contentFidelity, indexStatus: v.indexStatus, objectKey: v.objectKey }, true, tombstoned);
    return {
      id: v.id,
      ordinal: i + 1,
      isCurrent: v.id === doc.currentVersionId,
      isLatestObserved: latestObserved?.id === v.id,
      isLatestSuccessful: latestSuccessful?.id === v.id,
      newerThanCurrent: !!currentCreatedAt && v.createdAt > currentCreatedAt && v.id !== doc.currentVersionId,
      fidelity: v.contentFidelity,
      fidelityLabel: FIDELITY_LABEL[v.contentFidelity],
      indexStatus: v.indexStatus,
      indexDegraded: v.indexDegraded,
      sourceChangeAt: v.sourceChangeAt,
      ingestedAt: v.ingestedAt,
      createdAt: v.createdAt,
      disclosureSnapshot: v.disclosureSnapshot,
      versionHash: v.sha256,
      tombstoned,
      inspect,
      integrity: { degraded: v.indexDegraded, byteExactMissingObject: v.contentFidelity === 'byte_exact' && !v.objectKey },
    };
  });

  // ---- Knowledge relationships (explicit, version-bound) ------------------------------------------
  const knowledge: DetailKnowledgeRef[] = [];
  if (versionIds.length > 0) {
    const ks = await tx
      .select({
        id: knowledgeSources.id,
        knowledgeItemId: knowledgeSources.knowledgeItemId,
        knowledgeVersion: knowledgeSources.knowledgeVersion,
        transformation: knowledgeSources.transformation,
        documentVersionId: knowledgeSources.documentVersionId,
      })
      .from(knowledgeSources)
      .where(and(eq(knowledgeSources.orgId, ctx.orgId), eq(knowledgeSources.projectId, ctx.projectId), inArray(knowledgeSources.documentVersionId, versionIds)));

    const itemIds = [...new Set(ks.map((k) => k.knowledgeItemId))];
    const titleById = new Map<string, string>();
    const reliedSourceIds = new Set<string>();
    if (itemIds.length > 0) {
      const items = await tx
        .select({ id: knowledgeItems.id, title: knowledgeItems.title })
        .from(knowledgeItems)
        .where(and(eq(knowledgeItems.orgId, ctx.orgId), eq(knowledgeItems.projectId, ctx.projectId), inArray(knowledgeItems.id, itemIds)));
      for (const it of items) titleById.set(it.id, it.title);
      // Relied-upon status is a RECORDED support judgment (never inferred from attachment).
      const events = await tx
        .select({ reliedOnSourceIds: knowledgeVerificationEvents.reliedOnSourceIds })
        .from(knowledgeVerificationEvents)
        .where(and(eq(knowledgeVerificationEvents.orgId, ctx.orgId), eq(knowledgeVerificationEvents.projectId, ctx.projectId), inArray(knowledgeVerificationEvents.knowledgeItemId, itemIds)));
      for (const e of events) for (const id of e.reliedOnSourceIds ?? []) reliedSourceIds.add(id);
    }
    const hashByVersion = new Map(versionRows.map((v) => [v.id, v.sha256] as const));
    const inspectableByVersion = new Map(versions.map((v) => [v.id, v.inspect.canInspect] as const));
    for (const k of ks) {
      knowledge.push({
        knowledgeSourceId: k.id,
        knowledgeItemId: k.knowledgeItemId,
        knowledgeItemTitle: titleById.get(k.knowledgeItemId) ?? '(unknown)',
        knowledgeVersion: k.knowledgeVersion,
        role: k.transformation,
        reliedUpon: reliedSourceIds.has(k.id),
        documentVersionId: k.documentVersionId,
        versionHash: k.documentVersionId ? hashByVersion.get(k.documentVersionId) ?? null : null,
        currentlyInspectable: k.documentVersionId ? inspectableByVersion.get(k.documentVersionId) ?? false : false,
      });
    }
  }

  // ---- AI operation relationships (deduplicated by run; "supplied") ------------------------------
  const aiOperations: DetailRunRef[] = [];
  if (versionIds.length > 0) {
    const rdv = await tx
      .select({
        runId: runDocumentVersions.runId,
        documentVersionId: runDocumentVersions.documentVersionId,
        chunkIndex: runDocumentVersions.chunkIndex,
        disclosureSnapshot: runDocumentVersions.disclosureSnapshot,
      })
      .from(runDocumentVersions)
      .where(and(eq(runDocumentVersions.orgId, ctx.orgId), eq(runDocumentVersions.projectId, ctx.projectId), inArray(runDocumentVersions.documentVersionId, versionIds)));

    // Group by run, then by version — dedup by run so one run that cited a version via a version-level row
    // and several chunk rows is ONE AI operation, not four.
    const byRun = new Map<string, Map<string, { chunks: number; disclosure: KnowledgeDisclosure }>>();
    for (const r of rdv) {
      const perVersion = byRun.get(r.runId) ?? new Map();
      const entry = perVersion.get(r.documentVersionId) ?? { chunks: 0, disclosure: r.disclosureSnapshot as KnowledgeDisclosure };
      if (r.chunkIndex >= 0) entry.chunks += 1; // -1 is the version-level sentinel, not a supplied chunk
      perVersion.set(r.documentVersionId, entry);
      byRun.set(r.runId, perVersion);
    }
    const runIds = [...byRun.keys()];
    if (runIds.length > 0) {
      const runRows = await tx
        .select({ id: runs.id, status: runs.status, startedAt: runs.startedAt, primaryAgentId: runs.primaryAgentId, provider: agents.provider, model: agents.model })
        .from(runs)
        .leftJoin(agents, eq(runs.primaryAgentId, agents.id))
        .where(and(eq(runs.orgId, ctx.orgId), eq(runs.projectId, ctx.projectId), inArray(runs.id, runIds)));
      const runMeta = new Map(runRows.map((r) => [r.id, r] as const));
      const hashByVersion = new Map(versionRows.map((v) => [v.id, v.sha256] as const));
      for (const [runId, perVersion] of byRun) {
        const meta = runMeta.get(runId);
        aiOperations.push({
          runId,
          runStatus: meta?.status ?? 'unknown',
          dispatchAt: meta?.startedAt ?? null,
          provider: meta?.provider ?? null,
          model: meta?.model ?? null,
          suppliedVersions: [...perVersion.entries()].map(([vid, e]) => ({
            documentVersionId: vid,
            versionHash: hashByVersion.get(vid) ?? null,
            suppliedChunkCount: e.chunks,
            dispatchDisclosureSnapshot: e.disclosure,
          })),
        });
      }
      aiOperations.sort((a, b) => (b.dispatchAt?.getTime() ?? 0) - (a.dispatchAt?.getTime() ?? 0) || a.runId.localeCompare(b.runId));
    }
  }

  // ---- Audit & lifecycle history -----------------------------------------------------------------
  const historyRows = await tx
    .select({ action: auditLogs.action, at: auditLogs.createdAt, actorId: auditLogs.actorId, detail: auditLogs.detail })
    .from(auditLogs)
    .where(and(eq(auditLogs.orgId, ctx.orgId), eq(auditLogs.projectId, ctx.projectId), eq(auditLogs.entityType, 'document'), eq(auditLogs.entityId, documentId)))
    .orderBy(desc(auditLogs.createdAt))
    .limit(200);
  const history: DetailHistoryEntry[] = historyRows.map((h) => ({ action: h.action, at: h.at, actorId: h.actorId, detail: h.detail }));

  // ---- Shared assessment (lifecycle/state/attention/actions) -------------------------------------
  const knowledgeRefCount = knowledge.length;
  const record = assessDocument(
    {
      id: doc.id,
      relativePath: doc.relativePath,
      source: doc.source,
      status: doc.status,
      disclosure: doc.disclosure,
      currentVersionId: doc.currentVersionId,
      indexedAt: doc.indexedAt,
      currentVersion: currentVersion
        ? { id: currentVersion.id, contentFidelity: currentVersion.contentFidelity, indexStatus: currentVersion.indexStatus, indexDegraded: currentVersion.indexDegraded }
        : null,
      latestVersion: latestObserved
        ? { id: latestObserved.id, contentFidelity: latestObserved.contentFidelity, indexStatus: latestObserved.indexStatus, createdAt: latestObserved.createdAt }
        : null,
      versionCount: versionRows.length,
      knowledgeRefCount,
      aiOperationCount: aiOperations.length,
      lastSourceChangeAt: null, // not needed for Detail (no "recently changed" lens on the Detail surface)
      viewerIsAdmin: ctx.projectRole === 'admin',
    },
    new Date(),
  );

  return {
    found: true,
    restricted: access.restricted,
    viewerCanInspectRestricted: access.canInspect && access.restricted,
    identity: {
      documentId: doc.id,
      relativePath: doc.relativePath,
      source: doc.source,
      kind: doc.kind,
      lifecycleGroup: record.group,
      stateLabel: record.stateLabel,
      classification: doc.disclosure,
      sourceConnected: doc.status !== 'source_unavailable',
    },
    current: {
      versionId: currentValid ? currentVersion!.id : null,
      fidelity: currentVersion?.contentFidelity ?? null,
      fidelityLabel: currentVersion ? FIDELITY_LABEL[currentVersion.contentFidelity] : null,
      indexStatus: currentVersion?.indexStatus ?? null,
      indexDegraded: currentVersion?.indexDegraded ?? false,
      sourceModifiedAt: doc.sourceModifiedAt,
      ingestedAt: currentVersion?.ingestedAt ?? null,
      versionHash: currentVersion?.sha256 ?? null,
      newerVersion,
      latestObservedVersionId: latestObserved?.id ?? null,
      latestSuccessfulVersionId: latestSuccessful?.id ?? null,
    },
    classification: classificationAcrossTime({
      currentLogicalDisclosure: doc.disclosure,
      versionDisclosureSnapshot: currentVersion?.disclosureSnapshot ?? doc.disclosure,
    }),
    versions,
    knowledge,
    aiOperations,
    aiOperationCount: aiOperations.length,
    history,
    attention: record.attention,
    actions: record.actions,
  };
}
