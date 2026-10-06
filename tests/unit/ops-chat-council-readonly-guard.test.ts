import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Council Mode structural invariant: Council is REVIEW ONLY. The council domain
 * and its route may read authorized context and call the model provider, but they
 * must never import a mutation/DB-write helper or start work. Any action the owner
 * decides on still goes through the unchanged propose → /api/ops-chat/confirm
 * boundary. This guard fails if a write path leaks into Council.
 */

const root = process.cwd();
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

const COUNCIL_DOMAIN = 'src/domain/opschat/council.ts';
const COUNCIL_ROUTE = 'src/app/api/ops-chat/council/route.ts';
const COUNCIL_FILES = [COUNCIL_DOMAIN, COUNCIL_ROUTE];

// State-mutating / work-starting domain functions (spec PHASE F item 17).
const WRITE_FN_MARKERS = [
  'answerOwnerQuestion',
  'decideApproval',
  'createTask',
  'getTask',
  'enqueueRun',
  'executeApprovedIfEligible',
];
// Mutation/execution domain modules Council must not reach.
const WRITE_MODULE_MARKERS = [
  '@/domain/jobs/jobs',
  '@/domain/questions/questions',
  '@/domain/approvals/approvals',
  '@/domain/tasks/tasks',
  '@/domain/execution/execute-on-approval',
];
const DB_WRITE_MARKERS = ['.insert(', '.update(', '.delete('];

describe('Council Mode — cannot write hub state', () => {
  it.each(COUNCIL_FILES)('%s references no write-domain function', (file) => {
    const src = read(file);
    for (const marker of WRITE_FN_MARKERS) {
      expect(src, `${file} must not reference ${marker} — Council is review-only`).not.toContain(marker);
    }
  });

  it.each(COUNCIL_FILES)('%s imports no mutation/execution domain module', (file) => {
    const src = read(file);
    for (const marker of WRITE_MODULE_MARKERS) {
      expect(src, `${file} must not import ${marker} — Council is review-only`).not.toContain(marker);
    }
  });

  it.each(COUNCIL_FILES)('%s performs no direct DB write', (file) => {
    const src = read(file);
    for (const marker of DB_WRITE_MARKERS) {
      expect(src, `${file} must not perform ${marker}`).not.toContain(marker);
    }
  });
});

describe('Council Mode — provider boundary and spend controls', () => {
  it('the provider boundary lives in the council domain, not the route', () => {
    expect(read(COUNCIL_DOMAIN)).toContain('@/providers/registry');
    expect(read(COUNCIL_ROUTE), 'the route must not call the provider directly').not.toContain('@/providers/registry');
  });

  it('the council route keeps an owner-scoped rate limit', () => {
    const src = read(COUNCIL_ROUTE);
    expect(src).toContain('consumeRateLimit');
    expect(src).toContain('ops-chat-council:user:');
  });

  it('the council domain hard-caps reviewers and output tokens', () => {
    const src = read(COUNCIL_DOMAIN);
    expect(src).toContain('COUNCIL_MAX_REVIEWERS');
    expect(src).toContain('COUNCIL_MAX_REVIEWER_TOKENS');
    expect(src).toContain('COUNCIL_OVERALL_TIMEOUT_MS');
  });

  it('the single write boundary is still the confirm route', () => {
    const confirm = read('src/app/api/ops-chat/confirm/route.ts');
    for (const marker of ['answerOwnerQuestion', 'decideApproval', 'createTask', 'enqueueRun']) {
      expect(confirm, `confirm route must still own ${marker}`).toContain(marker);
    }
  });
});

describe('Council Mode — not on the default answer path', () => {
  it('the primary /api/ops-chat route does not import or auto-invoke Council', () => {
    const primary = read('src/app/api/ops-chat/route.ts');
    expect(primary, 'Council must be owner-triggered, never auto-run by the primary answer path').not.toContain(
      'opschat/council',
    );
    expect(primary).not.toContain('runCouncil');
  });

  it('the client only calls Council from an explicit handler (no call on load)', () => {
    const client = read('src/app/ops/ops-chat-client.tsx');
    expect(client).toContain('/api/ops-chat/council');
    // The council fetch must sit inside the askCouncil handler, not module/render scope.
    expect(client).toContain('async function askCouncil');
  });
});
