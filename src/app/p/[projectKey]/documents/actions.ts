'use server';

import { revalidatePath } from 'next/cache';
import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { linkFolder, refreshIndex, type IndexSummary } from '@/domain/documents/documents';

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
