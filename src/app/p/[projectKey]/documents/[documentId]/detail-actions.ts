'use server';

import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { getObjectStore } from '@/domain/documents/object-store';
import { loadDetailWithInspection } from '@/domain/documents/detail';
import { type DocumentIntegrityAudit, auditDocument } from '@/domain/documents/integrity';
import { type RepairPreview, type RepairResult, executeRepair, previewRepair } from '@/domain/documents/repair';
import { revalidatePath } from 'next/cache';
import { writeAudit } from '@/domain/audit/audit';

/**
 * Explicit restricted-content RELEASE — a Next.js server action (POST, origin/CSRF-validated by the
 * framework), NOT a GET query parameter. Releasing restricted content is a deliberate, non-replayable act:
 * a page load, refresh, back/forward navigation, prefetch, link scan, or shared URL can never trigger it,
 * and no reusable release command is left in the URL. The action reauthorizes the workspace + document +
 * exact selected version, releases ONLY that version through the gated `loadInspectableVersion` (which
 * records the restricted-inspection audit only on a successful release), and never falls back to another
 * version. A foreign, cross-document, cross-workspace, or unauthorized request releases nothing and returns
 * the same bounded, existence-neutral result.
 */

export interface RevealState {
  released: boolean;
  previewText: string | null;
  qualification: string | null;
  downloadable: boolean;
  message: string | null;
}

// NOTE: a 'use server' module may export ONLY async functions — the initial state constant lives in the
// client component, not here.
const DENIED: RevealState = { released: false, previewText: null, qualification: null, downloadable: false, message: 'This source is not available to your account.' };

export async function revealRestrictedVersionAction(_prev: RevealState, formData: FormData): Promise<RevealState> {
  const projectKey = String(formData.get('projectKey') ?? '');
  const documentId = String(formData.get('documentId') ?? '');
  const versionId = String(formData.get('versionId') ?? '') || undefined;
  try {
    const ctx = await requireTenant(projectKey); // reauthorize the workspace for THIS request
    const store = await getObjectStore();
    const { detail, inspection } = await withTenant(ctx, (tx) =>
      // Resolves the EXACT selected version (belongs-to-document + workspace) and releases only it — never
      // a fall-back to current; audits the restricted release only on success (inside loadInspectableVersion).
      loadDetailWithInspection(tx, ctx, store, documentId, versionId, { accessType: 'preview', purpose: 'documents detail reveal' }),
    );
    if (!detail.found || !inspection) return DENIED; // denied, missing, foreign, or cross-workspace → nothing released
    if (inspection.state === 'unavailable') {
      return { released: false, previewText: null, qualification: null, downloadable: false, message: 'Source content is unavailable for this version.' };
    }
    if (inspection.state !== 'released' || !inspection.inspection) {
      return { released: false, previewText: null, qualification: null, downloadable: false, message: 'No content is available to release for this version.' };
    }
    const previewText = inspection.inspection.chunks ? inspection.inspection.chunks.map((c) => c.content).join('\n\n') : '';
    return { released: true, previewText, qualification: inspection.inspection.qualification ?? null, downloadable: !!inspection.inspection.downloadable, message: null };
  } catch (err) {
    if (!(err instanceof AppError)) log.error('revealRestrictedVersion failed', { err });
    return { ...DENIED, message: toPublicMessage(err) };
  }
}

const AUDIT_VERSION = 'integrity-v1';

export interface IntegrityAuditState {
  audit: DocumentIntegrityAudit | null;
  error: string | null;
}

/**
 * Run the READ-ONLY integrity audit for one document — a deliberate Next.js server action (POST,
 * origin/CSRF-validated), admin-only, re-authorized + tenant-scoped at execution time. It mutates NOTHING
 * about the document; on successful completion it records ONE append-only audit event (never on a refused
 * or failed attempt). A cross-workspace / non-member / non-admin request releases no result.
 */
export async function runIntegrityAuditAction(_prev: IntegrityAuditState, formData: FormData): Promise<IntegrityAuditState> {
  const projectKey = String(formData.get('projectKey') ?? '');
  const documentId = String(formData.get('documentId') ?? '');
  try {
    const ctx = await requireTenant(projectKey);
    if (ctx.projectRole !== 'admin') return { audit: null, error: 'Only admins can run an integrity audit.' };
    const store = await getObjectStore();
    const audit = await withTenant(ctx, async (tx) => {
      const result = await auditDocument(tx, ctx, store, documentId);
      if (!result) return null; // not in this workspace → no result, no success audit
      // Record ONLY a completed audit (append-only), after the read-only assessment succeeded.
      await writeAudit(tx, ctx, {
        action: 'document.integrity_audited',
        entityType: 'document',
        entityId: documentId,
        detail: { auditVersion: AUDIT_VERSION, outcome: result.outcome, findings: result.findings.length, limitations: result.limitations.length, versionsScanned: result.versionsScanned, inspectedVersionIds: result.versions.map((v) => v.versionId) },
      });
      return result;
    });
    if (!audit) return { audit: null, error: 'This source is not available to your account.' };
    return { audit, error: null };
  } catch (err) {
    if (!(err instanceof AppError)) log.error('runIntegrityAudit failed', { err });
    // The audit operation itself could not complete — never present this as a completed/degraded result.
    return { audit: { documentId, outcome: 'audit_failed', findings: [], limitations: [], versions: [], versionsScanned: 0, checksApplied: [], currentVersionId: null, currentVersionState: 'none', archived: false }, error: toPublicMessage(err) };
  }
}

export interface RepairActionState {
  preview: RepairPreview | null;
  result: RepairResult | null;
  error: string | null;
}

/** PREVIEW a repair (read-only): admin-only, tenant-scoped, no mutation. Returns the proposal + fingerprint. */
export async function previewRepairAction(_prev: RepairActionState, formData: FormData): Promise<RepairActionState> {
  const projectKey = String(formData.get('projectKey') ?? '');
  const documentId = String(formData.get('documentId') ?? '');
  const versionId = String(formData.get('versionId') ?? '');
  try {
    const ctx = await requireTenant(projectKey);
    if (ctx.projectRole !== 'admin') return { preview: null, result: null, error: 'Only admins can repair documents.' };
    const store = await getObjectStore();
    const preview = await withTenant(ctx, (tx) => previewRepair(tx, ctx, store, documentId, { type: 'rebuild_chunks', versionId }));
    if (!preview) return { preview: null, result: null, error: 'This source is not available to your account.' };
    return { preview, result: null, error: null };
  } catch (err) {
    if (!(err instanceof AppError)) log.error('previewRepair failed', { err });
    return { preview: null, result: null, error: toPublicMessage(err) };
  }
}

/** EXECUTE a previewed repair: admin-only, tenant-scoped, bound to the preview fingerprint (refuses if the
 *  state changed), representation-safe, verified afterward, and recorded append-only. */
export async function executeRepairAction(_prev: RepairActionState, formData: FormData): Promise<RepairActionState> {
  const projectKey = String(formData.get('projectKey') ?? '');
  const documentId = String(formData.get('documentId') ?? '');
  const versionId = String(formData.get('versionId') ?? '');
  const fingerprint = String(formData.get('fingerprint') ?? '');
  try {
    const ctx = await requireTenant(projectKey);
    if (ctx.projectRole !== 'admin') return { preview: null, result: null, error: 'Only admins can repair documents.' };
    if (!fingerprint) return { preview: null, result: null, error: 'Preview the repair before applying it.' };
    const store = await getObjectStore();
    const result = await withTenant(ctx, (tx) => executeRepair(tx, ctx, store, documentId, { type: 'rebuild_chunks', versionId }, fingerprint));
    if (!result) return { preview: null, result: null, error: 'This source is not available to your account.' };
    revalidatePath(`/p/${projectKey}/documents/${documentId}`);
    return { preview: null, result, error: null };
  } catch (err) {
    if (!(err instanceof AppError)) log.error('executeRepair failed', { err });
    return { preview: null, result: null, error: toPublicMessage(err) };
  }
}
