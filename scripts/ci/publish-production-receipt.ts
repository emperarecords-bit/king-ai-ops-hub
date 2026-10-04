import { PRODUCTION_PINS } from '../backup/production-pins';
import { ReceiptPublishError } from '../backup/publish-receipt';
import { runPublishCli } from './publish-receipt';

/**
 * Gate 3 — PRODUCTION receipt-PUBLISH CLI (invoked by .github/workflows/publish-production-receipt.yml). A thin
 * per-environment entry over the SAME reviewed publisher the staging ceremony uses (`runPublishCli` in
 * scripts/ci/publish-receipt.ts → scripts/backup/publish-receipt.ts): only the pinned release facts
 * (scripts/backup/production-pins.ts) differ. It is a CONSUMER — it never holds the Ed25519 signing key.
 *
 * Mirrors scripts/ci/sign-production-receipt.ts exactly: the base CLI defaults to STAGING_PINS, so production needs
 * its own entry that passes PRODUCTION_PINS. All verification, create-only write, anonymous read-back, and
 * remote re-verification are the shared, already-reviewed code; the environment/application/locator are pinned to
 * production via PRODUCTION_PINS (environment `production`, application `king-ai-ops-hub-prod`).
 */

// Execute only when run directly as the CLI script (not when imported by tests).
const entry = (process.argv[1] ?? '').replace(/\\/g, '/');
if (/scripts\/ci\/publish-production-receipt\.(ts|js|mjs)$/.test(entry)) {
  runPublishCli(process.env, process.cwd(), console.log, {}, PRODUCTION_PINS).catch((e) => {
    const msg = e instanceof ReceiptPublishError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
    console.error(`[publish-production-receipt] FAILED: ${msg}`);
    process.exit(1);
  });
}
