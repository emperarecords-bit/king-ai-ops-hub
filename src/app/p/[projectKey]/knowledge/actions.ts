'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { KNOWLEDGE_DISCLOSURES, KNOWLEDGE_KINDS, KNOWLEDGE_SCOPE_KINDS } from '@/types/domain';
import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import {
  activateKnowledge,
  archiveKnowledge,
  createKnowledge,
  recordSupportJudgment,
  reviseKnowledge,
  setKnowledgeVerification,
} from '@/domain/knowledge/knowledge';
import {
  promoteKnowledgeProposal,
  rejectKnowledgeProposal,
  reviseKnowledgeProposalDraft,
  splitKnowledgeProposal,
} from '@/domain/knowledge/extraction';

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
  const itemId = String(formData.get('itemId') ?? '');
  if (itemId) revalidatePath(`/p/${projectKey}/knowledge/${itemId}`);
  return { error: null };
}

const dateOrNull = (v: FormDataEntryValue | null): Date | null => {
  const s = String(v ?? '').trim();
  return s ? new Date(s) : null;
};

/** Promote an AI proposal with the operator's explicit scope + temporal + disclosure + lifecycle choice. */
export async function submitProposalPromote(_prev: KnowledgeMutationState, formData: FormData): Promise<KnowledgeMutationState> {
  const proposalId = String(formData.get('proposalId') ?? '');
  if (!z.string().uuid().safeParse(proposalId).success) return { error: 'Invalid request.' };
  const scopeKind = z.enum(KNOWLEDGE_SCOPE_KINDS).safeParse(formData.get('scopeKind'));
  const disclosure = z.enum(KNOWLEDGE_DISCLOSURES).safeParse(formData.get('disclosure'));
  if (!scopeKind.success || !disclosure.success) return { error: 'Choose a scope and disclosure.' };
  return mutation(formData, (ctx) =>
    withTenant(ctx, (tx) =>
      promoteKnowledgeProposal(tx, ctx, proposalId, {
        scopeKind: scopeKind.data,
        scopeTaskId: String(formData.get('scopeTaskId') ?? '') || null,
        scopeObjectiveId: String(formData.get('scopeObjectiveId') ?? '') || null,
        disclosure: disclosure.data,
        asOf: dateOrNull(formData.get('asOf')),
        reviewAfter: dateOrNull(formData.get('reviewAfter')),
        expiresAt: dateOrNull(formData.get('expiresAt')),
        activate: formData.get('activate') === 'on',
      }),
    ),
  );
}

/** Reject an AI proposal — a rationale is required; the record is preserved. */
export async function submitProposalReject(_prev: KnowledgeMutationState, formData: FormData): Promise<KnowledgeMutationState> {
  const proposalId = String(formData.get('proposalId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (!z.string().uuid().safeParse(proposalId).success) return { error: 'Invalid request.' };
  if (!reason) return { error: 'A rejection rationale is required.' };
  return mutation(formData, (ctx) => withTenant(ctx, (tx) => rejectKnowledgeProposal(tx, ctx, proposalId, reason)));
}

/** Revise a pending proposal's claim before promotion. */
export async function submitProposalRevise(_prev: KnowledgeMutationState, formData: FormData): Promise<KnowledgeMutationState> {
  const proposalId = String(formData.get('proposalId') ?? '');
  if (!z.string().uuid().safeParse(proposalId).success) return { error: 'Invalid request.' };
  return mutation(formData, (ctx) =>
    withTenant(ctx, (tx) => reviseKnowledgeProposalDraft(tx, ctx, proposalId, { title: String(formData.get('title') ?? '') || undefined, claim: String(formData.get('claim') ?? '') || undefined })),
  );
}

/** Split a proposal into independently-reviewable children. Children arrive as a JSON array. */
export async function submitProposalSplit(_prev: KnowledgeMutationState, formData: FormData): Promise<KnowledgeMutationState> {
  const proposalId = String(formData.get('proposalId') ?? '');
  if (!z.string().uuid().safeParse(proposalId).success) return { error: 'Invalid request.' };
  const childrenSchema = z.array(z.object({ title: z.string().trim().min(1), claim: z.string().trim().min(1) })).min(2);
  let children;
  try {
    children = childrenSchema.parse(JSON.parse(String(formData.get('children') ?? '[]')));
  } catch {
    return { error: 'Provide at least two child claims, each with a title and claim.' };
  }
  return mutation(formData, async (ctx) => {
    await withTenant(ctx, (tx) => splitKnowledgeProposal(tx, ctx, proposalId, { reason: String(formData.get('reason') ?? '') || undefined, children }));
  });
}

/** Human-confirm or mark-disputed an active record (dispute requires a reason). Never source_supported. */
export async function submitKnowledgeVerification(_prev: KnowledgeMutationState, formData: FormData): Promise<KnowledgeMutationState> {
  const itemId = String(formData.get('itemId') ?? '');
  const verification = String(formData.get('verification') ?? '');
  if (!z.string().uuid().safeParse(itemId).success || !['human_confirmed', 'disputed'].includes(verification)) return { error: 'Invalid request.' };
  const reason = String(formData.get('reason') ?? '').trim();
  if (verification === 'disputed' && !reason) return { error: 'Marking a record disputed requires a reason.' };
  return mutation(formData, (ctx) =>
    withTenant(ctx, (tx) => setKnowledgeVerification(tx, ctx, itemId, verification as 'human_confirmed' | 'disputed', reason || undefined)),
  );
}

/** Record a source-support judgment over explicit relied-upon sources (ids arrive as a JSON array). */
export async function submitSupportJudgment(_prev: KnowledgeMutationState, formData: FormData): Promise<KnowledgeMutationState> {
  const itemId = String(formData.get('itemId') ?? '');
  if (!z.string().uuid().safeParse(itemId).success) return { error: 'Invalid request.' };
  let reliedOnSourceIds: string[];
  try {
    reliedOnSourceIds = z.array(z.string().uuid()).min(1).parse(JSON.parse(String(formData.get('reliedOnSourceIds') ?? '[]')));
  } catch {
    return { error: 'Select at least one relied-upon source.' };
  }
  return mutation(formData, (ctx) =>
    withTenant(ctx, (tx) => recordSupportJudgment(tx, ctx, itemId, { reliedOnSourceIds, rationale: String(formData.get('rationale') ?? '') || undefined, limitations: String(formData.get('limitations') ?? '') || undefined })),
  );
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
