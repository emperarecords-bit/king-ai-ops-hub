import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Ops Chat v2 structural invariant: the chat/tool-loop is READ + PROPOSE only.
 * The model loop can never write hub state or start work; every mutation lives
 * behind the one confirm/write boundary. This guard fails if a write-domain
 * function leaks into a chat-loop module, if the confirm route stops owning the
 * writes, or if the v1 spend/boundary protections regress.
 */

const root = process.cwd();
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

const CHAT_ROUTE = 'src/app/api/ops-chat/route.ts';
const CONFIRM_ROUTE = 'src/app/api/ops-chat/confirm/route.ts';
// The model/tool loop and everything it can reach during ordinary chat.
const CHAT_LOOP_FILES = [
  'src/domain/opschat/pulse.ts',
  'src/domain/opschat/tools.ts',
  CHAT_ROUTE,
  'src/app/ops/page.tsx',
  'src/app/ops/ops-chat-client.tsx',
];

// State-mutating / work-starting domain functions. None may appear in a chat-loop module.
const WRITE_FN_MARKERS = [
  'answerOwnerQuestion',
  'decideApproval',
  'createTask',
  'enqueueRun',
  'executeApprovedIfEligible',
];
const DB_WRITE_MARKERS = ['.insert(', '.update(', '.delete('];

describe('Ops Chat v2 — the chat/tool loop cannot write hub state', () => {
  it.each(CHAT_LOOP_FILES)('%s references no write-domain function', (file) => {
    const src = read(file);
    for (const marker of WRITE_FN_MARKERS) {
      expect(src, `${file} must not reference ${marker} — writes live only in the confirm route`).not.toContain(marker);
    }
  });

  it.each(CHAT_LOOP_FILES)('%s performs no direct DB write', (file) => {
    const src = read(file);
    for (const marker of DB_WRITE_MARKERS) {
      expect(src, `${file} must not perform ${marker}`).not.toContain(marker);
    }
  });

  it('the tool layer does not import the run-enqueue module (proposals are data-only)', () => {
    expect(read('src/domain/opschat/tools.ts')).not.toContain('@/domain/jobs/jobs');
  });
});

describe('Ops Chat v2 — writes live only in the confirm boundary', () => {
  it('the confirm route owns every mutation path', () => {
    const src = read(CONFIRM_ROUTE);
    for (const marker of WRITE_FN_MARKERS) {
      expect(src, `confirm route must own ${marker}`).toContain(marker);
    }
  });
});

describe('Ops Chat v2 — provider-spend boundary preserved from v1', () => {
  it('only the chat Send route reaches the model provider', () => {
    expect(read(CHAT_ROUTE)).toContain('@/providers/registry');
    for (const file of [CONFIRM_ROUTE, 'src/domain/opschat/pulse.ts', 'src/app/ops/page.tsx', 'src/app/ops/ops-chat-client.tsx', 'src/domain/opschat/tools.ts']) {
      expect(read(file), `${file} must not call the model provider`).not.toContain('@/providers/registry');
    }
  });

  it('the chat Send route keeps the v1 owner-scoped rate limit', () => {
    const src = read(CHAT_ROUTE);
    expect(src).toContain('consumeRateLimit');
    expect(src).toContain('ops-chat:user:');
  });

  it('the opening pulse path is provider-free (page load is free)', () => {
    expect(read('src/app/ops/page.tsx')).not.toContain('@/providers');
    expect(read('src/domain/opschat/pulse.ts')).not.toContain('@/providers');
  });

  it('no owner email is placed in the model context (v1 data-minimization preserved)', () => {
    const src = read('src/domain/opschat/pulse.ts');
    // pulseContext must address by display name only — not the email field.
    expect(src).toContain('OWNER: ${pulse.displayName}');
    expect(src).not.toContain('<${pulse.email}>');
  });
});
