import { z } from 'zod';
import { sha256Hex } from '@/lib/crypto';
import { canonicalJson } from '@/orchestration/actions';
import {
  type Executor,
  type ExecutorAction,
  type ExecutorCapability,
  type ExecutorProvenance,
  type ExecutorResult,
} from './executor-contract';

export const ACCURATEBIDS_QUOTE_EXECUTOR_ID = 'accuratebids_quote';
export const ACCURATEBIDS_QUOTE_EXECUTOR_VERSION = '1';

/**
 * The tap-in (owner directive 2026-08-17): "tap them into AccurateBids so I could do my quotes,
 * invoicing, and stuff through them." The team drafts a quote as an `external_http` proposed
 * action carrying this payload; the owner Okays it in the Inbox; this executor POSTs it to the
 * AccurateBids `hub-quote` endpoint, which creates a DRAFT quote pinned to the owner's own
 * contractor account. Draft-only by construction — sending, invoicing, and payment stay with
 * the owner inside AccurateBids. Reversible: a draft quote can be deleted in the app.
 *
 * Any other external_http payload is refused here: this executor does exactly one thing.
 */
export const accurateBidsQuotePayloadSchema = z
  .object({
    kind: z.literal('accuratebids_quote'),
    job_name: z.string().min(1).max(200),
    customer_name: z.string().min(1).max(200),
    customer_phone: z.string().max(40).optional(),
    customer_email: z.string().max(200).optional(),
    job_address: z.string().max(300).optional(),
    job_type: z.enum(['hvac', 'plumbing']).optional(),
    notes: z.string().max(5000).optional(),
    materials: z
      .array(
        z.object({
          description: z.string().min(1).max(300),
          quantity: z.number().positive().max(100_000),
          unit: z.string().max(20).optional(),
          unit_cost: z.number().min(0).max(1_000_000),
        }).strict(),
      )
      .max(100)
      .optional(),
    labor: z
      .array(
        z.object({
          description: z.string().min(1).max(300),
          hours: z.number().positive().max(10_000),
          hourly_rate: z.number().min(0).max(10_000),
        }).strict(),
      )
      .max(100)
      .optional(),
    additional_charges: z
      .array(z.object({ description: z.string().min(1).max(300), amount: z.number().min(0).max(1_000_000) }).strict())
      .max(100)
      .optional(),
    markup_percent: z.number().min(0).max(100).optional(),
    tax_percent: z.number().min(0).max(30).optional(),
  })
  .strict();

export type AccurateBidsQuotePayload = z.infer<typeof accurateBidsQuotePayloadSchema>;

/**
 * Email Desk (owner directive 2026-08-20: "build email desk"): an owner-approved reply to an
 * AccurateBids support inquiry. On Okay the hub POSTs to the hub-reply endpoint, which sends
 * the email through AccurateBids' own sender and marks the request answered. The endpoint
 * refuses a second reply to the same request, so a retried approval can never double-email.
 */
export const accurateBidsReplyPayloadSchema = z
  .object({
    kind: z.literal('accuratebids_reply'),
    request_id: z.string().uuid(),
    reply_text: z.string().min(10).max(5000),
  })
  .strict();

export type AccurateBidsReplyPayload = z.infer<typeof accurateBidsReplyPayloadSchema>;

/**
 * The invoice side of the tap-in (owner directive 2026-08-20: "build the invoice side").
 * Two modes, mirroring the AccurateBids app's own quote->invoice conversion:
 *   - quote_id: invoice an existing quote (the endpoint copies its customer/job/line items and
 *     refuses a second non-void invoice for the same quote, so a retry can't double-bill);
 *   - direct: customer_name + job_name + line_items when there is no quote behind it.
 * Unlike quotes there is NO draft state for invoices — on the owner's Okay the invoice is
 * created as a real 'unpaid' receivable, which is exactly why the Okay gates it. The owner
 * still controls when the customer sees it.
 */
export const accurateBidsInvoicePayloadSchema = z
  .object({
    kind: z.literal('accuratebids_invoice'),
    quote_id: z.string().uuid().optional(),
    customer_name: z.string().min(1).max(200).optional(),
    customer_phone: z.string().max(40).optional(),
    customer_email: z.string().max(200).optional(),
    job_name: z.string().min(1).max(200).optional(),
    job_address: z.string().max(300).optional(),
    line_items: z
      .array(
        z.object({
          description: z.string().min(1).max(300),
          qty: z.number().positive().max(100_000),
          unit: z.string().max(20).optional(),
          unit_price: z.number().min(0).max(1_000_000),
        }).strict(),
      )
      .max(100)
      .optional(),
    tax_percent: z.number().min(0).max(30).optional(),
    due_days: z.number().int().min(1).max(365).optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict()
  .refine(
    (p) => Boolean(p.quote_id) || Boolean(p.customer_name && p.job_name && p.line_items?.length),
    { message: 'Provide quote_id, or customer_name + job_name + at least one line_item.' },
  );

export type AccurateBidsInvoicePayload = z.infer<typeof accurateBidsInvoicePayloadSchema>;

/**
 * The SEND side of the tap-in (owner directive 2026-10-19: "send out the invoice … to get paid").
 * An owner-confirmed send of ONE existing record to its customer, through AccurateBids' own
 * customer emails (hub-send → send-email: invoice_sent / invoice_reminder / quote_sent — the
 * real "View & Pay" / "View & Approve" emails). The idempotency key is the approval id, and
 * hub-send records it, so a retried approval can never email the customer twice.
 */
export const accurateBidsSendPayloadSchema = z
  .object({
    kind: z.literal('accuratebids_send'),
    send: z.enum(['invoice', 'invoice_reminder', 'quote']),
    invoice_id: z.string().uuid().optional(),
    quote_id: z.string().uuid().optional(),
    /** Display only (what the owner confirmed) — the endpoint re-reads the record itself. */
    label: z.string().max(200).optional(),
  })
  .strict()
  .refine((p) => (p.send === 'quote' ? Boolean(p.quote_id) && !p.invoice_id : Boolean(p.invoice_id) && !p.quote_id), {
    message: 'A quote send needs quote_id only; an invoice send needs invoice_id only.',
  });

export type AccurateBidsSendPayload = z.infer<typeof accurateBidsSendPayloadSchema>;

/** The hub-send idempotency key for an approval: one approval = at most one email. */
export function accurateBidsSendKey(approvalId: string): string {
  return `hub:${approvalId}`;
}

export interface AccurateBidsQuoteExecutorDeps {
  /** The hub-quote edge-function URL. Unset means quote drafting is unconfigured and blocks. */
  readonly endpointUrl: string | undefined;
  /** The hub-reply edge-function URL (Email Desk). Unset means replies are unconfigured and block. */
  readonly replyUrl?: string | undefined;
  /** The hub-invoice edge-function URL. Unset means invoicing is unconfigured and blocks. */
  readonly invoiceUrl?: string | undefined;
  /** The hub-send edge-function URL. Unset means customer sends are unconfigured and block. */
  readonly sendUrl?: string | undefined;
  /** The machine service token AccurateBids minted for the hub. Never a human login. */
  readonly serviceToken: string | undefined;
  readonly fetcher?: typeof fetch;
  readonly now?: () => Date;
}

export function accurateBidsDepsFromEnv(env: Record<string, string | undefined> = process.env): AccurateBidsQuoteExecutorDeps {
  return {
    endpointUrl: env.ACCURATEBIDS_QUOTE_URL,
    replyUrl: env.ACCURATEBIDS_REPLY_URL,
    invoiceUrl: env.ACCURATEBIDS_INVOICE_URL,
    sendUrl: env.ACCURATEBIDS_SEND_URL,
    serviceToken: env.ACCURATEBIDS_SERVICE_TOKEN,
  };
}

const CAPABILITY: ExecutorCapability = Object.freeze({
  executorId: ACCURATEBIDS_QUOTE_EXECUTOR_ID,
  contractVersion: '1',
  actionTypes: ['external_http'] as const,
  riskClasses: ['external_reversible'] as const,
  supportedModes: ['dry_run', 'live'] as const,
  enabledByDefault: false,
  externalSideEffects: true,
});

export class AccurateBidsQuoteExecutor implements Executor {
  readonly capability = CAPABILITY;

  constructor(private readonly deps: AccurateBidsQuoteExecutorDeps) {}

  async execute(action: ExecutorAction): Promise<ExecutorResult> {
    const attemptedAt = (this.deps.now?.() ?? new Date()).toISOString();
    const result = (
      outcome: ExecutorResult['outcome'],
      message: string,
      preview: Record<string, unknown> | null,
      opts: { reconciliation?: ExecutorResult['reconciliation']; retryAllowed?: boolean } = {},
    ): ExecutorResult =>
      Object.freeze({
        outcome,
        reconciliation: opts.reconciliation ?? 'not_required',
        retryAllowed: opts.retryAllowed ?? false,
        message,
        preview: preview ? Object.freeze(preview) : null,
        provenance: this.provenance(action, attemptedAt),
      });

    if (action.actionType !== 'external_http') {
      return result('blocked', 'AccurateBidsQuoteExecutor only executes external_http actions.', null);
    }
    if (sha256Hex(canonicalJson(action.payload)) !== action.payloadSha256) {
      return result('blocked', 'Payload integrity re-verification failed at the executor.', null);
    }

    // Email Desk: an approved support-inquiry reply routes to its own endpoint.
    const kindPeek = (action.payload as Record<string, unknown>).kind;

    // Customer send (invoice / reminder / quote) — routes to hub-send, keyed by the approval.
    if (kindPeek === 'accuratebids_send') {
      return this.executeSend(action, result);
    }
    if (kindPeek === 'accuratebids_reply') {
      const replyParsed = accurateBidsReplyPayloadSchema.safeParse(action.payload);
      if (!replyParsed.success) {
        const issues = replyParsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
        return result('blocked', `accuratebids_reply payload is not executable: ${issues}`, null);
      }
      if (!this.deps.replyUrl || !this.deps.serviceToken) {
        return result('blocked', 'The AccurateBids Email Desk is not configured on this server.', null);
      }
      const rp = replyParsed.data;
      const replyPlan = { kind: rp.kind, requestId: rp.request_id, replyChars: rp.reply_text.length };
      if (action.mode === 'dry_run') {
        return result('not_executed', 'Dry run only. Would send the support reply.', { ...replyPlan, wouldExecute: true });
      }
      try {
        const fetcher = this.deps.fetcher ?? fetch;
        const res = await fetcher(this.deps.replyUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.deps.serviceToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ request_id: rp.request_id, reply_text: rp.reply_text }),
          signal: AbortSignal.timeout(15_000),
        });
        const text = await res.text();
        let parsedBody: Record<string, unknown> = {};
        try {
          parsedBody = JSON.parse(text) as Record<string, unknown>;
        } catch {
          // Non-JSON error body; status carries the verdict.
        }
        if (!res.ok || parsedBody.success !== true) {
          const detail = typeof parsedBody.error === 'string' ? parsedBody.error : `HTTP ${res.status}`;
          if (res.status === 409) {
            return result('blocked', 'This inquiry was already answered - a second reply was refused (no double-emailing).', replyPlan);
          }
          if (res.status >= 500) {
            return result('ambiguous', `AccurateBids returned ${detail}. The reply may or may not have sent - check the request's status before retrying.`, replyPlan, { reconciliation: 'required' });
          }
          return result('failed', `AccurateBids refused the reply: ${detail}`, replyPlan, { retryAllowed: true });
        }
        const sentTo = typeof parsedBody.sent_to === 'string' ? parsedBody.sent_to : null;
        return result('succeeded', `Support reply sent${sentTo ? ` to ${sentTo}` : ''}; the inquiry is marked answered.`, { ...replyPlan, sentTo });
      } catch (err) {
        const detail = err instanceof Error ? err.message : 'unknown error';
        return result('ambiguous', `Could not confirm the support reply (${detail}). Check the request's status before retrying.`, replyPlan, { reconciliation: 'required' });
      }
    }

    // Invoice side: an approved invoice routes to the hub-invoice endpoint.
    if (kindPeek === 'accuratebids_invoice') {
      const invParsed = accurateBidsInvoicePayloadSchema.safeParse(action.payload);
      if (!invParsed.success) {
        const issues = invParsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
        return result('blocked', `accuratebids_invoice payload is not executable: ${issues}`, null);
      }
      if (!this.deps.invoiceUrl || !this.deps.serviceToken) {
        return result('blocked', 'AccurateBids invoicing is not configured on this server.', null);
      }
      const inv = invParsed.data;
      const invPlan = {
        kind: inv.kind,
        quoteId: inv.quote_id ?? null,
        customerName: inv.customer_name ?? null,
        jobName: inv.job_name ?? null,
        lineItemCount: inv.line_items?.length ?? 0,
      };
      if (action.mode === 'dry_run') {
        return result('not_executed', 'Dry run only. Would create the invoice in AccurateBids.', { ...invPlan, wouldExecute: true });
      }
      const { kind: _invKind, ...invBody } = inv;
      try {
        const fetcher = this.deps.fetcher ?? fetch;
        const res = await fetcher(this.deps.invoiceUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.deps.serviceToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(invBody),
          signal: AbortSignal.timeout(15_000),
        });
        const text = await res.text();
        let parsedBody: Record<string, unknown> = {};
        try {
          parsedBody = JSON.parse(text) as Record<string, unknown>;
        } catch {
          // Non-JSON error body; status carries the verdict.
        }
        if (!res.ok || parsedBody.success !== true) {
          const detail = typeof parsedBody.error === 'string' ? parsedBody.error : `HTTP ${res.status}`;
          if (res.status === 409) {
            return result('blocked', `That quote is already invoiced - a second invoice was refused (no double-billing). ${detail}`, invPlan);
          }
          if (res.status >= 500) {
            return result('ambiguous', `AccurateBids returned ${detail}. The invoice may or may not exist - check the Invoices list before retrying.`, invPlan, { reconciliation: 'required' });
          }
          return result('failed', `AccurateBids refused the invoice: ${detail}`, invPlan, { retryAllowed: true });
        }
        const invoiceNumber = typeof parsedBody.invoice_number === 'string' ? parsedBody.invoice_number : null;
        const amount = parsedBody.amount;
        return result(
          'succeeded',
          `Invoice ${invoiceNumber ?? ''}${amount != null ? ` ($${amount})` : ''} created in AccurateBids (not yet sent to the customer — ask Ops Chat to send it, or send it from the app).`,
          { ...invPlan, invoiceId: parsedBody.invoice_id ?? null, invoiceNumber, amount: amount ?? null },
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : 'unknown error';
        return result('ambiguous', `Could not confirm the AccurateBids invoice (${detail}). Check the Invoices list before retrying.`, invPlan, { reconciliation: 'required' });
      }
    }

    const parsed = accurateBidsQuotePayloadSchema.safeParse(action.payload);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      return result(
        'blocked',
        `This external_http action is not an executable AccurateBids quote (${issues}). ` +
          'Only payloads matching the accuratebids_quote contract execute; everything else stays a proposal.',
        null,
      );
    }
    const payload = parsed.data;
    if (!this.deps.endpointUrl || !this.deps.serviceToken) {
      return result('blocked', 'The AccurateBids connection is not configured on this server.', null);
    }

    const plan = {
      kind: payload.kind,
      jobName: payload.job_name,
      customerName: payload.customer_name,
      materialCount: payload.materials?.length ?? 0,
      laborCount: payload.labor?.length ?? 0,
      chargeCount: payload.additional_charges?.length ?? 0,
    };

    if (action.mode === 'dry_run') {
      return result('not_executed', `Dry run only. Would create draft quote "${payload.job_name}" in AccurateBids.`, { ...plan, wouldExecute: true });
    }

    const { kind: _kind, ...body } = payload;
    try {
      const fetcher = this.deps.fetcher ?? fetch;
      const res = await fetcher(this.deps.endpointUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.deps.serviceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      let parsedBody: Record<string, unknown> = {};
      try {
        parsedBody = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // Non-JSON error body; fall through with status only.
      }
      if (!res.ok || parsedBody.success !== true) {
        const detail = typeof parsedBody.error === 'string' ? parsedBody.error : `HTTP ${res.status}`;
        // A non-2xx means AccurateBids refused before creating anything (its insert is the
        // final step) — but a 5xx AFTER insert cannot be ruled out, so 5xx reports ambiguous.
        if (res.status >= 500) {
          return result('ambiguous', `AccurateBids returned ${detail}. The draft may or may not exist — check the Quotes list before retrying.`, plan, { reconciliation: 'required' });
        }
        return result('failed', `AccurateBids refused the draft: ${detail}`, plan, { retryAllowed: true });
      }
      const quoteId = typeof parsedBody.quote_id === 'string' ? parsedBody.quote_id : null;
      const url = typeof parsedBody.url === 'string' ? parsedBody.url : null;
      const grandTotal = parsedBody.grand_total;
      return result(
        'succeeded',
        `Draft quote "${payload.job_name}" created in AccurateBids${grandTotal != null ? ` ($${grandTotal})` : ''} (not yet sent to the customer — review it, then ask Ops Chat to send it or send it from the app).`,
        { ...plan, quoteId, quoteUrl: url, grandTotal: grandTotal ?? null },
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      // Timeouts and network failures are indeterminate: the request may have landed.
      return result('ambiguous', `Could not confirm the AccurateBids draft (${detail}). Check the Quotes list before retrying.`, plan, { reconciliation: 'required' });
    }
  }

  /**
   * Send ONE record to its customer through hub-send. Outcome mapping is deliberately honest:
   * a refusal before sending (no email, not found, paid/void) is `blocked`/`failed`; a provider
   * refusal is `failed` (retry allowed — hub-send lets the same key retry a failed send); and
   * anything that could have reached the customer without confirmation is `ambiguous`.
   */
  private async executeSend(
    action: ExecutorAction,
    result: (
      outcome: ExecutorResult['outcome'],
      message: string,
      preview: Record<string, unknown> | null,
      opts?: { reconciliation?: ExecutorResult['reconciliation']; retryAllowed?: boolean },
    ) => ExecutorResult,
  ): Promise<ExecutorResult> {
    const parsed = accurateBidsSendPayloadSchema.safeParse(action.payload);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      return result('blocked', `accuratebids_send payload is not executable: ${issues}`, null);
    }
    if (!this.deps.sendUrl || !this.deps.serviceToken) {
      return result('blocked', 'Sending to customers through AccurateBids is not configured on this server.', null);
    }
    const p = parsed.data;
    const what = p.send === 'quote' ? 'quote' : p.send === 'invoice_reminder' ? 'payment reminder' : 'invoice';
    const idempotencyKey = accurateBidsSendKey(action.approvalId);
    const plan = { kind: p.kind, send: p.send, invoiceId: p.invoice_id ?? null, quoteId: p.quote_id ?? null, label: p.label ?? null, idempotencyKey };
    if (action.mode === 'dry_run') {
      return result('not_executed', `Dry run only. Would email the ${what} to the customer.`, { ...plan, wouldExecute: true });
    }
    try {
      const fetcher = this.deps.fetcher ?? fetch;
      const res = await fetcher(this.deps.sendUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.deps.serviceToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: p.send,
          ...(p.send === 'quote' ? { quote_id: p.quote_id } : { invoice_id: p.invoice_id }),
          idempotency_key: idempotencyKey,
        }),
        signal: AbortSignal.timeout(25_000),
      });
      const text = await res.text();
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // Non-JSON body; the status carries the verdict.
      }
      const detail = typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
      if (res.ok && body.success === true) {
        const sentTo = typeof body.sent_to === 'string' ? body.sent_to : null;
        const label = typeof body.label === 'string' ? body.label : p.label ?? what;
        return result(
          'succeeded',
          `${what[0]!.toUpperCase()}${what.slice(1)} ${label} emailed to the customer${sentTo ? ` (${sentTo})` : ''}${body.replayed === true ? ' — already sent earlier; not emailed again' : ''}.`,
          { ...plan, sentTo, replayed: body.replayed === true, invoiceNumber: body.invoice_number ?? null },
        );
      }
      if (body.ambiguous === true || res.status >= 500) {
        return result('ambiguous', `Could not confirm whether the ${what} was emailed (${detail}). Check the customer's email log in AccurateBids before retrying.`, plan, { reconciliation: 'required' });
      }
      if (res.status === 400 || res.status === 404 || res.status === 409) {
        return result('blocked', `The ${what} was not sent: ${detail}`, plan);
      }
      return result('failed', `The ${what} was not sent: ${detail}`, plan, { retryAllowed: true });
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      return result('ambiguous', `Could not confirm whether the ${what} was emailed (${detail}). Check the customer's email log in AccurateBids before retrying.`, plan, { reconciliation: 'required' });
    }
  }

  private provenance(action: ExecutorAction, attemptedAt: string): Readonly<ExecutorProvenance> {
    return Object.freeze({
      contractVersion: '1' as const,
      executorId: this.capability.executorId,
      executorVersion: ACCURATEBIDS_QUOTE_EXECUTOR_VERSION,
      actionType: action.actionType,
      riskClass: action.riskClass,
      actorId: action.authorization.actorId,
      orgId: action.orgId,
      projectId: action.projectId,
      approvalId: action.approvalId,
      taskId: action.taskId,
      runId: action.runId,
      correlationId: action.correlationId,
      idempotencyKey: action.idempotencyKey,
      payloadSha256: action.payloadSha256,
      mode: action.mode,
      attemptedAt,
      completedAt: (this.deps.now?.() ?? new Date()).toISOString(),
    });
  }
}
