'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { setOwner } from '@/domain/agents/org';

export interface OwnerState {
  error: string | null;
}

const schema = z.object({
  projectKey: z.string().min(1),
  object: z.enum(['task', 'decision', 'objective', 'project', 'work_item']),
  objectId: z.string().uuid(),
  ownerAgentId: z
    .string()
    .transform((v) => (v.trim() === '' ? null : v))
    .refine((v) => v === null || /^[0-9a-f-]{36}$/i.test(v), 'Invalid owner.'),
  revalidate: z.string().optional(),
});

/**
 * Assign (or clear) the employee owner of a business object (Slice 1, Stage 4).
 * Descriptive only — setting an owner triggers no routing/delegation. Any
 * non-viewer member may assign ownership.
 */
export async function setOwnerAction(_prev: OwnerState, formData: FormData): Promise<OwnerState> {
  const parsed = schema.safeParse({
    projectKey: formData.get('projectKey'),
    object: formData.get('object'),
    objectId: formData.get('objectId'),
    ownerAgentId: formData.get('ownerAgentId') ?? '',
    revalidate: formData.get('revalidate') || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  try {
    const ctx = await requireTenant(parsed.data.projectKey);
    if (ctx.projectRole === 'viewer') return { error: 'Viewers cannot assign ownership.' };
    await withTenant(ctx, (tx) =>
      setOwner(tx, ctx, parsed.data.object, parsed.data.objectId, parsed.data.ownerAgentId),
    );
  } catch (err) {
    if (!(err instanceof AppError)) log.error('setOwner failed', { err });
    return { error: toPublicMessage(err) };
  }
  revalidatePath(parsed.data.revalidate ?? `/p/${parsed.data.projectKey}`);
  // Objective ownership appears on more than the detail page — keep the list, Dashboard, and briefing
  // in step so a change is never shown on one surface and stale on another (HUB-005, req 4).
  if (parsed.data.object === 'objective') {
    revalidatePath(`/p/${parsed.data.projectKey}/objectives`);
    revalidatePath(`/p/${parsed.data.projectKey}`);
  }
  return { error: null };
}
