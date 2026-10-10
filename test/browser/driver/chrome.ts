// Chrome over the DevTools Protocol: launch with a fresh profile, one browser
// context and page per scenario, and the page operations of browser.ts.
// Every worker under the page (dedicated workers, and the workers those start)
// is attached too, paused at its start until its console, exceptions, and
// requests are being recorded.

import { spawn } from 'node:child_process';
import { closeSync, constants, openSync, rmSync } from 'node:fs';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { z } from '../../../src/core/zod.ts';
import { CRASHED_PAGE, type Browser, type BrowserCspViolation, type ConsoleEntry, type ConsoleLevel, type DiagnosedViolation, type DrivenPage, type EmulateOptions, type InterceptRule, type Json, type MessagePattern, type RequestEntry, type WaitOptions, type WorkerTarget } from './browser.ts';
import { connectPipe, type CdpConnection, type CdpEvent } from './cdp.ts';
import { EnvironmentError, killGroup, stopGroup, type Cleanup } from './processes.ts';

export const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWPORT = { width: 1280, height: 800 } as const;
const LOAD_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 20_000;
/** How long reading a page's diagnostics, or closing its browser context, may take before the driver gives up on it. */
const HOUSEKEEPING_TIMEOUT_MS = 5000;
/** How long `crash` waits for the browser to report the crash it asked for. */
const CRASH_TIMEOUT_MS = 10_000;
/** The console entry a renderer crash leaves, and the one a crash the scenario asked for leaves instead. */
const CRASH_TEXT = 'the renderer crashed';
const ASKED_CRASH_TEXT = 'the renderer crashed, as the scenario asked';
/** What declares the second, so only a crash the scenario asked for passes the console check. */
const ASKED_CRASH: MessagePattern = {
  because: 'the scenario crashed the renderer',
  channel: 'exception',
  source: 'crash',
  text: new RegExp(`^${ASKED_CRASH_TEXT}$`),
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Rejects after `ms` with `what` named, unless `promise` settles first. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function preview(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

// ---------------------------------------------------------------- replies and events

const VersionReply = z.object({ product: z.string(), userAgent: z.string() });
const ContextReply = z.object({ browserContextId: z.string() });
const TargetReply = z.object({ targetId: z.string() });
const SessionReply = z.object({ sessionId: z.string() });
const NavigateReply = z.object({ errorText: z.string().optional() });
const ScreenshotReply = z.object({ data: z.string() });
const RemoteObject = z.object({
  type: z.string(),
  subtype: z.string().optional(),
  value: z.unknown().optional(),
  description: z.string().optional(),
  objectId: z.string().optional(),
});
const StackTrace = z.object({ callFrames: z.array(z.object({ url: z.string() })) });
const ExceptionDetails = z.object({
  text: z.string(),
  url: z.string().optional(),
  stackTrace: StackTrace.optional(),
  exception: RemoteObject.optional(),
});
const EvaluateReply = z.object({ result: RemoteObject, exceptionDetails: ExceptionDetails.optional() });

const AttachedToTarget = z.object({
  sessionId: z.string(),
  targetInfo: z.object({ type: z.string(), url: z.string(), title: z.string() }),
  waitingForDebugger: z.boolean(),
});
const DetachedFromTarget = z.object({ sessionId: z.string() });
const RequestPaused = z.object({ requestId: z.string(), request: z.object({ url: z.string(), method: z.string() }) });
const ConsoleApiCalled = z.object({ type: z.string(), args: z.array(RemoteObject), stackTrace: StackTrace.optional() });
const ExceptionThrown = z.object({ exceptionDetails: ExceptionDetails });
const LogEntryAdded = z.object({
  entry: z.object({
    source: z.string(),
    level: z.enum(['verbose', 'info', 'warning', 'error']),
    text: z.string(),
    url: z.string().optional(),
    stackTrace: StackTrace.optional(),
  }),
});
const RequestWillBeSent = z.object({
  requestId: z.string(),
  request: z.object({ url: z.string(), method: z.string() }),
  type: z.string().optional(),
});
const ResponseReceived = z.object({ requestId: z.string(), response: z.object({ status: z.number() }) });
const LoadingFailed = z.object({ requestId: z.string(), errorText: z.string() });
const IssueAdded = z.object({
  issue: z.object({
    code: z.string(),
    details: z.object({
      contentSecurityPolicyIssueDetails: z
        .object({
          violatedDirective: z.string(),
          isReportOnly: z.boolean(),
          contentSecurityPolicyViolationType: z.string(),
          blockedURL: z.string().optional(),
          sourceCodeLocation: z.object({ url: z.string() }).optional(),
        })
        .optional(),
    }),
  }),
});

const Located = z.union([z.object({ x: z.number(), y: z.number() }), z.object({ error: z.string() })]);
const Harvest = z.object({
  url: z.string(),
  surface: z.boolean(),
  violations: z.array(z.object({ directive: z.string(), blocked: z.string(), disposition: z.string() })),
});

function consoleLevel(type: string): ConsoleLevel {
  switch (type) {
    case 'error':
    case 'assert':
      return 'error';
    case 'warning':
      return 'warning';
    case 'debug':
      return 'verbose';
    default:
      return 'info';
  }
}

function describeObject(o: z.infer<typeof RemoteObject>): string {
  if (o.value !== undefined) return typeof o.value === 'string' ? o.value : (JSON.stringify(o.value) ?? String(o.value));
  return o.description ?? o.type;
}

// ---------------------------------------------------------------- page-side functions (sent as source text)

function centreOf(selector: string): unknown {
  const el = document.querySelector(selector);
  if (el === null) return { error: `no element matches ${selector}` };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return { error: `${selector} has no size` };
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  if (hit === null || !(hit === el || el.contains(hit))) return { error: `${selector} is covered by ${hit === null ? 'nothing' : hit.tagName.toLowerCase()}` };
  return { x, y };
}

function isFileInput(selector: string): boolean {
  const el = document.querySelector(selector);
  return el instanceof HTMLInputElement && el.type === 'file';
}

function readViolations(): unknown {
  const surface = window.__noisyTest;
  if (surface === undefined) return { url: location.href, surface: false, violations: [] };
  const violations = [];
  for (const e of surface.diagnostics()) {
    if (e.event === 'csp.violation') violations.push({ directive: e.directive, blocked: e.blocked, disposition: e.disposition });
  }
  return { url: location.href, surface: true, violations };
}

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
} as const;

// ---------------------------------------------------------------- the page

/** A new page target in the browser context, attached with a flat session. */
async function createPageTarget(cdp: CdpConnection, browserContextId: string): Promise<{ readonly targetId: string; readonly sessionId: string }> {
  const { targetId } = TargetReply.parse(await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId }));
  const { sessionId } = SessionReply.parse(await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  return { targetId, sessionId };
}

async function openChromePage(cdp: CdpConnection, options: { readonly baseUrl: string; readonly dir: string }): Promise<DrivenPage> {
  const { browserContextId } = ContextReply.parse(await cdp.send('Target.createBrowserContext', { disposeOnDetach: true }));
  // Both change only when reopen replaces a crashed page.
  let { targetId, sessionId: pageSession } = await createPageTarget(cdp, browserContextId);

  const sessions = new Map<string, 'page' | 'worker'>([[pageSession, 'page']]);
  /**
   * The worker targets attached now, by session. Each leaves on its own
   * detach, a nested worker's included, so one whose detach never arrives
   * stays listed.
   */
  const workerTargets = new Map<string, WorkerTarget>();
  const consoleEntries: ConsoleEntry[] = [];
  const requests: RequestEntry[] = [];
  const requestIndex = new Map<string, number>();
  const violations: DiagnosedViolation[] = [];
  const cspViolations: BrowserCspViolation[] = [];
  let pagesRead = 0;
  let interceptRules: readonly InterceptRule[] = [];
  /** The requests a `hold` rule is holding, by Fetch request id. */
  let held: string[] = [];
  let loadWaiters: { resolve(): void; reject(e: Error): void }[] = [];
  /** Set when the page's renderer crashed: Chrome answers no later command on its session. */
  let crashed: string | null = null;
  /** Set while `crash` waits for the crash it asked for. */
  let askedCrash: { resolve(): void } | null = null;
  /** The console entries this page's operations declared, as a scenario declares its own. */
  const declared: MessagePattern[] = [];
  /** The viewport and color scheme `emulate` last set, which reopen repeats; null until it is called. */
  let emulation: EmulateOptions | null = null;
  const send = (method: string, params: Readonly<Record<string, unknown>> = {}): Promise<unknown> =>
    crashed === null ? cdp.send(method, params, pageSession) : Promise.reject(new Error(`${method}: ${crashed}`));
  const failLoads = (reason: string): void => {
    for (const waiter of loadWaiters) waiter.reject(new Error(`the page load did not finish: ${reason}`));
    loadWaiters = [];
  };

  const note = (entry: Omit<ConsoleEntry, 'at'>): void => {
    consoleEntries.push({ ...entry, at: new Date().toISOString() });
  };

  /** Records a child target's console, exceptions, and requests, attaches to its own workers, then lets it run. */
  const adopt = async (child: string): Promise<void> => {
    try {
      await Promise.all([
        cdp.send('Runtime.enable', {}, child),
        cdp.send('Network.enable', {}, child).catch(() => undefined),
        cdp.send('Log.enable', {}, child).catch(() => undefined),
        cdp.send('Audits.enable', {}, child).catch(() => undefined),
        cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, child).catch(() => undefined),
      ]);
    } catch {
      // A worker that ends at once detaches before it can be set up.
    } finally {
      await cdp.send('Runtime.runIfWaitingForDebugger', {}, child).catch(() => undefined);
    }
  };

  const onEvent = (event: CdpEvent): void => {
    try {
      handle(event);
    } catch {
      // An event whose parameters do not have the shape this driver reads is skipped.
    }
  };
  const handle = (event: CdpEvent): void => {
    if (event.sessionId === null) return;
    const context = sessions.get(event.sessionId);
    if (context === undefined) return;
    const key = (requestId: string): string => `${event.sessionId}:${requestId}`;
    switch (event.method) {
      case 'Target.attachedToTarget': {
        const p = AttachedToTarget.parse(event.params);
        sessions.set(p.sessionId, p.targetInfo.type === 'iframe' ? 'page' : 'worker');
        if (p.targetInfo.type !== 'iframe') workerTargets.set(p.sessionId, { type: p.targetInfo.type, url: p.targetInfo.url, title: p.targetInfo.title });
        void adopt(p.sessionId);
        return;
      }
      case 'Target.detachedFromTarget': {
        const { sessionId } = DetachedFromTarget.parse(event.params);
        sessions.delete(sessionId);
        workerTargets.delete(sessionId);
        return;
      }
      case 'Runtime.consoleAPICalled': {
        const p = ConsoleApiCalled.parse(event.params);
        note({
          channel: 'console',
          level: consoleLevel(p.type),
          source: 'console-api',
          text: p.args.map(describeObject).join(' '),
          url: null,
          scriptUrl: p.stackTrace?.callFrames[0]?.url ?? null,
          context,
        });
        return;
      }
      case 'Runtime.exceptionThrown': {
        const { exceptionDetails: d } = ExceptionThrown.parse(event.params);
        note({
          channel: 'exception',
          level: 'error',
          source: 'exception',
          text: d.exception?.description ?? d.text,
          url: null,
          scriptUrl: d.stackTrace?.callFrames[0]?.url ?? d.url ?? null,
          context,
        });
        return;
      }
      case 'Log.entryAdded': {
        const { entry } = LogEntryAdded.parse(event.params);
        const top = entry.stackTrace?.callFrames[0]?.url ?? null;
        note({
          channel: 'log',
          level: entry.level,
          source: entry.source,
          text: entry.text,
          url: entry.url ?? null,
          scriptUrl: top ?? (entry.source === 'javascript' ? (entry.url ?? null) : null),
          context,
        });
        return;
      }
      case 'Network.requestWillBeSent': {
        const p = RequestWillBeSent.parse(event.params);
        requestIndex.set(key(p.requestId), requests.length);
        requests.push({ url: p.request.url, method: p.request.method, resourceType: p.type ?? null, context, status: null, failed: null });
        return;
      }
      case 'Network.responseReceived': {
        const p = ResponseReceived.parse(event.params);
        const at = requestIndex.get(key(p.requestId));
        const entry = at === undefined ? undefined : requests[at];
        if (at !== undefined && entry !== undefined) requests[at] = { ...entry, status: p.response.status };
        return;
      }
      case 'Network.loadingFailed': {
        const p = LoadingFailed.parse(event.params);
        const at = requestIndex.get(key(p.requestId));
        const entry = at === undefined ? undefined : requests[at];
        if (at !== undefined && entry !== undefined) requests[at] = { ...entry, failed: p.errorText };
        return;
      }
      case 'Fetch.requestPaused': {
        if (event.sessionId !== pageSession) return;
        const { requestId, request } = RequestPaused.parse(event.params);
        const rule = interceptRules.find((r) => r.method === request.method && new URL(r.path, options.baseUrl).href === request.url);
        const answer = (method: string, params: Readonly<Record<string, unknown>>): void => void send(method, { requestId, ...params }).catch(() => undefined);
        if (rule === undefined) return answer('Fetch.continueRequest', {});
        switch (rule.action.kind) {
          case 'hold':
            held.push(requestId);
            return;
          case 'fail':
            return answer('Fetch.failRequest', { errorReason: 'Failed' });
          case 'respond':
            return answer('Fetch.fulfillRequest', {
              responseCode: rule.action.status,
              responseHeaders: [{ name: 'content-type', value: 'text/plain; charset=utf-8' }],
              body: Buffer.from(rule.action.body).toString('base64'),
            });
          default: {
            const exhaustive: never = rule.action;
            return exhaustive;
          }
        }
      }
      case 'Page.loadEventFired':
        if (event.sessionId !== pageSession) return;
        for (const waiter of loadWaiters) waiter.resolve();
        loadWaiters = [];
        return;
      case 'Audits.issueAdded': {
        const { issue } = IssueAdded.parse(event.params);
        const csp = issue.details.contentSecurityPolicyIssueDetails;
        if (issue.code !== 'ContentSecurityPolicyIssue' || csp === undefined) return;
        cspViolations.push({
          context,
          directive: csp.violatedDirective,
          violation: csp.contentSecurityPolicyViolationType,
          blocked: csp.blockedURL ?? null,
          reportOnly: csp.isReportOnly,
          sourceUrl: csp.sourceCodeLocation?.url || null,
        });
        return;
      }
      case 'Inspector.targetCrashed': {
        const asked = event.sessionId === pageSession ? askedCrash : null;
        note({ channel: 'exception', level: 'error', source: 'crash', text: asked === null ? CRASH_TEXT : ASKED_CRASH_TEXT, url: null, scriptUrl: null, context });
        if (event.sessionId !== pageSession) return;
        crashed = asked === null ? 'the page\'s renderer crashed' : CRASHED_PAGE;
        failLoads(crashed);
        cdp.rejectSession(pageSession, crashed);
        askedCrash = null;
        asked?.resolve();
        return;
      }
      default:
        return;
    }
  };
  const unsubscribe = cdp.onEvent(onEvent);
  const unsubscribeClose = cdp.onClose((reason) => failLoads(reason));

  /** Fetch patterns treat * and ? as wildcards and \ as their escape. */
  const fetchPatterns = (rules: readonly InterceptRule[]): readonly { readonly urlPattern: string; readonly requestStage: string }[] =>
    rules.map((r) => ({ urlPattern: new URL(r.path, options.baseUrl).href.replace(/[*?\\]/g, '\\$&'), requestStage: 'Request' }));

  /** The page's setup: the recorded domains, the viewport and color scheme, automatic attachment to its workers, and the standing intercept rules. */
  const setUp = async (): Promise<void> => {
    await Promise.all([send('Page.enable'), send('Runtime.enable'), send('Network.enable'), send('Log.enable'), send('Inspector.enable'), send('Audits.enable')]);
    if (emulation === null) {
      await send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
    } else {
      const { width, height, deviceScaleFactor, mobile, colorScheme } = emulation;
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile });
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: colorScheme }] });
    }
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    if (interceptRules.length > 0) await send('Fetch.enable', { patterns: fetchPatterns(interceptRules) });
  };
  await setUp();

  /** The next load event of the main frame; observed at once so a rejection is never unhandled. */
  const nextLoad = (): Promise<void> => {
    const loaded = within(new Promise<void>((resolve, reject) => loadWaiters.push({ resolve, reject })), LOAD_TIMEOUT_MS, 'the page load');
    loaded.catch(() => undefined);
    return loaded;
  };

  const evaluateRaw = async (source: string, args: readonly Json[]): Promise<unknown> => {
    const reply = EvaluateReply.parse(
      await send('Runtime.evaluate', { expression: `(${source})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true }),
    );
    if (reply.exceptionDetails !== undefined) {
      throw new Error(`the page threw: ${reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text}`);
    }
    return reply.result.value;
  };

  const parse = <T>(schema: z.ZodType<T>, value: unknown, what: string): T => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new Error(`${what} returned ${preview(value)}, which does not match its schema: ${parsed.error.message}`);
    return parsed.data;
  };

  const harvest = async (): Promise<void> => {
    let read: z.infer<typeof Harvest>;
    try {
      read = Harvest.parse(await within(evaluateRaw(readViolations.toString(), []), HOUSEKEEPING_TIMEOUT_MS, 'reading the page\'s diagnostics'));
    } catch {
      return; // No page, a crashed or hung one, or one that cannot be read: nothing to harvest.
    }
    if (!read.surface) return;
    pagesRead += 1;
    for (const v of read.violations) violations.push({ url: read.url, ...v });
  };

  const navigate = async (start: () => Promise<void>): Promise<void> => {
    await harvest();
    const loaded = nextLoad();
    await within(start(), LOAD_TIMEOUT_MS, 'the navigation');
    await loaded;
  };

  const mouse = (type: string, x: number, y: number, buttons: number): Promise<unknown> =>
    send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 });

  const page: DrivenPage = {
    goto: (target) =>
      navigate(async () => {
        const url = new URL(target, options.baseUrl).href;
        const reply = NavigateReply.parse(await send('Page.navigate', { url }));
        if (reply.errorText !== undefined) throw new Error(`navigation to ${url} failed: ${reply.errorText}`);
      }),
    reload: () =>
      navigate(async () => {
        await send('Page.reload');
      }),
    evaluate: async (schema, fn, ...args) => parse(schema, await evaluateRaw(fn.toString(), args), `the page function ${fn.name || '(anonymous)'}`),
    async waitFor(description, schema, fn, waitOptions: WaitOptions = {}) {
      const timeoutMs = waitOptions.timeoutMs ?? 10_000;
      const deadline = Date.now() + timeoutMs;
      let last: unknown = undefined;
      let lastError: string | null = null;
      for (;;) {
        try {
          // Bounded by the deadline, so a page whose main thread never answers still times out.
          last = await within(evaluateRaw(fn.toString(), []), Math.max(deadline - Date.now(), 1), `waiting for ${description}`);
          lastError = null;
          if (last !== null && last !== undefined && last !== false) return parse(schema, last, `waiting for ${description}`);
        } catch (e) {
          // A crashed page never answers, so waiting on it fails at once.
          if (crashed !== null) throw e;
          lastError = e instanceof Error ? e.message : String(e);
        }
        if (Date.now() >= deadline) {
          throw new Error(`timed out after ${timeoutMs} ms waiting for ${description}; last ${lastError === null ? `value ${preview(last)}` : `error: ${lastError}`}`);
        }
        await sleep(waitOptions.intervalMs ?? 100);
      }
    },
    async click(selector) {
      const at = Located.parse(await evaluateRaw(centreOf.toString(), [selector]));
      if ('error' in at) throw new Error(`cannot click: ${at.error}`);
      await mouse('mouseMoved', at.x, at.y, 0);
      await mouse('mousePressed', at.x, at.y, 1);
      await mouse('mouseReleased', at.x, at.y, 0);
    },
    async type(selector, text) {
      await page.click(selector);
      for (const ch of text) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
      }
    },
    async press(name) {
      const key = KEYS[name];
      await send('Input.dispatchKeyEvent', { type: 'text' in key ? 'keyDown' : 'rawKeyDown', ...key });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: key.key, code: key.code, windowsVirtualKeyCode: key.windowsVirtualKeyCode });
    },
    async setFiles(selector, files) {
      for (const file of files) if (!path.isAbsolute(file)) throw new Error(`setFiles takes absolute paths, not ${file}`);
      if ((await evaluateRaw(isFileInput.toString(), [selector])) !== true) throw new Error(`no file input matches ${selector}`);
      const { result } = EvaluateReply.parse(await send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})` }));
      if (result.objectId === undefined) throw new Error(`no file input matches ${selector}`);
      try {
        await send('DOM.setFileInputFiles', { files, objectId: result.objectId });
      } finally {
        await send('Runtime.releaseObject', { objectId: result.objectId }).catch(() => undefined);
      }
    },
    async emulate(emulated) {
      const { width, height, deviceScaleFactor, mobile, colorScheme } = emulated;
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile });
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: colorScheme }] });
      emulation = emulated;
    },
    async intercept(rules) {
      // Rejected before anything changes, so reopen installs no rule from a call that failed.
      if (crashed !== null) throw new Error(`intercept: ${crashed}`);
      interceptRules = rules;
      const release = held;
      held = [];
      // A held request goes on even when the page has given up on it; continuing one Chrome no longer holds fails, which is ignored.
      await Promise.all(release.map((requestId) => send('Fetch.continueRequest', { requestId }).catch(() => undefined)));
      if (rules.length === 0) {
        await send('Fetch.disable');
        return;
      }
      await send('Fetch.enable', { patterns: fetchPatterns(rules) });
    },
    async lifecycle(state) {
      await send('Page.setWebLifecycleState', { state });
      if (state === 'frozen') {
        // Chrome answers once it has sent the page its new state, not once the page has applied it: a renderer whose main thread is busy for a few milliseconds hides and freezes the page only after its current task, and a `crash()` sent before then lands first (it interrupts the main thread), so no `visibilitychange` ever runs. An evaluation runs as a task of its own after that one, and a frozen page still answers it, so the page reading hidden here has run its `visibilitychange` listeners and stopped.
        await page.waitFor('the page to apply the frozen state, hidden', z.literal(true), () => document.visibilityState === 'hidden', { intervalMs: 10 });
        return;
      }
      // Resuming leaves the page hidden, as `frozen` made it. A blank tab opened in its context and closed again shows the page, with a `visibilitychange` to visible, in tens of milliseconds headless or headed, and keeps the emulated viewport; minimizing and restoring the window also shows it, but a headed window's animation keeps the page hidden for about 1.5 s more.
      const { targetId: blank } = TargetReply.parse(await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId }));
      await cdp.send('Target.closeTarget', { targetId: blank });
      // As with freezing, the page shows itself in a task of its own; once it reads visible, its `visibilitychange` listeners have run.
      await page.waitFor('the page to show again, visible', z.literal(true), () => document.visibilityState === 'visible', { intervalMs: 10 });
    },
    async clearIndexedDb() {
      await send('Storage.clearDataForOrigin', { origin: new URL(options.baseUrl).origin, storageTypes: 'indexeddb' });
    },
    async screenshot(name) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`a screenshot name is lowercase letters, digits, and hyphens, not "${name}"`);
      const { data } = ScreenshotReply.parse(await send('Page.captureScreenshot', { format: 'png' }));
      const file = path.join(options.dir, `${name}.png`);
      await writeFile(file, Buffer.from(data, 'base64'));
      return file;
    },
    async crash() {
      if (crashed !== null) throw new Error(`crash: ${crashed}`);
      // The page's diagnostics are not read first: reading waits for the page's current task to end, so the crash would land after it, not where the scenario asked.
      const reported = within(new Promise<void>((resolve) => (askedCrash = { resolve })), CRASH_TIMEOUT_MS, 'the crash crash() asked for');
      reported.catch(() => undefined);
      declared.push(ASKED_CRASH);
      // The crash rejects the command's pending reply (rejectSession above), so the outcome is read from the crash event alone.
      send('Page.crash').catch(() => undefined);
      try {
        await reported;
      } finally {
        askedCrash = null;
      }
    },
    async reopen(target) {
      if (crashed === null) throw new Error('reopen follows a crash, and the page has not crashed');
      // The crashed page is closed first, so the context holds one page, as it did before the crash.
      await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
      // Every session the crashed page had is gone; events still arriving for them are ignored.
      sessions.clear();
      workerTargets.clear();
      held = [];
      ({ targetId, sessionId: pageSession } = await createPageTarget(cdp, browserContextId));
      sessions.set(pageSession, 'page');
      crashed = null;
      await setUp();
      await page.goto(target);
    },
    console: () => [...consoleEntries],
    requests: () => [...requests],
    workers: () => [...workerTargets.values()],
    diagnosed: () => ({ violations: [...violations], pagesRead }),
    cspViolations: () => [...cspViolations],
    expectedMessages: () => [...declared],
    harvest,
    async close() {
      unsubscribe();
      unsubscribeClose();
      await within(cdp.send('Target.disposeBrowserContext', { browserContextId }), HOUSEKEEPING_TIMEOUT_MS, 'closing the browser context').catch(() => undefined);
    },
  };
  return page;
}

// ---------------------------------------------------------------- the browser

export type ChromeOptions = {
  readonly executable: string;
  readonly headless: boolean;
  /** Chrome's stdout and stderr are appended here. */
  readonly logFile: string;
  readonly cleanup: Cleanup;
};

/**
 * Starts Chrome with a fresh profile in a temporary directory. Its stop and
 * the profile's removal are registered with `cleanup` before anything can
 * fail, so an error or an interruption at any point leaves neither behind.
 */
export async function launchChrome(options: ChromeOptions): Promise<Browser> {
  try {
    await access(options.executable, constants.X_OK);
  } catch {
    throw new EnvironmentError(`Chrome is not at ${options.executable}; pass --chrome <path to the Chrome executable>`);
  }
  const profile = await mkdtemp(path.join(tmpdir(), 'noisy-chrome-profile-'));
  options.cleanup.add(
    'the Chrome profile',
    () => rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
    () => rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );

  const log = openSync(options.logFile, 'a');
  const args = [
    ...(options.headless ? ['--headless=new'] : []),
    `--user-data-dir=${profile}`,
    '--remote-debugging-pipe',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    'about:blank',
  ];
  const child = spawn(options.executable, args, { detached: true, stdio: ['ignore', log, log, 'pipe', 'pipe'] });
  closeSync(log);
  const [, , , toChrome, fromChrome] = child.stdio;
  if (!(toChrome instanceof Writable) || !(fromChrome instanceof Readable)) {
    await stopGroup(child, 'SIGKILL', 2000);
    throw new EnvironmentError('Chrome started without the DevTools pipe');
  }
  const cdp = connectPipe(toChrome, fromChrome);
  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> =>
    (stopping ??= (async () => {
      await within(cdp.send('Browser.close'), 5000, 'Browser.close').catch(() => undefined);
      await stopGroup(child, null, 5000);
      cdp.close('Chrome was stopped');
    })());
  options.cleanup.add('Chrome', stop, () => killGroup(child, 'SIGKILL'));
  const failed = new Promise<never>((_, reject) => child.once('error', (e) => reject(new EnvironmentError(`Chrome did not start: ${e.message}`))));
  failed.catch(() => undefined);

  let version: z.infer<typeof VersionReply>;
  try {
    version = VersionReply.parse(await Promise.race([within(cdp.send('Browser.getVersion'), START_TIMEOUT_MS, 'Chrome startup'), failed]));
  } catch (e) {
    throw new EnvironmentError(`Chrome did not answer over the DevTools pipe (${e instanceof Error ? e.message : String(e)}); see ${options.logFile}`);
  }
  return {
    name: 'chrome',
    version: version.product,
    headless: options.headless,
    openPage: (pageOptions) => openChromePage(cdp, pageOptions),
    gone: () => {
      const reason = cdp.closedReason();
      return reason === null ? null : `${reason}; see ${options.logFile}`;
    },
    close: stop,
  };
}
