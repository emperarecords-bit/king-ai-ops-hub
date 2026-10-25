/**
 * Ops Chat voice (owner request 2026-10-22: "why don't I have a voice chat"). Pure rules for the two voice modes,
 * kept out of the component so they are unit-tested:
 *
 *  - DICTATE (🎤): speech becomes text in the message box; the owner still reviews and presses Send.
 *  - TALK (hands-free): a pause sends what was said, the reply is read aloud, then it listens again — until Stop.
 *
 * SAFETY: voice never confirms anything. A reply that carries a card (a proposed action that spends money or
 * changes something) is read with a pointer to the card and the hands-free loop STOPS there: Confirm / Cancel stay
 * explicit taps. Speech recognition and playback run in the browser (see @/lib/use-speech); the Hub only ever
 * receives the text the owner sends.
 */

/** Append dictated text to whatever is already in the message box, with one space between. */
export function appendDictation(current: string, spoken: string): string {
  const s = spoken.trim();
  if (!s) return current;
  if (!current.trim()) return s;
  return /\s$/.test(current) ? `${current}${s}` : `${current} ${s}`;
}

export const CARD_PROMPT =
  "There's a card on screen for you to confirm. I won't do anything until you tap Confirm. Hands-free is paused.";

/** What is read aloud for a finished reply: the reply, plus a pointer to any card waiting for a tap. */
export function spokenReply(content: string, cardCount: number): string {
  const text = content.trim();
  if (cardCount <= 0) return text || 'Done.';
  return text ? `${text}\n\n${CARD_PROMPT}` : CARD_PROMPT;
}

/** After a reply has been read aloud, keep listening only while hands-free is on and nothing awaits a tap. */
export function keepListeningAfterReply(o: { handsFree: boolean; cardCount: number; replyOk: boolean }): boolean {
  return o.handsFree && o.replyOk && o.cardCount === 0;
}
