import { describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '@/orchestration/actions';
import { sha256Hex } from '@/lib/crypto';
import {
  AccurateBidsQuoteExecutor,
  accurateBidsContactPatchPayloadSchema,
  type AccurateBidsQuoteExecutorDeps,
} from '@/domain/execution/accuratebids-quote-executor';
import { renderApprovalContent } from '@/domain/opschat/approval-content';
import { type ExecutorAction } from '@/domain/execution/executor-contract';

vi.mock('@/db/tenant', () => ({ withTenant: vi.fn(), withUser: vi.fn() }));
vi.mock('@/domain/agents/agents', () => ({ listAgents: vi.fn() }));

import { summarizeAccurateBidsPayload, parseAccurateBidsOpsChatPayload } from '@/domain/opschat/accuratebids-action';

/**
 * Correcting a DRAFT quote's customer contact details — the Hub half of hub-quote's
 * `patch_contact` action (live in AccurateBids production since hub-quote v7).
 *
 * The interesting risks here are not transport. They are:
 *
 *   1. it must actually ASK for the patch — the body carries `action: "patch_contact"`, and the
 *      same endpoint without it CREATES A NEW QUOTE, so a dropped action is not a no-op but a
 *      duplicate record;
 *   2. it OVERWRITES, and the Hub cannot see the value it replaces (`hub-snapshot` exposes only
 *      `has_email` and never the phone), so the card and the summary must say so plainly and must
 *      never imply a before/after;
 *   3. a blank must be refused rather than treated as "erase" — on both sides;
 *   4. the result must report what AccurateBids says actually CHANGED, including the honest
 *      `changed: []` no-op, instead of asserting a write it cannot see;
 *   5. a refusal that cannot be retried into success (not a draft, not found, moved mid-write) is
 *      `blocked`; anything that might have written is `ambiguous`.
 *
 * It emails nothing by construction — that is the whole reason the endpoint exists — so there is
 * no idempotency key to test: the same patch twice is the same state.
 */

const QUOTE_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const EMAIL = 'pat@example.com';
const PHONE = '(555) 010-9988';
const URL = 'https://example.supabase.co/functions/v1/hub-quote';

const PATCH = { kind: 'accuratebids_contact_patch', quote_id: QUOTE_ID, customer_email: EMAIL };

function action(payload: Record<string, unknown>, mode: 'dry_run' | 'live' = 'live'): ExecutorAction {
  return {
    contractVersion: '1', actionType: 'external_http', payload, payloadSha256: sha256Hex(canonicalJson(payload)),
    riskClass: 'external_reversible', orgId: 'org', projectId: 'project', approvalId: 'approval', taskId: 'task',
    runId: null, correlationId: 'corr', idempotencyKey: '1234567890123456', mode,
    authorization: { actorId: 'actor', orgId: 'org', projectId: 'project', projectRole: 'admin', resolvedAt: '2026-11-15T12:00:00.000Z', source: 'trusted_server' },
    confirmation: { required: true, confirmedBy: 'actor', confirmedAt: '2026-11-15T11:59:00.000Z', expiresAt: '2026-11-15T12:05:00.000Z', payloadSha256: sha256Hex(canonicalJson(payload)) },
  };
}

function executor(
  responder: () => Response,
  overrides: Partial<AccurateBidsQuoteExecutorDeps> = {},
): { ex: AccurateBidsQuoteExecutor; calls: { url: string; body: string }[] } {
  const calls: { url: string; body: string }[] = [];
  const ex = new AccurateBidsQuoteExecutor({
    endpointUrl: URL,
    serviceToken: 'test-token',
    fetcher: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      return responder();
    }) as typeof fetch,
    ...overrides,
  });
  return { ex, calls };
}

const ok = (body: Record<string, unknown>) => () =>
  new Response(JSON.stringify({ success: true, quote_id: QUOTE_ID, sent: false, ...body }), { status: 200 });
const err = (status: number, error = 'nope') => () => new Response(JSON.stringify({ error }), { status });
const sentBody = (calls: { body: string }[]): Record<string, unknown> => JSON.parse(calls[0]!.body) as Record<string, unknown>;

// ── 1. The request: it must ask for the patch, and carry nothing else ─────────────────────────

describe('accuratebids_contact_patch — the request', () => {
  it('asks for the patch action, so the same endpoint does not create a second quote', async () => {
    const { ex, calls } = executor(ok({ customer_email: EMAIL, customer_phone: null, changed: ['customer_email'] }));
    const r = await ex.execute(action(PATCH));
    expect(r.outcome).toBe('succeeded');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(URL);
    expect(sentBody(calls)).toEqual({ action: 'patch_contact', quote_id: QUOTE_ID, customer_email: EMAIL });
  });

  it('sends only the fields the owner actually gave, so one field never blanks the other', async () => {
    const { ex, calls } = executor(ok({ customer_email: null, customer_phone: PHONE, changed: ['customer_phone'] }));
    await ex.execute(action({ kind: 'accuratebids_contact_patch', quote_id: QUOTE_ID, customer_phone: PHONE }));
    expect(sentBody(calls)).toEqual({ action: 'patch_contact', quote_id: QUOTE_ID, customer_phone: PHONE });
    expect('customer_email' in sentBody(calls)).toBe(false);
  });

  it('carries both when both were corrected', async () => {
    const { ex, calls } = executor(ok({ customer_email: EMAIL, customer_phone: PHONE, changed: ['customer_email', 'customer_phone'] }));
    await ex.execute(action({ ...PATCH, customer_phone: PHONE }));
    expect(sentBody(calls)).toEqual({ action: 'patch_contact', quote_id: QUOTE_ID, customer_email: EMAIL, customer_phone: PHONE });
  });

  it('never forwards `label` — it is what the owner confirmed, not an endpoint field', async () => {
    const { ex, calls } = executor(ok({ customer_email: EMAIL, changed: ['customer_email'] }));
    await ex.execute(action({ ...PATCH, label: '"Condenser swap" for Pat' }));
    expect('label' in sentBody(calls)).toBe(false);
  });

  it('does not call AccurateBids at all on a dry run', async () => {
    const { ex, calls } = executor(ok({}));
    const r = await ex.execute(action(PATCH, 'dry_run'));
    expect(r.outcome).toBe('not_executed');
    expect(r.message).toMatch(/Nothing would be emailed/);
    expect(calls).toHaveLength(0);
  });
});

// ── 2. The boundary: what never reaches AccurateBids ──────────────────────────────────────────

describe('accuratebids_contact_patch — the schema boundary', () => {
  const refuses = async (payload: Record<string, unknown>, match: RegExp) => {
    const { ex, calls } = executor(ok({}));
    const r = await ex.execute(action(payload));
    expect(r.outcome).toBe('blocked');
    expect(r.message).toMatch(match);
    // The real assertion: a refused payload must never have left the building.
    expect(calls).toHaveLength(0);
  };

  it('refuses a patch that would change nothing', async () => {
    await refuses({ kind: 'accuratebids_contact_patch', quote_id: QUOTE_ID }, /customer_email, customer_phone, or both/);
  });

  it('refuses a blank, because a blank is a mistake and not an instruction to erase', async () => {
    await refuses({ ...PATCH, customer_email: '' }, /plain email address/);
    await refuses({ kind: 'accuratebids_contact_patch', quote_id: QUOTE_ID, customer_phone: '   ' }, /7 digits/);
  });

  it('refuses something that is not an address or not a number', async () => {
    await refuses({ ...PATCH, customer_email: 'pat at example dot com' }, /plain email address/);
    await refuses({ ...PATCH, customer_email: 'pat@example.com, lee@example.com' }, /plain email address/);
    await refuses({ kind: 'accuratebids_contact_patch', quote_id: QUOTE_ID, customer_phone: '555-01' }, /7 digits/);
  });

  it('refuses an id that is not a quote id', async () => {
    await refuses({ ...PATCH, quote_id: 'the condenser one' }, /quote_id/i);
  });

  it('refuses an invented field rather than silently dropping it', async () => {
    await refuses({ ...PATCH, customer_name: 'Pat Example' }, /customer_name/);
    // The one that matters most: this endpoint can only touch two fields, so anything that looks
    // like it is amending the job or the money is a payload the owner never confirmed.
    await refuses({ ...PATCH, grand_total: 9999 }, /grand_total/);
  });

  it('trims before validating, so a pasted address with whitespace still goes through clean', () => {
    const r = accurateBidsContactPatchPayloadSchema.safeParse({ ...PATCH, customer_email: `  ${EMAIL}  ` });
    expect(r.success).toBe(true);
    expect(r.success && r.data.customer_email).toBe(EMAIL);
  });

  it('accepts any formatting of a real number, since that is the customer\'s business', () => {
    for (const phone of ['5550109988', '(555) 010-9988', '+1 555-010-9988', '555.010.9988 ext 4']) {
      expect(accurateBidsContactPatchPayloadSchema.safeParse({ kind: 'accuratebids_contact_patch', quote_id: QUOTE_ID, customer_phone: phone }).success).toBe(true);
    }
  });
});

// ── 3. The readback: what AccurateBids says actually moved ────────────────────────────────────

describe('accuratebids_contact_patch — the result', () => {
  it('reports the fields AccurateBids says changed, and what the quote now holds', async () => {
    const { ex } = executor(ok({ customer_email: EMAIL, customer_phone: PHONE, changed: ['customer_email'] }));
    const r = await ex.execute(action(PATCH));
    expect(r.outcome).toBe('succeeded');
    expect(r.message).toMatch(/Updated the customer's email on that draft quote/);
    expect(r.message).toContain(`It now has email ${EMAIL}, phone ${PHONE}.`);
    expect(r.message).toMatch(/Nothing was emailed to the customer/);
  });

  it('calls a no-op a no-op instead of claiming a write', async () => {
    // changed: [] is AccurateBids saying the value was already identical. Reporting that as a
    // successful update would teach the owner to trust a confirmation that means nothing.
    const { ex } = executor(ok({ customer_email: EMAIL, changed: [] }));
    const r = await ex.execute(action(PATCH));
    expect(r.outcome).toBe('succeeded');
    expect(r.message).toMatch(/already had exactly that email — nothing changed/);
    expect(r.message).not.toMatch(/Updated/);
  });

  it('names both fields when both moved', async () => {
    const { ex } = executor(ok({ customer_email: EMAIL, customer_phone: PHONE, changed: ['customer_email', 'customer_phone'] }));
    const r = await ex.execute(action({ ...PATCH, customer_phone: PHONE }));
    expect(r.message).toMatch(/Updated the customer's email and phone/);
  });

  it('records which fields were asked for and that nothing was sent — never the values', async () => {
    const { ex } = executor(ok({ customer_email: EMAIL, customer_phone: PHONE, changed: ['customer_email'] }));
    const r = await ex.execute(action({ ...PATCH, label: '"Condenser swap" for Pat' }));
    expect(r.preview).toMatchObject({
      kind: 'accuratebids_contact_patch',
      quoteId: QUOTE_ID,
      label: '"Condenser swap" for Pat',
      fields: ['customer_email'],
      changed: ['customer_email'],
      sendsNothing: true,
      sent: false,
    });
    // Same posture as the send lane: the address is already in the hash-pinned approval payload,
    // so the execution record keeps field NAMES and does not spread the customer's details further.
    expect(JSON.stringify(r.preview)).not.toContain(EMAIL);
    expect(JSON.stringify(r.preview)).not.toContain(PHONE);
  });

  it('is not fooled by a 200 that does not say success', async () => {
    const { ex } = executor(() => new Response(JSON.stringify({ changed: ['customer_email'] }), { status: 200 }));
    const r = await ex.execute(action(PATCH));
    expect(r.outcome).not.toBe('succeeded');
  });
});

// ── 4. Outcomes: blocked vs ambiguous, and which one invites a retry ──────────────────────────

describe('accuratebids_contact_patch — outcome mapping', () => {
  it('blocks a quote that is no longer a draft — a retry would be refused the same way', async () => {
    const { ex } = executor(err(409, "only a draft quote's contact details can be changed here (this one is 'sent')"));
    const r = await ex.execute(action(PATCH));
    expect(r.outcome).toBe('blocked');
    expect(r.retryAllowed).toBe(false);
    expect(r.message).toMatch(/only a draft quote/);
  });

  it('blocks a quote that is not found (or belongs to another account)', async () => {
    const { ex } = executor(err(404, 'quote not found'));
    const r = await ex.execute(action(PATCH));
    expect(r.outcome).toBe('blocked');
    expect(r.message).toMatch(/quote not found/);
  });

  it('blocks a 400, because our payload and the endpoint disagreed', async () => {
    const { ex } = executor(err(400, "unknown action 'patch_contact'"));
    const r = await ex.execute(action(PATCH));
    expect(r.outcome).toBe('blocked');
    // The honest failure mode against an older hub-quote: named, not swallowed.
    expect(r.message).toMatch(/unknown action/);
  });

  it('allows a retry on a rate limit', async () => {
    const { ex } = executor(err(429, 'Too many requests'));
    const r = await ex.execute(action(PATCH));
    expect(r.outcome).toBe('failed');
    expect(r.retryAllowed).toBe(true);
  });

  it('calls a server error ambiguous and says a repeat is harmless', async () => {
    const { ex } = executor(err(500, 'could not update the quote'));
    const r = await ex.execute(action(PATCH));
    expect(r.outcome).toBe('ambiguous');
    expect(r.reconciliation).toBe('required');
    expect(r.message).toMatch(/re-sending the same correction is harmless/);
    expect(r.message).toMatch(/nothing was emailed either way/);
  });

  it('calls a network failure ambiguous too — the write may have landed', async () => {
    const { ex } = executor(() => {
      throw new Error('fetch failed');
    });
    const r = await ex.execute(action(PATCH));
    expect(r.outcome).toBe('ambiguous');
    expect(r.reconciliation).toBe('required');
  });

  it('blocks when AccurateBids is not configured, without inventing a result', async () => {
    const { ex, calls } = executor(ok({}), { endpointUrl: undefined });
    const r = await ex.execute(action(PATCH));
    expect(r.outcome).toBe('blocked');
    expect(r.message).toMatch(/not configured/);
    expect(calls).toHaveLength(0);
  });
});

// ── 5. The confirm card: the overwrite has to be unmissable ───────────────────────────────────

describe('accuratebids_contact_patch — the confirm card', () => {
  const card = (p: Record<string, unknown>) => renderApprovalContent('external_http', p);

  it('says in the title that it overwrites and emails nothing', () => {
    const v = card(PATCH);
    expect(v.title).toMatch(/overwrites what is on file/);
    expect(v.title).toMatch(/emails nothing/);
    expect(v.title).toMatch(/DRAFT quote/);
  });

  it('shows the exact values being written', () => {
    const v = card({ ...PATCH, customer_phone: PHONE, label: '"Condenser swap" for Pat' });
    const f = Object.fromEntries(v.fields.map((x) => [x.label, x.value]));
    expect(f['New email']).toBe(EMAIL);
    expect(f['New phone']).toBe(PHONE);
    expect(f['Quote']).toBe('"Condenser swap" for Pat');
    expect(f['Quote id']).toBe(QUOTE_ID);
  });

  it('states that the value being replaced is not visible, rather than implying a before/after', () => {
    const v = card(PATCH);
    const f = Object.fromEntries(v.fields.map((x) => [x.label, x.value]));
    expect(f['Replaces']).toMatch(/whatever email the quote has now/);
    expect(f['Replaces']).toMatch(/not visible to the Hub/);
    expect(v.body).toMatch(/OVERWRITES/);
    expect(v.body).toMatch(/not visible to the Hub/);
    expect(v.body).toMatch(/Nothing is emailed/);
    expect(v.body).toMatch(/Only a draft can be corrected/);
  });

  it('names only the fields actually being set', () => {
    const emailOnly = Object.fromEntries(card(PATCH).fields.map((x) => [x.label, x.value]));
    expect('New phone' in emailOnly).toBe(false);
    expect(emailOnly['Replaces']).toMatch(/whatever email the quote/);
    const phoneOnly = card({ kind: 'accuratebids_contact_patch', quote_id: QUOTE_ID, customer_phone: PHONE });
    const pf = Object.fromEntries(phoneOnly.fields.map((x) => [x.label, x.value]));
    expect('New email' in pf).toBe(false);
    expect(pf['Replaces']).toMatch(/whatever phone the quote/);
  });

  it('never truncates the warning away, even at the longest label a payload can carry', () => {
    const v = card({ ...PATCH, customer_phone: PHONE, label: 'L'.repeat(200) });
    expect(v.truncated).toBe(false);
    expect(v.body).toMatch(/OVERWRITES/);
  });
});

// ── 6. The stored summary: what the approval record says the owner agreed to ───────────────────

describe('accuratebids_contact_patch — the approval summary', () => {
  it('states the new values and that they replace what is on file, emailing nothing', () => {
    const s = summarizeAccurateBidsPayload(parseAccurateBidsOpsChatPayload({ ...PATCH, customer_phone: PHONE, label: '"Condenser swap" for Pat' }));
    expect(s).toContain(`email to ${EMAIL}`);
    expect(s).toContain(`phone to ${PHONE}`);
    expect(s).toContain('"Condenser swap" for Pat');
    expect(s).toMatch(/replacing whatever is on file/);
    expect(s).toMatch(/nothing is emailed to the customer/);
  });

  it('falls back to the quote id when the snapshot could not name the quote', () => {
    const s = summarizeAccurateBidsPayload(parseAccurateBidsOpsChatPayload(PATCH));
    expect(s).toContain(QUOTE_ID);
  });

  it('refuses to parse a payload the executor would refuse, so a card is never built from one', () => {
    expect(() => parseAccurateBidsOpsChatPayload({ kind: 'accuratebids_contact_patch', quote_id: QUOTE_ID })).toThrow(/customer_email, customer_phone, or both/);
    expect(() => parseAccurateBidsOpsChatPayload({ ...PATCH, customer_email: '' })).toThrow(/email/);
  });
});
