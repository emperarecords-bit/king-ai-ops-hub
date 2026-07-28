'use server';

import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { getObjectStore } from '@/domain/documents/object-store';
import { type DocumentPurgeAssessment, type DocumentPurgeResult, assessDocumentPurge, authorizeDocumentPurge, cancelDocumentPurge, executeDocumentPurge, proposeDocumentPurge } from '@/domain/documents/purge';
import { revalidatePath } from 'next/cache';

/**
 * Document PURGE actions — deliberate, admin-only POST server actions (origin/CSRF-validated). Purge is the
 * only capability that deletes a document and its versions; it is separate from cleanup and from the safe
 * lifecycle actions. Each step re-authenticates + re-checks admin at the server; the retention window and
 * reference closure are re-checked inside the domain. The DB-authoritative deletion runs on the RLS-enforced
 * withTenant path (every query is also explicitly tenant-scoped in the domain); no bypass, one document only.
 */

/** Retention/quarantine window before an authorized purge may execute (env-overridable; default 7 days). */
const PURGE_RETENTION_MS = Number.isFinite(Number(process.env.PURGE_RETENTION_MS)) ? Number(process.env.PURGE_RETENTION_MS) : undefined;

export interface PurgeActionState {
  assessment: DocumentPurgeAssessment | null;
  operationId: string | null;
  result: DocumentPurgeResult | null;
  message: string | null;
  error: string | null;
}

async function admin(projectKey: string) {
  const ctx = await requireTenant(projectKey);
  if (ctx.projectRole !== 'admin') throw new AppError('forbidden', 'Only admins can purge documents.');
  return ctx;
}

/** ASSESS (read-only): the exact scope + reference-closure blockers. Mutates nothing. */
export async function assessDocumentPurgeAction(_prev: PurgeActionState, formData: FormData): Promise<PurgeActionState> {
  const projectKey = String(formData.get('projectKey') ?? '');
  const documentId = String(formData.get('documentId') ?? '');
  try {
    const ctx = await admin(projectKey);
    const assessment = await withTenant(ctx, (tx) => assessDocumentPurge(tx, ctx, documentId));
    if (!assessment) return { assessment: null, operationId: null, result: null, message: null, error: 'This source is not available to your account.' };
    return { assessment, operationId: null, result: null, message: null, error: null };
  } catch (err) {
    if (!(err instanceof AppError)) log.error('assessDocumentPurge failed', { err });
    return { assessment: null, operationId: null, result: null, message: null, error: toPublicMessage(err) };
  }
}

/** PROPOSE: record the purge proposal (only for a permitted document). */
export async function proposeDocumentPurgeAction(_prev: PurgeActionState, formData: FormData): Promise<PurgeActionState> {
  const projectKey = String(formData.get('projectKey') ?? '');
  const documentId = String(formData.get('documentId') ?? '');
  const reason = String(formData.get('reason') ?? '') || undefined;
  try {
    const ctx = await admin(projectKey);
    const res = await withTenant(ctx, (tx) => proposeDocumentPurge(tx, ctx, documentId, reason));
    if (!res) return { assessment: null, operationId: null, result: null, message: null, error: 'This source is not available to your account.' };
    revalidatePath(`/p/${projectKey}/documents/${documentId}`);
    return { assessment: res.assessment, operationId: res.operationId, result: null, message: res.operationId ? null : 'This document cannot be purged: it is still referenced.', error: null };
  } catch (err) {
    if (!(err instanceof AppError)) log.error('proposeDocumentPurge failed', { err });
    return { assessment: null, operationId: null, result: null, message: null, error: toPublicMessage(err) };
  }
}

/** AUTHORIZE: enter the retention/quarantine window (document becomes retrieval-excluded, still cancellable). */
export async function authorizeDocumentPurgeAction(_prev: PurgeActionState, formData: FormData): Promise<PurgeActionState> {
  const projectKey = String(formData.get('projectKey') ?? '');
  const documentId = String(formData.get('documentId') ?? '');
  const operationId = String(formData.get('operationId') ?? '');
  try {
    const ctx = await admin(projectKey);
    if (!operationId) return { assessment: null, operationId: null, result: null, message: null, error: 'Propose the purge before authorizing it.' };
    const r = await withTenant(ctx, (tx) => authorizeDocumentPurge(tx, ctx, operationId, PURGE_RETENTION_MS ? { retentionMs: PURGE_RETENTION_MS } : undefined));
    revalidatePath(`/p/${projectKey}/documents/${documentId}`);
    const message = r.outcome === 'quarantined' ? 'Authorized. The document is quarantined and will be purged after the retention window unless cancelled.'
      : r.outcome === 'refused_blocked' ? 'A reference appeared since proposal; authorization refused.'
      : r.outcome === 'refused_state_changed' ? 'The document changed since proposal; re-propose.'
      : 'This purge could not be authorized.';
    return { assessment: null, operationId, result: null, message, error: null };
  } catch (err) {
    if (!(err instanceof AppError)) log.error('authorizeDocumentPurge failed', { err });
    return { assessment: null, operationId: null, result: null, message: null, error: toPublicMessage(err) };
  }
}

/** CANCEL: abort the purge and restore the document; nothing was deleted. */
export async function cancelDocumentPurgeAction(_prev: PurgeActionState, formData: FormData): Promise<PurgeActionState> {
  const projectKey = String(formData.get('projectKey') ?? '');
  const documentId = String(formData.get('documentId') ?? '');
  const operationId = String(formData.get('operationId') ?? '');
  try {
    const ctx = await admin(projectKey);
    if (!operationId) return { assessment: null, operationId: null, result: null, message: null, error: 'No purge to cancel.' };
    const r = await withTenant(ctx, (tx) => cancelDocumentPurge(tx, ctx, operationId, 'cancelled by operator'));
    revalidatePath(`/p/${projectKey}/documents/${documentId}`);
    const message = r.outcome === 'cancelled' ? 'Purge cancelled — the document was restored; nothing was deleted.' : 'This purge can no longer be cancelled.';
    return { assessment: null, operationId: null, result: null, message, error: null };
  } catch (err) {
    if (!(err instanceof AppError)) log.error('cancelDocumentPurge failed', { err });
    return { assessment: null, operationId: null, result: null, message: null, error: toPublicMessage(err) };
  }
}

/** EXECUTE: after the retention window, run the authoritative DB purge (RLS-enforced withTenant per phase),
 *  then the restartable object reconciler. 'completed' only after every object is HEAD-confirmed absent. */
export async function executeDocumentPurgeAction(_prev: PurgeActionState, formData: FormData): Promise<PurgeActionState> {
  const projectKey = String(formData.get('projectKey') ?? '');
  const documentId = String(formData.get('documentId') ?? '');
  const operationId = String(formData.get('operationId') ?? '');
  try {
    const ctx = await admin(projectKey);
    if (!operationId) return { assessment: null, operationId: null, result: null, message: null, error: 'Authorize the purge before executing it.' };
    const store = await getObjectStore();
    const result = await executeDocumentPurge((fn) => withTenant(ctx, fn), ctx, store, operationId);
    revalidatePath(`/p/${projectKey}/documents/${documentId}`);
    return { assessment: null, operationId, result, message: null, error: null };
  } catch (err) {
    if (!(err instanceof AppError)) log.error('executeDocumentPurge failed', { err });
    return { assessment: null, operationId: null, result: null, message: null, error: toPublicMessage(err) };
  }
}
