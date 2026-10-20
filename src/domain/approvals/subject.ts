import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { type DbTx } from '@/db/client';
import { approvals } from '@/db/schema';
import { type TenantContext } from '@/types/domain';

/**
 * Approval SUBJECTS — persistent rejection / supersession for run-proposed actions.
 *
 * Evidence (2026-10-19): one AccurateBids support inquiry (request e4c08c7c, "ONEAL") produced 11 approvals
 * since 2026-09-28 — reworded each time and switching between external_http and email_send, so the existing
 * exact-payload duplicate check never matched. The owner REJECTED it on 2026-10-18 and it was re-proposed three
 * more times the next day (two still pending). A subject is what an action is ABOUT, independent of wording:
 * a rejected subject is not re-proposed from stale context, and a subject already awaiting a decision is not
 * proposed twice.
 *
 * Re-proposal of a rejected subject is allowed only on:
 *  - changed underlying evidence — for support inquiries a new customer message is a NEW request id, so it is
 *    a new subject automatically; or
 *  - an explicit owner request — an owner-created, non-standing task created AFTER the rejection whose
 *    instructions name the subject (its request id).
 */

/** What a proposed action is about, or null when it has no stable subject (then only exact dedupe applies). */
export function approvalSubjectKey(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const requestId = (payload as Record<string, unknown>).request_id;
  if (typeof requestId === 'string' && requestId.trim().length > 0) return `support_request:${requestId.trim()}`;
  return null;
}

export interface SubjectHistoryRow {
  id: string;
  status: string;
  decidedAt: Date | null;
}

export interface ProposingTask {
  scheduleId: string | null;
  createdAt: Date;
  input: string;
}

export type SubjectDecision =
  | { allow: true; reason?: 'owner_reconsider' }
  | { allow: false; reason: 'pending_same_subject' | 'rejected_subject'; approvalId: string };

/** Pure decision (unit-tested against the real ONEAL history). `history` = this subject's approvals. */
export function decideSubject(subjectKey: string, history: readonly SubjectHistoryRow[], task: ProposingTask): SubjectDecision {
  const pending = history.find((h) => h.status === 'pending');
  if (pending) return { allow: false, reason: 'pending_same_subject', approvalId: pending.id };
  const rejected = history
    .filter((h) => h.status === 'rejected')
    .sort((a, b) => (b.decidedAt?.getTime() ?? 0) - (a.decidedAt?.getTime() ?? 0))[0];
  if (!rejected) return { allow: true };
  const subjectId = subjectKey.slice(subjectKey.indexOf(':') + 1);
  const ownerAskedAgain =
    task.scheduleId == null &&
    rejected.decidedAt != null &&
    task.createdAt.getTime() > rejected.decidedAt.getTime() &&
    subjectId.length > 0 &&
    task.input.includes(subjectId);
  if (ownerAskedAgain) return { allow: true, reason: 'owner_reconsider' };
  return { allow: false, reason: 'rejected_subject', approvalId: rejected.id };
}

/** This subject's pending + rejected approvals in the current workspace (tenant-scoped; read-only). */
export async function loadSubjectHistory(tx: DbTx, ctx: TenantContext, subjectKey: string): Promise<SubjectHistoryRow[]> {
  if (!subjectKey.startsWith('support_request:')) return [];
  const requestId = subjectKey.slice('support_request:'.length);
  return tx
    .select({ id: approvals.id, status: approvals.status, decidedAt: approvals.decidedAt })
    .from(approvals)
    .where(
      and(
        eq(approvals.projectId, ctx.projectId),
        eq(approvals.orgId, ctx.orgId),
        inArray(approvals.status, ['pending', 'rejected']),
        sql`${approvals.payload}->>'request_id' = ${requestId}`,
      ),
    )
    .orderBy(desc(approvals.createdAt))
    .limit(20);
}
