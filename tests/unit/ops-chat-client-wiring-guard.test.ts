import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Ops Chat PR 2 client wiring — structural invariants (source-level, like ops-chat-readonly-guard).
 * The behaviour is unit-tested in ops-chat-transcript.test.ts / ops-chat-stream.test.ts; this guard
 * pins the wiring rules that a refactor could silently break:
 *
 *  - RECOVERY IS EXPLICIT: a pending turn is resumed ONLY by the owner clicking "Resume message" —
 *    never from an effect / on load (a resume can spend a model call) — and it re-sends the EXACT
 *    pending turn (its own turnId; no new id is minted for recovery).
 *  - The send body carries the client-minted ids and NO client-supplied history.
 *  - Confirm/Cancel are proposalId-authoritative: the body is only `{ proposalId, intent }`.
 *  - The page loads the earliest unanswered owner turn from the store and hands it to the client.
 */

const root = process.cwd();
const read = (p: string): string => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');
const CLIENT = read('src/app/ops/ops-chat-client.tsx');
const PAGE = read('src/app/ops/page.tsx');

function body(src: string, startMarker: string, endMarker: string): string {
  const s = src.indexOf(startMarker);
  const e = src.indexOf(endMarker, s + startMarker.length);
  expect(s, `missing ${startMarker}`).toBeGreaterThanOrEqual(0);
  expect(e, `missing ${endMarker}`).toBeGreaterThan(s);
  return src.slice(s, e);
}

describe('Ops Chat client wiring — recovery is explicit and exact', () => {
  it('resume() is invoked only from an onClick handler (never automatically)', () => {
    const calls = CLIENT.match(/\bresume\(\)/g) ?? [];
    const clicks = CLIENT.match(/onClick=\{\(\) => void resume\(\)\}/g) ?? [];
    // one definition (`async function resume()`) + click handlers only
    expect(CLIENT).toContain('async function resume()');
    expect(clicks.length).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBe(1 + clicks.length);
  });

  it('no effect runs a turn or a resume', () => {
    for (const effect of CLIENT.split('useEffect(').slice(1)) {
      // The effect body runs up to its dependency array (`, [` — e.g. `}, [messages]` or `, [])`).
      const head = effect.slice(0, effect.indexOf(', ['));
      expect(head).not.toMatch(/resume\(|runTurn\(|send\(/);
    }
  });

  it('resume re-sends the pending turn with ITS OWN turnId and content — no new id is minted', () => {
    const resume = body(CLIENT, 'async function resume()', 'async function runTurn(');
    expect(resume).toContain('turnId: turn.turnId');
    expect(resume).toContain('content: turn.content');
    expect(resume).not.toContain('randomUUID');
  });

  it('a new message is refused while a turn is pending (the server answers turns in order)', () => {
    const send = body(CLIENT, 'async function send(', 'async function resume()');
    expect(send).toMatch(/if \(!trimmed \|\| streaming \|\| pending\) return;/);
  });

  it('the send body is exactly the persisted turn identity — no client-supplied history', () => {
    expect(CLIENT).toContain('JSON.stringify({ message: t.content, conversationId: t.conversationId, turnId: t.turnId })');
    // (window.history.replaceState is URL handling, not a prompt-history payload.)
    expect(CLIENT).not.toMatch(/\bhistory\s*[,}:]/);
  });
});

describe('Ops Chat client wiring — confirm is proposalId-authoritative', () => {
  it('confirm/cancel send only { proposalId, intent }', () => {
    const act = body(CLIENT, 'async function act(', 'function setCouncil(');
    expect(act).toContain("fetch('/api/ops-chat/confirm'");
    expect(act).toContain('JSON.stringify({ proposalId: card.proposalId, intent })');
    expect(act).toContain('isActionable(card)');
    expect(CLIENT).not.toContain('confirmBody');
  });

  it('a network failure mid-confirm disables the card (unrecorded) rather than allowing a blind retry', () => {
    const act = body(CLIENT, 'async function act(', 'function setCouncil(');
    expect(act).toMatch(/catch \{[\s\S]*state: 'unrecorded'/);
  });
});

describe('Ops Chat page — loads the conversation and its pending turn from the store', () => {
  it('uses the persisted store, never client-only state', () => {
    expect(PAGE).toContain('loadConversation(');
    expect(PAGE).toContain('earliestUnansweredOwnerTurn(');
    expect(PAGE).toContain('mostRecentConversationId(');
    expect(PAGE).toMatch(/pendingTurn=\{pendingTurn\}/);
  });
});
