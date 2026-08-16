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
      return 'Microphone access is blocked. Click the padlock in the address bar, allow the Microphone, then reload this page.';
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

export function useSpeechInput(onFinalText: (text: string) => void) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<RecognitionLike | null>(null);
  const onFinalRef = useRef(onFinalText);
  useEffect(() => {
    onFinalRef.current = onFinalText;
  }, [onFinalText]);

  useEffect(() => {
    // Deferred detection: SSR renders unsupported, the client corrects after mount.
    const timer = setTimeout(() => setSupported(recognitionCtor() != null), 0);
    return () => {
      clearTimeout(timer);
      recRef.current?.stop();
    };
  }, []);

  const stop = useCallback(() => {
    recRef.current?.stop();
    recRef.current = null;
    setListening(false);
    setInterim('');
  }, []);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor || recRef.current) return;
    setError(null);
    const rec = new Ctor();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = true;
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
      recRef.current = null;
      setListening(false);
      setInterim('');
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
  }, []);

  const toggle = useCallback(() => (listening ? stop() : start()), [listening, start, stop]);
  return { supported, listening, interim, error, toggle, stop };
}

/** Read one message aloud (cancels anything already speaking). Light cleanup of markdown noise. */
export function speak(text: string): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' Code block omitted. ')
    .replace(/[#*_`>|-]{2,}/g, ' ')
    .replace(/[#*_`]/g, '')
    .slice(0, 4000);
  const utterance = new SpeechSynthesisUtterance(cleaned);
  utterance.rate = 1.05;
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
}

export function speechOutputSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}
