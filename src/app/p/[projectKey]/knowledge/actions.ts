'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { KNOWLEDGE_KINDS } from '@/types/domain';
import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import {
  activateKnowledge,
  archiveKnowledge,
  createKnowledge,
  reviseKnowledge,
} from '@/domain/knowledge/knowledge';

export interface KnowledgeMutationState {
  error: string | null;
}

async function mutation(
  formData: FormData,
  fn: (ctx: Awaited<ReturnType<typeof requireTenant>>) => Promise<void>,
): Promise<KnowledgeMutationState> {
  const projectKey = String(formData.get('projectKey') ?? '');
  if (!projectKey) return { error: 'Invalid request.' };
  try {
    const ctx = await requireTenant(projectKey);
    await fn(ctx);
  } catch (err) {
    if (!(err instanceof AppError)) log.error('knowledge mutation failed', { err });
    return { error: toPublicMessage(err) };
  }
  revalidatePath(`/p/${projectKey}/knowledge`);
  return { error: null };
}

export async function submitKnowledge(
  _prev: KnowledgeMutationState,
  formData: FormData,
): Promise<KnowledgeMutationState> {
  const kind = z.enum(KNOWLEDGE_KINDS).safeParse(formData.get('kind'));
  return mutation(formData, (ctx) =>
    withTenant(ctx, async (tx) => {
      await createKnowledge(tx, ctx, {
        title: String(formData.get('title') ?? ''),
        body: String(formData.get('body') ?? ''),
        kind: kind.success ? kind.data : 'fact',
        activate: formData.get('activate') === 'on',
      });
    }),
  );
}

export async function submitKnowledgeStatus(
  _prev: KnowledgeMutationState,
  formData: FormData,
): Promise<KnowledgeMutationState> {
  const itemId = String(formData.get('itemId') ?? '');
  const op = String(formData.get('op') ?? '');
  if (!z.string().uuid().safeParse(itemId).success || !['activate', 'archive'].includes(op)) {
    return { error: 'Invalid request.' };
  }
  return mutation(formData, (ctx) =>
    withTenant(ctx, (tx) =>
      op === 'activate' ? activateKnowledge(tx, ctx, itemId) : archiveKnowledge(tx, ctx, itemId),
    ),
  );
}

export async function submitKnowledgeRevision(
  _prev: KnowledgeMutationState,
  formData: FormData,
): Promise<KnowledgeMutationState> {
  const itemId = String(formData.get('itemId') ?? '');
  if (!z.string().uuid().safeParse(itemId).success) return { error: 'Invalid request.' };
  return mutation(formData, (ctx) =>
    withTenant(ctx, async (tx) => {
      await reviseKnowledge(tx, ctx, itemId, {
        body: String(formData.get('body') ?? ''),
        activate: formData.get('activate') === 'on',
      });
    }),
  );
}
