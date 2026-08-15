import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTION_TYPES } from '@/types/domain';
import { hasEligibleExecutor } from '@/domain/execution/executors';
import { MAX_REVISIONS, MAX_RETRIES_PER_CALL, MAX_STEPS } from '@/orchestration/engine';

/**
 * Static architecture guard for G-Backup-A. The backup modules must be a pure, read-only planning layer: no
 * path to provider dispatch / runner / orchestration / executors / pricing, no write queries, and NO wiring
 * into the live migration path (`scripts/migrate.ts` must remain untouched by this increment). Also pins the
 * engine constants and executor-eligibility invariant.
 */

const ROOT = process.cwd();
const DIR = join(ROOT, 'scripts', 'backup');

function backupSources(): { file: string; src: string }[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: f, src: readFileSync(join(DIR, f), 'utf8') }));
}

const FORBIDDEN_IMPORTS = [
  "from '@/providers/",
  "from '@/orchestration/",
  "from '@/domain/tasks/runner",
  "from '@/domain/execution/executors",
  "from '@/domain/connectors",
  '/credentials',
];

describe('G-Backup-A import boundary', () => {
  it('has the expected backup modules', () => {
    const files = backupSources().map((r) => r.file).sort();
    expect(files).toEqual(
      expect.arrayContaining([
        'backup-decision.ts',
        'migration-detector.ts',
        'migration-hash.ts',
        'receipt-canonical.ts',
        'receipt-schema.ts',
        'receipt-verify.ts',
        'source-manifest.ts',
        'legacy-attestation-schema.ts',
        'legacy-attestation-canonical.ts',
        'legacy-attestation-verify.ts',
        'legacy-attestation-sign.ts',
        'legacy-active-bundle.ts',
        'strict-json.ts',
        'runtime-migration-set.ts',
        'provider-fly-volumes.ts',
        'receipt-v2-schema.ts',
        'receipt-v2-canonical.ts',
        'receipt-v2-sign.ts',
        'receipt-v2-verify.ts',
        'receipt-v2-locator.ts',
        'receipt-transport.ts',
        'receipt-v2-encoding.ts',
        'receipt-key-bundle.ts',
        'receipt-v2-controller.ts',
        'premigration-gate.ts',
      ]),
    );
  });

  it('imports no provider / runner / orchestration / executor / connector / credential module', () => {
    for (const { file, src } of backupSources()) {
      for (const bad of FORBIDDEN_IMPORTS) {
        expect(src.includes(bad), `${file} must not import ${bad}`).toBe(false);
      }
    }
  });

  it('issues no write queries (raw SQL or query-builder writes)', () => {
    // Target actual write statements/builders — NOT crypto `.update()` (hash) which is legitimate.
    const writePatterns = [/insert\s+into/i, /delete\s+from/i, /\bupdate\s+[a-z_."]+\s+set\b/i, /\.insert\(/, /\.delete\(/];
    for (const { file, src } of backupSources()) {
      for (const re of writePatterns) {
        expect(re.test(src), `${file} must not contain a write op (${re})`).toBe(false);
      }
    }
  });

  it('scripts/migrate.ts imports ONLY the B2a consumer surface from backup (gate + transport), no other backup module', () => {
    // Superseded by G-Backup-B2a: migrate.ts now wires the pre-migration verification gate. The ONLY backup
    // imports permitted are the gate and the transport (the consumer surface). The detailed signer / Fly-authority
    // exclusions are asserted in the B2a-specific tests below.
    const migrate = readFileSync(join(ROOT, 'scripts', 'migrate.ts'), 'utf8');
    const backupImports = [...migrate.matchAll(/from '\.\/backup\/([a-z0-9-]+)'/g)].map((m) => m[1]);
    expect(new Set(backupImports)).toEqual(new Set(['premigration-gate', 'receipt-transport']));
  });

  it('the SIGNER module is NOT imported by the runtime verifier, detector, or migrate.ts (correction 3)', () => {
    const signerImport = "legacy-attestation-sign";
    for (const f of ['legacy-attestation-verify.ts', 'legacy-attestation-schema.ts', 'legacy-attestation-canonical.ts', 'migration-detector.ts']) {
      const src = readFileSync(join(DIR, f), 'utf8');
      expect(src.includes(signerImport), `${f} must not import the signer`).toBe(false);
    }
    const migrate = readFileSync(join(ROOT, 'scripts', 'migrate.ts'), 'utf8');
    expect(migrate.includes(signerImport)).toBe(false);
    // The runtime verifier exposes no signing method / private-key path.
    const verifySrc = readFileSync(join(DIR, 'legacy-attestation-verify.ts'), 'utf8');
    expect(verifySrc.includes('sign as cryptoSign')).toBe(false);
    expect(/\bcryptoSign\b/.test(verifySrc)).toBe(false);
  });

  it('G-Backup-B1: the receipt-v2 SIGNER is not imported by the v2 verifier, transport, locator, detector, or migrate.ts', () => {
    const signer = 'receipt-v2-sign';
    for (const f of ['receipt-v2-verify.ts', 'receipt-v2-canonical.ts', 'receipt-v2-schema.ts', 'receipt-transport.ts', 'receipt-v2-locator.ts', 'provider-fly-volumes.ts', 'runtime-migration-set.ts', 'migration-detector.ts']) {
      expect(readFileSync(join(DIR, f), 'utf8').includes(signer), `${f} must not import the v2 signer`).toBe(false);
    }
    expect(readFileSync(join(ROOT, 'scripts', 'migrate.ts'), 'utf8').includes(signer)).toBe(false);
  });

  it('G-Backup-B1: the receipt transport carries no Fly/deploy authority and no signer', () => {
    const t = readFileSync(join(DIR, 'receipt-transport.ts'), 'utf8');
    for (const bad of ['flyctl', 'fly deploy', 'FLY_API_TOKEN', 'access-token', 'receipt-v2-sign', 'cryptoSign', ' sign(']) {
      expect(t.includes(bad), `receipt-transport must not reference ${bad}`).toBe(false);
    }
    // The v2 runtime verifier only VERIFIES (no signing primitive).
    const v = readFileSync(join(DIR, 'receipt-v2-verify.ts'), 'utf8');
    expect(/\bcryptoSign\b/.test(v)).toBe(false);
    expect(v.includes('sign as')).toBe(false);
  });

  it('G-Backup-B2a: the gate + migrate.ts import no signer and no Fly snapshot authority', () => {
    const gate = readFileSync(join(DIR, 'premigration-gate.ts'), 'utf8');
    const migrate = readFileSync(join(ROOT, 'scripts', 'migrate.ts'), 'utf8');
    for (const forbidden of ['receipt-v2-sign', 'legacy-attestation-sign', 'cryptoSign', 'flyctl', 'fly deploy', 'FLY_API_TOKEN', 'volumes snapshots']) {
      expect(gate.includes(forbidden), `premigration-gate must not reference ${forbidden}`).toBe(false);
      expect(migrate.includes(forbidden), `migrate.ts must not reference ${forbidden}`).toBe(false);
    }
    // The gate has no signing primitive of its own.
    expect(/\bsign\s*\(/.test(gate)).toBe(false);
  });

  it('G-Backup-B2a: migrate.ts wires the gate before any mutation and drops the Windows-only backup path', () => {
    const migrate = readFileSync(join(ROOT, 'scripts', 'migrate.ts'), 'utf8');
    expect(migrate.includes("from './backup/premigration-gate'")).toBe(true);
    expect(migrate.includes('runPreMigrationGate')).toBe(true);
    // The Windows-only best-effort path is gone; backup.ps1 itself is intentionally retained on disk.
    expect(migrate.includes('preMigrationBackup')).toBe(false);
    expect(migrate.includes('powershell.exe')).toBe(false);
    expect(readdirSync(join(ROOT, 'scripts')).includes('backup.ps1')).toBe(true);
    // The gate runs strictly before the two mutation calls.
    const gateAt = migrate.indexOf('runPreMigrationGate');
    const migrateAt = migrate.indexOf('await migrate(db');
    const rlsAt = migrate.indexOf('rls.sql');
    expect(gateAt).toBeGreaterThan(0);
    expect(gateAt).toBeLessThan(migrateAt);
    expect(gateAt).toBeLessThan(rlsAt);
  });

  it('G-Backup-B2a: the Dockerfile bakes the source identity in build AND copies it into the runtime image at the gate-read path', () => {
    const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
    const migrate = readFileSync(join(ROOT, 'scripts', 'migrate.ts'), 'utf8');
    // Split into stages on each FROM … so we can assert per-stage.
    const stages = dockerfile.split(/^FROM /m).slice(1).map((s) => `FROM ${s}`);
    const buildStage = stages.find((s) => /\bAS build\b/.test(s.split('\n')[0]!))!;
    const runtimeStage = stages.find((s) => /\bAS runtime\b/.test(s.split('\n')[0]!))!;
    expect(buildStage).toBeTruthy();
    expect(runtimeStage).toBeTruthy();
    // 1. the BUILD stage creates the identity file at /app/source-identity.json.
    expect(/>\s*\/app\/source-identity\.json/.test(buildStage)).toBe(true);
    expect(buildStage.includes('source-identity.json')).toBe(true);
    // 2. the RUNTIME stage copies it FROM the build stage (so the deployed migrate image contains it).
    expect(runtimeStage.includes('COPY --from=build /app/source-identity.json ./source-identity.json')).toBe(true);
    // 3. the runtime destination matches the path scripts/migrate.ts reads: <cwd=/app>/source-identity.json.
    expect(/WORKDIR \/app/.test(runtimeStage)).toBe(true);
    expect(migrate.includes("join(process.cwd(), 'source-identity.json')")).toBe(true);
  });

  it('executor eligibility is true ONLY for git_pr (Action Executors v1)', () => {
    for (const a of ACTION_TYPES) expect(hasEligibleExecutor(a)).toBe(a === 'git_pr');
  });

  it('engine constants are unchanged', () => {
    expect(MAX_STEPS).toBe(4);
    expect(MAX_REVISIONS).toBe(1);
    expect(MAX_RETRIES_PER_CALL).toBe(2);
  });
});
