import { describe, expect, it } from 'vitest';
import { canonicalizeFileWriteAction } from '@/domain/execution/file-write-action';
import { confirmationBindingSha256, FILE_WRITE_CONFIRMATION_LIFETIME_MS, validateConfirmationUse, type FileWriteConfirmationFields } from '@/domain/execution/file-write-confirmation';

const actionResult = canonicalizeFileWriteAction({ operation: 'replace', target: 'plans/a.md', payload: 'new', expectedCurrentSha256: 'a'.repeat(64) });
if (!actionResult.allowed) throw new Error('fixture invalid');
const confirmedAt = new Date('2026-08-08T12:00:00.000Z');
const base: FileWriteConfirmationFields = {
  confirmationId: 'confirmation-1', orgId: 'org-1', projectId: 'project-1', actorId: 'actor-1', executorId: 'file_write',
  riskClass: 'reversible_internal_write', mode: 'live', confirmedAt: confirmedAt.toISOString(),
  expiresAt: new Date(confirmedAt.getTime() + FILE_WRITE_CONFIRMATION_LIFETIME_MS).toISOString(), action: actionResult.action,
};

describe('file-write confirmation binding', () => {
  it('is deterministic, valid before expiry, invalid exactly at expiry, and single-use', () => {
    const digest = confirmationBindingSha256(base);
    expect(digest).toBe(confirmationBindingSha256(base));
    const first = validateConfirmationUse(base, digest, new Date(confirmedAt.getTime() + 1), new Set());
    expect(first.allowed).toBe(true);
    if (!first.allowed) return;
    expect(validateConfirmationUse(base, digest, new Date(confirmedAt.getTime() + 2), first.consumedIds).allowed).toBe(false);
    expect(validateConfirmationUse(base, digest, new Date(base.expiresAt), new Set()).allowed).toBe(false);
  });

  it.each([
    ['confirmationId', 'confirmation-2'], ['orgId', 'org-2'], ['projectId', 'project-2'], ['actorId', 'actor-2'],
    ['riskClass', 'external_reversible'], ['mode', 'dry_run'], ['confirmedAt', '2026-08-08T12:00:01.000Z'],
    ['expiresAt', '2026-08-08T12:11:00.000Z'],
  ] as const)('changing %s invalidates the binding', (key, changed) => {
    expect(validateConfirmationUse({ ...base, [key]: changed }, confirmationBindingSha256(base), new Date(confirmedAt.getTime() + 1), new Set()).allowed).toBe(false);
  });

  it.each([
    ['operation', 'create'], ['normalizedTarget', 'plans/b.md'], ['payloadSha256', 'b'.repeat(64)],
    ['expectedCurrentSha256', 'c'.repeat(64)], ['desiredPostconditionSha256', 'd'.repeat(64)],
  ] as const)('changing action %s invalidates the binding', (key, changed) => {
    const altered = { ...base, action: { ...base.action, [key]: changed } } as FileWriteConfirmationFields;
    expect(validateConfirmationUse(altered, confirmationBindingSha256(base), new Date(confirmedAt.getTime() + 1), new Set()).allowed).toBe(false);
  });
});
