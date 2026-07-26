'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { DECISION_APPLICABILITY, DECISION_SCOPES, DECISION_TYPES } from '@/types/domain';
import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireUser, requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import {
  acceptDecision,
  createDecision,
  rejectDecision,
  retireDecision,
} from '@/domain/decisions/decisions';

export interface DecisionState {
  error: string | null;
}

const idSchema = z.string().uuid();

export async function createDecisionAction(
  _prev: DecisionState,
  formData: FormData,
): Promise<DecisionState> {
  const projectKey = String(formData.get('projectKey') ?? '');
  const parsed = z
    .object({
      title: z.string().trim().min(1).max(200),
      summary: z.string().trim().min(1).max(2_000),
      rationale: z.string().trim().max(4_000).optional().default(''),
      decisionType: z.enum(DECISION_TYPES).default('operational'),
      applicability: z.enum(DECISION_APPLICABILITY).default('guidance'),
      scope: z.enum(DECISION_SCOPES).default('workspace'),
      scopeTaskId: z.string().uuid().nullable().optional().default(null),
      scopeObjectiveId: z.string().uuid().nullable().optional().default(null),
      effectiveUntil: z.coerce.date().nullable().optional().default(null),
      originatingTaskId: z.string().uuid().nullable().optional().default(null),
      supersedesId: z.string().uuid().nullable().optional().default(null),
    })
    .safeParse({
      title: formData.get('title'),
      summary: formData.get('summary'),
      rationale: formData.get('rationale') ?? '',
      decisionType: formData.get('decisionType') ?? 'operational',
      applicability: formData.get('applicability') ?? 'guidance',
      scope: formData.get('scope') ?? 'workspace',
      scopeTaskId: emptyToNull(formData.get('scopeTaskId')),
      scopeObjectiveId: emptyToNull(formData.get('scopeObjectiveId')),
      effectiveUntil: emptyToNull(formData.get('effectiveUntil')),
      originatingTaskId: emptyToNull(formData.get('originatingTaskId')),
      supersedesId: emptyToNull(formData.get('supersedesId')),
    });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input.' };

  try {
    const user = await requireUser();
    const ctx = await requireTenant(projectKey);
    await withTenant(ctx, (tx) =>
      createDecision(tx, ctx, user.displayName, {
        title: parsed.data.title,
        summary: parsed.data.summary,
        rationale: parsed.data.rationale,
        decisionType: parsed.data.decisionType,
        applicability: parsed.data.applicability,
        scope: parsed.data.scope,
        scopeTaskId: parsed.data.scopeTaskId,
        scopeObjectiveId: parsed.data.scopeObjectiveId,
        effectiveUntil: parsed.data.effectiveUntil,
        originatingTaskId: parsed.data.originatingTaskId,
        supersedesId: parsed.data.supersedesId,
      }),
    );
  } catch (err) {
    if (!(err instanceof AppError)) log.error('createDecision failed', { err });
    return { error: toPublicMessage(err) };
  }
  revalidatePath(`/p/${projectKey}/decisions`);
  return { error: null };
}

const VERBS = ['accept_record', 'accept_guidance', 'reject', 'retire'] as const;

export async function decideDecisionAction(
  _prev: DecisionState,
  formData: FormData,
): Promise<DecisionState> {
  const projectKey = String(formData.get('projectKey') ?? '');
  const id = String(formData.get('decisionId') ?? '');
  const verb = String(formData.get('verb') ?? '');
  const reason = String(formData.get('reason') ?? '').trim() || undefined;
  if (!idSchema.safeParse(id).success || !VERBS.includes(verb as (typeof VERBS)[number])) {
    return { error: 'Invalid request.' };
  }

  // Accept-as-guidance carries the operator's explicit scope choice (a traceable activation).
  const promo = z
    .object({
      scope: z.enum(DECISION_SCOPES).default('workspace'),
      scopeTaskId: z.string().uuid().nullable().optional().default(null),
      scopeObjectiveId: z.string().uuid().nullable().optional().default(null),
      effectiveUntil: z.coerce.date().nullable().optional().default(null),
    })
    .parse({
      scope: formData.get('scope') ?? 'workspace',
      scopeTaskId: emptyToNull(formData.get('scopeTaskId')),
      scopeObjectiveId: emptyToNull(formData.get('scopeObjectiveId')),
      effectiveUntil: emptyToNull(formData.get('effectiveUntil')),
    });

  try {
    const ctx = await requireTenant(projectKey);
    await withTenant(ctx, (tx) => {
      switch (verb) {
        case 'accept_record':
          return acceptDecision(tx, ctx, id, { applicability: 'record', scope: 'workspace' });
        case 'accept_guidance':
          return acceptDecision(tx, ctx, id, { applicability: 'guidance', ...promo });
        case 'retire':
          return retireDecision(tx, ctx, id, reason);
        default:
          return rejectDecision(tx, ctx, id, reason);
      }
    });
  } catch (err) {
    if (!(err instanceof AppError)) log.error('decideDecision failed', { err });
    return { error: toPublicMessage(err) };
  }
  revalidatePath(`/p/${projectKey}/decisions`);
  revalidatePath(`/p/${projectKey}/decisions/${id}`);
  return { error: null };
}

function emptyToNull(v: FormDataEntryValue | null): string | null {
  const s = v == null ? '' : String(v).trim();
  return s.length === 0 ? null : s;
}
