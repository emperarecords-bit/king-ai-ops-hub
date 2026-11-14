import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@/orchestration/actions';
import { sha256Hex } from '@/lib/crypto';
import {
  AccurateBidsQuoteExecutor,
  letterheadNote,
  type AccurateBidsQuoteExecutorDeps,
} from '@/domain/execution/accuratebids-quote-executor';
import { renderApprovalContent } from '@/domain/opschat/approval-content';
import { type ExecutorAction } from '@/domain/execution/executor-contract';

/**
 * Per-document letterhead — `company_name_override`, the Hub half of AccurateBids 941ee5f
 * (hub-quote v7 / hub-invoice v13 both accept it in production).
 *
 * What is worth testing here is not that a string survives a POST. It is the four things that can
 * actually go wrong with a field that decides which business name a customer sees:
 *
 *   1. the owner must SEE the name on the confirm card before approving it — an override the card
 *      does not render is one the owner never actually approved;
 *   2. a blank must be REFUSED, because AccurateBids maps a blank to null and null means "use the
 *      profile name", which is the opposite of what a blank "Bill as" on a card looks like;
 *   3. the letterhead AccurateBids reports BACK is what gets reported to the owner — hub-invoice
 *      reads it off the row after the freeze trigger, so it is the settled value — and any
 *      disagreement with what was asked for must never read as a clean success;
 *   4. on a from-quote invoice the card must say that an explicit name re-pins the invoice away
 *      from the quote's frozen letterhead, because the customer is already holding that quote.
 *
 * It never chooses an account: AccurateBids resolves the contractor from the bearer token and
 * ignores the body for identity, so nothing here can interact with per-workspace token routing.
 */

const HILL = 'Hill Street Construction';
const EMPERA = 'Empera Home Improvement';
const QUOTE_ID = '4c5e2a92-fa7c-49db-b9fd-8eb31cb8b901';

const QUOTE = {
  kind: 'accuratebids_quote',
  job_name: 'Furnace swap',
  customer_name: 'Pat Example',
  materials: [{ description: '80k BTU furnace', quantity: 1, unit: 'ea', unit_cost: 1850 }],
};

const DIRECT_INVOICE = {
  kind: 'accuratebids_invoice',
  customer_name: 'Pat Example',
  job_name: 'Boiler service call',
  line_items: [{ description: 'Diagnostic + repair', qty: 2, unit_price: 150 }],
};

function action(payload: Record<string, unknown>, mode: 'dry_run' | 'live' = 'live'): ExecutorAction {
  return {
    contractVersion: '1', actionType: 'external_http', payload, payloadSha256: sha256Hex(canonicalJson(payload)),
    riskClass: 'external_reversible', orgId: 'org', projectId: 'project', approvalId: 'approval', taskId: 'task',
    runId: null, correlationId: 'corr', idempotencyKey: '1234567890123456', mode,
    authorization: { actorId: 'actor', orgId: 'org', projectId: 'project', projectRole: 'admin', resolvedAt: '2026-11-14T12:00:00.000Z', source: 'trusted_server' },
    confirmation: { required: true, confirmedBy: 'actor', confirmedAt: '2026-11-14T11:59:00.000Z', expiresAt: '2026-11-14T12:05:00.000Z', payloadSha256: sha256Hex(canonicalJson(payload)) },
  };
}

function executor(
  responder: () => Response,
  overrides: Partial<AccurateBidsQuoteExecutorDeps> = {},
): { ex: AccurateBidsQuoteExecutor; calls: { url: string; body: string }[] } {
  const calls: { url: string; body: string }[] = [];
  const ex = new AccurateBidsQuoteExecutor({
    endpointUrl: 'https://example.supabase.co/functions/v1/hub-quote',
    invoiceUrl: 'https://example.supabase.co/functions/v1/hub-invoice',
    serviceToken: 'test-token',
    fetcher: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      return responder();
    }) as typeof fetch,
    ...overrides,
  });
  return { ex, calls };
}

const sentBody = (calls: { body: string }[]): Record<string, unknown> =>
  JSON.parse(calls[0]!.body) as Record<string, unknown>;

// ── 1. letterheadNote: the honesty rule, in isolation ────────────────────────────────────────

describe('letterheadNote', () => {
  it('says nothing when there is nothing to say', () => {
    expect(letterheadNote(null, null, 'billed as')).toBe('');
  });

  it('reports the letterhead AccurateBids settled on, even when the owner named none', () => {
    expect(letterheadNote(null, EMPERA, 'billed as')).toBe(` Billed as "${EMPERA}".`);
    expect(letterheadNote(null, HILL, 'will be sent under')).toBe(` Will be sent under "${HILL}".`);
  });

  it('confirms plainly when what came back is what was asked for', () => {
    expect(letterheadNote(HILL, HILL, 'billed as')).toBe(` Billed as "${HILL}".`);
  });

  it('a disagreement is called out, naming BOTH names — never a clean success', () => {
    const note = letterheadNote(HILL, EMPERA, 'billed as');
    expect(note).toMatch(/NOTE/);
    expect(note).toContain(HILL);
    expect(note).toContain(EMPERA);
    expect(note).toMatch(/before it goes to the customer/);
  });

  it('an override that came back as nothing at all is also a disagreement', () => {
    const note = letterheadNote(HILL, null, 'billed as');
    expect(note).toMatch(/NOTE/);
    expect(note).toContain('your profile name');
  });
});

// ── 2. The quote lane ────────────────────────────────────────────────────────────────────────

describe('accuratebids_quote — company_name_override', () => {
  it('forwards the override to hub-quote and reports the name the quote will be SENT under', async () => {
    const { ex, calls } = executor(() =>
      new Response(JSON.stringify({ success: true, quote_id: 'q-1', grand_total: 1850, will_bill_as: HILL }), { status: 200 }),
    );
    const result = await ex.execute(action({ ...QUOTE, company_name_override: HILL }));
    expect(result.outcome).toBe('succeeded');
    // Forwarded verbatim, and `kind` is still stripped — the endpoint never sees it.
    expect(sentBody(calls).company_name_override).toBe(HILL);
    expect(sentBody(calls).kind).toBeUndefined();
    // A draft is not frozen, so the wording is about the future send, not a settled letterhead.
    expect(result.message).toContain(`Will be sent under "${HILL}".`);
    expect(result.preview).toMatchObject({ companyNameOverride: HILL, willBillAs: HILL });
  });

  it('omitting it is the status quo: nothing is sent, nothing is claimed', async () => {
    const { ex, calls } = executor(() =>
      new Response(JSON.stringify({ success: true, quote_id: 'q-1', grand_total: 1850, will_bill_as: null }), { status: 200 }),
    );
    const result = await ex.execute(action(QUOTE));
    expect(result.outcome).toBe('succeeded');
    expect('company_name_override' in sentBody(calls)).toBe(false);
    expect(result.message).not.toMatch(/sent under|Billed as/);
    expect(result.preview).toMatchObject({ companyNameOverride: null, willBillAs: null });
  });

  it('a blank is REFUSED, not treated as "use my profile name"', async () => {
    const { ex, calls } = executor(() => new Response('{}', { status: 200 }));
    for (const bad of ['', '   ', '\t\n']) {
      const result = await ex.execute(action({ ...QUOTE, company_name_override: bad }));
      expect(result.outcome).toBe('blocked');
    }
    // Nothing reached AccurateBids: the refusal is at the payload boundary.
    expect(calls).toHaveLength(0);
  });

  it('is length-bounded at the Hub rather than silently truncated by AccurateBids', async () => {
    const { ex, calls } = executor(() => new Response('{}', { status: 200 }));
    const result = await ex.execute(action({ ...QUOTE, company_name_override: 'x'.repeat(201) }));
    expect(result.outcome).toBe('blocked');
    expect(calls).toHaveLength(0);
    // 200 exactly is fine — the boundary is inclusive, matching the endpoint's slice(0, 200).
    const { ex: ok } = executor(() => new Response(JSON.stringify({ success: true, quote_id: 'q-1' }), { status: 200 }));
    expect((await ok.execute(action({ ...QUOTE, company_name_override: 'x'.repeat(200) }))).outcome).toBe('succeeded');
  });

  it('surrounding whitespace is trimmed before it is sent', async () => {
    const { ex, calls } = executor(() =>
      new Response(JSON.stringify({ success: true, quote_id: 'q-1', will_bill_as: HILL }), { status: 200 }),
    );
    await ex.execute(action({ ...QUOTE, company_name_override: `  ${HILL}  ` }));
    expect(sentBody(calls).company_name_override).toBe(HILL);
  });
});

// ── 3. The invoice lane ──────────────────────────────────────────────────────────────────────

describe('accuratebids_invoice — company_name_override', () => {
  it('forwards it on a direct invoice and reports the settled letterhead', async () => {
    const { ex, calls } = executor(() =>
      new Response(JSON.stringify({ success: true, invoice_id: 'inv-1', invoice_number: 'INV-123456', amount: 300, status: 'unpaid', billed_as: HILL }), { status: 200 }),
    );
    const result = await ex.execute(action({ ...DIRECT_INVOICE, company_name_override: HILL }));
    expect(result.outcome).toBe('succeeded');
    expect(sentBody(calls).company_name_override).toBe(HILL);
    expect(result.message).toContain(`Billed as "${HILL}".`);
    expect(result.preview).toMatchObject({ companyNameOverride: HILL, billedAs: HILL });
  });

  it('forwards it on a from-quote invoice, where it re-pins the letterhead', async () => {
    const { ex, calls } = executor(() =>
      new Response(JSON.stringify({ success: true, invoice_id: 'inv-1', invoice_number: 'INV-123456', amount: 1200, billed_as: HILL }), { status: 200 }),
    );
    const result = await ex.execute(action({ kind: 'accuratebids_invoice', quote_id: QUOTE_ID, company_name_override: HILL }));
    expect(result.outcome).toBe('succeeded');
    expect(sentBody(calls)).toMatchObject({ quote_id: QUOTE_ID, company_name_override: HILL });
    expect(result.message).toContain(`Billed as "${HILL}".`);
  });

  it('reports the letterhead even when the owner named none — it is read back, not echoed', async () => {
    const { ex } = executor(() =>
      new Response(JSON.stringify({ success: true, invoice_id: 'inv-1', invoice_number: 'INV-1', amount: 300, billed_as: EMPERA }), { status: 200 }),
    );
    const result = await ex.execute(action(DIRECT_INVOICE));
    expect(result.message).toContain(`Billed as "${EMPERA}".`);
    expect(result.preview).toMatchObject({ companyNameOverride: null, billedAs: EMPERA });
  });

  it('a letterhead that came back different from the one asked for is flagged, not buried', async () => {
    // The failure this guards: the invoice is real and unpaid, so it cannot be un-created — the
    // owner has to be told BEFORE they send it that it is headed with the wrong business.
    const { ex } = executor(() =>
      new Response(JSON.stringify({ success: true, invoice_id: 'inv-1', invoice_number: 'INV-1', amount: 300, billed_as: EMPERA }), { status: 200 }),
    );
    const result = await ex.execute(action({ ...DIRECT_INVOICE, company_name_override: HILL }));
    expect(result.outcome).toBe('succeeded'); // the invoice DOES exist; pretending otherwise would be worse
    expect(result.message).toMatch(/NOTE/);
    expect(result.message).toContain(HILL);
    expect(result.message).toContain(EMPERA);
    expect(result.preview).toMatchObject({ companyNameOverride: HILL, billedAs: EMPERA });
  });

  it('a blank is refused here too, and nothing is billed', async () => {
    const { ex, calls } = executor(() => new Response('{}', { status: 200 }));
    expect((await ex.execute(action({ ...DIRECT_INVOICE, company_name_override: '  ' }))).outcome).toBe('blocked');
    expect(calls).toHaveLength(0);
  });

  it('the dry run shows the letterhead without creating anything', async () => {
    const { ex, calls } = executor(() => new Response('{}', { status: 200 }));
    const result = await ex.execute(action({ ...DIRECT_INVOICE, company_name_override: HILL }, 'dry_run'));
    expect(result.outcome).toBe('not_executed');
    expect(result.preview).toMatchObject({ companyNameOverride: HILL, wouldExecute: true });
    expect(calls).toHaveLength(0);
  });
});

// ── 4. The confirm card — what the owner actually sees before approving ──────────────────────

describe('confirm card — Bill as', () => {
  const fieldsOf = (payload: Record<string, unknown>) =>
    renderApprovalContent('external_http', payload).fields;
  const billAs = (payload: Record<string, unknown>) =>
    fieldsOf(payload).find((f) => f.label === 'Bill as') ?? null;

  it('shows the trading name on a quote card', () => {
    expect(billAs({ ...QUOTE, company_name_override: HILL })).toEqual({ label: 'Bill as', value: HILL });
  });

  it('shows it plainly on a DIRECT invoice — there is nothing to re-pin', () => {
    expect(billAs({ ...DIRECT_INVOICE, company_name_override: HILL })).toEqual({ label: 'Bill as', value: HILL });
  });

  it('warns on a FROM-QUOTE invoice that the invoice will not match the quote', () => {
    const f = billAs({ kind: 'accuratebids_invoice', quote_id: QUOTE_ID, company_name_override: HILL });
    expect(f?.value).toContain(HILL);
    expect(f?.value).toMatch(/re-pins/);
    expect(f?.value).toMatch(/NOT match the quote/);
  });

  it('omits the field entirely when no name was given, so the card never implies one', () => {
    expect(billAs(QUOTE)).toBeNull();
    expect(billAs(DIRECT_INVOICE)).toBeNull();
    expect(billAs({ kind: 'accuratebids_invoice', quote_id: QUOTE_ID })).toBeNull();
  });

  it('the re-pin warning survives a maximum-length trading name', () => {
    // The field is capped, so the warning is kept short enough that a 200-char name cannot push
    // it past the limit and truncate away the one thing the owner needs to read.
    const f = billAs({ kind: 'accuratebids_invoice', quote_id: QUOTE_ID, company_name_override: 'x'.repeat(200) });
    expect(f?.value).toMatch(/NOT match the quote/);
    expect(renderApprovalContent('external_http', { kind: 'accuratebids_invoice', quote_id: QUOTE_ID, company_name_override: 'x'.repeat(200) }).truncated).toBe(false);
  });
});
