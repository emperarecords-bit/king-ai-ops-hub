'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { sendChatMessageAction, type ChatFormState } from '../chat/actions';
import { primeSpeech, speak, stopSpeaking, useSpeechInput } from '../chat/use-speech';

interface Entry {
  id: string;
  role: 'owner' | 'employee';
  content: string;
  at: string;
}

type Phase = 'idle' | 'listening' | 'sending' | 'waiting' | 'speaking';

/**
 * Voice Mode — a phone-first conversation with an employee. Tap once: speak; pausing sends;
 * the reply is spoken automatically (speech unlocked by the tap); then it listens again.
 * A hands-free loop until Stop. The keyboard chat remains one tap away.
 */
export function TalkClient({
  projectKey,
  agentId,
  agentName,
  entries,
  awaitingReply,
}: {
  projectKey: string;
  agentId: string;
  agentName: string;
  entries: Entry[];
  awaitingReply: boolean;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('idle');
  const [conversationOn, setConversationOn] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const bufferRef = useRef<string>('');
  const spokenTailRef = useRef<string | null>(null);
  const phaseRef = useRef<Phase>('idle');
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const sendBuffered = useCallback(async () => {
    const text = bufferRef.current.trim();
    bufferRef.current = '';
    if (!text) {
      setPhase('idle');
      return;
    }
    setPhase('sending');
    const form = new FormData();
    form.set('projectKey', projectKey);
    form.set('agentId', agentId);
    form.set('content', text);
    const prev: ChatFormState = { error: null, sentAt: null };
    try {
      const result = await sendChatMessageAction(prev, form);
      if (result.error) {
        setLastError(result.error);
        setPhase('idle');
        return;
      }
      setPhase('waiting');
      router.refresh();
    } catch {
      setLastError('Could not send. Tap and try again.');
      setPhase('idle');
    }
  }, [projectKey, agentId, router]);

  const speech = useSpeechInput(
    (text) => {
      bufferRef.current = bufferRef.current ? `${bufferRef.current} ${text}` : text;
    },
    useMemo(
      () => ({
        continuous: false,
        onAutoEnd: () => {
          if (phaseRef.current === 'listening') void sendBuffered();
        },
      }),
      [sendBuffered],
    ),
  );

  // Poll while a reply is composing.
  useEffect(() => {
    if (phase !== 'waiting') return;
    const timer = setInterval(() => router.refresh(), 3500);
    return () => clearInterval(timer);
  }, [phase, router]);

  // Arm on the current tail so history is never read back.
  useEffect(() => {
    if (spokenTailRef.current !== null) return;
    const tail = [...entries].reverse().find((e) => e.role === 'employee');
    spokenTailRef.current = tail?.id ?? 'none';
  }, [entries]);

  // A NEW employee reply while waiting: speak it, then (in conversation mode) listen again.
  useEffect(() => {
    if (phase !== 'waiting' || awaitingReply) return;
    const tail = [...entries].reverse().find((e) => e.role === 'employee');
    if (!tail || tail.id === spokenTailRef.current) return;
    spokenTailRef.current = tail.id;
    setPhase('speaking');
    speak(tail.content, () => {
      if (conversationOn) {
        setPhase('listening');
        speech.start();
      } else {
        setPhase('idle');
      }
    });
  }, [entries, awaitingReply, phase, conversationOn, speech]);

  const begin = useCallback(() => {
    setLastError(null);
    primeSpeech(); // the tap that unlocks spoken replies on mobile
    setConversationOn(true);
    setPhase('listening');
    speech.start();
  }, [speech]);

  const end = useCallback(() => {
    setConversationOn(false);
    speech.stop();
    stopSpeaking();
    bufferRef.current = '';
    setPhase('idle');
  }, [speech]);

  const lastFew = entries.slice(-4);

  return (
    <div className="flex min-h-[70vh] flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto pb-4">
        {lastFew.map((e) => (
          <div key={e.id} className={e.role === 'owner' ? 'flex justify-end' : 'flex justify-start'}>
            <div
              className={`max-w-[88%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed ${
                e.role === 'owner' ? 'bg-[var(--accent-soft,rgba(120,160,255,0.12))]' : 'border border-[var(--border)]'
              }`}
            >
              {e.content}
            </div>
          </div>
        ))}
        {phase === 'waiting' && (
          <div className="flex justify-start">
            <div className="rounded-2xl border border-dashed border-[var(--border)] px-4 py-2.5 text-[15px] opacity-60">
              {agentName} is thinking…
            </div>
          </div>
        )}
      </div>

      {speech.interim ? <p className="pb-2 text-center text-sm italic opacity-60">{speech.interim}…</p> : null}
      {(lastError ?? speech.error) ? (
        <p className="pb-2 text-center text-sm text-amber-400">{lastError ?? speech.error}</p>
      ) : null}

      <div className="flex flex-col items-center gap-3 pb-2">
        {phase === 'idle' && (
          <button
            type="button"
            onClick={begin}
            disabled={!speech.supported}
            className="flex h-24 w-24 items-center justify-center rounded-full bg-[var(--accent)] text-4xl text-[#0b0e14] shadow-lg active:scale-95 disabled:opacity-40"
            aria-label="Start talking"
          >
            🎤
          </button>
        )}
        {phase === 'listening' && (
          <button
            type="button"
            onClick={() => speech.stop()}
            className="flex h-24 w-24 animate-pulse items-center justify-center rounded-full border-4 border-[var(--danger,#c37474)] text-4xl"
            aria-label="Listening — tap to cancel"
          >
            ●
          </button>
        )}
        {(phase === 'sending' || phase === 'waiting') && (
          <div className="flex h-24 w-24 items-center justify-center rounded-full border-4 border-[var(--border)] text-3xl opacity-70">
            …
          </div>
        )}
        {phase === 'speaking' && (
          <button
            type="button"
            onClick={() => {
              stopSpeaking();
              if (conversationOn) {
                setPhase('listening');
                speech.start();
              } else setPhase('idle');
            }}
            className="flex h-24 w-24 items-center justify-center rounded-full border-4 border-[var(--success,#74c3a4)] text-4xl"
            aria-label="Speaking — tap to skip"
          >
            🔊
          </button>
        )}
        <p className="text-sm opacity-60">
          {phase === 'idle' && (speech.supported ? 'Tap to talk — pausing sends automatically' : 'Voice is not available in this browser')}
          {phase === 'listening' && 'Listening… pause when you finish'}
          {phase === 'sending' && 'Sending…'}
          {phase === 'waiting' && 'Waiting for the reply — it will be read aloud'}
          {phase === 'speaking' && 'Speaking — tap to skip'}
        </p>
        {conversationOn && phase !== 'idle' ? (
          <button type="button" onClick={end} className="rounded-full border border-[var(--border)] px-5 py-2 text-sm opacity-80 hover:opacity-100">
            End conversation
          </button>
        ) : null}
        <Link href={`/p/${projectKey}/agents/${agentId}/chat`} className="text-sm underline opacity-60 hover:opacity-100">
          ⌨️ Switch to keyboard chat
        </Link>
      </div>
    </div>
  );
}
