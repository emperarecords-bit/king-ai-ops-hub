import { describe, expect, it } from 'vitest';
import { type DecisionInput, decideBackup } from '../../scripts/backup/backup-decision';

function d(over: Partial<DecisionInput>): DecisionInput {
  return { state: 'NO_PENDING', receiptVerification: null, pendingBindable: true, priorFailedMigrationAttempt: false, environment: 'staging', ...over };
}

describe('G-Backup-A backup decision (fail-closed gate)', () => {
  it('NO_PENDING → schema_free, no backup required', () => {
    expect(decideBackup(d({ state: 'NO_PENDING' }))).toMatchObject({ outcome: 'schema_free', backupRequired: false, mayProceed: true });
  });

  it('BOOTSTRAP_EMPTY → bootstrap, no backup required', () => {
    expect(decideBackup(d({ state: 'BOOTSTRAP_EMPTY' }))).toMatchObject({ outcome: 'bootstrap', backupRequired: false, mayProceed: true });
  });

  it('PENDING_FORWARD + valid receipt + bindable → proceed_with_backup', () => {
    expect(decideBackup(d({ state: 'PENDING_FORWARD', receiptVerification: { ok: true } }))).toMatchObject({ outcome: 'proceed_with_backup', backupRequired: true, mayProceed: true });
  });

  it('PENDING_FORWARD + missing receipt → blocked (every environment)', () => {
    for (const environment of ['development', 'staging', 'production'] as const) {
      expect(decideBackup(d({ state: 'PENDING_FORWARD', environment, receiptVerification: null }))).toMatchObject({ outcome: 'blocked', mayProceed: false });
    }
  });

  it('PENDING_FORWARD in DEVELOPMENT with no receipt is BLOCKED (no dev bypass — correction 4)', () => {
    expect(decideBackup(d({ state: 'PENDING_FORWARD', environment: 'development', receiptVerification: null }))).toMatchObject({ outcome: 'blocked', mayProceed: false });
  });

  it('PENDING_FORWARD + invalid receipt → blocked with the receipt reason', () => {
    const r = decideBackup(d({ state: 'PENDING_FORWARD', receiptVerification: { ok: false, reason: 'receipt expired' } }));
    expect(r.outcome).toBe('blocked');
    expect(r.reason).toContain('receipt expired');
  });

  it('PENDING_FORWARD with unbindable pending bytes → blocked (even with a valid receipt)', () => {
    const r = decideBackup(d({ state: 'PENDING_FORWARD', receiptVerification: { ok: true }, pendingBindable: false }));
    expect(r.outcome).toBe('blocked');
    expect(r.requiresManualInspection).toBe(true);
    expect(r.reason).toContain('not an exact committed-source or recognized EOL variant');
  });

  it('every divergence / failure state → blocked + manual inspection', () => {
    for (const state of ['HISTORICAL_HASH_MISMATCH', 'UNKNOWN_DATABASE_DIVERGENCE', 'MIGRATION_TABLE_MISSING_NONEMPTY', 'DETECTOR_FAILURE'] as const) {
      const r = decideBackup(d({ state }));
      expect(r.outcome).toBe('blocked');
      expect(r.requiresManualInspection).toBe(true);
    }
  });

  it('a prior failed migration attempt blocks even with a valid receipt (no auto-replay)', () => {
    const r = decideBackup(d({ state: 'PENDING_FORWARD', receiptVerification: { ok: true }, priorFailedMigrationAttempt: true }));
    expect(r.outcome).toBe('blocked');
    expect(r.requiresManualInspection).toBe(true);
    expect(r.reason).toContain('prior migration attempt failed');
  });
});
