'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Voice for Employee Chat, entirely on-device: SpeechRecognition (mic -> text) and
 * speechSynthesis (text -> voice). No audio ever leaves the browser through the hub —
 * transcription happens in the phone/browser engine, and the hub only ever sees the
 * final TEXT the owner chooses to send.
 */

interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionResultEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  start(): void;
  stop(): void;
}

type RecognitionCtor = new () => RecognitionLike;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Human-facing explanation for a recognition failure — silence taught us nothing. */
function explainError(code: string | undefined): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access is blocked. Click the icon just left of the web address (a padlock or two small sliders), set Microphone to Allow (it may be under "Site settings"), then reload this page. Or open chrome://settings/content/microphone and remove this site from "Not allowed".';
    case 'audio-capture':
      return 'No microphone was found. Plug one in or pick an input device in your system sound settings, then try again.';
    case 'network':
      return 'The speech service is unreachable. Voice input needs an internet connection (the browser transcribes via its online speech service).';
    case 'no-speech':
      return 'No speech was detected — tap the mic and try again.';
    case 'aborted':
      return '';
    default:
      return `Voice input failed${code ? ` (${code})` : ''}. Try again, or check the microphone permission in the address bar.`;
  }
}

export interface SpeechInputOptions {
  /** false = recognition auto-ends when the speaker pauses (Voice Mode's send trigger). */
  continuous?: boolean;
  /** Fired when recognition ends on its own (not via stop()) — Voice Mode auto-sends here. */
  onAutoEnd?: () => void;
}

export function useSpeechInput(onFinalText: (text: string) => void, options: SpeechInputOptions = {}) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<RecognitionLike | null>(null);
  const manualStopRef = useRef(false);
  const onFinalRef = useRef(onFinalText);
  const onAutoEndRef = useRef(options.onAutoEnd);
  useEffect(() => {
    onFinalRef.current = onFinalText;
    onAutoEndRef.current = options.onAutoEnd;
  }, [onFinalText, options.onAutoEnd]);

  useEffect(() => {
    // Deferred detection: SSR renders unsupported, the client corrects after mount.
    const timer = setTimeout(() => setSupported(recognitionCtor() != null), 0);
    return () => {
      clearTimeout(timer);
      recRef.current?.stop();
    };
  }, []);

  const stop = useCallback(() => {
    manualStopRef.current = true;
    recRef.current?.stop();
    recRef.current = null;
    setListening(false);
    setInterim('');
  }, []);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor || recRef.current) return;
    setError(null);
    manualStopRef.current = false;
    const rec = new Ctor();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = options.continuous !== false;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let interimText = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        if (r.isFinal) onFinalRef.current(r[0].transcript.trim());
        else interimText += r[0].transcript;
      }
      setInterim(interimText);
    };
    rec.onend = () => {
      const wasManual = manualStopRef.current;
      recRef.current = null;
      setListening(false);
      setInterim('');
      if (!wasManual) onAutoEndRef.current?.();
    };
    rec.onerror = (e) => {
      recRef.current = null;
      setListening(false);
      setInterim('');
      const message = explainError(e?.error);
      if (message) setError(message);
    };
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      recRef.current = null;
      setError('Voice input could not start. Reload the page and try again.');
    }
  }, [options.continuous]);

  const toggle = useCallback(() => (listening ? stop() : start()), [listening, start, stop]);
  return { supported, listening, interim, error, toggle, start, stop };
}

/**
 * Unlock speech output from a user gesture. Mobile browsers only allow speech that starts from a
 * tap — priming with an empty utterance inside the tap handler lets LATER, programmatic speech
 * (an arriving reply) play out loud.
 */
export function primeSpeech(): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  window.speechSynthesis.speak(u);
}

/** Read one message aloud (cancels anything already speaking). Light cleanup of markdown noise. */
export function speak(text: string, onDone?: () => void): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    onDone?.();
    return;
  }
  window.speechSynthesis.cancel();
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' Code block omitted. ')
    .replace(/[#*_`>|-]{2,}/g, ' ')
    .replace(/[#*_`]/g, '')
    .slice(0, 4000);
  const utterance = new SpeechSynthesisUtterance(cleaned);
  utterance.rate = 1.05;
  if (onDone) {
    utterance.onend = () => onDone();
    utterance.onerror = () => onDone();
  }
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
}

export function speechOutputSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}
