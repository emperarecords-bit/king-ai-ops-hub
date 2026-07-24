'use server';

import { redirect } from 'next/navigation';
import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireUser } from '@/domain/auth/guard';
import { createWorkspace } from '@/domain/projects/provision';

export interface WorkspaceFormState {
  error: string | null;
}

export async function submitWorkspace(
  _prev: WorkspaceFormState,
  formData: FormData,
): Promise<WorkspaceFormState> {
  let projectKey: string;
  try {
    const user = await requireUser();
    const result = await createWorkspace(user, {
      name: String(formData.get('name') ?? ''),
      description: String(formData.get('description') ?? ''),
    });
    projectKey = result.projectKey;
  } catch (err) {
    if (!(err instanceof AppError)) log.error('createWorkspace failed', { err });
    return { error: toPublicMessage(err) };
  }
  redirect(`/p/${projectKey}?welcome=1`);
}
