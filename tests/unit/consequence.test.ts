import { describe, expect, it } from 'vitest';
import { assessConsequence, isInlineAuthorizable, readConsequence } from '@/domain/approvals/consequence';

const read = (type: Parameters<typeof assessConsequence>[0]['type'], payload: Record<string, unknown>) =>
  readConsequence(assessConsequence({ type, summary: 's', payload }));
const inline = (type: Parameters<typeof assessConsequence>[0]['type'], payload: Record<string, unknown>) =>
  isInlineAuthorizable(read(type, payload), payload);

/**
 * Consequence claims must come from evidence, not action-type templates. These lock that the
 * assessor establishes only what the payload proves and never asserts reversibility or external
 * impact it cannot establish.
 */
describe('assessConsequence establishes only what the evidence proves', () => {
  it('never infers reversibility from the action type', () => {
    const write = assessConsequence({ type: 'file_write', summary: 'Write notes.md', payload: { path: 'notes.md' } });
    expect(write.reversibility.established).toBe(false);
    expect(write.reversibility.value).toBeNull();
    // "reversibility" is surfaced as an explicit unknown, not silently assumed either way.
    expect(write.unknowns).toContain('reversibility');
  });

  it('always establishes the narrow authority requested from the proposal itself', () => {
    const a = assessConsequence({ type: 'deployment', summary: 'Deploy a1b3c9 to staging', payload: { revision: 'a1b3c9' } });
    expect(a.authorityRequested.established).toBe(true);
    expect(a.authorityRequested.source).toBe('proposal-payload');
    expect(a.authorityRequested.value).toMatch(/exactly as proposed/i);
  });

  it('establishes financial exposure only when an amount is present', () => {
    const withAmount = assessConsequence({ type: 'financial', summary: 'Renew domain', payload: { amount: '$480', payee: 'registrar' } });
    expect(withAmount.financialExposure.established).toBe(true);
    expect(withAmount.financialExposure.value).toMatch(/480/);

    const noAmount = assessConsequence({ type: 'financial', summary: 'Pay vendor', payload: {} });
    expect(noAmount.financialExposure.established).toBe(false);
    expect(noAmount.unknowns).toContain('financial exposure');
  });

  it('establishes external-party impact only when the payload names an outside recipient/endpoint', () => {
    const email = assessConsequence({ type: 'email_send', summary: 'Follow up', payload: { to: 'nick@lnmechanical.com' } });
    expect(email.externalPartiesAffected.established).toBe(true);
    expect(email.externalPartiesAffected.value).toMatch(/nick@/);

    const write = assessConsequence({ type: 'file_write', summary: 'Write file', payload: { path: 'x.md' } });
    expect(write.externalPartiesAffected.established).toBe(false);
  });

  it('describes a delete by its predicate, never by an unproven row count', () => {
    const del = assessConsequence({ type: 'destructive', summary: 'Purge stale leads', payload: { where: "last_touched < '2025-01-01'" } });
    expect(del.dataAffected.established).toBe(true);
    expect(del.dataAffected.value).toMatch(/matching/i);
    expect(del.dataAffected.value).not.toMatch(/\d+ rows/i);
  });

  it('always states, from policy, that no executor exists yet', () => {
    const a = assessConsequence({ type: 'git_push', summary: 'Push', payload: {} });
    expect(a.executionMethod.established).toBe(true);
    expect(a.executionMethod.source).toBe('policy');
    expect(a.executionMethod.value).toMatch(/no automated executor/i);
  });
});

describe('readConsequence levels the proposal from evidence, not the type alone', () => {
  it('a workspace-internal file write is routine and needs no clarification', () => {
    const r = read('file_write', { path: 'notes.md' });
    expect(r.level).toBe('routine');
    expect(r.needsClarification).toBe(false);
  });

  it('an email with a known recipient is consequential and clear', () => {
    const r = read('email_send', { to: 'nick@lnmechanical.com' });
    expect(r.level).toBe('consequential');
    expect(r.needsClarification).toBe(false);
  });

  it('an email with no recipient is consequential but needs clarification', () => {
    const r = read('email_send', {});
    expect(r.level).toBe('consequential');
    expect(r.needsClarification).toBe(true);
  });

  it('an external HTTP call always needs clarification — its effect is unknowable here', () => {
    const r = read('external_http', { url: 'https://hooks.partner.io/ingest' });
    expect(r.needsClarification).toBe(true);
  });

  it('a financial action needs an amount to be clear', () => {
    expect(read('financial', { amount: '$480' }).needsClarification).toBe(false);
    expect(read('financial', {}).needsClarification).toBe(true);
  });

  it('a destructive mutation needs a predicate to be clear', () => {
    expect(read('destructive', { where: "x < '2025'" }).needsClarification).toBe(false);
    expect(read('destructive', {}).needsClarification).toBe(true);
  });
});

describe('inline authorization requires complete context', () => {
  it('a proposal with a hidden material parameter can NEVER be authorized inline', () => {
    // A routine file write, but the actual content is hidden from the compact queue reference.
    expect(read('file_write', { path: 'notes.md', content: 'material body' }).level).toBe('routine');
    expect(inline('file_write', { path: 'notes.md', content: 'material body' })).toBe(false);
    // Even a bare path is a hidden material parameter → detail required.
    expect(inline('file_write', { path: 'notes.md' })).toBe(false);
  });

  it('only a routine proposal with no hidden material parameter may be inline', () => {
    expect(inline('file_write', {})).toBe(true); // nothing material concealed
    // Consequential is never inline regardless of payload.
    expect(inline('email_send', { to: 'x@y.z' })).toBe(false);
    // Cosmetic/empty fields do not count as material.
    expect(inline('file_write', { note: '', draft: false, tags: [] })).toBe(true);
  });
});
