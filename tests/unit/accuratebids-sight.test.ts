import { describe, expect, it } from 'vitest';
import {
  assembleAccurateBidsSight,
  formatSightBriefing,
  sightDepsFromEnv,
  sightEnabledKeys,
} from '@/domain/integrations/accuratebids-sight';

/** AccurateBids sight — config gating, formatting, and graceful degradation. */

const SNAPSHOT = {
  as_of: '2026-08-17T20:00:00.000Z',
  quotes: {
    total: 427,
    by_status: { completed: 245, sent: 141, draft: 37 },
    won_total: 512345.67,
    recent: [
      { job_name: 'Mini-split install', customer_name: 'Travis W', status: 'draft', grand_total: 11500, deposit_paid: false, bid_date: '2026-08-12' },
      { job_name: 'Garage conversion', customer_name: 'True North', status: 'sent', grand_total: 24000, deposit_paid: true, bid_date: '2026-08-10' },
    ],
  },
  invoices: {
    total: 12,
    open_count: 2,
    open_balance: 10000,
    recent: [
      { invoice_number: 'INV-9', job_name: 'Boiler swap', customer_name: 'T Rokwell', status: 'partial', amount: 10000, paid_amount: 6000, balance_due: 4000, payment_method: 'card' },
    ],
  },
};

describe('accuratebids sight', () => {
  it('config gating: unset env disables everywhere', () => {
    expect(sightEnabledKeys({})).toEqual([]);
    expect(sightEnabledKeys({ ACCURATEBIDS_SIGHT_PROJECT_KEYS: ' empera-air-conditioning-and-heating , accuratebids-com ' })).toEqual([
      'empera-air-conditioning-and-heating',
      'accuratebids-com',
    ]);
    expect(sightDepsFromEnv({}).snapshotUrl).toBeUndefined();
  });

  it('formats the briefing with pipeline, money, deposits, and open balances', () => {
    const text = formatSightBriefing(SNAPSHOT);
    expect(text).toContain('ACCURATEBIDS LIVE SNAPSHOT');
    expect(text).toContain('427 total');
    expect(text).toContain('completed 245');
    expect(text).toContain('won revenue $512,345.67');
    expect(text).toContain('deposit PAID');
    expect(text).toContain('paid $6,000 (card)');
    expect(text).toContain('DUE $4,000');
    expect(text.length).toBeLessThanOrEqual(6100);
  });

  it('caps runaway payloads', () => {
    const big = {
      ...SNAPSHOT,
      quotes: { ...SNAPSHOT.quotes, recent: Array.from({ length: 200 }, (_, i) => ({ job_name: `Job ${i} ${'x'.repeat(80)}`, customer_name: 'C', status: 'sent', grand_total: 1, bid_date: '2026-01-01' })) },
    };
    expect(formatSightBriefing(big).length).toBeLessThanOrEqual(6100);
  });

  it('assemble returns null on missing config, non-200, and network failure — never throws', async () => {
    expect(await assembleAccurateBidsSight({ snapshotUrl: undefined, serviceToken: undefined })).toBeNull();
    const deps = (responder: () => Response | Promise<Response>) => ({
      snapshotUrl: 'https://example.test/hub-snapshot',
      serviceToken: 't',
      fetcher: (async () => responder()) as typeof fetch,
    });
    expect(await assembleAccurateBidsSight(deps(() => new Response('nope', { status: 500 })))).toBeNull();
    expect(
      await assembleAccurateBidsSight(
        deps(() => {
          throw new Error('socket hang up');
        }),
      ),
    ).toBeNull();
    const ok = await assembleAccurateBidsSight(
      deps(() => new Response(JSON.stringify(SNAPSHOT), { status: 200, headers: { 'Content-Type': 'application/json' } })),
    );
    expect(ok).toContain('ACCURATEBIDS LIVE SNAPSHOT');
  });
});
