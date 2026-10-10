// The browser driver's own failure handling: the DevTools pipe's framing and
// its rejection of commands Chrome will never answer, the forced cleanup, and
// a run in real headless Chrome whose scenarios hang the page, crash the
// renderer, and lose their server, which must each fail within bounds and let
// the run go on.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { PassThrough } from 'node:stream';
import { z } from '../src/core/zod.ts';
import { connectPipe } from './browser/driver/cdp.ts';
import { DEFAULT_CHROME, launchChrome } from './browser/driver/chrome.ts';
import { createCleanup } from './browser/driver/processes.ts';
import { createRecorder, runScenarios, type ScenarioOutcome } from './browser/driver/run.ts';
import type { Scenario } from './browser/scenario.ts';
import { runTool, tempDir } from './support/cli.ts';

/** A pipe pair standing in for Chrome: what the driver writes, and a stream to answer on. */
function fakeChrome(): { readonly toChrome: PassThrough; readonly fromChrome: PassThrough; readonly written: () => readonly unknown[] } {
  const toChrome = new PassThrough();
  const fromChrome = new PassThrough();
  let text = '';
  toChrome.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
  return { toChrome, fromChrome, written: () => text.split('\0').filter(Boolean).map((m): unknown => JSON.parse(m)) };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('the pipe splits replies at NUL bytes however the chunks fall, a character split across two included', async () => {
  const chrome = fakeChrome();
  const cdp = connectPipe(chrome.toChrome, chrome.fromChrome);
  const first = cdp.send('A.one');
  const second = cdp.send('A.two', { x: 1 }, 'session-1');
  const third = cdp.send('A.three');
  await settle();
  assert.deepEqual(chrome.written(), [
    { id: 1, method: 'A.one', params: {} },
    { id: 2, method: 'A.two', params: { x: 1 }, sessionId: 'session-1' },
    { id: 3, method: 'A.three', params: {} },
  ]);
  const bytes = Buffer.from(`${JSON.stringify({ id: 1, result: { v: 'one' } })}\0${JSON.stringify({ id: 2, result: { v: 'déjà' } })}\0${JSON.stringify({ id: 3, result: { v: 3 } })}\0`);
  const accent = bytes.indexOf(Buffer.from('é'));
  // The first chunk ends inside the two bytes of the first accented character.
  chrome.fromChrome.write(bytes.subarray(0, accent + 1));
  chrome.fromChrome.write(bytes.subarray(accent + 1, accent + 4));
  chrome.fromChrome.write(bytes.subarray(accent + 4));
  assert.deepEqual(await Promise.all([first, second, third]), [{ v: 'one' }, { v: 'déjà' }, { v: 3 }]);
});

test('a message of many megabytes in small chunks arrives whole', async () => {
  const chrome = fakeChrome();
  const cdp = connectPipe(chrome.toChrome, chrome.fromChrome);
  const reply = cdp.send('Runtime.evaluate');
  const value = 'x'.repeat(20_000_000);
  const bytes = Buffer.from(`${JSON.stringify({ id: 1, result: { value } })}\0`);
  for (let at = 0; at < bytes.length; at += 65_536) chrome.fromChrome.write(bytes.subarray(at, at + 65_536));
  assert.equal(z.object({ value: z.string() }).parse(await reply).value.length, value.length);
});

test('a session\'s pending commands are rejected when the driver gives up on it or the session detaches', async () => {
  const chrome = fakeChrome();
  const cdp = connectPipe(chrome.toChrome, chrome.fromChrome);
  const crashed = cdp.send('Runtime.evaluate', {}, 'page');
  const detached = cdp.send('Runtime.evaluate', {}, 'worker');
  const other = cdp.send('Browser.getVersion');
  cdp.rejectSession('page', 'the renderer crashed');
  await assert.rejects(crashed, /^Error: Runtime\.evaluate: the renderer crashed$/);
  chrome.fromChrome.write(`${JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId: 'worker' } })}\0`);
  await assert.rejects(detached, /the target detached/);
  chrome.fromChrome.write(`${JSON.stringify({ id: 3, result: { product: 'Chrome' } })}\0`);
  assert.deepEqual(await other, { product: 'Chrome' });
});

test('a closed pipe rejects pending and later commands and tells each close listener once', async () => {
  const chrome = fakeChrome();
  const cdp = connectPipe(chrome.toChrome, chrome.fromChrome);
  const heard: string[] = [];
  cdp.onClose((reason) => heard.push(reason));
  const pending = cdp.send('Page.reload', {}, 'page');
  chrome.fromChrome.destroy();
  await assert.rejects(pending, /Page\.reload: Chrome closed the DevTools pipe/);
  await assert.rejects(cdp.send('Page.navigate'), /Page\.navigate: Chrome closed the DevTools pipe/);
  cdp.close('again');
  assert.deepEqual(heard, ['Chrome closed the DevTools pipe']);
  assert.equal(cdp.closedReason(), 'Chrome closed the DevTools pipe');
});

test('a forced cleanup runs the force of everything not yet disposed, newest first', async () => {
  const cleanup = createCleanup();
  const forced: string[] = [];
  cleanup.add('server', async () => undefined, () => forced.push('server'));
  const unregister = cleanup.add('gone', async () => undefined, () => forced.push('gone'));
  cleanup.add('no force', async () => undefined);
  cleanup.add('chrome', async () => undefined, () => forced.push('chrome'));
  unregister();
  assert.deepEqual(cleanup.force(), []);
  assert.deepEqual(forced, ['chrome', 'server']);
  assert.deepEqual(await cleanup.run(), []);
  forced.length = 0;
  cleanup.force();
  assert.deepEqual(forced, [], 'nothing is left to force once every disposer has run');
});

// ---------------------------------------------------------------- a run in Chrome

let scratch = '';
const cleanup = createCleanup();
before(async () => {
  scratch = await tempDir('drive-chrome');
});
after(async () => {
  // Kills Chrome and the servers even when the run test timed out mid-run, so the process can exit.
  cleanup.force();
  await rm(scratch, { recursive: true, force: true });
});

function spin(): unknown {
  for (;;) {
    // Holds the page's main thread until the browser context is closed.
  }
}

function isolated(): boolean {
  return window.crossOriginIsolated;
}

/** Kills the process listening on a port: the scenario's own dev server. */
function killListener(baseUrl: string): void {
  const pids = execFileSync('lsof', ['-t', '-i', `tcp:${new URL(baseUrl).port}`, '-s', 'TCP:LISTEN']).toString().trim().split('\n');
  for (const pid of pids) process.kill(Number(pid), 'SIGKILL');
}

const SCENARIOS: readonly Scenario[] = [
  {
    id: 'hang',
    title: 'hangs the page\'s main thread',
    target: 'dev',
    covers: [],
    timeoutMs: 1000,
    async run(t) {
      await t.page.goto('/');
      await t.page.evaluate(z.unknown(), spin);
    },
  },
  {
    id: 'crash',
    title: 'crashes the renderer',
    target: 'dev',
    covers: [],
    timeoutMs: 20_000,
    async run(t) {
      await t.page.goto('/');
      await t.page.goto('chrome://crash');
    },
  },
  {
    id: 'server-dies',
    title: 'loses its server',
    target: 'dev',
    covers: [],
    async run(t) {
      await t.page.goto('/');
      killListener(t.baseUrl);
    },
  },
  {
    id: 'after',
    title: 'Chrome still drives a page',
    target: 'dev',
    covers: [],
    async run(t) {
      await t.page.goto('/');
      t.equal('the page is cross-origin isolated', await t.page.evaluate(z.boolean(), isolated), true);
    },
  },
];

test('a hung page, a crashed renderer, and a dead server each fail their scenario within bounds, and the run goes on', async () => {
  const devRoot = path.join(scratch, 'build-dev');
  const build = await runTool('tools/build.mjs', ['--mode', 'dev', '--outdir', devRoot]);
  assert.equal(build.code, 0, build.stderr);
  const runDir = path.join(scratch, 'run');
  const outcomes: ScenarioOutcome[] = [];
  try {
    await mkdir(runDir);
    const browser = await launchChrome({ executable: DEFAULT_CHROME, headless: true, logFile: path.join(runDir, 'chrome.log'), cleanup });
    const recorder = createRecorder(path.join(runDir, 'checks.jsonl'));
    await runScenarios(
      SCENARIOS,
      {
        runDir,
        browser,
        servers: { kind: 'start', roots: { dev: devRoot, production: devRoot } },
        cleanup,
        onStart: () => undefined,
        onOutcome: (o) => outcomes.push(o),
      },
      recorder,
    );
  } finally {
    assert.deepEqual(await cleanup.run(), [], 'everything the run started stops');
  }
  const byId = new Map(outcomes.map((o) => [o.id, o]));
  const failedChecks = (id: string): readonly string[] => byId.get(id)?.failed.map((r) => r.check) ?? [];
  assert.deepEqual(outcomes.map((o) => [o.id, o.status]), [['hang', 'failed'], ['crash', 'failed'], ['server-dies', 'failed'], ['after', 'passed']]);

  // The scenario's 1 s, then at most 5 s reading the hung page and 5 s closing its context.
  assert.ok((byId.get('hang')?.ms ?? Infinity) < 15_000, `the hung page took ${byId.get('hang')?.ms} ms`);
  assert.deepEqual(failedChecks('hang'), ['the scenario ran to its end']);

  assert.ok((byId.get('crash')?.ms ?? Infinity) < 10_000, `the crash took ${byId.get('crash')?.ms} ms`);
  assert.ok(failedChecks('crash').includes('the scenario ran to its end'), String(failedChecks('crash')));

  const dead = byId.get('server-dies')?.failed.find((r) => r.check === 'I6 no CSP report at the server');
  assert.match(String(dead?.evidence), /the server did not answer GET \/dev\/csp-report .*server\/serve\.log$/);

  assert.match(await readFile(path.join(runDir, 'checks.jsonl'), 'utf8'), /"scenario":"after".*"ok":true/);
});
