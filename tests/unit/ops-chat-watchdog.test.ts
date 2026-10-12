import { describe, expect, it, vi } from 'vitest';
import { createDeadlineWatchdog } from '@/app/ops/ops-chat-watchdog';

/**
 * Ops Chat client watchdog — the backstop that guarantees the UI never hangs on "Thinking…". A plain setTimeout
 * is throttled in a backgrounded tab, so the watchdog also exposes checkNow() (called on visibilitychange) which
 * fires against the wall clock. These tests inject now/setTimer/clearTimer for determinism.
 */

function harness(timeoutMs: number, startNow = 1_000_000) {
  let now = startNow;
  let timerCb: (() => void) | null = null;
  const fired = vi.fn();
  const setTimer = vi.fn((fn: () => void) => { timerCb = fn; return 1 as unknown as ReturnType<typeof setTimeout>; });
  const clearTimer = vi.fn();
  const wd = createDeadlineWatchdog(timeoutMs, fired, () => now, setTimer, clearTimer);
  return { wd, fired, setTimer, clearTimer, fireTimer: () => timerCb?.(), advance: (ms: number) => { now += ms; }, hasTimer: () => timerCb !== null };
}

describe('createDeadlineWatchdog', () => {
  it('deadlineAt is now + timeoutMs', () => {
    const { wd } = harness(188_000, 5_000);
    expect(wd.deadlineAt).toBe(5_000 + 188_000);
  });

  it('the timer path fires onFire once (the on-time, foregrounded case)', () => {
    const { wd, fired, fireTimer } = harness(188_000);
    wd.start();
    expect(fired).not.toHaveBeenCalled();
    fireTimer();
    expect(fired).toHaveBeenCalledTimes(1);
    expect(wd.fired).toBe(true);
  });

  it('checkNow fires when the wall clock has passed the deadline (backgrounded→foregrounded)', () => {
    const { wd, fired, advance } = harness(188_000);
    wd.start();
    wd.checkNow(); // before deadline
    expect(fired).not.toHaveBeenCalled();
    advance(188_001); // deadline passed while the tab was hidden (timer throttled, never fired)
    wd.checkNow(); // visibilitychange → visible
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('never double-fires: a throttled timer firing AFTER checkNow already fired is a no-op', () => {
    const { wd, fired, advance, fireTimer } = harness(188_000);
    wd.start();
    advance(200_000);
    wd.checkNow(); // fires
    fireTimer(); // the throttled timer finally fires later — must not fire onFire again
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('clear() cancels the pending timer', () => {
    const { wd, clearTimer } = harness(188_000);
    wd.start();
    wd.clear();
    expect(clearTimer).toHaveBeenCalledTimes(1);
  });

  it('checkNow after clear (not yet fired) still fires if the deadline passed (clear only cancels the timer)', () => {
    const { wd, fired, advance } = harness(188_000);
    wd.start();
    wd.clear();
    advance(200_000);
    wd.checkNow();
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('start() is idempotent — arming twice schedules only one timer', () => {
    const { wd, setTimer } = harness(188_000);
    wd.start();
    wd.start();
    expect(setTimer).toHaveBeenCalledTimes(1);
  });
});
