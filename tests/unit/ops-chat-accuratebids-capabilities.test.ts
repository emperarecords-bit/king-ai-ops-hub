import { describe, expect, it } from 'vitest';
import { accurateBidsCapabilityContext } from '@/domain/opschat/accuratebids-capabilities';

/**
 * Turn-start AccurateBids capabilities: derived from configuration presence only (never values),
 * so the model knows on its FIRST turn what the current release can do — including the owner-
 * provided email for an invoice with none on file — and that older "unavailable" replies in the
 * same conversation are out of date.
 */

const FULL = {
  ACCURATEBIDS_SIGHT_PROJECT_KEYS: 'empera-air-conditioning-and-heating, accuratebids-com',
  ACCURATEBIDS_SERVICE_TOKEN: 'secret-token-value',
  ACCURATEBIDS_QUOTE_URL: 'https://x.supabase.co/functions/v1/hub-quote',
  ACCURATEBIDS_INVOICE_URL: 'https://x.supabase.co/functions/v1/hub-invoice',
  ACCURATEBIDS_SEND_URL: 'https://x.supabase.co/functions/v1/hub-send',
};

describe('accurateBidsCapabilityContext', () => {
  it('no connected workspace → no block at all', () => {
    expect(accurateBidsCapabilityContext({})).toBeNull();
    expect(accurateBidsCapabilityContext({ ...FULL, ACCURATEBIDS_SIGHT_PROJECT_KEYS: ' , ' })).toBeNull();
  });

  it('fully configured → every action AVAILABLE, including the owner-email send for an invoice with none on file', () => {
    const t = accurateBidsCapabilityContext(FULL)!;
    expect(t).toMatch(/Connected workspace key\(s\): empera-air-conditioning-and-heating, accuratebids-com/);
    expect(t).toMatch(/propose_accuratebids_quote\): AVAILABLE/);
    expect(t).toMatch(/propose_accuratebids_invoice\): AVAILABLE/);
    expect(t).toMatch(/propose_accuratebids_send\): AVAILABLE/);
    expect(t).toMatch(/Invoice with NO email on file \(has_email false\): SUPPORTED/);
    expect(t).toMatch(/pass it as customer_email/);
    expect(t).toMatch(/never replaced/);
    expect(t).toMatch(/earlier in this conversation said .* unavailable .* out of date/);
  });

  it('never leaks a configured value (token or URL) — presence only', () => {
    const t = accurateBidsCapabilityContext(FULL)!;
    expect(t).not.toContain('secret-token-value');
    expect(t).not.toContain('supabase.co');
  });

  it('send not configured → says so, and does NOT promise the owner-email path', () => {
    const t = accurateBidsCapabilityContext({ ...FULL, ACCURATEBIDS_SEND_URL: undefined })!;
    expect(t).toMatch(/propose_accuratebids_send\): NOT CONFIGURED/);
    expect(t).not.toMatch(/SUPPORTED/);
  });

  it('no service token → nothing is available (every call would be refused)', () => {
    const t = accurateBidsCapabilityContext({ ...FULL, ACCURATEBIDS_SERVICE_TOKEN: '' })!;
    expect(t).not.toMatch(/: AVAILABLE/);
  });
});
