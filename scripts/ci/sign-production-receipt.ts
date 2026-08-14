import { PRODUCTION_PINS } from '../backup/production-pins';
import { PRIVATE_KEY_MARKER } from '../backup/receipt-key-bundle';
import { runCli, type RunCliOptions } from './sign-staging-receipt';

/**
 * Gate 3 — PRODUCTION receipt-signing CLI (invoked by .github/workflows/sign-production-receipt.yml). A thin
 * per-environment entry over the SAME reviewed CLI/producer the staging ceremony uses: only the pinned release
 * facts (scripts/backup/production-pins.ts), the output filename, and the log label differ. All key handling,
 * validation, signing, self-verification, and private-material guarantees are the shared, already-reviewed code.
 */

export const PRODUCTION_CLI_OPTIONS: RunCliOptions = {
  pins: PRODUCTION_PINS,
  receiptBasename: 'production-receipt.v2.json',
  label: 'production',
};

// Execute only when run directly as the CLI script (not when imported by tests).
const entry = (process.argv[1] ?? '').replace(/\\/g, '/');
if (/scripts\/ci\/sign-production-receipt\.(ts|js|mjs)$/.test(entry)) {
  try {
    runCli(process.env, process.cwd(), console.log, PRODUCTION_CLI_OPTIONS);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[sign-production-receipt] FAILED: ${msg.includes(PRIVATE_KEY_MARKER) ? '<redacted>' : msg}`);
    process.exit(1);
  }
}
