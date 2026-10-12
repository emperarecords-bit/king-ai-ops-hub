/**
 * Ops Chat client watchdog — framework-free so it is unit-tested in node.
 *
 * A Send must NEVER leave the UI stuck on "Thinking…". The browser normally receives a clean server timeout
 * error first; this watchdog is the backstop that fires `onFire` (which aborts the fetch and surfaces a
 * retryable timeout) at the deadline. A plain `setTimeout` is THROTTLED in a backgrounded tab, so the timer
 * alone can fire far too late — therefore the watchdog ALSO exposes `checkNow()`, which the component calls on
 * `visibilitychange`: the instant the tab becomes visible again it compares the wall-clock `now()` against a
 * fixed `deadlineAt` and fires immediately if the deadline has passed. Either path fires `onFire` at most once.
 */
export interface DeadlineWatchdog {
  /** Absolute wall-clock time (ms) at which the request is considered timed out. */
  readonly deadlineAt: number;
  /** Arm the setTimeout (fires on time when the tab is foregrounded). */
  start(): void;
  /** Re-check against the wall clock — call on visibilitychange; fires if the deadline has already passed. */
  checkNow(): void;
  /** Cancel the timer (on any exit path). Does not un-fire if already fired. */
  clear(): void;
  /** True once `onFire` has run. */
  readonly fired: boolean;
}

export function createDeadlineWatchdog(
  timeoutMs: number,
  onFire: () => void,
  now: () => number = Date.now,
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
  clearTimer: (t: ReturnType<typeof setTimeout>) => void = clearTimeout,
): DeadlineWatchdog {
  const deadlineAt = now() + timeoutMs;
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = (): void => {
    if (fired) return;
    fired = true;
    onFire();
  };
  return {
    deadlineAt,
    start() {
      // Guard against double-arm; the timer is the on-time path when foregrounded.
      if (timer === undefined && !fired) timer = setTimer(fire, timeoutMs);
    },
    checkNow() {
      if (!fired && now() >= deadlineAt) fire();
    },
    clear() {
      if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
      }
    },
    get fired() {
      return fired;
    },
  };
}
