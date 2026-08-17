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

export interface AccurateBidsQuoteExecutorDeps {
  /** The hub-quote edge-function URL. Unset means the executor is unconfigured and blocks. */
  readonly endpointUrl: string | undefined;
  /** The machine service token AccurateBids minted for the hub. Never a human login. */
  readonly serviceToken: string | undefined;
  readonly fetcher?: typeof fetch;
  readonly now?: () => Date;
}

export function accurateBidsDepsFromEnv(env: Record<string, string | undefined> = process.env): AccurateBidsQuoteExecutorDeps {
  return { endpointUrl: env.ACCURATEBIDS_QUOTE_URL, serviceToken: env.ACCURATEBIDS_SERVICE_TOKEN };
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
        `Draft quote "${payload.job_name}" created in AccurateBids${grandTotal != null ? ` ($${grandTotal})` : ''}. Review and send it there.`,
        { ...plan, quoteId, quoteUrl: url, grandTotal: grandTotal ?? null },
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      // Timeouts and network failures are indeterminate: the request may have landed.
      return result('ambiguous', `Could not confirm the AccurateBids draft (${detail}). Check the Quotes list before retrying.`, plan, { reconciliation: 'required' });
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
