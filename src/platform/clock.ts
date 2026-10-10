// Time, injected wherever a module measures or waits, so a test harness can
// supply a clock it advances.

export interface Clock {
  /** Monotonic milliseconds (performance.now): watchdogs, cooldowns, debounces, event times. */
  now(): number;
  /** Wall-clock milliseconds (Date.now), which keeps counting across a suspension of the page. */
  wallNow(): number;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

/**
 * The page's clock. It calls the window's timers, never the bare globals,
 * whose return type the node test project's typings widen to NodeJS.Timeout.
 */
export function createBrowserClock(win: Pick<Window, 'setTimeout' | 'clearTimeout' | 'performance'>): Clock {
  return {
    now: () => win.performance.now(),
    wallNow: () => Date.now(),
    setTimeout: (callback, ms) => win.setTimeout(callback, ms),
    clearTimeout: (handle) => win.clearTimeout(handle),
  };
}
