import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendDictation, CARD_PROMPT, keepListeningAfterReply, spokenReply } from '@/app/ops/ops-chat-voice';

/**
 * Ops Chat voice (owner request 2026-10-22). Dictate fills the box; Talk is hands-free. Voice NEVER confirms a card:
 * a reply carrying a card is read with a pointer to it and the hands-free loop stops.
 */

describe('voice rules', () => {
  it('dictation appends to the box with one space', () => {
    expect(appendDictation('', ' server cooling ')).toBe('server cooling');
    expect(appendDictation('what about', 'server cooling')).toBe('what about server cooling');
    expect(appendDictation('what about ', 'server cooling')).toBe('what about server cooling');
    expect(appendDictation('keep this', '   ')).toBe('keep this');
  });

  it('a reply with a card is read with a pointer to it; no card → just the reply', () => {
    expect(spokenReply('Here is the update card.', 1)).toBe(`Here is the update card.\n\n${CARD_PROMPT}`);
    expect(spokenReply('', 2)).toBe(CARD_PROMPT);
    expect(spokenReply('All three tasks are done.', 0)).toBe('All three tasks are done.');
    expect(CARD_PROMPT).toMatch(/won't do anything until you tap Confirm/);
  });

  it('hands-free keeps listening only when on, the reply succeeded, and nothing awaits a tap', () => {
    expect(keepListeningAfterReply({ handsFree: true, replyOk: true, cardCount: 0 })).toBe(true);
    expect(keepListeningAfterReply({ handsFree: true, replyOk: true, cardCount: 1 })).toBe(false);
    expect(keepListeningAfterReply({ handsFree: true, replyOk: false, cardCount: 0 })).toBe(false);
    expect(keepListeningAfterReply({ handsFree: false, replyOk: true, cardCount: 0 })).toBe(false);
  });
});

describe('Ops Chat client — voice wiring', () => {
  const CLIENT = readFileSync(join(process.cwd(), 'src/app/ops/ops-chat-client.tsx'), 'utf8').replace(/\r\n/g, '\n');
  const voice = CLIENT.slice(CLIENT.indexOf('// Voice (owner request 2026-10-22'), CLIENT.indexOf('  /** Called once a turn ends.'));
  const after = CLIENT.slice(CLIENT.indexOf('  function afterReply('), CLIENT.indexOf('  function afterReply(') + 900);

  it('voice can only SEND a message (by pressing the form Send) — it never confirms or cancels a card', () => {
    expect(voice).toContain('formRef.current?.requestSubmit()');
    for (const src of [voice, after]) {
      expect(src).not.toMatch(/\/api\/ops-chat\/confirm|confirmCard|intent:/);
    }
  });

  it('voice runs on-device: it uses the shared browser speech hook, never an audio upload', () => {
    expect(CLIENT).toContain("from '@/lib/use-speech'");
    expect(CLIENT).not.toMatch(/MediaRecorder|getUserMedia|audio\/webm/);
  });
});
