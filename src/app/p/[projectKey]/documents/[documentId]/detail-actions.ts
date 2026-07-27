'use server';

import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { getObjectStore } from '@/domain/documents/object-store';
import { loadDetailWithInspection } from '@/domain/documents/detail';

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

export const revealInitial: RevealState = { released: false, previewText: null, qualification: null, downloadable: false, message: null };

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
