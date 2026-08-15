import { FLY_VOLUMES_ADAPTER_VERSION, FLY_VOLUMES_PROVIDER } from './provider-fly-volumes';
import { type ReleasePins } from './sign-staging-receipt';

/**
 * Gate 3 (owner-approved 2026-08-14) — the immutable PRODUCTION release facts a production receipt binds. Values
 * come from the closed Gate-1 provisioning record: app/database identities, the production source volume, and the
 * migration endpoint of the source being released. The endpoint/count pins are a deliberate tripwire: adding a
 * migration makes production signing fail until this file is consciously updated in a reviewed PR (a unit test
 * asserts these pins match the repository's actual migration set, so drift is caught in CI, not at ceremony time).
 */
export const PRODUCTION_PINS: ReleasePins = {
  environment: 'production',
  targetApplication: 'king-ai-ops-hub-prod',
  databaseApp: 'king-ai-hub-db-prod',
  sourceVolumeId: 'vol_vlye16958n6x6ed4',
  databaseIdentity: 'king_ai_ops_hub_production',
  snapshotProvider: FLY_VOLUMES_PROVIDER,
  providerAdapterVersion: FLY_VOLUMES_ADAPTER_VERSION,
  // Bumped 2026-08-15 (0063 pricing schedule v3 — corrected Gemini model ids). Prod deployed through 0062 same day.
  expectedMigrationEndpoint: '0063_pricing_schedule_v3',
  expectedCommittedMigrationCount: 64,
  /** Production deployed through 0062 on 2026-08-15; 0063 is the one pending. */
  defaultAppliedCount: 63,
} as const;
