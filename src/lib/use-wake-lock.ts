'use client';

import { useEffect } from 'react';

/**
 * Keep the screen on while hands-free voice is running (owner feedback 2026-10-23: on a phone, when the screen
 * turned off the page was suspended and Talk stopped listening). Uses the Screen Wake Lock API where the browser has
 * it (Chrome, Edge, Safari 16.4+); elsewhere it does nothing. The browser drops the lock whenever the tab is hidden,
 * so it is re-requested when the tab is visible again, and released as soon as Talk stops.
 */

interface SentinelLike {
  release(): Promise<void>;
  addEventListener(type: 'release', fn: () => void): void;
}
export interface WakeLockNavigator {
  wakeLock?: { request(type: 'screen'): Promise<SentinelLike> };
}
export interface VisibilityDocument {
  visibilityState: string;
  addEventListener(type: 'visibilitychange', fn: () => void): void;
  removeEventListener(type: 'visibilitychange', fn: () => void): void;
}

/** Hold the screen awake until the returned function is called. Never throws; no-op without the API. */
export function holdScreenAwake(nav: WakeLockNavigator, doc: VisibilityDocument): () => void {
  if (!nav.wakeLock) return () => {};
  let lock: SentinelLike | null = null;
  let stopped = false;
  let pending = false;
  const acquire = async (): Promise<void> => {
    if (stopped || lock || pending || doc.visibilityState !== 'visible') return;
    pending = true;
    try {
      const l = await nav.wakeLock!.request('screen');
      if (stopped) {
        void l.release().catch(() => {});
        return;
      }
      lock = l;
      l.addEventListener('release', () => {
        if (lock === l) lock = null;
      });
    } catch {
      /* denied (e.g. battery saver) — Talk still works, the screen just may turn off */
    } finally {
      pending = false;
    }
  };
  const onVisible = (): void => {
    if (doc.visibilityState === 'visible') void acquire();
  };
  void acquire();
  doc.addEventListener('visibilitychange', onVisible);
  return () => {
    stopped = true;
    doc.removeEventListener('visibilitychange', onVisible);
    const l = lock;
    lock = null;
    void l?.release().catch(() => {});
  };
}

/** React hook: keep the screen awake while `active` is true. */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof navigator === 'undefined' || typeof document === 'undefined') return;
    return holdScreenAwake(navigator as unknown as WakeLockNavigator, document);
  }, [active]);
}
