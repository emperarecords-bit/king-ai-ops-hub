import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Ops Chat v1 is READ-ONLY by construction. This guard reads the Ops Chat source
 * and fails if a write/dispatch/approve capability or a stray provider-spend
 * boundary is introduced — so v1 cannot silently acquire the ability to change
 * hub state, and the provider is only ever reached from the one Send route.
 */

const root = process.cwd();
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

const ROUTE = 'src/app/api/ops-chat/route.ts';
const NON_SPEND_FILES = [
  'src/domain/opschat/pulse.ts',
  'src/app/ops/page.tsx',
  'src/app/ops/ops-chat-client.tsx',
];
const ALL_FILES = [ROUTE, ...NON_SPEND_FILES];

// State-mutating primitives. If Ops Chat v1 ever needs one of these it is no
// longer read-only and must be reviewed as v2.
const MUTATION_MARKERS = [
  'enqueueRun',
  'createTask',
  'startRun',
  'dispatchRun',
  'answerOwnerQuestion',
  'approveApproval',
  'resolveApproval',
  '@/domain/jobs/jobs',
  '@/domain/tasks/tasks',
  '.insert(',
  '.update(',
  '.delete(',
];

describe('Ops Chat v1 — read-only by construction', () => {
  it.each(ALL_FILES)('%s contains no state-mutation/dispatch primitive', (file) => {
    const src = read(file);
    for (const marker of MUTATION_MARKERS) {
      expect(src, `${file} must not reference ${marker} in read-only v1`).not.toContain(marker);
    }
  });
});

describe('Ops Chat v1 — single provider-spend boundary', () => {
  it('only the Send route imports the provider registry', () => {
    expect(read(ROUTE)).toContain('@/providers/registry');
    for (const file of NON_SPEND_FILES) {
      expect(read(file), `${file} must not import a provider (spend only happens in the Send route)`).not.toContain(
        '@/providers',
      );
    }
  });

  it('the opening pulse path does not import the provider (page load is free)', () => {
    expect(read('src/app/ops/page.tsx')).not.toContain('@/providers');
    expect(read('src/domain/opschat/pulse.ts')).not.toContain('@/providers');
  });

  it('the Send route bounds spend with the per-user rate limiter', () => {
    const src = read(ROUTE);
    expect(src).toContain('consumeRateLimit');
    expect(src).toContain('ops-chat:user:');
  });
});
