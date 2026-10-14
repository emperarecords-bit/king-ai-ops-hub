import { describe, expect, it } from 'vitest';
import {
  applySavedMapping,
  buildTranscript,
  confirmOutcome,
  isActionable,
  pendingOutsideWindow,
  pendingTurnOf,
  RELOAD_TO_SEE_STATE,
  type PersistedMessage,
} from '@/app/ops/ops-chat-transcript';

/**
 * Ops Chat transcript + recovery model (PR 2 client wiring). Pure, node-level tests for:
 *  - turn-aware display order from the persisted store (never raw seq),
 *  - the "earliest unanswered owner turn" recovery state (DB fact, never auto-retried),
 *  - proposal cards: actionable only when pending AND backed by a persisted proposalId,
 *  - confirm outcomes: `unrecorded` / 409 / network-unknown disable the card and require a reload.
 */

const owner = (id: string, content = id): PersistedMessage => ({
  id,
  role: 'user',
  status: 'complete',
  content,
  question: null,
  replyToMessageId: null,
  proposals: [],
});
const reply = (id: string, to: string | null, extra: Partial<PersistedMessage> = {}): PersistedMessage => ({
  id,
  role: 'assistant',
  status: 'complete',
  content: `answer ${to}`,
  question: to,
  replyToMessageId: to,
  proposals: [],
  ...extra,
});

describe('buildTranscript — turn-aware order from the persisted store', () => {
  it('B persisted while A ran (seq: A, B, replyA, replyB) displays as A, replyA, B, replyB', () => {
    const t = buildTranscript([owner('A'), owner('B'), reply('rA', 'A'), reply('rB', 'B')]);
    expect(t.map((m) => m.id)).toEqual(['A', 'rA', 'B', 'rB']);
    expect(t.filter((m) => m.role === 'owner').every((m) => m.awaitingReply === false)).toBe(true);
  });

  it('an owner turn with no reply is awaiting; one with an INTERRUPTED reply is closed (terminal)', () => {
    const t = buildTranscript([
      owner('A'),
      reply('rA', 'A', { status: 'interrupted', content: 'partial' }),
      owner('B'),
    ]);
    expect(t.find((m) => m.id === 'A')!.awaitingReply).toBe(false);
    expect(t.find((m) => m.id === 'rA')!.status).toBe('interrupted');
    expect(t.find((m) => m.id === 'B')!.awaitingReply).toBe(true);
  });

  it('an interrupted reply never yields cards, even if a row were present (never actionable)', () => {
    const t = buildTranscript([
      owner('A'),
      reply('rA', 'A', { status: 'interrupted', proposals: [{ id: 'p1', proposal: { kind: 'rerun_task' }, state: 'pending', result: null, error: null }] }),
    ]);
    expect(t.find((m) => m.id === 'rA')!.cards).toBeUndefined();
  });

  it('persisted cards carry their proposalId + stored state; an unknown state fails closed to unrecorded', () => {
    const t = buildTranscript([
      owner('A'),
      reply('rA', 'A', {
        proposals: [
          { id: 'p1', proposal: { kind: 'rerun_task', taskId: 't' }, state: 'pending', result: null, error: null },
          { id: 'p2', proposal: { kind: 'rerun_task', taskId: 'u' }, state: 'done', result: { outcome: 'succeeded' }, error: null },
          { id: 'p3', proposal: { kind: 'rerun_task', taskId: 'v' }, state: 'weird', result: null, error: null },
        ],
      }),
    ]);
    const cards = t.find((m) => m.id === 'rA')!.cards!;
    expect(cards.map((c) => [c.proposalId, c.state])).toEqual([
      ['p1', 'pending'],
      ['p2', 'done'],
      ['p3', 'unrecorded'],
    ]);
    expect(cards[1]!.executed).toEqual({ outcome: 'succeeded' });
    // Reloaded cards are marked as historical ("Proposed earlier") — display only.
    expect(cards.every((c) => c.fromHistory === true)).toBe(true);
    expect(isActionable(cards[0]!)).toBe(true);
    expect(isActionable(cards[2]!)).toBe(false);
  });

  it('a reply whose owner fell outside the display window is kept (shown first), not dropped', () => {
    const t = buildTranscript([reply('rOld', 'OUTSIDE'), owner('B'), reply('rB', 'B')]);
    expect(t.map((m) => m.id)).toEqual(['rOld', 'B', 'rB']);
  });
});

describe('pending turn — the earliest unanswered owner turn is the recovery state', () => {
  it('is the FIRST awaiting owner turn in order (FIFO), with its exact id + content', () => {
    const t = buildTranscript([owner('A'), reply('rA', 'A'), owner('B', 'second'), owner('C', 'third')]);
    expect(pendingTurnOf(t, null)).toEqual({ turnId: 'B', content: 'second' });
  });

  it('is null when every owner turn has a terminal reply — sending is open', () => {
    const t = buildTranscript([owner('A'), reply('rA', 'A')]);
    expect(pendingTurnOf(t, null)).toBeNull();
  });

  it('a server pending turn OUTSIDE the loaded window is authoritative; inside the window it is derived', () => {
    const t = buildTranscript([owner('B'), reply('rB', 'B')]);
    const outside = pendingOutsideWindow(t, { turnId: 'OLD', content: 'old message' });
    expect(outside).toEqual({ turnId: 'OLD', content: 'old message' });
    expect(pendingTurnOf(t, outside)).toEqual({ turnId: 'OLD', content: 'old message' });

    const t2 = buildTranscript([owner('B', 'b')]);
    expect(pendingOutsideWindow(t2, { turnId: 'B', content: 'b' })).toBeNull();
    expect(pendingTurnOf(t2, null)).toEqual({ turnId: 'B', content: 'b' });
  });
});

describe('applySavedMapping — cards become actionable ONLY through `saved`', () => {
  it('attaches proposalIds by correlationKey; an unmapped card stays non-actionable', () => {
    const cards = [
      { proposal: { kind: 'rerun_task' }, correlationKey: 'k1', state: 'pending' as const },
      { proposal: { kind: 'rerun_task' }, correlationKey: 'k2', state: 'pending' as const },
    ];
    expect(cards.some(isActionable)).toBe(false); // streamed but not yet saved
    expect(cards.some((c) => 'fromHistory' in c)).toBe(false); // streamed cards are not "proposed earlier"
    const out = applySavedMapping(cards, [{ correlationKey: 'k1', proposalId: 'p1' }])!;
    expect(out[0]!.proposalId).toBe('p1');
    expect(isActionable(out[0]!)).toBe(true);
    expect(out[1]!.proposalId).toBeUndefined();
    expect(isActionable(out[1]!)).toBe(false);
  });
});

describe('confirmOutcome — never a false done, never a blind re-confirm', () => {
  it('done → done with the executed result', () => {
    expect(confirmOutcome(200, { ok: true, executed: { outcome: 'succeeded' }, state: 'done' })).toEqual({
      state: 'done',
      error: undefined,
      executed: { outcome: 'succeeded' },
    });
  });

  it('executed but unrecorded (200) → unrecorded, card disabled, reload required', () => {
    const o = confirmOutcome(200, { ok: true, executed: {}, state: 'unrecorded', warning: 'reload to see the true state' });
    expect(o.state).toBe('unrecorded');
    expect(o.error).toContain('reload');
    expect(isActionable({ proposal: {}, proposalId: 'p', ...o })).toBe(false);
  });

  it('failed and the terminal state could not be recorded (5xx, state unrecorded) → unrecorded', () => {
    expect(confirmOutcome(502, { error: 'boom', state: 'unrecorded', warning: 'reload' }).state).toBe('unrecorded');
  });

  it('409 (another tab/device moved the card) → conflict, disabled, reload required', () => {
    const o = confirmOutcome(409, { error: 'This proposal is no longer pending.', state: 'pending' });
    expect(o.state).toBe('conflict');
    expect(o.error).toContain('Reload');
  });

  it('recorded stale / error are terminal (no re-confirm)', () => {
    expect(confirmOutcome(410,{ error: 'gone', state: 'stale' })).toMatchObject({ state: 'stale', error: 'gone' });
    expect(confirmOutcome(502, { error: 'failed', state: 'error' })).toMatchObject({ state: 'error', error: 'failed' });
  });

  it('cancel → cancelled', () => {
    expect(confirmOutcome(200, { ok: true, state: 'cancelled' }).state).toBe('cancelled');
  });

  it('rejected BEFORE the pending→confirming CAS (403/429/400, no state) → still pending and retryable', () => {
    for (const status of [400, 403, 429]) {
      const o = confirmOutcome(status, { error: 'nope' });
      expect(o).toEqual({ state: 'pending', error: 'nope' });
      expect(isActionable({ proposal: {}, proposalId: 'p', ...o })).toBe(true);
    }
  });

  it('a 200 with no recognizable state cannot prove the outcome → unrecorded (fail closed)', () => {
    expect(confirmOutcome(200, null)).toMatchObject({ state: 'unrecorded', error: RELOAD_TO_SEE_STATE });
  });
});
