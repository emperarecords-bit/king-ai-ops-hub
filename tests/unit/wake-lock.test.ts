import { describe, expect, it, vi } from 'vitest';
import { holdScreenAwake, type VisibilityDocument, type WakeLockNavigator } from '@/lib/use-wake-lock';

/**
 * Owner feedback 2026-10-23: on the phone, Talk stopped when the screen turned off (the page was suspended). Talk now
 * holds a screen wake lock while it runs, re-takes it when the tab is visible again, and releases it on Stop.
 */

function fakes() {
  const listeners: Array<() => void> = [];
  const sentinels: Array<{ release: ReturnType<typeof vi.fn>; fireRelease: () => void }> = [];
  const request = vi.fn(async () => {
    const onRelease: Array<() => void> = [];
    const s = {
      release: vi.fn(async () => {}),
      addEventListener: (_t: 'release', fn: () => void) => onRelease.push(fn),
      fireRelease: () => onRelease.forEach((f) => f()),
    };
    sentinels.push(s);
    return s;
  });
  const nav: WakeLockNavigator = { wakeLock: { request } };
  const doc: VisibilityDocument & { visibilityState: string } = {
    visibilityState: 'visible',
    addEventListener: (_t, fn) => listeners.push(fn),
    removeEventListener: (_t, fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  return { nav, doc, request, sentinels, listeners };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('holdScreenAwake', () => {
  it('takes a screen lock while held and releases it on stop', async () => {
    const { nav, doc, request, sentinels, listeners } = fakes();
    const stop = holdScreenAwake(nav, doc);
    await tick();
    expect(request).toHaveBeenCalledWith('screen');
    stop();
    expect(sentinels[0]!.release).toHaveBeenCalled();
    expect(listeners).toHaveLength(0);
  });

  it('the browser drops the lock when hidden; it is taken again when the tab is visible', async () => {
    const { nav, doc, request, sentinels, listeners } = fakes();
    const stop = holdScreenAwake(nav, doc);
    await tick();
    doc.visibilityState = 'hidden';
    sentinels[0]!.fireRelease(); // what the browser does on hide
    doc.visibilityState = 'visible';
    listeners.forEach((f) => f());
    await tick();
    expect(request).toHaveBeenCalledTimes(2);
    stop();
  });

  it('does nothing where the API is missing, and never throws when the request is denied', async () => {
    const doc = fakes().doc;
    expect(() => holdScreenAwake({}, doc)()).not.toThrow();
    const denied: WakeLockNavigator = { wakeLock: { request: vi.fn(async () => Promise.reject(new Error('NotAllowedError'))) } };
    const stop = holdScreenAwake(denied, doc);
    await tick();
    expect(() => stop()).not.toThrow();
  });

  it('a lock that arrives after Stop is released at once', async () => {
    const { nav, doc, sentinels } = fakes();
    const stop = holdScreenAwake(nav, doc);
    stop(); // before the request resolves
    await tick();
    expect(sentinels[0]!.release).toHaveBeenCalled();
  });
});
