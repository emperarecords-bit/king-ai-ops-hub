'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { getGitHubClient } from '@/domain/github/client';
import { listRepoLinks } from '@/domain/github/links';
import {
  approveContextItem,
  archiveContextItem,
  importRepoFileAsPendingContext,
} from '@/domain/github/content';

export interface RepoActionState {
  error: string | null;
  ok: string | null;
}

const importSchema = z.object({
  projectKey: z.string().min(1),
  repoFullName: z.string().min(3).max(200),
  path: z.string().min(1).max(300),
});

/**
 * Import one repo file so employees can read it. The file is fetched through the policy-gated
 * GitHub client, lands as a PENDING context item, and — when the actor is a project admin (the
 * human clicking the button) — is approved in the same breath. Non-admins leave it pending for an
 * admin to approve from the same page.
 */
export async function importRepoFile(_prev: RepoActionState, formData: FormData): Promise<RepoActionState> {
  const parsed = importSchema.safeParse({
    projectKey: formData.get('projectKey'),
    repoFullName: formData.get('repoFullName'),
    path: formData.get('path'),
  });
  if (!parsed.success) return { error: 'Invalid request.', ok: null };
  const { projectKey, repoFullName, path } = parsed.data;
  try {
    const ctx = await requireTenant(projectKey);
    const outcome = await withTenant(ctx, async (tx) => {
      const links = await listRepoLinks(tx, ctx);
      const link = links.find((l) => l.repoFullName === repoFullName);
      if (!link) throw new AppError('validation', 'That repository is not linked to this workspace.');
      const content = await getGitHubClient().readBlob(
        { installationId: link.installationId, repoFullName: link.repoFullName },
        link.defaultBranch,
        path,
      );
      const id = await importRepoFileAsPendingContext(tx, ctx, {
        repoFullName: link.repoFullName,
        ref: link.defaultBranch,
        path,
        content,
      });
      if (ctx.projectRole === 'admin') {
        await approveContextItem(tx, ctx, id);
        return 'approved';
      }
      return 'pending';
    });
    revalidatePath(`/p/${projectKey}/repo`);
    return {
      error: null,
      ok:
        outcome === 'approved'
          ? `Imported ${path} — employees can read it from their next run.`
          : `Imported ${path} as pending — an admin must approve it before employees see it.`,
    };
  } catch (err) {
    if (!(err instanceof AppError)) log.error('importRepoFile failed', { err });
    return { error: toPublicMessage(err), ok: null };
  }
}

const statusSchema = z.object({
  projectKey: z.string().min(1),
  itemId: z.string().uuid(),
  op: z.enum(['approve', 'archive']),
});

/** Approve or archive an imported item from the shared-files list (admin-gated in the domain). */
export async function setContextItemStatus(_prev: RepoActionState, formData: FormData): Promise<RepoActionState> {
  const parsed = statusSchema.safeParse({
    projectKey: formData.get('projectKey'),
    itemId: formData.get('itemId'),
    op: formData.get('op'),
  });
  if (!parsed.success) return { error: 'Invalid request.', ok: null };
  try {
    const ctx = await requireTenant(parsed.data.projectKey);
    await withTenant(ctx, (tx) =>
      parsed.data.op === 'approve' ? approveContextItem(tx, ctx, parsed.data.itemId) : archiveContextItem(tx, ctx, parsed.data.itemId),
    );
  } catch (err) {
    if (!(err instanceof AppError)) log.error('setContextItemStatus failed', { err });
    return { error: toPublicMessage(err), ok: null };
  }
  revalidatePath(`/p/${parsed.data.projectKey}/repo`);
  return { error: null, ok: parsed.data.op === 'approve' ? 'Approved.' : 'Archived.' };
}
