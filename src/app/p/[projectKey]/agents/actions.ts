'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { updateAgent } from '@/domain/agents/agents';
import { createEmployee, updateEmployee } from '@/domain/agents/org';

export interface AgentFormState {
  error: string | null;
  saved: boolean;
}

/** Optional UUID coming from a <select> where "" means "none". */
const optionalId = z
  .string()
  .transform((v) => (v.trim() === '' ? null : v))
  .refine((v) => v === null || /^[0-9a-f-]{36}$/i.test(v), 'Invalid selection.');

const createEmployeeSchema = z.object({
  projectKey: z.string().min(1),
  name: z.string().min(1).max(120),
  title: z.string().max(120).optional(),
  role: z.enum(['primary', 'reviewer']),
  departmentId: optionalId,
  reportsToId: optionalId,
});

export async function createEmployeeAction(
  _prev: AgentFormState,
  formData: FormData,
): Promise<AgentFormState> {
  const parsed = createEmployeeSchema.safeParse({
    projectKey: formData.get('projectKey'),
    name: formData.get('name'),
    title: formData.get('title') || undefined,
    role: formData.get('role') || 'primary',
    departmentId: formData.get('departmentId') ?? '',
    reportsToId: formData.get('reportsToId') ?? '',
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input.', saved: false };
  try {
    const ctx = await requireTenant(parsed.data.projectKey);
    if (ctx.projectRole !== 'admin') return { error: 'Only workspace admins can add employees.', saved: false };
    await withTenant(ctx, (tx) =>
      createEmployee(tx, ctx, {
        name: parsed.data.name,
        title: parsed.data.title ?? null,
        role: parsed.data.role,
        departmentId: parsed.data.departmentId,
        reportsToId: parsed.data.reportsToId,
      }),
    );
  } catch (err) {
    if (!(err instanceof AppError)) log.error('createEmployee failed', { err });
    return { error: toPublicMessage(err), saved: false };
  }
  revalidatePath(`/p/${parsed.data.projectKey}/agents`);
  return { error: null, saved: true };
}

const orgPatchSchema = z.object({
  projectKey: z.string().min(1),
  employeeId: z.string().uuid(),
  name: z.string().min(1).max(120),
  title: z.string().max(120).optional(),
  departmentId: optionalId,
  reportsToId: optionalId,
  enabled: z.boolean(),
});

export async function saveEmployeeOrgAction(
  _prev: AgentFormState,
  formData: FormData,
): Promise<AgentFormState> {
  const parsed = orgPatchSchema.safeParse({
    projectKey: formData.get('projectKey'),
    employeeId: formData.get('employeeId'),
    name: formData.get('name'),
    title: formData.get('title') || undefined,
    departmentId: formData.get('departmentId') ?? '',
    reportsToId: formData.get('reportsToId') ?? '',
    enabled: formData.get('enabled') === 'on',
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input.', saved: false };
  try {
    const ctx = await requireTenant(parsed.data.projectKey);
    if (ctx.projectRole !== 'admin') return { error: 'Only workspace admins can edit employees.', saved: false };
    await withTenant(ctx, (tx) =>
      updateEmployee(tx, ctx, parsed.data.employeeId, {
        name: parsed.data.name,
        title: parsed.data.title ?? null,
        departmentId: parsed.data.departmentId,
        reportsToId: parsed.data.reportsToId,
        enabled: parsed.data.enabled,
      }),
    );
  } catch (err) {
    if (!(err instanceof AppError)) log.error('updateEmployee failed', { err });
    return { error: toPublicMessage(err), saved: false };
  }
  revalidatePath(`/p/${parsed.data.projectKey}/agents`);
  return { error: null, saved: true };
}

const patchSchema = z.object({
  projectKey: z.string().min(1),
  agentId: z.string().uuid(),
  model: z.string().min(1).max(100),
  systemPrompt: z.string().min(1).max(8000),
  temperatureMilli: z.coerce.number().int().min(0).max(1000),
  maxOutputTokens: z.coerce.number().int().min(1).max(65_536),
  enabled: z.boolean(),
});

export async function saveAgent(_prev: AgentFormState, formData: FormData): Promise<AgentFormState> {
  const parsed = patchSchema.safeParse({
    projectKey: formData.get('projectKey'),
    agentId: formData.get('agentId'),
    model: formData.get('model'),
    systemPrompt: formData.get('systemPrompt'),
    temperatureMilli: formData.get('temperatureMilli'),
    maxOutputTokens: formData.get('maxOutputTokens'),
    enabled: formData.get('enabled') === 'on',
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid input.', saved: false };
  }

  try {
    const ctx = await requireTenant(parsed.data.projectKey);
    // Admin-only employee configuration (P1b). Denial happens BEFORE any withTenant/updateAgent write, so a
    // non-admin can never partially mutate an agent's model/prompt/sampling/enabled. Mirrors the sibling
    // createEmployeeAction / saveEmployeeOrgAction gates exactly.
    if (ctx.projectRole !== 'admin') {
      return { error: 'Only workspace admins can change employee configuration.', saved: false };
    }
    await withTenant(ctx, (tx) =>
      updateAgent(tx, ctx, parsed.data.agentId, {
        model: parsed.data.model,
        systemPrompt: parsed.data.systemPrompt,
        temperatureMilli: parsed.data.temperatureMilli,
        maxOutputTokens: parsed.data.maxOutputTokens,
        enabled: parsed.data.enabled,
      }),
    );
  } catch (err) {
    if (!(err instanceof AppError)) log.error('updateAgent failed', { err });
    return { error: toPublicMessage(err), saved: false };
  }

  revalidatePath(`/p/${parsed.data.projectKey}/agents`);
  return { error: null, saved: true };
}
