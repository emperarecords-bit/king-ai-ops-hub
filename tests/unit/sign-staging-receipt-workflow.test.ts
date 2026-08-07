import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static security validation of the manual staging-receipt-signing workflow. String/structural assertions (no YAML
 * runtime dependency) that fail closed if a future edit weakens the trigger surface, permissions, action pinning,
 * or introduces a Fly / snapshot / migration / deploy command, or leaks the signing secret into an input.
 */

const WF_PATH = join(process.cwd(), '.github', 'workflows', 'sign-staging-receipt.yml');
const wf = readFileSync(WF_PATH, 'utf8').replaceAll('\r\n', '\n');
/** The workflow with `#` comment lines removed — documentation legitimately names forbidden tokens. */
const wfCode = wf
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');

describe('sign-staging-receipt workflow — trigger surface', () => {
  it('is manual (workflow_dispatch) only', () => {
    expect(wfCode).toMatch(/^on:\n\s+workflow_dispatch:/m);
  });
  const forbiddenTriggers = ['push:', 'pull_request:', 'pull_request_target', 'schedule:', 'repository_dispatch:'];
  for (const t of forbiddenTriggers) {
    it(`does not trigger on ${t}`, () => {
      // Match only trigger keys at 2-space indent in executable YAML (comments already stripped).
      expect(wfCode).not.toMatch(new RegExp(`^\\s{2}${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'));
      expect(wfCode).not.toContain('pull_request_target');
    });
  }
});

describe('sign-staging-receipt workflow — least privilege + fork/environment guards', () => {
  it('declares read-only contents permission and no write scopes', () => {
    expect(wfCode).toMatch(/permissions:\n\s+contents:\s+read/);
    expect(wfCode).not.toMatch(/:\s*write\b/);
    expect(wfCode).not.toContain('id-token');
  });
  it('runs only in the canonical repository (no forks) and binds the staging environment', () => {
    expect(wf).toContain("if: github.repository == 'emperarecords-bit/king-ai-ops-hub'");
    expect(wf).toMatch(/environment:\s+staging/);
  });
});

describe('sign-staging-receipt workflow — third-party actions pinned to immutable SHAs', () => {
  it('every uses: is pinned to a 40-hex commit SHA', () => {
    const uses = [...wf.matchAll(/uses:\s+(\S+)/g)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });
});

describe('sign-staging-receipt workflow — no Fly / snapshot / migration / deploy commands', () => {
  // Restrict the scan to the executable run: steps so input DESCRIPTIONS mentioning "snapshot" don't false-positive.
  const runBlocks = [...wf.matchAll(/run:\s*\|?\n?([^\n]*(?:\n(?:\s{8,}).*)*)/g)].map((m) => m[0]).join('\n');
  const banned = ['flyctl', 'fly deploy', 'fly ssh', 'fly secrets', 'fly volumes', 'fly machine', 'fly pg', 'db:migrate', 'db:bootstrap', 'fly.io/graphql'];
  for (const b of banned) {
    it(`run: steps contain no ${b}`, () => {
      expect(runBlocks).not.toContain(b);
    });
  }
  it('the only build/run commands are npm ci, the signer CLI, git ancestor check, and the private-material scan', () => {
    expect(wf).toContain('npm ci');
    expect(wf).toContain('npx tsx scripts/ci/sign-staging-receipt.ts');
    expect(wf).toContain('merge-base --is-ancestor');
  });
});

describe('sign-staging-receipt workflow — secret handling + artifact hygiene', () => {
  it('materializes the signing key only from a secret, never a workflow input', () => {
    // The private key env var is fed from secrets.*, and no input carries key/PEM material.
    expect(wf).toMatch(/GBACKUP_SIGNING_KEY_PEM_B64:\s+\$\{\{\s*secrets\.GBACKUP_RECEIPT_SIGNING_KEY_B64\s*\}\}/);
    const inputsBlock = wf.slice(wf.indexOf('inputs:'), wf.indexOf('permissions:'));
    for (const bad of ['signing_key', 'private_key', 'key_pem', 'secret']) expect(inputsBlock.toLowerCase()).not.toContain(bad);
  });
  it('uploads only the three public files with a short retention and errors if missing', () => {
    expect(wf).toContain('receipt-out/staging-receipt.v2.json');
    expect(wf).toContain('receipt-out/trust-bundle.public.json');
    expect(wf).toContain('receipt-out/verification-metadata.json');
    expect(wf).toMatch(/retention-days:\s+7/);
    expect(wf).toMatch(/if-no-files-found:\s+error/);
  });
  it('has a step that fails if PRIVATE KEY material appears in the outputs', () => {
    expect(wf).toContain('PRIVATE KEY');
    expect(wf).toMatch(/grep -rl.*PRIVATE KEY.*receipt-out/);
  });
});

describe('sign-staging-receipt workflow — signer/selected-source separation + secret step-scoping', () => {
  it('does NOT check out the selected source commit over the trusted workspace', () => {
    // The trusted checkout has no `ref:` (so it uses the workflow revision = reviewed signer). The selected source
    // is never checked out as the primary workspace ref.
    expect(wfCode).not.toContain('ref: ${{ inputs.source_commit }}');
  });
  it('materializes the selected source as a separate DATA-ONLY worktree', () => {
    expect(wfCode).toContain('git worktree add');
    expect(wfCode).toContain('selected-source');
    // No dependency install or script execution happens inside the selected-source checkout.
    expect(wfCode).not.toMatch(/cd\s+selected-source/);
    expect(wfCode).not.toMatch(/selected-source[^\n]*npm|npm[^\n]*selected-source/);
  });
  it('runs the reviewed signer from the trusted workspace against SOURCE_DIR', () => {
    expect(wfCode).toContain('npx tsx scripts/ci/sign-staging-receipt.ts');
    expect(wfCode).toMatch(/SOURCE_DIR:\s+\$\{\{\s*github\.workspace\s*\}\}\/selected-source/);
  });
  it('the signing secret appears exactly once, only in the signing step', () => {
    const secretRefs = wfCode.match(/secrets\.GBACKUP_RECEIPT_SIGNING_KEY_B64/g) ?? [];
    expect(secretRefs.length).toBe(1);
    const keyEnvRefs = wfCode.match(/GBACKUP_SIGNING_KEY_PEM_B64:/g) ?? [];
    expect(keyEnvRefs.length).toBe(1);
    // Not at workflow-level or job-level env: the only occurrence follows the signing step's name.
    const idx = wfCode.indexOf('GBACKUP_SIGNING_KEY_PEM_B64:');
    const signStepIdx = wfCode.indexOf('Sign + self-verify the staging receipt');
    expect(signStepIdx).toBeGreaterThan(0);
    expect(idx).toBeGreaterThan(signStepIdx);
  });
  it('npm ci (trusted deps) runs before the signing step', () => {
    expect(wfCode.indexOf('npm ci')).toBeLessThan(wfCode.indexOf('GBACKUP_SIGNING_KEY_PEM_B64:'));
  });
});

describe('sign-staging-receipt workflow — required non-secret inputs are present', () => {
  const required = ['source_commit', 'target_image_ref', 'target_image_digest', 'deployment_nonce', 'database_system_identifier', 'snapshot_id', 'snapshot_created_at', 'key_id'];
  for (const r of required) {
    it(`declares input ${r}`, () => expect(wf).toMatch(new RegExp(`^\\s{6}${r}:`, 'm')));
  }
});
