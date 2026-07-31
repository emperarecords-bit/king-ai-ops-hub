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

  it('scripts/migrate.ts is NOT modified to import the backup modules (live path untouched by G-Backup-A)', () => {
    const migrate = readFileSync(join(ROOT, 'scripts', 'migrate.ts'), 'utf8');
    expect(migrate.includes('scripts/backup')).toBe(false);
    expect(migrate.includes("from './backup")).toBe(false);
    // The current (unchanged) behavior: it still calls the old preMigrationBackup().
    expect(migrate.includes('preMigrationBackup')).toBe(true);
  });

  it('executor eligibility remains false for every action', () => {
    for (const a of ACTION_TYPES) expect(hasEligibleExecutor(a)).toBe(false);
  });

  it('engine constants are unchanged', () => {
    expect(MAX_STEPS).toBe(4);
    expect(MAX_REVISIONS).toBe(1);
    expect(MAX_RETRIES_PER_CALL).toBe(2);
  });
});
