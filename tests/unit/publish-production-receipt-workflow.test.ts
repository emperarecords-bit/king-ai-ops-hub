import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static security validation of the gated PRODUCTION receipt-PUBLISH workflow (Gate 3). String/structural
 * assertions (no YAML runtime dependency) that fail closed if a future edit weakens the trigger surface,
 * permissions, action pinning, environment gating, secret separation, or lets the publisher job see the signing
 * key / app credentials / a STAGING target or staging cross-use. A parameter-for-parameter mirror of the staging
 * workflow test, pinned to production.
 */

const WF_PATH = join(process.cwd(), '.github', 'workflows', 'publish-production-receipt.yml');
const wf = readFileSync(WF_PATH, 'utf8').replaceAll('\r\n', '\n');
/** The workflow with `#` comment lines removed — documentation legitimately names tokens we otherwise forbid. */
const wfCode = wf
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');

/** The ONLY secret names this workflow may reference: the 5 dedicated receipt-publish S3 creds + the built-in
 *  Actions token (read-only, for artifact provenance/download). No signing key, no app AWS_*, no VER-002. */
const APPROVED_SECRETS = new Set([
  'GBACKUP_RECEIPT_S3_ACCESS_KEY_ID',
  'GBACKUP_RECEIPT_S3_SECRET_ACCESS_KEY',
  'GBACKUP_RECEIPT_S3_ENDPOINT',
  'GBACKUP_RECEIPT_S3_REGION',
  'GBACKUP_RECEIPT_S3_BUCKET',
  'GITHUB_TOKEN',
]);

describe('publish-production-receipt workflow — trigger surface', () => {
  it('is manual (workflow_dispatch) only', () => {
    expect(wfCode).toMatch(/^on:\n\s+workflow_dispatch:/m);
  });
  for (const t of ['push:', 'pull_request:', 'schedule:', 'repository_dispatch:']) {
    it(`does not trigger on ${t}`, () => {
      expect(wfCode).not.toMatch(new RegExp(`^\\s{2}${t}`, 'm'));
    });
  }
  it('never uses pull_request_target', () => {
    expect(wfCode).not.toContain('pull_request_target');
  });
});

describe('publish-production-receipt workflow — least privilege + fork/environment guards', () => {
  it('declares contents: read + actions: read and NO write scope / id-token', () => {
    expect(wfCode).toMatch(/permissions:\n\s+contents:\s+read\n\s+actions:\s+read/);
    expect(wfCode).not.toMatch(/:\s*write\b/);
    expect(wfCode).not.toContain('id-token');
    expect(wfCode).not.toContain('packages:');
    expect(wfCode).not.toContain('deployments:');
  });
  it('runs only in the canonical repository (no forks) and binds the production environment', () => {
    expect(wf).toContain("if: github.repository == 'emperarecords-bit/king-ai-ops-hub'");
    expect(wf).toMatch(/environment:\s+production/);
  });
});

describe('publish-production-receipt workflow — targets production, never staging', () => {
  it('has an explicit production-only guard and never names the staging app/environment', () => {
    expect(wfCode).toContain('king-ai-ops-hub-prod');
    expect(wf).not.toContain('king-ai-ops-hub-staging');
    expect(wfCode).not.toMatch(/environment:\s+staging/);
    // The guard refuses any non-production target application.
    expect(wfCode).toMatch(/TARGET_APP.*!=.*king-ai-ops-hub-prod|!= "king-ai-ops-hub-prod"/);
  });
  it('does not cross-use any staging workflow, artifact, or publisher', () => {
    expect(wf).not.toContain('sign-staging-receipt.yml');
    expect(wf).not.toContain('publish-staging-receipt');
    expect(wf).not.toContain('staging-receipt-v2');
    expect(wf).not.toContain('staging-publish-evidence');
    expect(wf).not.toContain('publish-receipt.ts\n'); // the staging-pinned base entry is never invoked directly
  });
});

describe('publish-production-receipt workflow — third-party actions pinned to immutable SHAs', () => {
  it('every uses: is pinned to a 40-hex commit SHA', () => {
    const uses = [...wf.matchAll(/uses:\s+(\S+)/g)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });
});

describe('publish-production-receipt workflow — no Fly / snapshot / migration / deploy commands', () => {
  const runBlocks = [...wf.matchAll(/run:\s*\|?\n?([^\n]*(?:\n(?:\s{8,}).*)*)/g)].map((m) => m[0]).join('\n');
  const banned = ['flyctl', 'fly deploy', 'fly ssh', 'fly secrets', 'fly volumes', 'fly machine', 'fly pg', 'db:migrate', 'db:bootstrap'];
  for (const b of banned) {
    it(`run: steps contain no ${b}`, () => expect(runBlocks).not.toContain(b));
  }
  it('the publisher command is the PRODUCTION CLI entry, gated behind the ancestor check', () => {
    expect(wf).toContain('npm ci');
    expect(wf).toContain('npx tsx scripts/ci/publish-production-receipt.ts');
    expect(wf).toContain('merge-base --is-ancestor');
  });
});

describe('publish-production-receipt workflow — secret separation', () => {
  it('references ONLY the approved secret names (5 dedicated S3 + the Actions token)', () => {
    const referenced = new Set([...wf.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]!));
    expect(referenced.size).toBeGreaterThan(0);
    for (const name of referenced) expect(APPROVED_SECRETS.has(name), `unexpected secret ${name}`).toBe(true);
    // All five dedicated S3 creds are present.
    for (const s of ['GBACKUP_RECEIPT_S3_ACCESS_KEY_ID', 'GBACKUP_RECEIPT_S3_SECRET_ACCESS_KEY', 'GBACKUP_RECEIPT_S3_ENDPOINT', 'GBACKUP_RECEIPT_S3_REGION', 'GBACKUP_RECEIPT_S3_BUCKET']) {
      expect(referenced.has(s), `missing dedicated secret ${s}`).toBe(true);
    }
  });
  it('the publisher job never holds the Ed25519 signing private key', () => {
    expect(wf).not.toContain('GBACKUP_RECEIPT_SIGNING_KEY_B64');
    expect(wf).not.toContain('GBACKUP_SIGNING_KEY_PEM');
    expect(wf).not.toContain('SIGNING_KEY');
  });
  it('never falls back to app AWS_* / S3_* document-store or VER-002 credentials', () => {
    expect(wf).not.toMatch(/secrets\.AWS_/);
    expect(wf).not.toMatch(/secrets\.S3_/);
    expect(wf).not.toMatch(/\bAWS_ACCESS_KEY_ID\b|\bAWS_SECRET_ACCESS_KEY\b|\bAWS_ENDPOINT_URL_S3\b/);
    // VER-002 may appear in documentation comments as something NOT used; forbid it only in executable YAML.
    expect(wfCode.toLowerCase()).not.toContain('ver-002');
    expect(wfCode.toLowerCase()).not.toContain('ver002');
  });
  it('pulls the non-secret public verification config from vars (not secrets)', () => {
    expect(wf).toMatch(/GBACKUP_RECEIPT_BASE_URL:\s+\$\{\{\s*vars\.GBACKUP_RECEIPT_BASE_URL\s*\}\}/);
    expect(wf).toMatch(/GBACKUP_RECEIPT_HOSTS:\s+\$\{\{\s*vars\.GBACKUP_RECEIPT_HOSTS\s*\}\}/);
    expect(wf).toMatch(/GBACKUP_RECEIPT_TRUST_BUNDLE:\s+\$\{\{\s*vars\.GBACKUP_RECEIPT_TRUST_BUNDLE\s*\}\}/);
  });
});

describe('publish-production-receipt workflow — artifact provenance + publication safety', () => {
  it('downloads the PRODUCTION signer artifact by explicit run id with provenance verification', () => {
    expect(wf).toContain('name: production-receipt-v2');
    expect(wf).toMatch(/run-id:\s+\$\{\{\s*inputs\.signer_run_id\s*\}\}/);
    expect(wf).toContain('.github/workflows/sign-production-receipt.yml');
    expect(wf).toContain('actions/download-artifact');
  });
  it('does NOT infer release identity from branch HEAD — source_commit is an explicit input bound + ancestor-checked', () => {
    expect(wf).toMatch(/^\s{6}source_commit:/m);
    expect(wfCode).not.toContain('github.sha');
    expect(wfCode).not.toContain('git rev-parse HEAD');
  });
  it('uploads sanitized evidence only, with a credential scan before upload', () => {
    expect(wf).toContain('PUBLISH_EVIDENCE_FILE');
    expect(wf).toContain('name: production-publish-evidence');
    expect(wf).toMatch(/retention-days:\s+7/);
    expect(wf).toMatch(/if-no-files-found:\s+error/);
    expect(wf).toMatch(/grep -rliE "SECRET\|ACCESS_KEY\|PRIVATE KEY\|AWS_SECRET"/);
  });
});

describe('publish-production-receipt workflow — required explicit inputs', () => {
  const required = ['signer_run_id', 'source_commit', 'target_image_ref', 'target_image_digest', 'deployment_nonce', 'applied_count', 'target_application', 'database_system_identifier', 'snapshot_id'];
  for (const r of required) {
    it(`declares required input ${r}`, () => {
      const block = wf.slice(wf.indexOf('inputs:'), wf.indexOf('permissions:'));
      expect(block).toMatch(new RegExp(`^\\s{6}${r}:`, 'm'));
    });
  }
  it('every declared input is required: true', () => {
    const block = wf.slice(wf.indexOf('inputs:'), wf.indexOf('permissions:'));
    // No input may be optional in this ceremony.
    expect(block).not.toMatch(/required:\s+false/);
  });
});

describe('publish-production-receipt CLI entry — production-pinned consumer', () => {
  const cli = readFileSync(join(process.cwd(), 'scripts', 'ci', 'publish-production-receipt.ts'), 'utf8');
  it('passes PRODUCTION_PINS into the shared reviewed publisher', () => {
    expect(cli).toContain("from '../backup/production-pins'");
    expect(cli).toContain('PRODUCTION_PINS');
    expect(cli).toContain('runPublishCli');
  });
  it('is a CONSUMER — never imports or references a signing key / signer', () => {
    expect(cli).not.toContain('SIGNING_KEY');
    expect(cli).not.toMatch(/\bsign(Receipt|ReceiptV2|Cli)\b/);
    expect(cli).not.toContain('receipt-v2-sign');
  });
  it('only self-executes under its own path (no accidental double-run of the staging entry)', () => {
    expect(cli).toMatch(/scripts\\\/ci\\\/publish-production-receipt/);
  });
});
