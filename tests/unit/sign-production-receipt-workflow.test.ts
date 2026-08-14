import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static invariants of the PRODUCTION receipt-signing workflow (Gate 3) — the same guarantees the staging
 * workflow test pins, asserted on the mirror. Line endings are normalized first so the pins hold identically on
 * LF (CI) and CRLF (Windows working tree) checkouts.
 */

const wf = readFileSync(join('.github', 'workflows', 'sign-production-receipt.yml'), 'utf8').replaceAll('\r\n', '\n');

describe('sign-production-receipt workflow — least privilege + manual-only + production environment', () => {
  it('is manual (workflow_dispatch) only — no push/PR/schedule/repository_dispatch/pull_request_target', () => {
    expect(wf).toContain('workflow_dispatch:');
    for (const trigger of ['push:', 'pull_request:', 'schedule:', 'repository_dispatch:', 'pull_request_target:']) {
      expect(wf.includes(trigger), `forbidden trigger present: ${trigger}`).toBe(false);
    }
  });

  it('declares read-only contents permission and no write scopes / id-token', () => {
    expect(wf).toMatch(/permissions:\n\s+contents:\s+read/);
    expect(wf).not.toMatch(/:\s*write\b/);
    expect(wf).not.toMatch(/id-token\s*:/); // the PERMISSION grant — prose mentions of the word are fine
  });

  it('binds to the protected production environment and the canonical repository only', () => {
    expect(wf).toMatch(/environment:\s*production/);
    expect(wf).toContain("github.repository == 'emperarecords-bit/king-ai-ops-hub'");
  });

  it('materializes the signing key ONLY from the environment secret, in exactly one step', () => {
    const occurrences = wf.split('secrets.GBACKUP_RECEIPT_SIGNING_KEY_B64').length - 1;
    expect(occurrences).toBe(1);
    // Never as a workflow input:
    expect(wf).not.toMatch(/inputs\.[a-z_]*key[a-z_]*_b64/i);
  });

  it('reuses the reviewed staging signer CLI unchanged and scans outputs for private material', () => {
    expect(wf).toContain('npx tsx scripts/ci/sign-staging-receipt.ts');
    expect(wf).toContain('grep -rlZ "PRIVATE KEY" receipt-out');
  });

  it('verifies the source commit is an ancestor of protected main before any signing', () => {
    expect(wf).toContain('git merge-base --is-ancestor "$SRC" origin/main');
  });

  it('uploads only public material under the production artifact name', () => {
    expect(wf).toContain('name: production-receipt-v2');
    expect(wf).toContain('production-receipt.v2.json');
    expect(wf).toContain('trust-bundle.public.json');
  });

  it('production defaults: retention 30 days, applied_count 0 (fresh database)', () => {
    expect(wf).toMatch(/retention_days:[\s\S]{0,200}default:\s*'30'/);
    expect(wf).toMatch(/applied_count:[\s\S]{0,220}default:\s*'0'/);
  });
});
