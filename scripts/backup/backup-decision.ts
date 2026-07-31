import { type MigrationState } from './migration-detector';
import { type VerifyResult } from './receipt-verify';

/**
 * G-Backup-A — the pure gate decision. Fail-closed everywhere. Only NO_PENDING (schema-free) and
 * BOOTSTRAP_EMPTY (catalog-verified, declared empty database) proceed without a backup. PENDING_FORWARD needs a
 * VERIFIED backup receipt in EVERY environment (correction 4 — no development bypass; a logical dev-backup
 * receipt is deferred to G-Backup-C). Additionally, PENDING_FORWARD is blocked when the pending runtime bytes
 * are not bound to the portable source (not an exact committed-source or recognized EOL variant). Any
 * divergence / mismatch / detector failure, and any prior failed migration attempt, blocks.
 */

export type BackupOutcome = 'schema_free' | 'bootstrap' | 'proceed_with_backup' | 'blocked';
export type GateEnvironment = 'development' | 'staging' | 'production';

export interface DecisionInput {
  readonly state: MigrationState;
  /** Result of verifying the supplied receipt, or null when no receipt was supplied. */
  readonly receiptVerification: VerifyResult | null;
  /** True if the pending migration bytes are bound to the portable source (exact or recognized EOL variant). */
  readonly pendingBindable: boolean;
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

  if (inp.priorFailedMigrationAttempt) {
    return blocked('a prior migration attempt failed; re-run the detector and inspect manually — PENDING_FORWARD does not imply safe replay', true);
  }

  switch (inp.state) {
    case 'NO_PENDING':
      return { outcome: 'schema_free', backupRequired: false, mayProceed: true, requiresManualInspection: false, reason: 'no pending migrations; schema-free release' };

    case 'BOOTSTRAP_EMPTY':
      return { outcome: 'bootstrap', backupRequired: false, mayProceed: true, requiresManualInspection: false, reason: 'catalog-verified declared empty bootstrap database; no preexisting Hub data to preserve' };

    case 'PENDING_FORWARD': {
      // Pending bytes must be bound to the portable source in every environment.
      if (!inp.pendingBindable) {
        return blocked('pending migration bytes are not an exact committed-source or recognized EOL variant; refusing to bind a receipt to unverified bytes', true);
      }
      // A verified backup receipt is required in EVERY environment (no development bypass).
      if (inp.receiptVerification?.ok) {
        return { outcome: 'proceed_with_backup', backupRequired: true, mayProceed: true, requiresManualInspection: false, reason: 'pending forward migrations with source-bound bytes and a verified backup receipt' };
      }
      const why = inp.receiptVerification ? `invalid receipt: ${inp.receiptVerification.reason}` : 'no backup receipt supplied';
      return blocked(`pending forward migrations in ${inp.environment} require a verified backup receipt — ${why}`);
    }

    case 'HISTORICAL_HASH_MISMATCH':
      return blocked('an applied migration matches neither the committed source nor a recognized EOL variant; manual inspection required', true);
    case 'UNKNOWN_DATABASE_DIVERGENCE':
      return blocked('database migration history is not a valid prefix of the source; manual inspection required', true);
    case 'MIGRATION_TABLE_MISSING_NONEMPTY':
      return blocked('migration tracking table absent on a non-empty / undeclared / identity-mismatched database; manual inspection required', true);
    case 'DETECTOR_FAILURE':
      return blocked('migration-state detector failed; cannot classify the database, fail closed', true);
    default:
      return blocked(`unhandled migration state: ${inp.state as string}`, true);
  }
}
