// The page operations a scenario uses, independent of the protocol behind
// them. Chrome implements them over the DevTools Protocol (chrome.ts); a
// WebDriver backend for Safari would implement the same interfaces.

import type { z } from '../../../src/core/zod.ts';

/** A value that crosses into the page as an argument. */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

export type ConsoleLevel = 'error' | 'warning' | 'info' | 'verbose';

/** A console message, a browser log entry, or an uncaught exception, from the page or any worker under it. */
export type ConsoleEntry = {
  /** `console` is a console API call, `log` a message the browser logged (a failed load, a CSP refusal), `exception` an uncaught exception. */
  readonly channel: 'console' | 'log' | 'exception';
  readonly level: ConsoleLevel;
  /** The browser's source for `log` entries (`network`, `security`, `javascript`, ...); `console-api` or `exception` otherwise. */
  readonly source: string;
  readonly text: string;
  /** The resource the entry is about, when the browser names one. */
  readonly url: string | null;
  /** The script that emitted it: the top stack frame's URL, when known. */
  readonly scriptUrl: string | null;
  readonly context: 'page' | 'worker';
  readonly at: string;
};

export type RequestEntry = {
  readonly url: string;
  readonly method: string;
  readonly resourceType: string | null;
  readonly context: 'page' | 'worker';
  /** The response status, or null when none arrived. */
  readonly status: number | null;
  /** The browser's error text when the request failed. */
  readonly failed: string | null;
};

/** A worker target attached under the page: a dedicated worker, or a worker such a worker started. */
export type WorkerTarget = {
  /** The browser's target type, such as `worker`. */
  readonly type: string;
  readonly url: string;
  /** The browser's title for the target; for a dedicated worker, the name it was given, or its URL when it has none. */
  readonly title: string;
};

export type EmulateOptions = {
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
  readonly mobile: boolean;
  readonly colorScheme: 'light' | 'dark';
};

/**
 * What an intercepted request gets: `hold` leaves it unanswered while the
 * rule stands, `fail` fails it as a network error, and `respond` answers it
 * with `status` and a plain-text `body` without it reaching the server.
 */
export type InterceptAction = { readonly kind: 'hold' } | { readonly kind: 'fail' } | { readonly kind: 'respond'; readonly status: number; readonly body: string };

/** A request of `method` to exactly `path` (no query) on the server's origin. */
export type InterceptRule = { readonly method: 'GET' | 'POST'; readonly path: `/${string}`; readonly action: InterceptAction };

export type WaitOptions = { readonly timeoutMs?: number; readonly intervalMs?: number };

/**
 * A console message, log entry, or exception provoked on purpose, such as the
 * error the browser logs for a fault's 500. An entry matching every given
 * field is recorded as expected and fails nothing.
 */
export type MessagePattern = {
  readonly because: string;
  readonly channel?: ConsoleEntry['channel'];
  readonly source?: string;
  readonly level?: ConsoleLevel;
  readonly text?: RegExp;
  readonly url?: RegExp;
};

/** What every operation but `reopen` rejects with once `crash` has crashed the page. */
export const CRASHED_PAGE = 'the page crashed; call reopen';

export type BrowserPage = {
  /** Navigates to `path`, resolved against the server's base URL, and waits for the load event. */
  goto(path: string): Promise<void>;
  /** Reloads and waits for the load event. */
  reload(): Promise<void>;
  /**
   * Runs `fn` in the page with `args` and parses what it returns (or resolves
   * to) with `schema`. `fn` is sent as source text, so it must not close over
   * anything outside itself.
   */
  evaluate<T, A extends readonly Json[]>(schema: z.ZodType<T>, fn: (...args: A) => unknown, ...args: A): Promise<T>;
  /**
   * Runs `fn` in the page every `intervalMs` (default 100) until it returns
   * something other than null, undefined, or false, and parses that with
   * `schema`; rejects after `timeoutMs` (default 10000) naming `description`
   * and the last value.
   */
  waitFor<T>(description: string, schema: z.ZodType<T>, fn: () => unknown, options?: WaitOptions): Promise<T>;
  /** Clicks the centre of the first element matching `selector` with real mouse events. */
  click(selector: string): Promise<void>;
  /** Clicks the element to focus it, then types `text` one key event per character. */
  type(selector: string, text: string): Promise<void>;
  /** Presses one named key. */
  press(key: 'Enter' | 'Tab' | 'Escape' | 'Backspace'): Promise<void>;
  /** Sets a file input's files to these absolute paths. */
  setFiles(selector: string, files: readonly string[]): Promise<void>;
  /**
   * Sets the viewport (CSS pixels), its device scale factor, whether the
   * browser emulates a mobile device, and the emulated
   * `prefers-color-scheme`, for the rest of this scenario's page.
   */
  emulate(options: EmulateOptions): Promise<void>;
  /**
   * From now until the next call, answers the requests of the page and its
   * frames (not its workers) that match a rule as the rule says; every other
   * request goes on. Requests a rule held go on to the server when the rules
   * change. `[]` stops intercepting.
   */
  intercept(rules: readonly InterceptRule[]): Promise<void>;
  /**
   * `frozen` freezes the page as Chrome freezes a background tab: the page
   * is hidden first (`visibilitychange` to `hidden`), then its tasks stop;
   * it resolves once the page reads `hidden`, so its `visibilitychange`
   * listeners have run. `active` resumes it and shows it again
   * (`visibilitychange` to `visible`), and resolves once the page reads
   * `visible`.
   */
  lifecycle(state: 'frozen' | 'active'): Promise<void>;
  /**
   * Deletes the IndexedDB databases of the server's origin in this page's
   * browser context, as clearing a site's data does; Chrome force-closes
   * every open connection to them, firing `close` on each.
   */
  clearIndexedDb(): Promise<void>;
  /** Captures the viewport as `<scenario dir>/<name>.png` and returns that path. */
  screenshot(name: string): Promise<string>;
  /** Every console message, log entry, and exception so far in this scenario. */
  console(): readonly ConsoleEntry[];
  /** Every request so far in this scenario, the workers' included. */
  requests(): readonly RequestEntry[];
  /** The worker targets attached under the page now, nested workers included, in the order they attached; a worker leaves the list when the browser detaches it. */
  workers(): readonly WorkerTarget[];
  /**
   * Crashes the page's renderer (`Page.crash`) at once, mid-task on a busy
   * page, so the page gets no `pagehide`, and resolves once the browser
   * reports the crash, rejecting after 10 seconds. The page's own
   * diagnostics are not read before it, so the end-of-scenario check of
   * them does not cover the crashed page. The crash's own console entry is
   * declared here, so it fails no check. Every other operation then rejects
   * with CRASHED_PAGE until `reopen`; the record lists stay readable.
   */
  crash(): Promise<void>;
  /**
   * After a crash, closes the crashed page and opens a new one in the same
   * browser context, so it shares the dead page's storage; repeats the setup
   * the dead page had (the recorded domains, automatic attachment to its
   * workers, the viewport and color scheme `emulate` last set, and the
   * `intercept` rules standing); and navigates to `path`. The console,
   * request, and CSP records go on in the same lists, and `workers()` starts
   * empty. Rejects when the page has not crashed.
   */
  reopen(path: string): Promise<void>;
};

/** A CSP violation the page's own diagnostics logged, read through the dev test surface. */
export type DiagnosedViolation = { readonly url: string; readonly directive: string; readonly blocked: string; readonly disposition: string };

/**
 * A CSP violation the browser itself reported for the page or a worker under
 * it, enforced or report-only, whether or not the page has a test surface.
 */
export type BrowserCspViolation = {
  readonly context: 'page' | 'worker';
  readonly directive: string;
  /** The browser's kind of violation, such as kEvalViolation or kURLViolation. */
  readonly violation: string;
  readonly blocked: string | null;
  readonly reportOnly: boolean;
  readonly sourceUrl: string | null;
};

/** What the runner needs beyond the scenario's operations. */
export type DrivenPage = BrowserPage & {
  /**
   * The `csp.violation` events read from `window.__noisyTest.diagnostics()`
   * before each navigation and at the end, and how many page loads had the
   * test surface to read.
   */
  diagnosed(): { readonly violations: readonly DiagnosedViolation[]; readonly pagesRead: number };
  /** Every CSP violation the browser reported for this page and its workers so far. */
  cspViolations(): readonly BrowserCspViolation[];
  /** The console entries the page's own operations provoked on purpose, such as `crash`'s, declared as a scenario declares its own. */
  expectedMessages(): readonly MessagePattern[];
  /** Reads the current page's diagnostics, as goto and reload do before leaving it; gives up after a few seconds on a page that does not answer. */
  harvest(): Promise<void>;
  /** Closes the page's browser context; gives up after a few seconds when the browser does not answer. */
  close(): Promise<void>;
};

export type Browser = {
  readonly name: 'chrome';
  readonly version: string;
  readonly headless: boolean;
  /** Opens a page in a fresh browser context, so no storage is shared with another scenario. */
  openPage(options: { readonly baseUrl: string; readonly dir: string }): Promise<DrivenPage>;
  /** Why the browser can no longer be driven (it exited, or was stopped), or null while it can. */
  gone(): string | null;
  close(): Promise<void>;
};
