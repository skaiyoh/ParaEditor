// The command line of tools/drive-chrome.mjs: select scenarios, launch Chrome,
// run them, write the run's directory, and stop everything it started on
// success, failure, and SIGINT, SIGTERM, or SIGHUP.

import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { Scenario } from '../scenario.ts';
import { SCENARIO_FILES } from '../scenarios/index.ts';
import type { Browser } from './browser.ts';
import { DEFAULT_CHROME, launchChrome } from './chrome.ts';
import { createCleanup, EnvironmentError } from './processes.ts';
import { createRecorder, runScenarios, type ScenarioOutcome, type ServerSource } from './run.ts';
import { checkBuildRoot, isTargetName, REPO, TARGETS, type TargetName } from './server.ts';

const EXIT = { passed: 0, failed: 1, usage: 2, environment: 3, interrupted: 130 } as const;
const ID_FORM = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

const HELP = `usage: node tools/drive-chrome.mjs [scenario ...] [flags]

Runs the browser scenarios of test/browser/scenarios/ in Chrome. Each scenario
gets its own tools/serve.mjs on a free port and a fresh browser context; every
scenario is also checked for same-origin requests, CSP violations, and console
noise. Results go to test-results/<run>/: checks.jsonl, summary.json, and a
directory per scenario with its screenshots, files, browser logs, and server.

Arguments:
  scenario               an exact scenario id, or a prefix ending in * (quote it: 'shell.*');
                         several may be given; default every scenario

Flags:
  --list                 print the selected scenarios (id, target, covers, title) and exit
  --target <name>        only the scenarios of this target: ${Object.keys(TARGETS).join(', ')}
  --base-url <url>       attach to a server already running at <url> instead of starting one per
                         scenario; needs --target naming what it serves; the driver clears its
                         fault state around each scenario when its mode has one, and skips,
                         listing them, the scenarios that read the sink's files, which only a
                         server it starts gives it
  --headed               show Chrome's window (default: --headless=new)
  --chrome <path>        the Chrome executable (default: ${DEFAULT_CHROME})
  --dev-root <dir>       the dev build to serve (default: build/dev)
  --production-root <dir>  the production build to serve (default: build/production)
  --out <dir>            the run directory, which must not exist (default: test-results/chrome-<UTC time>-<hex>)
  -h, --help             print this help

Exit status: 0 every scenario that ran passed; 1 a scenario failed; 2 a usage
error or a malformed scenario list; 3 Chrome, a build, or a server is missing or
broken, the driver failed, or something the run started could not be stopped
(this outranks 0 and 1); 130 interrupted, after stopping everything it started.
A second interrupt SIGKILLs what is still running and exits 130 at once.

Examples:
  npm run test:browser
  node tools/drive-chrome.mjs --list
  node tools/drive-chrome.mjs threads.default
  node tools/drive-chrome.mjs 'shell.*' boot.env-event --headed
  node tools/drive-chrome.mjs --target dev-production-build
  node tools/drive-chrome.mjs --base-url http://127.0.0.1:8790/ --target dev shell.isolated
  node tools/drive-chrome.mjs --base-url https://<this Mac's MagicDNS name>/ --target production`;

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Every scenario in run order, after checking the registry against the files on disk. */
async function loadScenarios(): Promise<readonly Scenario[]> {
  const dir = path.join(REPO, 'test/browser/scenarios');
  const onDisk = (await readdir(dir)).filter((f) => f.endsWith('.scenario.ts')).sort();
  const registered = Object.keys(SCENARIO_FILES).sort();
  const missing = onDisk.filter((f) => !registered.includes(f));
  if (missing.length > 0) throw new UsageError(`test/browser/scenarios/index.ts does not register ${missing.join(', ')}; add each to SCENARIO_FILES`);
  const all = Object.values(SCENARIO_FILES).flat();
  const seen = new Set<string>();
  for (const s of all) {
    if (!ID_FORM.test(s.id)) throw new UsageError(`scenario id "${s.id}" is not lowercase words joined by dots or hyphens`);
    if (seen.has(s.id)) throw new UsageError(`scenario id "${s.id}" is used twice`);
    seen.add(s.id);
  }
  return all;
}

const SKIP_REASON = 'reads the sink\'s files, which only a server this run starts gives it';

/** The scenarios a run attached with --base-url cannot run, and why. */
function unrunnable(scenarios: readonly Scenario[], attached: boolean): ReadonlySet<string> {
  return new Set(attached ? scenarios.filter((s) => s.readsSinkFiles === true).map((s) => s.id) : []);
}

function select(all: readonly Scenario[], filters: readonly string[], target: TargetName | null): readonly Scenario[] {
  const ofTarget = all.filter((s) => target === null || s.target === target);
  if (filters.length === 0) return ofTarget;
  const chosen = new Set<string>();
  for (const filter of filters) {
    const hits = ofTarget.filter((s) => (filter.endsWith('*') ? s.id.startsWith(filter.slice(0, -1)) : s.id === filter));
    if (hits.length === 0) {
      throw new UsageError(`no scenario${target === null ? '' : ` of target ${target}`} matches "${filter}"; list them with node tools/drive-chrome.mjs --list`);
    }
    for (const s of hits) chosen.add(s.id);
  }
  return ofTarget.filter((s) => chosen.has(s.id));
}

function listing(scenarios: readonly Scenario[]): string {
  const idWidth = Math.max(...scenarios.map((s) => s.id.length));
  const targetWidth = Math.max(...scenarios.map((s) => s.target.length));
  return scenarios
    .map((s) => `${s.id.padEnd(idWidth)}  ${s.target.padEnd(targetWidth)}  ${(s.covers.join(' ') || '-').padEnd(8)}  ${s.title}`)
    .join('\n');
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
/** A path relative to the working directory when it is inside it, absolute otherwise. */
const display = (p: string): string => {
  const relative = path.relative(process.cwd(), p);
  return relative === '' ? '.' : relative.startsWith('..') ? p : relative;
};

function brief(value: unknown): string {
  const text = JSON.stringify(value) ?? 'undefined';
  return text.length > 240 ? `${text.slice(0, 240)}...` : text;
}

function report(outcome: ScenarioOutcome, checksFile: string): string {
  const covers = outcome.covers.length === 0 ? '' : ` [${outcome.covers.join(' ')}]`;
  const lines = [`${outcome.status === 'passed' ? 'PASS' : 'FAIL'} ${outcome.id}${covers} ${seconds(outcome.ms)}`];
  for (const m of outcome.vendorOrt) {
    lines.push(`  vendor ORT ${m.level}${m.count > 1 ? ` x${m.count}` : ''}: ${brief(m.text)}`);
  }
  for (const row of outcome.failed) {
    const detail = 'expected' in row ? `expected ${brief(row.expected)}, got ${brief(row.actual)}` : `evidence ${brief(row.evidence)}`;
    lines.push(`  x ${row.check}${row.covers.length > 0 ? ` (${row.covers.join(' ')})` : ''}: ${detail}`);
    lines.push(`    ${display(checksFile)} seq ${row.seq}; ${display(outcome.dir)}/`);
  }
  return lines.join('\n');
}

function runName(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `chrome-${stamp}-${randomBytes(2).toString('hex')}`;
}

export async function main(argv: readonly string[]): Promise<number> {
  let values;
  let positionals: readonly string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        list: { type: 'boolean' },
        target: { type: 'string' },
        'base-url': { type: 'string' },
        headed: { type: 'boolean' },
        chrome: { type: 'string' },
        'dev-root': { type: 'string' },
        'production-root': { type: 'string' },
        out: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (e) {
    process.stderr.write(`drive-chrome: ${e instanceof Error ? e.message : String(e)}\nnode tools/drive-chrome.mjs --help lists the flags\n`);
    return EXIT.usage;
  }
  if (values.help === true) {
    process.stdout.write(`${HELP}\n`);
    return EXIT.passed;
  }

  let scenarios: readonly Scenario[];
  let skipped: readonly Scenario[] = [];
  let servers: ServerSource;
  try {
    const target = values.target ?? null;
    if (target !== null && !isTargetName(target)) throw new UsageError(`--target must be one of ${Object.keys(TARGETS).join(', ')}, not "${target}"`);
    const baseUrl = values['base-url'];
    if (baseUrl !== undefined) {
      if (target === null) throw new UsageError('--base-url needs --target naming what that server serves, such as --base-url http://127.0.0.1:8790/ --target dev');
      if (!URL.canParse(baseUrl)) throw new UsageError(`--base-url "${baseUrl}" is not a URL`);
      servers = { kind: 'attach', baseUrl };
    } else {
      servers = {
        kind: 'start',
        roots: {
          dev: path.resolve(values['dev-root'] ?? path.join(REPO, 'build/dev')),
          production: path.resolve(values['production-root'] ?? path.join(REPO, 'build/production')),
        },
      };
    }
    const selected = select(await loadScenarios(), positionals, target);
    const cannot = unrunnable(selected, servers.kind === 'attach');
    const named = selected.filter((s) => cannot.has(s.id) && positionals.includes(s.id));
    if (named.length > 0) throw new UsageError(`${named.map((s) => s.id).join(', ')} ${SKIP_REASON}; run it without --base-url`);
    scenarios = selected.filter((s) => !cannot.has(s.id));
    skipped = selected.filter((s) => cannot.has(s.id));
    if (scenarios.length === 0) throw new UsageError('no scenario is selected');
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`drive-chrome: ${e.message}\n`);
    return EXIT.usage;
  }
  if (values.list === true) {
    process.stdout.write(`${listing(scenarios)}\n`);
    if (skipped.length > 0) process.stdout.write(`skipped with --base-url (each ${SKIP_REASON}): ${skipped.map((s) => s.id).join(', ')}\n`);
    return EXIT.passed;
  }

  const runDir = path.resolve(values.out ?? path.join(REPO, 'test-results', runName()));
  try {
    await mkdir(path.dirname(runDir), { recursive: true });
    await mkdir(runDir);
  } catch (e) {
    process.stderr.write(`drive-chrome: cannot create the run directory ${runDir}: ${e instanceof Error ? e.message : String(e)}; pass --out <a new directory>\n`);
    return EXIT.usage;
  }

  const startedAt = new Date();
  const cleanup = createCleanup();
  const recorder = createRecorder(path.join(runDir, 'checks.jsonl'));
  const outcomes: ScenarioOutcome[] = [];
  let browser: Browser | null = null;
  /** The scenario running now, if any, so an interrupted run reports it as interrupted rather than not run. */
  let current: Scenario | null = null;
  let summaryWritten = false;

  const writeSummary = (code: number, note: string | null, leftovers: readonly string[]): number => {
    // Something left running outranks a pass or a failure: it can break the next run.
    const exitCode = leftovers.length > 0 && (code === EXIT.passed || code === EXIT.failed) ? EXIT.environment : code;
    if (summaryWritten) return exitCode;
    summaryWritten = true;
    const passed = outcomes.filter((o) => o.status === 'passed').length;
    const failed = outcomes.length - passed;
    const inFlight = current === null ? null : { id: current.id, failedChecks: recorder.failedOf(current.id).map((r) => r.check) };
    const notRun = scenarios.length - outcomes.length - (inFlight === null ? 0 : 1);
    const ms = Date.now() - startedAt.getTime();
    const summary = {
      run: path.basename(runDir),
      startedAt: startedAt.toISOString(),
      ms,
      browser: browser === null ? null : { name: browser.name, version: browser.version, headless: browser.headless },
      servers: servers.kind === 'start' ? { started: 'per scenario', roots: servers.roots } : { attached: servers.baseUrl },
      selected: scenarios.map((s) => s.id),
      skipped: skipped.map((s) => ({ id: s.id, reason: SKIP_REASON })),
      scenarios: outcomes.map(({ failed: rows, ...o }) => ({ ...o, dir: path.relative(runDir, o.dir), failedChecks: rows.map((r) => r.check) })),
      inFlight,
      totals: { passed, failed, interrupted: inFlight === null ? 0 : 1, notRun, skipped: skipped.length },
      note,
      leftovers,
      exitCode,
    };
    writeFileSync(path.join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    for (const leftover of leftovers) process.stderr.write(`drive-chrome: could not stop ${leftover}\n`);
    const counts = [`${passed} passed`, `${failed} failed`, ...(inFlight === null ? [] : [`1 interrupted (${inFlight.id})`]), `${notRun} not run`, ...(skipped.length === 0 ? [] : [`${skipped.length} skipped`])];
    process.stdout.write(`drive-chrome: ${counts.join(', ')}, in ${seconds(ms)}; ${display(path.join(runDir, 'summary.json'))}\n`);
    return exitCode;
  };

  let finishing: Promise<number> | null = null;
  /** Stops everything the run started and writes the summary; the first caller's code and note win. */
  const finish = (code: number, note: string | null): Promise<number> =>
    (finishing ??= cleanup.run().then((leftovers) => writeSummary(code, note, leftovers)));

  let signals = 0;
  const onSignal = (signal: NodeJS.Signals): void => {
    signals += 1;
    if (signals > 1) {
      // A second interrupt: SIGKILL every process group still registered, delete the profile, and leave now.
      const failures = cleanup.force();
      process.stderr.write(`drive-chrome: second ${signal}; killed what was still running\n`);
      writeSummary(EXIT.interrupted, `forced by a second ${signal}`, failures);
      process.exit(EXIT.interrupted);
    }
    if (finishing !== null) {
      process.stderr.write(`drive-chrome: ${signal}; already stopping; a second ${signal} kills what is still running\n`);
      return;
    }
    process.stderr.write(`drive-chrome: ${signal}; stopping Chrome and the servers; a second ${signal} kills them\n`);
    void finish(EXIT.interrupted, `interrupted by ${signal}`).then((code) => process.exit(code));
  };
  const onCrash = (e: unknown): void => {
    process.stderr.write(`drive-chrome: driver error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    void finish(EXIT.environment, 'driver error').then((code) => process.exit(code));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);

  try {
    if (servers.kind === 'start') {
      const modes = new Set(scenarios.map((s) => TARGETS[s.target].build));
      for (const mode of modes) await checkBuildRoot(servers.roots[mode], mode);
    }
    browser = await launchChrome({ executable: values.chrome ?? DEFAULT_CHROME, headless: values.headed !== true, logFile: path.join(runDir, 'chrome.log'), cleanup });
    process.stdout.write(`drive-chrome: ${browser.version}${browser.headless ? ' headless' : ' headed'}; ${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'}; ${display(runDir)}/\n`);
    const done = await runScenarios(scenarios, {
      runDir,
      browser,
      servers,
      cleanup,
      onStart: (scenario) => {
        current = scenario;
      },
      onOutcome: (o) => {
        current = null;
        outcomes.push(o);
        process.stdout.write(`${report(o, recorder.file)}\n`);
      },
    }, recorder);
    return await finish(done.every((o) => o.status === 'passed') ? EXIT.passed : EXIT.failed, null);
  } catch (e) {
    // A signal handler or a crash handler is already stopping everything and will exit; failures caused by that stop are not reported.
    if (finishing !== null) return finishing;
    const environment = e instanceof EnvironmentError;
    process.stderr.write(`drive-chrome: ${environment ? e.message : `driver error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`}\n`);
    return await finish(EXIT.environment, environment ? e.message : 'driver error');
  }
}
