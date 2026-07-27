'use server';

import { revalidatePath } from 'next/cache';
import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import {
  archiveDocument,
  linkFolder,
  refreshIndex,
  restoreDocument,
  type IndexSummary,
} from '@/domain/documents/documents';
import {
  replaceDocument,
  retryDocument,
  uploadDocument,
} from '@/domain/documents/cloud';
import { getObjectStore } from '@/domain/documents/object-store';
import { maxBatchFiles, maxUploadBytes } from '@/domain/documents/upload-validation';

export interface DocumentsState {
  error: string | null;
  message: string | null;
}

export async function linkFolderAction(
  _prev: DocumentsState,
  formData: FormData,
): Promise<DocumentsState> {
  const projectKey = String(formData.get('projectKey') ?? '');
  const folderPath = String(formData.get('folderPath') ?? '');
  try {
    const ctx = await requireTenant(projectKey);
    if (ctx.projectRole !== 'admin') {
      return { error: 'Only project admins can link a folder.', message: null };
    }
    await withTenant(ctx, (tx) => linkFolder(tx, ctx, folderPath));
  } catch (err) {
    if (!(err instanceof AppError)) log.error('linkFolder failed', { err });
    return { error: toPublicMessage(err), message: null };
  }
  revalidatePath(`/p/${projectKey}/documents`);
  return { error: null, message: 'Folder linked. Click Refresh index to read it.' };
}

function summarize(s: IndexSummary): string {
  const parts = [`${s.indexed} indexed`, `${s.skippedUnchanged} unchanged`];
  if (s.archived > 0) parts.push(`${s.archived} removed`);
  if (s.unsupported > 0) parts.push(`${s.unsupported} unsupported`);
  if (s.failed > 0) parts.push(`${s.failed} failed`);
  return parts.join(' · ');
}

export async function refreshIndexAction(
  _prev: DocumentsState,
  formData: FormData,
): Promise<DocumentsState> {
  const projectKey = String(formData.get('projectKey') ?? '');
  try {
    const ctx = await requireTenant(projectKey);
    if (ctx.projectRole !== 'admin') {
      return { error: 'Only project admins can refresh the index.', message: null };
    }
    const summary = await withTenant(ctx, (tx) => refreshIndex(tx, ctx));
    revalidatePath(`/p/${projectKey}/documents`);
    return { error: null, message: summarize(summary) };
  } catch (err) {
    if (!(err instanceof AppError)) log.error('refreshIndex failed', { err });
    return { error: toPublicMessage(err), message: null };
  }
}

/**
 * Cloud upload (O-23). Admin-only. Reads files from the multipart FormData,
 * validates + stores + enqueues each — tenancy comes ONLY from the server
 * context, never from the upload. One bad file does not fail the batch.
 */
export async function uploadDocumentsAction(
  _prev: DocumentsState,
  formData: FormData,
): Promise<DocumentsState> {
  const projectKey = String(formData.get('projectKey') ?? '');
  try {
    const ctx = await requireTenant(projectKey);
    if (ctx.projectRole !== 'admin') {
      return { error: 'Only project admins can upload documents.', message: null };
    }
    const files = formData.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length === 0) return { error: 'Choose at least one file to upload.', message: null };
    if (files.length > maxBatchFiles()) {
      return { error: `Too many files at once (max ${maxBatchFiles()}).`, message: null };
    }

    const store = await getObjectStore();
    let queued = 0;
    let unchanged = 0;
    let unsupported = 0;
    const failures: string[] = [];
    for (const file of files) {
      if (file.size > maxUploadBytes()) {
        failures.push(`${file.name} (too large)`);
        continue;
      }
      try {
        const bytes = Buffer.from(await file.arrayBuffer());
        const outcome = await withTenant(ctx, (tx) =>
          uploadDocument(tx, ctx, store, {
            rawFilename: file.name,
            declaredMime: file.type,
            bytes,
          }),
        );
        if (outcome.result === 'queued') queued += 1;
        else if (outcome.result === 'unchanged') unchanged += 1;
        else unsupported += 1;
      } catch (err) {
        // One file's failure never fails the batch.
        failures.push(`${file.name} (${toPublicMessage(err)})`);
        if (!(err instanceof AppError)) log.error('document upload failed', { name: file.name, err });
      }
    }
    revalidatePath(`/p/${projectKey}/documents`);
    const parts = [`${queued} queued`];
    if (unchanged > 0) parts.push(`${unchanged} unchanged`);
    if (unsupported > 0) parts.push(`${unsupported} unsupported`);
    if (failures.length > 0) parts.push(`${failures.length} rejected: ${failures.join('; ')}`);
    return { error: null, message: parts.join(' · ') };
  } catch (err) {
    if (!(err instanceof AppError)) log.error('uploadDocuments failed', { err });
    return { error: toPublicMessage(err), message: null };
  }
}

async function adminDocMutation(
  formData: FormData,
  verb: string,
  fn: (ctx: Awaited<ReturnType<typeof requireTenant>>, documentId: string) => Promise<void>,
): Promise<DocumentsState> {
  const projectKey = String(formData.get('projectKey') ?? '');
  const documentId = String(formData.get('documentId') ?? '');
  try {
    const ctx = await requireTenant(projectKey);
    if (ctx.projectRole !== 'admin') return { error: `Only admins can ${verb} documents.`, message: null };
    await fn(ctx, documentId);
    revalidatePath(`/p/${projectKey}/documents`);
    return { error: null, message: `Document ${verb}d.` };
  } catch (err) {
    if (!(err instanceof AppError)) log.error(`${verb}Document failed`, { err });
    return { error: toPublicMessage(err), message: null };
  }
}

export async function retryDocumentAction(_prev: DocumentsState, formData: FormData): Promise<DocumentsState> {
  return adminDocMutation(formData, 'retrie', (ctx, documentId) =>
    withTenant(ctx, (tx) => retryDocument(tx, ctx, documentId)),
  );
}

export async function archiveDocumentAction(_prev: DocumentsState, formData: FormData): Promise<DocumentsState> {
  return adminDocMutation(formData, 'archive', (ctx, documentId) =>
    withTenant(ctx, (tx) => archiveDocument(tx, ctx, documentId)),
  );
}

/** Explicit restore of an archived document (admin, adapter-neutral). Cloud sources restore immediately;
 *  a local source whose path is unreachable from the server records the intent and completes on the next
 *  refresh from a capable host. */
export async function restoreDocumentAction(_prev: DocumentsState, formData: FormData): Promise<DocumentsState> {
  const projectKey = String(formData.get('projectKey') ?? '');
  const documentId = String(formData.get('documentId') ?? '');
  try {
    const ctx = await requireTenant(projectKey);
    if (ctx.projectRole !== 'admin') return { error: 'Only admins can restore documents.', message: null };
    const store = await getObjectStore();
    const outcome = await withTenant(ctx, (tx) => restoreDocument(tx, ctx, store, documentId));
    revalidatePath(`/p/${projectKey}/documents`);
    if (outcome.restored) {
      return { error: null, message: outcome.versionReused ? 'Restored (source unchanged).' : 'Restored (new version ingested).' };
    }
    return { error: null, message: 'Restore requested — refresh the linked folder from a host that can reach its path to complete it.' };
  } catch (err) {
    if (!(err instanceof AppError)) log.error('restoreDocument failed', { err });
    return { error: toPublicMessage(err), message: null };
  }
}

export async function replaceDocumentAction(_prev: DocumentsState, formData: FormData): Promise<DocumentsState> {
  const projectKey = String(formData.get('projectKey') ?? '');
  const documentId = String(formData.get('documentId') ?? '');
  const file = formData.get('file');
  try {
    const ctx = await requireTenant(projectKey);
    if (ctx.projectRole !== 'admin') return { error: 'Only admins can replace documents.', message: null };
    if (!(file instanceof File) || file.size === 0) return { error: 'Choose a replacement file.', message: null };
    if (file.size > maxUploadBytes()) return { error: 'Replacement file is too large.', message: null };
    const store = await getObjectStore();
    const bytes = Buffer.from(await file.arrayBuffer());
    await withTenant(ctx, (tx) =>
      replaceDocument(tx, ctx, store, documentId, { rawFilename: file.name, declaredMime: file.type, bytes }),
    );
    revalidatePath(`/p/${projectKey}/documents`);
    return { error: null, message: 'Replacement uploaded and queued for indexing.' };
  } catch (err) {
    if (!(err instanceof AppError)) log.error('replaceDocument failed', { err });
    return { error: toPublicMessage(err), message: null };
  }
}
