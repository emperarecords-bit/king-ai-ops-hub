import { describe, expect, it } from 'vitest';
import { classifyNotification, isOpsChatRunCompletion, OPS_CHAT_RUN_COMPLETED } from '@/domain/notifications/severity';
import { opsChatLinkLine, opsChatLinkTarget, type OpsChatRunLink } from '@/domain/notifications/ops-chat-link';
import { cardIdFromHash } from '@/app/ops/ops-chat-transcript';

/**
 * P5b-1 — the completion of a run the owner started from an Ops Chat card reaches them by email, with a link back.
 * Pure halves: routing policy, the deep-link privacy rule, and the card anchor. DB/worker/router proofs:
 * tests/integration/opschat-run-notification.test.ts.
 */

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CONV = '33333333-3333-4333-8333-333333333333';
const CARD = '44444444-4444-4444-8444-444444444444';
const link = (over: Partial<OpsChatRunLink> = {}): OpsChatRunLink => ({
  proposalId: CARD,
  conversationId: CONV,
  cardOwnerUserId: OWNER,
  taskPath: '/p/hvac/tasks/55555555-5555-4555-8555-555555555555',
  ...over,
});

describe('classifyNotification — Ops Chat-linked runs', () => {
  it('a linked COMPLETION is emailed (immediate) but stays success severity (so quiet hours and the opt-out apply)', () => {
    expect(classifyNotification('run_completed', { opsChatLinked: true })).toEqual({ severity: 'success', routing: 'immediate' });
    expect(OPS_CHAT_RUN_COMPLETED).toEqual({ severity: 'success', routing: 'immediate' });
  });

  it('unlinked completions are unchanged (in-app only); failures stay critical + immediate either way', () => {
    expect(classifyNotification('run_completed')).toEqual({ severity: 'success', routing: 'in_app_only' });
    expect(classifyNotification('run_completed', { opsChatLinked: false })).toEqual({ severity: 'success', routing: 'in_app_only' });
    expect(classifyNotification('run_failed', { opsChatLinked: true })).toEqual({ severity: 'critical', routing: 'immediate' });
    expect(classifyNotification('approval_pending', { opsChatLinked: true })).toEqual({ severity: 'action_required', routing: 'immediate' });
  });

  it('isOpsChatRunCompletion recognizes exactly success + immediate', () => {
    expect(isOpsChatRunCompletion({ severity: 'success', routing: 'immediate' })).toBe(true);
    expect(isOpsChatRunCompletion({ severity: 'success' })).toBe(true); // the router's pending list carries severity only
    expect(isOpsChatRunCompletion({ severity: 'critical' })).toBe(false);
    expect(isOpsChatRunCompletion({ severity: 'action_required' })).toBe(false);
    expect(isOpsChatRunCompletion({ severity: 'success', routing: 'in_app_only' })).toBe(false);
  });
});

describe('opsChatLinkTarget — the card deep link only for the card owner', () => {
  it('recipient IS the card owner → /ops?c=<conversation>#card-<proposal>', () => {
    expect(opsChatLinkTarget(link(), OWNER)).toEqual({ kind: 'card', path: `/ops?c=${CONV}#card-${CARD}` });
  });

  it('recipient is NOT the card owner → task link; the conversation id never appears', () => {
    const t = opsChatLinkTarget(link(), OTHER);
    expect(t).toEqual({ kind: 'task', path: '/p/hvac/tasks/55555555-5555-4555-8555-555555555555' });
    expect(opsChatLinkLine(link(), OTHER, 'https://hub.example.com')).not.toContain(CONV);
  });

  it('card not readable at finalize (no conversation / no owner) → task link', () => {
    expect(opsChatLinkTarget(link({ conversationId: null }), OWNER).kind).toBe('task');
    expect(opsChatLinkTarget(link({ cardOwnerUserId: null }), OWNER).kind).toBe('task');
  });

  it('absolute on a valid http(s) APP_URL (origin only); the path alone otherwise', () => {
    expect(opsChatLinkLine(link(), OWNER, 'https://hub.example.com/some/path')).toBe(`Open it in Ops Chat: https://hub.example.com/ops?c=${CONV}#card-${CARD}`);
    expect(opsChatLinkLine(link(), OTHER, 'https://hub.example.com')).toBe('Open the task: https://hub.example.com/p/hvac/tasks/55555555-5555-4555-8555-555555555555');
    expect(opsChatLinkLine(link(), OWNER, undefined)).toBe(`Open it in Ops Chat: /ops?c=${CONV}#card-${CARD}`);
    expect(opsChatLinkLine(link(), OWNER, 'not a url')).toBe(`Open it in Ops Chat: /ops?c=${CONV}#card-${CARD}`);
    expect(opsChatLinkLine(link(), OWNER, 'javascript:alert(1)')).toBe(`Open it in Ops Chat: /ops?c=${CONV}#card-${CARD}`);
  });
});

describe('cardIdFromHash — the Ops Chat anchor a notification lands on', () => {
  it('accepts exactly #card-<uuid>', () => {
    expect(cardIdFromHash(`#card-${CARD}`)).toBe(CARD);
    expect(cardIdFromHash(`#card-${CARD.toUpperCase()}`)).toBe(CARD);
    expect(cardIdFromHash('')).toBeNull();
    expect(cardIdFromHash('#card-')).toBeNull();
    expect(cardIdFromHash(`#card-${CARD}x`)).toBeNull();
    expect(cardIdFromHash('#card-"><img src=x>')).toBeNull();
  });
});
