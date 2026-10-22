import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boundedExcerpt, describeLinkedRun, RESULT_EXCERPT_CHARS, type LinkedRunFacts } from '@/domain/opschat/linked-run-view';
import { completionEntries, completionReplyLead, type ContinuityCard } from '@/domain/opschat/conversation-continuity';
import { isBuildSkewed } from '@/app/ops/ops-chat-transcript';
import { currentBuildId, resetBuildIdForTests } from '@/lib/build-id';

/**
 * Hub prod 2026-10-22: a task finished and its email was sent, but the owner saw "no reply" in Ops Chat — (1) the tab
 * was open across the deploy and ran OLD client code (no live refresh), and (2) a completion was a small server note,
 * not an answer. Now: a build-skew reload banner, and completions rendered as an Ops Chat reply with the label and a
 * bounded excerpt of the actual result (chat only — never in email; never markdown/links).
 */

const h = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock('@/domain/auth/guard', () => ({ requireUser: h.requireUser }));

describe('isBuildSkewed', () => {
  it('only a real difference between two real builds counts', () => {
    expect(isBuildSkewed('1a2388a3963e', 'cd6bc5d81a84')).toBe(true);
    expect(isBuildSkewed('cd6bc5d81a84', 'cd6bc5d81a84')).toBe(false);
    expect(isBuildSkewed('dev', 'cd6bc5d81a84')).toBe(false);
    expect(isBuildSkewed('cd6bc5d81a84', 'dev')).toBe(false);
    expect(isBuildSkewed(null, 'cd6bc5d81a84')).toBe(false);
    expect(isBuildSkewed('cd6bc5d81a84', undefined)).toBe(false);
  });
});

describe('currentBuildId + GET /api/ops-chat/version', () => {
  const cwd = process.cwd();
  let spy: ReturnType<typeof vi.spyOn> | null = null;
  beforeEach(() => {
    resetBuildIdForTests();
    h.requireUser.mockResolvedValue({ id: 'u1' });
  });
  afterEach(() => {
    spy?.mockRestore();
    spy = null;
    resetBuildIdForTests();
  });

  it('reads the release sourceCommit from source-identity.json; anything else is "dev"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'build-id-'));
    writeFileSync(join(dir, 'source-identity.json'), JSON.stringify({ sourceCommit: 'cd6bc5d81a84ba05148120ad21ed81c7a2401088' }));
    spy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    expect(currentBuildId()).toBe('cd6bc5d81a84ba05148120ad21ed81c7a2401088');
    resetBuildIdForTests();
    writeFileSync(join(dir, 'source-identity.json'), JSON.stringify({ sourceCommit: '<script>' }));
    expect(currentBuildId()).toBe('dev');
    resetBuildIdForTests();
    spy.mockReturnValue(join(dir, 'missing'));
    expect(currentBuildId()).toBe('dev');
    expect(cwd).toBeTruthy();
  });

  it('the endpoint: signed-in only, never cached', async () => {
    const { GET } = await import('@/app/api/ops-chat/version/route');
    const ok = await GET();
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(await ok.json()).toHaveProperty('buildId');
    const { UnauthenticatedError } = await import('@/lib/errors');
    h.requireUser.mockRejectedValueOnce(new UnauthenticatedError());
    expect((await GET()).status).toBe(401);
  });
});

describe('boundedExcerpt', () => {
  it('short results whole; long ones cut back to a word boundary within the limit and flagged', () => {
    expect(boundedExcerpt('CFM ≈ 3,410.', 12)).toEqual({ excerpt: 'CFM ≈ 3,410.', truncated: false });
    expect(boundedExcerpt('', 0)).toEqual({ excerpt: null, truncated: false });
    expect(boundedExcerpt(null, 0)).toEqual({ excerpt: null, truncated: false });
    const long = 'word '.repeat(600); // 3,000 chars
    const r = boundedExcerpt(long.slice(0, RESULT_EXCERPT_CHARS + 1), 3_000);
    expect(r.truncated).toBe(true);
    expect(r.excerpt!.length).toBeLessThanOrEqual(RESULT_EXCERPT_CHARS);
    expect(r.excerpt!.endsWith('word')).toBe(true); // never mid-word
    // A result exactly at the limit but reported longer overall is still flagged as continuing.
    expect(boundedExcerpt('x'.repeat(RESULT_EXCERPT_CHARS), RESULT_EXCERPT_CHARS + 50).truncated).toBe(true);
  });
});

describe('describeLinkedRun carries the excerpt only for a finished run with text', () => {
  const facts = (status: string, excerpt: string | null, resultChars = excerpt?.length ?? 0): LinkedRunFacts => ({
    proposalId: 'p',
    taskId: 't',
    job: null,
    run: { id: 'r', status, reviewOutcome: 'required_unmet', startedAt: new Date('2026-10-22T01:59:56Z'), finishedAt: status === 'running' ? null : new Date('2026-10-22T02:00:52Z'), resultChars, errorMessage: status === 'failed' ? 'boom' : null, excerpt },
    pendingApprovals: 0,
  });
  it('completed → excerpt (bounded); the owner-facing sentence never contains result text', () => {
    const v = describeLinkedRun(facts('completed', 'UPDATED PUNCH LIST: Lead-Lag, Empera install.'));
    expect(v.excerpt).toBe('UPDATED PUNCH LIST: Lead-Lag, Empera install.');
    expect(v.excerptTruncated).toBe(false);
    expect(v.text).not.toContain('UPDATED PUNCH LIST');
  });
  it('failed / running → no excerpt', () => {
    expect(describeLinkedRun(facts('failed', null)).excerpt).toBeUndefined();
    expect(describeLinkedRun(facts('running', 'partial')).excerpt).toBeUndefined();
  });
});

describe('completion reply', () => {
  const card = (state: 'ready' | 'draft' | 'needs_approval' | 'failed', excerpt?: string): ContinuityCard => ({
    proposalId: `p-${state}`,
    kind: 'dispatch_task',
    label: 'dispatch "Server Cabinet Cooling — updated with your answers"',
    projectKey: 'hvac',
    view: { taskId: 't', runId: 'r', state, finishedAt: '2026-10-22T02:00:52.000Z', activeAt: '2026-10-22T02:00:52.000Z', text: 'Finished.', ...(excerpt ? { excerpt, excerptTruncated: true } : {}) },
  });

  it('entries carry the excerpt (never for FAILED)', () => {
    const [d, f] = completionEntries([card('draft', 'UPDATED PUNCH LIST…'), card('failed', 'should not show')]);
    expect(d).toMatchObject({ resultLabel: 'UNREVIEWED DRAFT', excerpt: 'UPDATED PUNCH LIST…', excerptTruncated: true });
    expect(f!.resultLabel).toBe('FAILED');
    expect(f!.excerpt).toBeUndefined();
  });

  it('the lead line is honest about the label', () => {
    const lead = (s: 'ready' | 'draft' | 'needs_approval' | 'failed', ex?: string) => completionReplyLead(completionEntries([card(s, ex)])[0]!);
    expect(lead('ready', 'x')).toBe('Your request dispatch "Server Cabinet Cooling — updated with your answers" has finished. Here\'s the start of what came back:');
    expect(lead('draft', 'x')).toMatch(/has finished — it is an UNREVIEWED DRAFT \(review was required but did not happen\), so it is not final\. Here's the start/);
    expect(lead('needs_approval')).toMatch(/proposed an action that needs your approval before the work is done\.$/);
    expect(lead('failed')).toMatch(/failed — nothing was produced\.$/);
  });
});
