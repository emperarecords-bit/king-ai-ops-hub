import 'server-only';
import type { z } from 'zod';
import { AppError } from '@/lib/errors';
import { withTenant } from '@/db/tenant';
import { approvals } from '@/db/schema';
import { type TenantContext } from '@/types/domain';
import { canonicalJson } from '@/orchestration/actions';
import { sha256Hex } from '@/lib/crypto';
import { listAgents } from '@/domain/agents/agents';
import { createTask, setTaskStatus } from '@/domain/tasks/tasks';
import { decideApproval } from '@/domain/approvals/approvals';
import { executeApprovedIfEligible, type ApprovalExecutionOutcome } from '@/domain/execution/execute-on-approval';
import {
  accurateBidsInvoicePayloadSchema,
  accurateBidsQuotePayloadSchema,
  accurateBidsSendPayloadSchema,
} from '@/domain/execution/accuratebids-quote-executor';
import { sightDepsFromEnv, sightEnabledKeys, type AccurateBidsSightDeps } from '@/domain/integrations/accuratebids-sight';

/**
 * Ops Chat → AccurateBids bridge (owner directive 2026-10-19: "do the quotes … do the invoice …
 * send out the invoice"). The owner asks in Ops Chat, the model PREPARES a card, and only the
 * owner's Confirm runs it — through the SAME governed path the Inbox uses, never a side door:
 *
 *   1. one tenant transaction: an anchor task + an `external_http` approval carrying the exact
 *      payload the owner saw (sha256-pinned), decided 'approved' through `decideApproval`
 *      (the Confirm IS the approval);
 *   2. `executeApprovedIfEligible` — the single dispatch choke point (executor enablement,
 *      payload-bound confirmation, audit, idempotency, ambiguity handling);
 *   3. the AccurateBids executor (hub-quote / hub-invoice / hub-send).
 *
 * Only workspaces with AccurateBids sight (ACCURATEBIDS_SIGHT_PROJECT_KEYS) may use it — the
 * AccurateBids account is the owner's own, so it is never reachable from an unrelated workspace.
 */

const APPROVAL_WINDOW_MS = 10 * 60 * 1000;

export type AccurateBidsOpsChatPayload =
  | z.infer<typeof accurateBidsQuotePayloadSchema>
  | z.infer<typeof accurateBidsInvoicePayloadSchema>
  | z.infer<typeof accurateBidsSendPayloadSchema>;

/** Parse a stored/proposed payload into exactly one of the three executable AccurateBids kinds. */
export function parseAccurateBidsOpsChatPayload(input: unknown): AccurateBidsOpsChatPayload {
  const kind = input && typeof input === 'object' ? (input as Record<string, unknown>).kind : undefined;
  const schema =
    kind === 'accuratebids_quote'
      ? accurateBidsQuotePayloadSchema
      : kind === 'accuratebids_invoice'
        ? accurateBidsInvoicePayloadSchema
        : kind === 'accuratebids_send'
          ? accurateBidsSendPayloadSchema
          : null;
  if (!schema) throw new AppError('validation', 'Not an AccurateBids quote, invoice, or send.');
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new AppError('validation', `Invalid AccurateBids ${String(kind).replace('accuratebids_', '')}: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  }
  return r.data as AccurateBidsOpsChatPayload;
}

/** Is this workspace connected to the owner's AccurateBids account? */
export function accurateBidsEnabledFor(projectKey: string, env: Record<string, string | undefined> = process.env): boolean {
  return sightEnabledKeys(env).includes(projectKey);
}

/** The one-line summary stored on the approval (what the owner confirmed). */
export function summarizeAccurateBidsPayload(p: AccurateBidsOpsChatPayload): string {
  const money = (v: number) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (p.kind === 'accuratebids_quote') {
    return `Draft an AccurateBids quote "${p.job_name}" for ${p.customer_name} (draft only — nothing is sent to the customer).`;
  }
  if (p.kind === 'accuratebids_invoice') {
    if (p.quote_id) return `Create an AccurateBids invoice from quote ${p.quote_id} (a real unpaid invoice; not sent to the customer).`;
    const total = (p.line_items ?? []).reduce((s, l) => s + l.qty * l.unit_price, 0);
    return `Create an AccurateBids invoice "${p.job_name}" for ${p.customer_name} — ${money(total)} before tax (a real unpaid invoice; not sent to the customer).`;
  }
  const what = p.send === 'quote' ? 'quote' : p.send === 'invoice_reminder' ? 'payment reminder for invoice' : 'invoice';
  if (p.customer_email) {
    return `Save ${p.customer_email} as the customer's email on invoice${p.label ? ` ${p.label}` : ''} (it has none on file), then email the ${what} to it through AccurateBids.`;
  }
  return `Email the ${what}${p.label ? ` ${p.label}` : ''} to the customer through AccurateBids.`;
}

export interface OpsChatAccurateBidsResult {
  readonly approvalId: string;
  readonly attempted: boolean;
  readonly outcome: ApprovalExecutionOutcome['outcome'];
  readonly message: string | null;
  readonly preview: unknown;
}

/** Run one owner-confirmed AccurateBids action through the governed path (see module doc). */
export async function executeAccurateBidsFromOpsChat(ctx: TenantContext, projectKey: string, input: unknown): Promise<OpsChatAccurateBidsResult> {
  if (!accurateBidsEnabledFor(projectKey)) {
    throw new AppError('forbidden', 'This workspace is not connected to AccurateBids.');
  }
  const payload = parseAccurateBidsOpsChatPayload(input);
  const summary = summarizeAccurateBidsPayload(payload);

  const { approvalId, taskId } = await withTenant(ctx, async (tx) => {
    // An approval must hang off a task (schema invariant). Anchor it to the workspace's first enabled
    // PRIMARY employee; the action is owner-initiated via Ops Chat and no AI run is enqueued.
    const agent = (await listAgents(tx, ctx)).find((a) => a.enabled && a.role === 'primary');
    if (!agent) throw new AppError('conflict', 'This workspace has no enabled primary employee to anchor the action.');
    const anchorTaskId = await createTask(tx, ctx, {
      title: summary.slice(0, 200),
      input: `Owner-initiated AccurateBids action prepared via Ops Chat.\n${summary}`,
      providerSelection: agent.provider,
      reviewEnabled: false,
      primaryAgentId: agent.id,
    });
    const inserted = await tx
      .insert(approvals)
      .values({
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        taskId: anchorTaskId,
        actionType: 'external_http',
        payload,
        payloadSha256: sha256Hex(canonicalJson(payload)),
        summary,
        status: 'pending',
        expiresAt: new Date(Date.now() + APPROVAL_WINDOW_MS),
      })
      .returning({ id: approvals.id });
    const id = inserted[0]!.id;
    // The admin's Ops Chat Confirm IS the approval decision — recorded through the sanctioned path.
    await decideApproval(tx, ctx, id, 'approved', 'Confirmed via Ops Chat AccurateBids bridge');
    return { approvalId: id, taskId: anchorTaskId };
  });

  const result = await executeApprovedIfEligible(ctx, approvalId);
  await withTenant(ctx, (tx) => setTaskStatus(tx, ctx, taskId, result.outcome === 'succeeded' ? 'completed' : 'failed')).catch(() => {
    /* finalization is best-effort; the execution result + audit are the source of truth */
  });
  return { approvalId, attempted: result.attempted, outcome: result.outcome, message: result.message, preview: result.preview ?? null };
}

// ── Read side: recent quotes & invoices (ids) for the model to target ─────────────────────────

export interface AccurateBidsRecords {
  readonly quotes: ReadonlyArray<Record<string, unknown>>;
  readonly invoices: ReadonlyArray<Record<string, unknown>>;
  readonly openBalance: number | null;
}

const pick = (o: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));

/** The owner's newest quotes and invoices (with ids) from hub-snapshot. Read-only; null when unavailable. */
export async function fetchAccurateBidsRecords(deps: AccurateBidsSightDeps = sightDepsFromEnv()): Promise<AccurateBidsRecords | null> {
  if (!deps.snapshotUrl || !deps.serviceToken) return null;
  try {
    const res = await (deps.fetcher ?? fetch)(deps.snapshotUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${deps.serviceToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const q = (data.quotes ?? {}) as Record<string, unknown>;
    const i = (data.invoices ?? {}) as Record<string, unknown>;
    const asList = (v: unknown) => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []);
    return {
      quotes: asList(q.recent).map((r) => pick(r, ['id', 'job_name', 'customer_name', 'status', 'grand_total', 'has_email', 'bid_date'])),
      invoices: asList(i.recent).map((r) =>
        pick(r, ['id', 'invoice_number', 'job_name', 'customer_name', 'status', 'amount', 'balance_due', 'due_date', 'has_email']),
      ),
      openBalance: typeof i.open_balance === 'number' ? i.open_balance : null,
    };
  } catch {
    return null;
  }
}
