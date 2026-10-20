import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BridgeNs from '@/domain/opschat/accuratebids-action';

/**
 * Ops Chat AccurateBids tools — PREPARE only. The propose tools validate with the executor's own
 * schemas and record a card; they never create, invoice, or email anything (the governed bridge is
 * a spy that must stay untouched). Only the AccurateBids-connected workspace, only admins; dead-end
 * sends (no customer email, paid/void invoice) are refused up front; invented fields are rejected.
 */

type Bridge = typeof BridgeNs;
type AbProposal = Extract<OpsChatProposal, { kind: 'accuratebids_quote' | 'accuratebids_invoice' | 'accuratebids_send' }>;

const h = vi.hoisted(() => ({
  withTenant: vi.fn(),
  fetchAccurateBidsRecords: vi.fn(),
  executeAccurateBidsFromOpsChat: vi.fn(),
}));

vi.mock('@/db/tenant', () => ({ withTenant: h.withTenant, withUser: vi.fn() }));
vi.mock('@/domain/agents/agents', () => ({ listAgents: vi.fn() }));
vi.mock('@/domain/opschat/accuratebids-action', async (orig) => ({
  ...(await orig<Bridge>()),
  fetchAccurateBidsRecords: h.fetchAccurateBidsRecords,
  executeAccurateBidsFromOpsChat: h.executeAccurateBidsFromOpsChat,
}));

import { createOpsChatToolset, type OpsChatProposal } from '@/domain/opschat/tools';

const INV = '4c5e2a92-fa7c-49db-b9fd-8eb31cb8b901';
const INV_PAID = '5d6f3b03-0b8d-4aec-8a0e-9fc42dc0c902';
const INV_NOMAIL = '6e7a4c14-1c9e-4bfd-9b1f-a0d53ed1da03';
const QUOTE = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

const PROJECTS = [
  { projectId: 'p-em', orgId: 'o1', key: 'empera', name: 'Empera A/C', description: '', projectRole: 'admin' as const },
  { projectId: 'p-sp', orgId: 'o1', key: 'stressprobe', name: 'StressProbe', description: '', projectRole: 'admin' as const },
  { projectId: 'p-mb', orgId: 'o1', key: 'member-ws', name: 'Member WS', description: '', projectRole: 'member' as const },
];
const AUTH = { userId: 'u1', projects: PROJECTS, orgRoles: new Map([['o1', 'owner' as const]]) };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ACCURATEBIDS_SIGHT_PROJECT_KEYS = 'empera,member-ws';
  h.fetchAccurateBidsRecords.mockResolvedValue({
    quotes: [{ id: QUOTE, job_name: 'Condenser swap', customer_name: 'Pat', status: 'draft', grand_total: 4200, has_email: true }],
    invoices: [
      { id: INV, invoice_number: 'INV-123456', customer_name: 'Pat', status: 'unpaid', amount: 1200, balance_due: 1200, has_email: true },
      { id: INV_PAID, invoice_number: 'INV-222222', customer_name: 'Lee', status: 'paid', amount: 500, balance_due: 0, has_email: true },
      { id: INV_NOMAIL, invoice_number: 'INV-333333', customer_name: 'Sam', status: 'unpaid', amount: 300, balance_due: 300, has_email: false },
    ],
    openBalance: 1500,
  });
});

const run = async (name: string, input: Record<string, unknown>) => {
  const ts = createOpsChatToolset(AUTH);
  const out = JSON.parse(await ts.runTool({ name, input }));
  return { out, proposals: ts.getProposals() as readonly OpsChatProposal[] };
};

describe('AccurateBids tools — prepare only, never execute', () => {
  it('list_accuratebids_records returns ids for the connected workspace', async () => {
    const { out } = await run('list_accuratebids_records', { project: 'empera' });
    expect(out.invoices[0].id).toBe(INV);
    expect(out.quotes[0].id).toBe(QUOTE);
  });

  it('propose_accuratebids_send records a card naming the invoice — and sends NOTHING', async () => {
    const { out, proposals } = await run('propose_accuratebids_send', { project: 'Empera A/C', send: 'invoice', invoice_id: INV });
    expect(out.prepared).toBe(true);
    expect(out.note).toMatch(/NOTHING has happened yet/);
    expect(proposals).toHaveLength(1);
    const p = proposals[0]! as AbProposal;
    expect(p.kind).toBe('accuratebids_send');
    expect(p.projectKey).toBe('empera');
    expect(p.payload).toEqual({ kind: 'accuratebids_send', send: 'invoice', invoice_id: INV, label: 'INV-123456 (Pat, balance $1200)' });
    expect(p.summary).toMatch(/Email the invoice INV-123456/);
    expect(p.content.title).toMatch(/Email the invoice to the customer/);
    expect(h.executeAccurateBidsFromOpsChat).not.toHaveBeenCalled();
  });

  it('refuses dead-end sends up front (paid invoice, no customer email)', async () => {
    expect((await run('propose_accuratebids_send', { project: 'empera', send: 'invoice', invoice_id: INV_PAID })).out.error).toMatch(/paid/);
    // No email on file and none given: the refusal tells the model exactly how to proceed.
    const noMail = (await run('propose_accuratebids_send', { project: 'empera', send: 'invoice_reminder', invoice_id: INV_NOMAIL })).out.error;
    expect(noMail).toMatch(/no customer email on file/);
    expect(noMail).toMatch(/Ask the owner/);
    expect(noMail).toMatch(/customer_email/);
  });

  it('an invoice with NO email on file + the owner-given address → a card that shows it, saves it and sends', async () => {
    const { out, proposals } = await run('propose_accuratebids_send', {
      project: 'empera',
      send: 'invoice',
      invoice_id: INV_NOMAIL,
      customer_email: '  joeyo2228@gmail.com ',
    });
    expect(out.prepared).toBe(true);
    const p = proposals[0]! as AbProposal;
    expect(p.payload).toEqual({
      kind: 'accuratebids_send',
      send: 'invoice',
      invoice_id: INV_NOMAIL,
      customer_email: 'joeyo2228@gmail.com',
      label: 'INV-333333 (Sam, balance $300)',
    });
    expect(p.summary).toMatch(/Save joeyo2228@gmail.com as the customer's email on invoice INV-333333/);
    expect(JSON.stringify(p.content)).toContain('joeyo2228@gmail.com');
    expect(h.executeAccurateBidsFromOpsChat).not.toHaveBeenCalled();
  });

  it('never replaces an address on file, never adds one to a quote, and rejects a malformed address', async () => {
    expect((await run('propose_accuratebids_send', { project: 'empera', send: 'invoice', invoice_id: INV, customer_email: 'other@x.com' })).out.error).toMatch(
      /already has an email on file/,
    );
    expect((await run('propose_accuratebids_send', { project: 'empera', send: 'quote', quote_id: QUOTE, customer_email: 'a@b.com' })).out.error).toMatch(
      /only be added to an invoice/,
    );
    for (const bad of ['not-an-email', 'a@b.com, c@d.com', 'Joe <a@b.com>']) {
      expect((await run('propose_accuratebids_send', { project: 'empera', send: 'invoice', invoice_id: INV_NOMAIL, customer_email: bad })).out.error).toMatch(/Invalid|email/);
    }
    expect(h.executeAccurateBidsFromOpsChat).not.toHaveBeenCalled();
  });

  it('propose_accuratebids_quote validates with the executor schema and records a draft card', async () => {
    const { out, proposals } = await run('propose_accuratebids_quote', {
      project: 'empera',
      quote: { job_name: 'Condenser swap', customer_name: 'Pat', materials: [{ description: 'Condenser', quantity: 1, unit_cost: 2800 }], labor: [{ description: 'Install', hours: 6, hourly_rate: 120 }] },
    });
    expect(out.prepared).toBe(true);
    expect(proposals[0]!.kind).toBe('accuratebids_quote');
    expect((proposals[0] as AbProposal).summary).toMatch(/DRAFT|draft/);
  });

  it('propose_accuratebids_invoice accepts from-quote and direct; rejects invented / missing fields', async () => {
    expect((await run('propose_accuratebids_invoice', { project: 'empera', invoice: { quote_id: QUOTE } })).out.prepared).toBe(true);
    expect(
      (await run('propose_accuratebids_invoice', { project: 'empera', invoice: { customer_name: 'Pat', job_name: 'Service', line_items: [{ description: 'Repair', qty: 1, unit_price: 250 }] } })).out
        .prepared,
    ).toBe(true);
    // No quote_id and no line items → refused.
    expect((await run('propose_accuratebids_invoice', { project: 'empera', invoice: { customer_name: 'Pat', job_name: 'Service' } })).out.error).toMatch(/Invalid AccurateBids invoice/);
    // A field the endpoint does not accept (e.g. a URL to call) is rejected by the strict schema.
    expect((await run('propose_accuratebids_invoice', { project: 'empera', invoice: { quote_id: QUOTE, url: 'https://evil.example' } })).out.error).toMatch(/Invalid/);
  });

  it('only the AccurateBids-connected workspace, and only admins', async () => {
    expect((await run('propose_accuratebids_send', { project: 'stressprobe', send: 'invoice', invoice_id: INV })).out.error).toMatch(/not connected to AccurateBids/);
    expect((await run('propose_accuratebids_send', { project: 'member-ws', send: 'invoice', invoice_id: INV })).out.error).toMatch(/admin/);
    expect((await run('propose_accuratebids_quote', { project: 'kodisnap', quote: {} })).out.error).toMatch(/No workspace matched/);
  });

  it('the same card twice in a turn is one proposal; a different payload is a new one', async () => {
    const ts = createOpsChatToolset(AUTH);
    await ts.runTool({ name: 'propose_accuratebids_send', input: { project: 'empera', send: 'invoice', invoice_id: INV } });
    await ts.runTool({ name: 'propose_accuratebids_send', input: { project: 'empera', send: 'invoice', invoice_id: INV } });
    expect(ts.getProposals()).toHaveLength(1);
    await ts.runTool({ name: 'propose_accuratebids_send', input: { project: 'empera', send: 'invoice_reminder', invoice_id: INV } });
    expect(ts.getProposals()).toHaveLength(2);
  });
});
