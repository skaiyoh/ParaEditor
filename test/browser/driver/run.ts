// Runs scenarios one at a time: a server and a fresh browser context for
// each, the scenario's own checks, then the invariant checks every scenario
// gets, every row appended to checks.jsonl as it is made.

import { appendFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { MessagePattern, Scenario, ScenarioContext } from '../scenario.ts';
import type { Browser, ConsoleEntry, ConsoleLevel, RequestEntry } from './browser.ts';
import { EnvironmentError, type Cleanup } from './processes.ts';
import { attachServer, startServer, TARGETS, type BuildMode, type Server, type ServerLevers } from './server.ts';

const DEFAULT_TIMEOUT_MS = 60_000;
/** How long the runner waits after a scenario for late console entries and CSP reports. */
const SETTLE_MS = 300;
const VENDOR_PREFIX = '/vendor/ort/';
/** Schemes whose requests never leave the page. */
const LOCAL_SCHEMES = new Set(['data:', 'blob:', 'about:']);

export type CheckRow = {
  readonly kind: 'check';
  readonly seq: number;
  readonly at: string;
  readonly scenario: string;
  readonly covers: readonly string[];
  readonly check: string;
  readonly ok: boolean;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly evidence?: unknown;
};

/** A message of the vendored runtime: recorded and reported, and failing nothing by itself. */
export type VendorMessage = { readonly level: ConsoleLevel; readonly text: string; readonly scriptUrl: string | null; readonly count: number };

export type ScenarioOutcome = {
  readonly id: string;
  readonly title: string;
  readonly target: string;
  readonly covers: readonly string[];
  readonly status: 'passed' | 'failed';
  readonly ms: number;
  readonly failed: readonly CheckRow[];
  readonly vendorOrt: readonly VendorMessage[];
  readonly dir: string;
};

export type ServerSource =
  | { readonly kind: 'start'; readonly roots: Readonly<Record<BuildMode, string>> }
  | { readonly kind: 'attach'; readonly baseUrl: string };

export type RunOptions = {
  readonly runDir: string;
  readonly browser: Browser;
  readonly servers: ServerSource;
  readonly cleanup: Cleanup;
  /** Called as each scenario starts. */
  readonly onStart: (scenario: Scenario) => void;
  /** Called with each scenario's outcome as soon as it is known. */
  readonly onOutcome: (outcome: ScenarioOutcome) => void;
};

export type Recorder = {
  readonly file: string;
  append(row: Omit<CheckRow, 'kind' | 'seq' | 'at'>): CheckRow;
  scenario(outcome: ScenarioOutcome): void;
  /** The failed checks recorded so far for one scenario, such as one still running when the run was interrupted. */
  failedOf(scenario: string): readonly CheckRow[];
};

export function createRecorder(file: string): Recorder {
  let seq = 0;
  const failures: CheckRow[] = [];
  const write = (row: object): void => appendFileSync(file, `${JSON.stringify(row)}\n`);
  return {
    file,
    append(row) {
      const full: CheckRow = { kind: 'check', seq: ++seq, at: new Date().toISOString(), ...row };
      write(full);
      if (!full.ok) failures.push(full);
      return full;
    },
    scenario(outcome) {
      const { failed, ...rest } = outcome;
      write({ kind: 'scenario', seq: ++seq, at: new Date().toISOString(), ...rest, failedChecks: failed.map((r) => r.check) });
    },
    failedOf: (scenario) => failures.filter((r) => r.scenario === scenario),
  };
}

function fromVendor(entry: ConsoleEntry, origin: string): boolean {
  if (entry.channel === 'log' && entry.source === 'network') return false;
  if (entry.scriptUrl === null) return false;
  try {
    const url = new URL(entry.scriptUrl);
    return url.origin === origin && url.pathname.startsWith(VENDOR_PREFIX);
  } catch {
    return false;
  }
}

function matches(pattern: MessagePattern, entry: ConsoleEntry): boolean {
  return (
    (pattern.channel === undefined || pattern.channel === entry.channel) &&
    (pattern.source === undefined || pattern.source === entry.source) &&
    (pattern.level === undefined || pattern.level === entry.level) &&
    (pattern.text === undefined || pattern.text.test(entry.text)) &&
    (pattern.url === undefined || (entry.url !== null && pattern.url.test(entry.url)))
  );
}

function foreignRequests(requests: readonly RequestEntry[], origin: string): readonly RequestEntry[] {
  return requests.filter((r) => {
    let url: URL;
    try {
      url = new URL(r.url);
    } catch {
      return true;
    }
    return !LOCAL_SCHEMES.has(url.protocol) && url.origin !== origin;
  });
}

const errorText = (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : String(e));
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The vendored runtime's console messages, one per distinct message with how often it came. */
function vendorMessages(entries: readonly ConsoleEntry[]): readonly VendorMessage[] {
  const grouped = new Map<string, VendorMessage>();
  for (const e of entries) {
    const key = JSON.stringify([e.level, e.text, e.scriptUrl]);
    const seen = grouped.get(key);
    grouped.set(key, { level: e.level, text: e.text, scriptUrl: e.scriptUrl, count: (seen?.count ?? 0) + 1 });
  }
  return [...grouped.values()];
}

/** The server's levers for one scenario: once `isOpen` turns false, each rejects without reaching the server. */
function guardedLevers(levers: ServerLevers, isOpen: () => boolean): ServerLevers {
  const closed = (): Promise<never> => Promise.reject(new Error('the scenario timed out, so its server levers no longer reach the server'));
  return {
    setFaults: (rules) => (isOpen() ? levers.setFaults(rules) : closed()),
    clearFaults: () => (isOpen() ? levers.clearFaults() : closed()),
    sinkLines: () => (isOpen() ? levers.sinkLines() : closed()),
    requestLog: () => (isOpen() ? levers.requestLog() : closed()),
    cspReports: () => (isOpen() ? levers.cspReports() : closed()),
  };
}

async function runOne(scenario: Scenario, options: RunOptions, recorder: Recorder): Promise<ScenarioOutcome> {
  const started = Date.now();
  const dir = path.join(options.runDir, 'scenarios', scenario.id);
  await mkdir(path.join(dir, 'server'), { recursive: true });
  const failed: CheckRow[] = [];
  const record = (check: string, ok: boolean, covers: readonly string[], fields: { expected?: unknown; actual?: unknown; evidence?: unknown }): boolean => {
    const row = recorder.append({ scenario: scenario.id, covers, check, ok, ...fields });
    if (!ok) failed.push(row);
    return ok;
  };
  let vendorOrt: readonly VendorMessage[] = [];

  const source = options.servers;
  // A server that does not start or attach throws an EnvironmentError, and the summary counts this scenario under interrupted.
  const server: Server =
    source.kind === 'start'
      ? await startServer({ target: scenario.target, root: source.roots[TARGETS[scenario.target].build], dir: path.join(dir, 'server'), cleanup: options.cleanup })
      : await attachServer(source.baseUrl, scenario.target);
  const origin = new URL(server.url).origin;
  const serverHint = server.logFile === null ? `the server at ${server.url}` : `the server's output is in ${server.logFile}`;
  try {
    // An attached dev server keeps its fault state between scenarios; one started for this scenario starts clear.
    const sharedFaults = !server.started && server.devSurfaces;
    // Registered before the first lever call, so an interruption at any point clears what the scenario set.
    const unregisterFaults = sharedFaults ? options.cleanup.add(`the fault state of ${server.url}`, () => server.levers.clearFaults()) : () => undefined;
    if (sharedFaults) await server.levers.clearFaults();
    const reportsBefore = server.devSurfaces ? (await server.levers.cspReports()).length : 0;
    const page = await options.browser.openPage({ baseUrl: server.url, dir });
    const unregisterPage = options.cleanup.add(`the page of ${scenario.id}`, () => page.close());
    try {
      const expected: MessagePattern[] = [];
      // A scenario abandoned at its timeout may still be running; its later checks are dropped, not written after its outcome, and its levers stop reaching the server.
      let open = true;
      const t: ScenarioContext = {
        page,
        server: guardedLevers(server.levers, () => open),
        build: server.build,
        baseUrl: server.url,
        dir,
        equal: (check, actual, wanted, evidence) => open && record(check, isDeepStrictEqual(actual, wanted), scenario.covers, { expected: wanted, actual, evidence }),
        ok: (check, condition, evidence) => open && record(check, condition, scenario.covers, { evidence }),
        expectMessage: (pattern) => void expected.push(pattern),
        async file(name, data) {
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`a file name is letters, digits, dots, underscores, and hyphens, not "${name}"`);
          const file = path.join(dir, name);
          await writeFile(file, data);
          return file;
        },
      };

      const running = scenario.run(t);
      running.catch(() => undefined);
      const timeoutMs = scenario.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          running,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`the scenario did not finish within ${timeoutMs} ms`)), timeoutMs);
          }),
        ]);
      } catch (e) {
        record('the scenario ran to its end', false, scenario.covers, { evidence: errorText(e) });
      } finally {
        clearTimeout(timer);
        open = false;
      }

      await page.harvest();
      await sleep(SETTLE_MS);
      const entries = page.console();
      const requests = page.requests();
      await writeFile(path.join(dir, 'browser-console.jsonl'), entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
      await writeFile(path.join(dir, 'browser-requests.jsonl'), requests.map((r) => `${JSON.stringify(r)}\n`).join(''));

      const foreign = foreignRequests(requests, origin);
      record('I6 every request is same-origin', foreign.length === 0, ['I6'], { expected: [], actual: foreign, evidence: { origin, requests: requests.length } });
      const browserCsp = page.cspViolations();
      record('I6 no CSP violation reported by the browser', browserCsp.length === 0, ['I6'], { expected: [], actual: browserCsp });
      const diagnosed = page.diagnosed();
      record('I6 no csp.violation in the page diagnostics', diagnosed.violations.length === 0, ['I6'], {
        expected: [],
        actual: diagnosed.violations,
        evidence: { pagesWithTestSurface: diagnosed.pagesRead },
      });
      if (server.devSurfaces) {
        try {
          const reports = (await server.levers.cspReports()).slice(reportsBefore);
          record('I6 no CSP report at the server', reports.length === 0, ['I6'], { expected: [], actual: reports });
        } catch (e) {
          record('I6 no CSP report at the server', false, ['I6'], { evidence: `the server did not answer GET /dev/csp-report (${messageOf(e)}); ${serverHint}` });
        }
      }

      const noisy = entries.filter((e) => e.channel === 'exception' || e.level === 'error' || e.level === 'warning');
      const vendor = noisy.filter((e) => fromVendor(e, origin));
      vendorOrt = vendorMessages(vendor);
      const declared = [...expected, ...page.expectedMessages()];
      const provoked = noisy.filter((e) => !fromVendor(e, origin)).map((e) => ({ entry: e, because: declared.find((p) => matches(p, e))?.because ?? null }));
      const app = provoked.filter((p) => p.because === null).map((p) => p.entry);
      record('I7 no console error, warning, or exception from the app', app.length === 0, ['I7'], {
        expected: [],
        actual: app,
        evidence: {
          vendorOrt,
          provoked: provoked.filter((p) => p.because !== null).map((p) => ({ level: p.entry.level, text: p.entry.text, url: p.entry.url, because: p.because })),
          entries: entries.length,
        },
      });
    } finally {
      unregisterPage();
      await page.close();
    }
    if (sharedFaults) {
      // Left registered when the clear fails, so the run's cleanup tries again and reports it.
      await server.levers.clearFaults();
      unregisterFaults();
    }
  } catch (e) {
    record('the runner finished the scenario', false, [], { evidence: `${errorText(e)}\n${serverHint}` });
  } finally {
    await server.stop();
  }
  return {
    id: scenario.id,
    title: scenario.title,
    target: scenario.target,
    covers: scenario.covers,
    status: failed.length === 0 ? 'passed' : 'failed',
    ms: Date.now() - started,
    failed,
    vendorOrt,
    dir,
  };
}

/**
 * Runs each scenario in order. A server that does not start, or a browser
 * that can no longer be driven after a scenario, ends the run with an
 * EnvironmentError; that scenario's outcome is reported first.
 */
export async function runScenarios(scenarios: readonly Scenario[], options: RunOptions, recorder: Recorder): Promise<readonly ScenarioOutcome[]> {
  const outcomes: ScenarioOutcome[] = [];
  for (const scenario of scenarios) {
    options.onStart(scenario);
    const outcome = await runOne(scenario, options, recorder);
    recorder.scenario(outcome);
    outcomes.push(outcome);
    options.onOutcome(outcome);
    const gone = options.browser.gone();
    if (gone !== null) throw new EnvironmentError(`Chrome can no longer be driven: ${gone}`);
  }
  return outcomes;
}
