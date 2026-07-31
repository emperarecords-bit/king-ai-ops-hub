import { type MigrationState } from './migration-detector';
import { type VerifyResult } from './receipt-verify';

/**
 * G-Backup-A — the pure gate decision. Combines a migration-state classification with (optional) receipt
 * verification into one outcome. Fail-closed everywhere: only NO_PENDING (schema-free) and BOOTSTRAP_EMPTY
 * (explicitly-declared empty database) proceed without a backup; PENDING_FORWARD needs a VERIFIED receipt in
 * staging/production; every divergence/failure state — and any prior failed migration attempt — blocks.
 *
 * This function only DECIDES; it never executes migrations, creates snapshots, or writes anything.
 */

export type BackupOutcome = 'schema_free' | 'bootstrap' | 'proceed_with_backup' | 'blocked';
export type GateEnvironment = 'staging' | 'production' | 'development';

export interface DecisionInput {
  readonly state: MigrationState;
  /** Result of verifying the supplied receipt, or null when no receipt was supplied. */
  readonly receiptVerification: VerifyResult | null;
  /** True if a prior migration attempt for this deployment failed and was not cleanly resolved. */
  readonly priorFailedMigrationAttempt: boolean;
  readonly environment: GateEnvironment;
}

export interface Decision {
  readonly outcome: BackupOutcome;
  readonly backupRequired: boolean;
  readonly mayProceed: boolean;
  readonly requiresManualInspection: boolean;
  readonly reason: string;
}

export function decideBackup(inp: DecisionInput): Decision {
  const blocked = (reason: string, manual = false): Decision => ({
    outcome: 'blocked',
    backupRequired: false,
    mayProceed: false,
    requiresManualInspection: manual,
    reason,
  });

  // A prior failed migration attempt is never auto-replayed — recovery-after-failure is a separate, manual path
  // (G-Backup-A distinguishes detection-before-migration from recovery-after-failure; see G-BACKUP-A.md).
  if (inp.priorFailedMigrationAttempt) {
    return blocked('a prior migration attempt failed; re-run the detector and inspect manually — PENDING_FORWARD does not imply safe replay', true);
  }

  switch (inp.state) {
    case 'NO_PENDING':
      return { outcome: 'schema_free', backupRequired: false, mayProceed: true, requiresManualInspection: false, reason: 'no pending migrations; schema-free release' };

    case 'BOOTSTRAP_EMPTY':
      return { outcome: 'bootstrap', backupRequired: false, mayProceed: true, requiresManualInspection: false, reason: 'explicitly-declared empty bootstrap database; no preexisting Hub data to preserve' };

    case 'PENDING_FORWARD': {
      const backupRequired = inp.environment === 'staging' || inp.environment === 'production';
      if (!backupRequired) {
        // Development: forward migrations allowed without a managed snapshot.
        return { outcome: 'proceed_with_backup', backupRequired: false, mayProceed: true, requiresManualInspection: false, reason: 'pending forward migrations (development: no managed snapshot required)' };
      }
      if (inp.receiptVerification?.ok) {
        return { outcome: 'proceed_with_backup', backupRequired: true, mayProceed: true, requiresManualInspection: false, reason: 'pending forward migrations with a verified backup receipt' };
      }
      const why = inp.receiptVerification ? `invalid receipt: ${inp.receiptVerification.reason}` : 'no backup receipt supplied';
      return blocked(`pending forward migrations in ${inp.environment} require a verified backup receipt — ${why}`);
    }

    case 'HISTORICAL_HASH_MISMATCH':
      return blocked('a historical migration hash does not match the repository; manual inspection required', true);
    case 'UNKNOWN_DATABASE_DIVERGENCE':
      return blocked('database migration history is not a valid prefix of the repository; manual inspection required', true);
    case 'MIGRATION_TABLE_MISSING_NONEMPTY':
      return blocked('migration tracking table absent on a non-empty / undeclared database; manual inspection required', true);
    case 'DETECTOR_FAILURE':
      return blocked('migration-state detector failed; cannot classify the database, fail closed', true);
    default:
      return blocked(`unhandled migration state: ${inp.state as string}`, true);
  }
}
