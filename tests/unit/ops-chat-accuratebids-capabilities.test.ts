import { describe, expect, it } from 'vitest';
import { accurateBidsCapabilityContext } from '@/domain/opschat/accuratebids-capabilities';
import { accurateBidsEnabledFor } from '@/domain/opschat/accuratebids-action';

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
    expect(t).toMatch(/[Pp]ass it as customer_email/);
    expect(t).toMatch(/never replaced/);
    // Owner request 2026-11-13 (field use): the address may be read out of a document the owner uploaded,
    // not only typed by them — and the file must be named so the owner can catch a wrong one on the card.
    expect(t).toMatch(/from a document they uploaded here/);
    expect(t).toMatch(/say which file/);
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

  /**
   * Hill Street Construction (owner direction 2026-11-13) is a second contractor account sharing
   * this deployment. Listing it before its token exists must not make Ops Chat offer to quote for
   * it: the action would be refused at execution, and the failure mode it guards against — the
   * work quietly billing Empera's account — is the reason the whole change exists.
   */
  const TWO = {
    ...FULL,
    ACCURATEBIDS_SIGHT_PROJECT_KEYS: 'empera-air-conditioning-and-heating, empera-home-improvement',
    ACCURATEBIDS_DEFAULT_TOKEN_KEYS: 'empera-air-conditioning-and-heating',
  };

  it('a listed workspace with no usable token is named as NOT connected', () => {
    const t = accurateBidsCapabilityContext(TWO)!;
    expect(t).toMatch(/Connected workspace key\(s\): empera-air-conditioning-and-heating\./);
    expect(t).toMatch(/Listed but NOT connected yet: empera-home-improvement/);
    expect(t).toMatch(/do not route their work through a connected workspace/);
    expect(accurateBidsEnabledFor('empera-home-improvement', TWO)).toBe(false);
    expect(accurateBidsEnabledFor('empera-air-conditioning-and-heating', TWO)).toBe(true);
  });

  it('setting its own token moves it to connected, and never prints the value', () => {
    const wired = { ...TWO, ACCURATEBIDS_SERVICE_TOKEN__EMPERA_HOME_IMPROVEMENT: 'hill-street-token' };
    const t = accurateBidsCapabilityContext(wired)!;
    expect(t).toMatch(/Connected workspace key\(s\): empera-air-conditioning-and-heating, empera-home-improvement/);
    expect(t).not.toMatch(/NOT connected yet/);
    expect(t).not.toContain('hill-street-token');
    expect(accurateBidsEnabledFor('empera-home-improvement', wired)).toBe(true);
  });

  it('a workspace not listed at all stays off, token or no token', () => {
    expect(accurateBidsEnabledFor('kodisnap', { ...TWO, ACCURATEBIDS_SERVICE_TOKEN__KODISNAP: 'x' })).toBe(false);
  });
});
