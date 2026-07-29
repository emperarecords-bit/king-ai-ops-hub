import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * HUB-009 — production classification logic must never determine classification from a title/name/path/key
 * prefix. This asserts the runtime domain + read code carries no `[demo]`/`[test]`/`[pf-demo]`/`__pf-demo-`
 * matching and no `isDemoRecord` helper. (Seed scripts + investigation tooling may still contain the strings;
 * they are excluded here.)
 */
const ROOT = process.cwd();
const PRODUCTION_FILES = [
  'src/domain/classification/classification.ts',
  'src/domain/agents/attribution.ts',
  'src/domain/health/health.ts',
  'src/domain/briefing/briefing.ts',
  'src/domain/objectives/objectives.ts',
  'src/domain/execution/execution.ts',
  'src/domain/state/project-state.ts',
  'src/domain/dependencies/dependencies.ts',
  'src/domain/tasks/tasks.ts',
];

describe('HUB-009 — no runtime prefix-matching in production classification', () => {
  it.each(PRODUCTION_FILES)('%s determines classification only from stored values, never a prefix', (file) => {
    const src = readFileSync(join(ROOT, file), 'utf8');
    expect(src, `${file} must not prefix-match a demo/test/pf-demo marker`).not.toMatch(/\[demo\]|\[test\]|\[pf-demo\]|__pf-demo/i);
    expect(src, `${file} must not contain the removed isDemoRecord prefix matcher`).not.toContain('isDemoRecord');
  });
});
