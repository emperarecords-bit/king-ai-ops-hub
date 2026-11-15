import { z } from 'zod';
import { sha256Hex } from '@/lib/crypto';
import { canonicalJson } from '@/orchestration/actions';
import {
  NO_TOKEN_FOR_WORKSPACE,
  resolveServiceToken,
  type ResolvedServiceToken,
} from '@/domain/integrations/accuratebids-tokens';
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
    /**
     * Optional per-document trading name — the LETTERHEAD only ("draft THIS job as Hill Street
     * Construction"). AccurateBids resolves the contractor from the bearer token and ignores the
     * body for identity, so this can never move a quote onto another company's books.
     *
     * A quote is created as a DRAFT, so nothing is frozen yet: this is what the quote will be
     * pinned to when it is sent, which is why hub-quote echoes it back as `will_bill_as` rather
     * than as a settled letterhead.
     *
     * Trimmed and non-empty on purpose — see the invoice schema below for why a blank is refused.
     */
    company_name_override: z.string().trim().min(1).max(200).optional(),
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
    /**
     * Optional per-document trading name — the LETTERHEAD only. AccurateBids resolves the
     * contractor from the bearer token and ignores the body for identity, so this can never move
     * an invoice onto another company's books; it only changes the name printed at the top.
     *
     * On a DIRECT invoice there is nothing to inherit, so this is what the freeze trigger pins.
     *
     * On a FROM-QUOTE invoice, explicit beats inherited: hub-invoice drops the name inherited
     * from the quote and re-pins the invoice to this one. That is deliberate on their side and a
     * real consequence on ours — the invoice will then NOT match the letterhead on the quote the
     * customer is already holding. Only set it on a from-quote invoice when that is the intent.
     *
     * Trimmed and non-empty on purpose: AccurateBids maps a blank string to null, which means
     * "use the profile name" — the opposite of what an owner who confirmed a card showing a blank
     * "Bill as" intended. Refuse it here rather than silently invert it.
     */
    company_name_override: z.string().trim().min(1).max(200).optional(),
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
/** Same rule as AccurateBids hub-send: one @, a dotted domain, no spaces/<>/quotes/commas/semicolons. */
export const ACCURATEBIDS_EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[A-Za-z]{2,}$/;

export const accurateBidsSendPayloadSchema = z
  .object({
    kind: z.literal('accuratebids_send'),
    send: z.enum(['invoice', 'invoice_reminder', 'quote']),
    invoice_id: z.string().uuid().optional(),
    quote_id: z.string().uuid().optional(),
    /** Display only (what the owner confirmed) — the endpoint re-reads the record itself. */
    label: z.string().max(200).optional(),
    /**
     * Invoice sends only: the address the OWNER gave for an invoice with no email on file.
     * hub-send saves it only while the invoice has none (never overwriting one), then emails it.
     */
    customer_email: z
      .string()
      .trim()
      .max(200)
      .regex(ACCURATEBIDS_EMAIL_RE, 'must be one plain email address')
      .optional(),
  })
  .strict()
  .refine((p) => (p.send === 'quote' ? Boolean(p.quote_id) && !p.invoice_id : Boolean(p.invoice_id) && !p.quote_id), {
    message: 'A quote send needs quote_id only; an invoice send needs invoice_id only.',
  })
  .refine((p) => p.send !== 'quote' || p.customer_email === undefined, {
    message: 'customer_email is only for invoice sends.',
  });

export type AccurateBidsSendPayload = z.infer<typeof accurateBidsSendPayloadSchema>;

/** The hub-send idempotency key for an approval: one approval = at most one email. */
export function accurateBidsSendKey(approvalId: string): string {
  return `hub:${approvalId}`;
}

/**
 * Correcting the customer's contact details on an EXISTING DRAFT quote — hub-quote's second
 * action (`action: "patch_contact"`, live in AccurateBids production since hub-quote v7).
 *
 * WHY THIS IS A SEPARATE KIND and not a field on the quote payload: it targets a quote that
 * already exists. Everything else in this file creates a record; this one amends one.
 *
 * WHAT IT CANNOT DO, by construction on the AccurateBids side:
 *   - It SENDS NOTHING. No email, no SMS, no status change — that is the entire reason the
 *     endpoint exists, since `hub-send` could only save an address by emailing at the same time.
 *   - DRAFT ONLY. A sent quote's contact details are part of what the customer already received,
 *     so AccurateBids refuses one with a 409 rather than quietly skipping it.
 *   - It cannot reach another company's quote: the contractor comes from the bearer token and the
 *     quote lookup is scoped to it, so an id from the wrong account reads as 404 / not found.
 *
 * WHAT IT DOES DO, and the owner must see it on the card: it OVERWRITES whatever address or
 * number is on file. That is deliberate upstream — a correction path that cannot overwrite cannot
 * fix a typo, which is the only reason it exists — but the Hub has no way to show the owner the
 * value being replaced. `hub-snapshot` deliberately strips `customer_email` (it exposes only
 * `has_email`) and never returns `customer_phone` at all, so the old value is not ours to read.
 * The confirm card therefore says "replacing whatever is on file" rather than naming it, and the
 * executor reports what AccurateBids has AFTERWARDS plus its `changed` list, which is the only
 * honest account of what actually moved.
 *
 * CLEARING IS NOT SUPPORTED on either side: an absent field is left alone, and a blank one is
 * refused here (and 400s there) rather than wiping a contact detail because a payload carried an
 * empty string.
 *
 * NO IDEMPOTENCY KEY, unlike `accuratebids_send`: setting a field to the same value twice is the
 * same state, and `changed: []` reports a no-op honestly, so a retry is harmless by construction
 * rather than by bookkeeping.
 */
export const accurateBidsContactPatchPayloadSchema = z
  .object({
    kind: z.literal('accuratebids_contact_patch'),
    /** The existing DRAFT quote to correct. */
    quote_id: z.string().uuid(),
    /**
     * The corrected address. Validated against the same rule hub-send uses, which is stricter than
     * hub-quote's own check, so anything accepted here is accepted there — never the reverse.
     */
    customer_email: z
      .string()
      .trim()
      .max(200)
      .regex(ACCURATEBIDS_EMAIL_RE, 'must be one plain email address')
      .optional(),
    /**
     * The corrected number. Formatting is the customer's business, but AccurateBids requires at
     * least 7 digits — mirrored here so a non-number is refused before the request is made.
     */
    customer_phone: z
      .string()
      .trim()
      .max(40)
      .refine((v) => (v.match(/\d/g) ?? []).length >= 7, 'must contain at least 7 digits')
      .optional(),
    /** Display only (what the owner confirmed) — the endpoint re-reads the quote itself. */
    label: z.string().max(200).optional(),
  })
  .strict()
  .refine((p) => p.customer_email !== undefined || p.customer_phone !== undefined, {
    message: 'Provide customer_email, customer_phone, or both.',
  });

export type AccurateBidsContactPatchPayload = z.infer<typeof accurateBidsContactPatchPayloadSchema>;

/**
 * What to append to a success message about the company name a document was issued under.
 *
 * `reported` is what AccurateBids read back: `will_bill_as` on a draft quote (nothing is frozen
 * yet, so it is the name the quote WILL be sent under) or `billed_as` on an invoice (the settled
 * letterhead, read off the row after the freeze trigger ran). `asked` is what the owner confirmed,
 * or null when they named no trading name and the profile name applies.
 *
 * A disagreement between the two is reported loudly rather than swallowed. Quietly succeeding
 * under a company name other than the one the owner confirmed is the only way this field can do
 * real damage — the customer receives paperwork headed with the wrong business — so it must never
 * read as a clean success.
 */
export function letterheadNote(
  asked: string | null,
  reported: string | null,
  verb: 'billed as' | 'will be sent under',
): string {
  if (asked && reported !== asked) {
    return ` NOTE: you asked for "${asked}" but AccurateBids reports "${reported ?? 'your profile name'}" — check the document in AccurateBids before it goes to the customer.`;
  }
  if (!reported) return '';
  return ` ${verb[0]!.toUpperCase()}${verb.slice(1)} "${reported}".`;
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
  /**
   * Resolve the token for THIS action's workspace, at execute time.
   *
   * AccurateBids resolves the contractor account from the bearer token alone, so this is the one
   * thing deciding whose books an invoice lands in. It is a loader rather than a value because the
   * workspace is only known per action (dispatch looks its key up in the same transaction), and it
   * follows the loader idiom the sibling executors already use for per-project config. Absent, the
   * flat `serviceToken` is used — which is what every existing test and call site does.
   */
  readonly loadServiceToken?: () => Promise<ResolvedServiceToken>;
  readonly fetcher?: typeof fetch;
  readonly now?: () => Date;
}

export function accurateBidsDepsFromEnv(
  projectKey?: string,
  env: Record<string, string | undefined> = process.env,
): AccurateBidsQuoteExecutorDeps {
  return {
    endpointUrl: env.ACCURATEBIDS_QUOTE_URL,
    replyUrl: env.ACCURATEBIDS_REPLY_URL,
    invoiceUrl: env.ACCURATEBIDS_INVOICE_URL,
    sendUrl: env.ACCURATEBIDS_SEND_URL,
    serviceToken: resolveServiceToken(projectKey, env).token,
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

    // WHOSE AccurateBids account this action bills, resolved once for every branch below. The
    // token IS the contractor identity on the AccurateBids side, so a wrong or defaulted token
    // silently files a workspace's quote or invoice under another contractor. 'none' means we
    // could not establish the workspace's entitlement — refuse rather than guess.
    const resolvedToken = this.deps.loadServiceToken
      ? await this.deps.loadServiceToken()
      : ({ token: this.deps.serviceToken, source: 'default' } as const);
    if (resolvedToken.source === 'none') {
      return result('blocked', NO_TOKEN_FOR_WORKSPACE, null);
    }
    const serviceToken = resolvedToken.token;

    // Email Desk: an approved support-inquiry reply routes to its own endpoint.
    const kindPeek = (action.payload as Record<string, unknown>).kind;

    // Customer send (invoice / reminder / quote) — routes to hub-send, keyed by the approval.
    if (kindPeek === 'accuratebids_send') {
      return this.executeSend(action, result, serviceToken);
    }

    // Contact correction on an existing DRAFT quote — hub-quote's `patch_contact` action. Same
    // endpoint as drafting, so it is configured (or not) together with it.
    if (kindPeek === 'accuratebids_contact_patch') {
      return this.executeContactPatch(action, result, serviceToken);
    }
    if (kindPeek === 'accuratebids_reply') {
      const replyParsed = accurateBidsReplyPayloadSchema.safeParse(action.payload);
      if (!replyParsed.success) {
        const issues = replyParsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
        return result('blocked', `accuratebids_reply payload is not executable: ${issues}`, null);
      }
      if (!this.deps.replyUrl || !serviceToken) {
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
          headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' },
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
      if (!this.deps.invoiceUrl || !serviceToken) {
        return result('blocked', 'AccurateBids invoicing is not configured on this server.', null);
      }
      const inv = invParsed.data;
      const invPlan = {
        kind: inv.kind,
        quoteId: inv.quote_id ?? null,
        customerName: inv.customer_name ?? null,
        jobName: inv.job_name ?? null,
        lineItemCount: inv.line_items?.length ?? 0,
        companyNameOverride: inv.company_name_override ?? null,
      };
      if (action.mode === 'dry_run') {
        return result('not_executed', 'Dry run only. Would create the invoice in AccurateBids.', { ...invPlan, wouldExecute: true });
      }
      const { kind: _invKind, ...invBody } = inv;
      try {
        const fetcher = this.deps.fetcher ?? fetch;
        const res = await fetcher(this.deps.invoiceUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' },
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
        // The letterhead the customer will actually see. hub-invoice reads it back off the row
        // AFTER the freeze trigger ran, so it is the settled value rather than merely what we
        // asked for — which is the whole reason to report it instead of echoing the request.
        const billedAs = typeof parsedBody.billed_as === 'string' ? parsedBody.billed_as : null;
        return result(
          'succeeded',
          `Invoice ${invoiceNumber ?? ''}${amount != null ? ` ($${amount})` : ''} created in AccurateBids (not yet sent to the customer — ask Ops Chat to send it, or send it from the app).` +
            letterheadNote(inv.company_name_override ?? null, billedAs, 'billed as'),
          { ...invPlan, invoiceId: parsedBody.invoice_id ?? null, invoiceNumber, amount: amount ?? null, billedAs },
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
    if (!this.deps.endpointUrl || !serviceToken) {
      return result('blocked', 'The AccurateBids connection is not configured on this server.', null);
    }

    const plan = {
      kind: payload.kind,
      jobName: payload.job_name,
      customerName: payload.customer_name,
      materialCount: payload.materials?.length ?? 0,
      laborCount: payload.labor?.length ?? 0,
      chargeCount: payload.additional_charges?.length ?? 0,
      companyNameOverride: payload.company_name_override ?? null,
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
          Authorization: `Bearer ${serviceToken}`,
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
      // A draft is not frozen, so this is the name the quote WILL be sent under rather than a
      // settled letterhead; null means "your profile name as it stands at send time".
      const willBillAs = typeof parsedBody.will_bill_as === 'string' ? parsedBody.will_bill_as : null;
      return result(
        'succeeded',
        `Draft quote "${payload.job_name}" created in AccurateBids${grandTotal != null ? ` ($${grandTotal})` : ''} (not yet sent to the customer — review it, then ask Ops Chat to send it or send it from the app).` +
          letterheadNote(payload.company_name_override ?? null, willBillAs, 'will be sent under'),
        { ...plan, quoteId, quoteUrl: url, grandTotal: grandTotal ?? null, willBillAs },
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
    /** Already resolved for this action's workspace by execute() — never re-read from deps. */
    serviceToken: string | undefined,
  ): Promise<ExecutorResult> {
    const parsed = accurateBidsSendPayloadSchema.safeParse(action.payload);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      return result('blocked', `accuratebids_send payload is not executable: ${issues}`, null);
    }
    if (!this.deps.sendUrl || !serviceToken) {
      return result('blocked', 'Sending to customers through AccurateBids is not configured on this server.', null);
    }
    const p = parsed.data;
    const what = p.send === 'quote' ? 'quote' : p.send === 'invoice_reminder' ? 'payment reminder' : 'invoice';
    const idempotencyKey = accurateBidsSendKey(action.approvalId);
    // The plan (audit) records only THAT an owner-given address came with the send, never the address.
    const plan = {
      kind: p.kind,
      send: p.send,
      invoiceId: p.invoice_id ?? null,
      quoteId: p.quote_id ?? null,
      label: p.label ?? null,
      idempotencyKey,
      withOwnerEmail: p.customer_email !== undefined,
    };
    if (action.mode === 'dry_run') {
      return result('not_executed', `Dry run only. Would email the ${what} to the customer.`, { ...plan, wouldExecute: true });
    }
    try {
      const fetcher = this.deps.fetcher ?? fetch;
      const res = await fetcher(this.deps.sendUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: p.send,
          ...(p.send === 'quote' ? { quote_id: p.quote_id } : { invoice_id: p.invoice_id }),
          ...(p.customer_email !== undefined ? { customer_email: p.customer_email } : {}),
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
          `${what[0]!.toUpperCase()}${what.slice(1)} ${label} emailed to the customer${sentTo ? ` (${sentTo})` : ''}${body.email_saved === true ? '; that email is now saved on the invoice' : ''}${body.replayed === true ? ' — already sent earlier; not emailed again' : ''}.`,
          { ...plan, sentTo, replayed: body.replayed === true, emailSaved: body.email_saved === true, invoiceNumber: body.invoice_number ?? null },
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

  /**
   * Correct `customer_email` / `customer_phone` on ONE existing DRAFT quote through hub-quote's
   * `patch_contact` action. Emails nothing, changes no status, and touches no other field.
   *
   * Outcome mapping follows the send lane's rule — honest over tidy. A refusal that means the
   * quote cannot be amended (gone, not ours, no longer a draft, or it moved mid-write) is
   * `blocked`: a retry of the same payload would be refused the same way, so it needs a new
   * decision rather than another attempt. Anything that could have written without confirming is
   * `ambiguous`, and there a retry IS safe — the patch is idempotent — which the message says.
   */
  private async executeContactPatch(
    action: ExecutorAction,
    result: (
      outcome: ExecutorResult['outcome'],
      message: string,
      preview: Record<string, unknown> | null,
      opts?: { reconciliation?: ExecutorResult['reconciliation']; retryAllowed?: boolean },
    ) => ExecutorResult,
    /** Already resolved for this action's workspace by execute() — never re-read from deps. */
    serviceToken: string | undefined,
  ): Promise<ExecutorResult> {
    const parsed = accurateBidsContactPatchPayloadSchema.safeParse(action.payload);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      return result('blocked', `accuratebids_contact_patch payload is not executable: ${issues}`, null);
    }
    if (!this.deps.endpointUrl || !serviceToken) {
      return result('blocked', 'The AccurateBids connection is not configured on this server.', null);
    }
    const p = parsed.data;
    const asked: string[] = [
      ...(p.customer_email !== undefined ? ['customer_email'] : []),
      ...(p.customer_phone !== undefined ? ['customer_phone'] : []),
    ];
    const human = (f: string) => (f === 'customer_email' ? 'email' : 'phone');
    const askedWords = asked.map(human).join(' and ');
    // The plan (audit) records WHICH fields the owner asked to set, never the values — the same
    // posture as the send lane. The address is already in the approval payload the owner
    // confirmed and hash-pinned; copying the customer's contact details into a second row buys
    // nothing. `changed` below is field NAMES for the same reason.
    const plan = {
      kind: p.kind,
      quoteId: p.quote_id,
      label: p.label ?? null,
      fields: asked,
      sendsNothing: true,
    };
    if (action.mode === 'dry_run') {
      return result('not_executed', `Dry run only. Would correct the customer's ${askedWords} on that draft quote. Nothing would be emailed.`, {
        ...plan,
        wouldExecute: true,
      });
    }
    try {
      const fetcher = this.deps.fetcher ?? fetch;
      const res = await fetcher(this.deps.endpointUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'patch_contact',
          quote_id: p.quote_id,
          ...(p.customer_email !== undefined ? { customer_email: p.customer_email } : {}),
          ...(p.customer_phone !== undefined ? { customer_phone: p.customer_phone } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
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
        // What AccurateBids says actually differed — the authoritative account of the write, and
        // the only way a no-op can be reported as a no-op instead of a silent success.
        const changed = Array.isArray(body.changed) ? body.changed.filter((f): f is string => typeof f === 'string') : [];
        // Read back off the row, so this is what the quote now holds rather than what we asked for.
        const nowEmail = typeof body.customer_email === 'string' && body.customer_email ? body.customer_email : null;
        const nowPhone = typeof body.customer_phone === 'string' && body.customer_phone ? body.customer_phone : null;
        const onFile = [nowEmail ? `email ${nowEmail}` : null, nowPhone ? `phone ${nowPhone}` : null]
          .filter((x): x is string => x !== null)
          .join(', ');
        const didChange =
          changed.length === 0
            ? `That draft quote already had exactly that ${askedWords} — nothing changed.`
            : `Updated the customer's ${changed.map(human).join(' and ')} on that draft quote.`;
        return result('succeeded', `${didChange}${onFile ? ` It now has ${onFile}.` : ''} Nothing was emailed to the customer.`, {
          ...plan,
          changed,
          // hub-quote states this explicitly in its response; recorded rather than assumed.
          sent: body.sent === true,
        });
      }
      if (res.status >= 500) {
        return result(
          'ambiguous',
          `Could not confirm the correction (${detail}). Open that quote in AccurateBids to see the customer's details as they now stand — nothing was emailed either way, and re-sending the same correction is harmless.`,
          plan,
          { reconciliation: 'required' },
        );
      }
      if (res.status === 400 || res.status === 404 || res.status === 409) {
        // 404: gone, or another company's quote (indistinguishable on purpose). 409: no longer a
        // draft, or it moved between the read and the write — in both cases nothing was written.
        return result('blocked', `That quote's contact details were not changed: ${detail}`, plan);
      }
      return result('failed', `That quote's contact details were not changed: ${detail}`, plan, { retryAllowed: true });
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      return result(
        'ambiguous',
        `Could not confirm the correction (${detail}). Open that quote in AccurateBids to see the customer's details as they now stand — nothing was emailed either way, and re-sending the same correction is harmless.`,
        plan,
        { reconciliation: 'required' },
      );
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
