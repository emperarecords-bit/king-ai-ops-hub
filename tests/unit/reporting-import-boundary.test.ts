import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTION_TYPES } from '@/types/domain';
import { hasEligibleExecutor } from '@/domain/execution/executors';
import { MAX_REVISIONS, MAX_RETRIES_PER_CALL, MAX_STEPS } from '@/orchestration/engine';

/**
 * Static architecture guard for the M0a reporting increment. The reporting domain must be a pure, read-only
 * consumer: no path to provider dispatch / runner / orchestration / executors / connectors / credentials, and
 * no write queries. Also pins the engine constants and executor-eligibility invariant so this increment
 * provably changed neither.
 */

const ROOT = process.cwd();
const REPORTING_DIR = join(ROOT, 'src', 'domain', 'reporting');

function reportingSources(): { file: string; src: string }[] {
  return readdirSync(REPORTING_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: f, src: readFileSync(join(REPORTING_DIR, f), 'utf8') }));
}

const FORBIDDEN_IMPORT_SUBSTRINGS = [
  "from '@/providers/",
  "from '@/orchestration/",
  "from '@/domain/tasks/runner",
  "from '@/domain/execution/executors",
  "from '@/domain/connectors",
  '/credentials',
  "from '@/providers/openai",
  "from '@/providers/anthropic",
  "from '@/providers/registry",
];

describe('M0a reporting import boundary', () => {
  it('has at least the expected reporting modules', () => {
    const files = reportingSources().map((r) => r.file).sort();
    expect(files).toEqual(expect.arrayContaining(['access.ts', 'attribution.ts', 'm0a.ts', 'pricing-match.ts', 'small-sample.ts']));
  });

  it('imports no provider / runner / orchestration / executor / connector / credential module', () => {
    for (const { file, src } of reportingSources()) {
      for (const bad of FORBIDDEN_IMPORT_SUBSTRINGS) {
        expect(src.includes(bad), `${file} must not import ${bad}`).toBe(false);
      }
    }
  });

  it('issues no write queries (no insert/update/delete/execute)', () => {
    for (const { file, src } of reportingSources()) {
      for (const bad of ['.insert(', '.update(', '.delete(', '.execute(']) {
        expect(src.includes(bad), `${file} must not contain ${bad}`).toBe(false);
      }
    }
  });

  it('does not read prompt/response/content/evidence columns', () => {
    // Reporting projects identifiers + metrics only. These TABLE-QUALIFIED sensitive column selectors must
    // never appear (table-qualified so a benign local like `a.input` cannot false-positive).
    const forbiddenColumns = [
      'tasks.input',
      'agents.systemPrompt',
      'runs.consolidatedResult',
      'runs.retrievedSources',
      'runs.retrievedDocuments',
      'runs.errorMessage',
      'runSteps.verdictDetail',
      'runSteps.errorMessage',
      'messages.content',
    ];
    for (const { file, src } of reportingSources()) {
      for (const bad of forbiddenColumns) {
        expect(src.includes(bad), `${file} must not reference ${bad}`).toBe(false);
      }
    }
  });

  it('executor eligibility remains false for every action', () => {
    for (const a of ACTION_TYPES) expect(hasEligibleExecutor(a)).toBe(false);
  });

  it('engine constants are unchanged (fixed pipeline)', () => {
    expect(MAX_STEPS).toBe(4);
    expect(MAX_REVISIONS).toBe(1);
    expect(MAX_RETRIES_PER_CALL).toBe(2);
  });
});
