// tools/start.mjs end to end against a stub `tailscale` first on PATH
// (test/support/tailscale-stub.ts), so no test needs a tailnet: each refusal,
// a fetch refusal stopping the start, Ctrl-C stopping both children, either
// child exiting stopping the other, and the removal of a configuration the
// share left behind. Every run builds into, serves from, and fetches into
// temporary directories, on a free port.

import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { after, test } from 'node:test';
import { z } from 'zod';
import type { Behavior } from './support/tailscale-stub.ts';
import { REPO, tempDir, writeTree } from './support/cli.ts';

const HEALTHY = {
  BackendState: 'Running',
  Self: { Online: true, DNSName: 'stub.example.ts.net.' },
  // Tailscale lists benign warnings here too, so a healthy tailnet may have some.
  Health: ['Some peers are advertising routes but --accept-routes is false'],
};
const OFFLINE_HEALTH = [
  'Unable to connect to the Tailscale coordination server to synchronize the state of your tailnet. Peer reachability might degrade over time.',
  'Network equipment from "Fortinet" may be blocking Tailscale traffic on this network. Connect to another network, or contact your network administrator for assistance.',
];
const COMMIT = 'a'.repeat(40);
const SHARE_CONFIG = { TCP: { '443': { HTTPS: true } }, Web: { 'stub.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8790' } } } } };

const Call = z.union([z.object({ pid: z.number(), args: z.array(z.string()) }), z.object({ pid: z.number(), signal: z.string() })]);

type Rig = {
  readonly dir: string;
  readonly stubDir: string;
  readonly models: string;
  readonly lock: string;
  readonly outdir: string;
  readonly env: NodeJS.ProcessEnv;
};

const scratch: string[] = [];
/** Every process a test saw start, killed afterwards if a failed test left one running. */
const started: number[] = [];
after(async () => {
  for (const pid of started) {
    // Only a process that is still this suite's, never a pid the system has reused.
    const command = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout;
    if (/tools\/start\.mjs|tools\/serve\.mjs|tailscale-stub\.ts/.test(command)) process.kill(pid, 'SIGKILL');
  }
  await Promise.all(scratch.map((d) => rm(d, { recursive: true, force: true })));
});

/**
 * A temporary directory with the stub on PATH, a one-file model lock with its file present, and a build directory not yet written.
 * The `tailscale` script on PATH execs the stub, or with `wrapper: 'sh'` runs it as its own child, as the real
 * /usr/local/bin/tailscale runs the CLI inside Tailscale.app.
 */
async function rig(
  behavior: Behavior,
  options: { readonly serveConfig?: unknown; readonly path?: 'stub' | 'empty'; readonly wrapper?: 'exec' | 'sh' } = {},
): Promise<Rig> {
  const dir = await tempDir('start');
  scratch.push(dir);
  const bin = path.join(dir, 'bin');
  const stubDir = path.join(dir, 'stub');
  const model = randomBytes(5_000);
  const sha256 = createHash('sha256').update(model).digest('hex');
  const served = `/models/tiny-${sha256.slice(0, 8)}.onnx`;
  const lock = {
    lockVersion: 1,
    models: { tiny: { repo: 'example/tiny', commit: COMMIT, files: [{ source: `https://huggingface.co/example/tiny/resolve/${COMMIT}/tiny.onnx`, sha256, bytes: model.length, served }] } },
  };
  await writeTree(dir, {
    [`models/${served.slice('/models/'.length)}`]: model,
    'lock.json': JSON.stringify(lock),
    'stub/behavior.json': JSON.stringify(behavior),
    'stub/serve.json': JSON.stringify(options.serveConfig ?? {}),
    'stub/calls.jsonl': '',
  });
  await mkdir(bin);
  if (options.path !== 'empty') {
    const script = path.join(bin, 'tailscale');
    const exec = options.wrapper === 'sh' ? '' : 'exec ';
    await writeFile(script, `#!/bin/sh\n${exec}'${process.execPath}' '${path.join(REPO, 'test/support/tailscale-stub.ts')}' "$@"\n`);
    await chmod(script, 0o755);
  }
  return {
    dir,
    stubDir,
    models: path.join(dir, 'models'),
    lock: path.join(dir, 'lock.json'),
    outdir: path.join(dir, 'build'),
    env: { ...process.env, PATH: options.path === 'empty' ? bin : `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`, TAILSCALE_STUB_DIR: stubDir },
  };
}

type Run = {
  readonly child: ChildProcess;
  output(): { stdout: string; stderr: string };
  readonly done: Promise<{ code: number | null; stdout: string; stderr: string }>;
};

/**
 * Runs start.mjs. With `group`, it leads a process group of its own, so a test
 * can signal the group as a terminal's Ctrl-C does (`interrupt`).
 */
function start(r: Rig, args: readonly string[] = [], options: { readonly group?: boolean } = {}): Run {
  const child = spawn(
    process.execPath,
    [path.join(REPO, 'tools/start.mjs'), '--port', '0', '--outdir', r.outdir, '--models', r.models, '--lock', r.lock, ...args],
    { cwd: REPO, env: r.env, detached: options.group === true },
  );
  if (child.pid !== undefined) started.push(child.pid);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
  return { child, output: () => ({ stdout, stderr }), done };
}

/** Sends SIGINT to the process group a `group` run leads, as a Ctrl-C in its terminal would. */
function interrupt(run: Run): void {
  assert.ok(run.child.pid !== undefined);
  process.kill(-run.child.pid, 'SIGINT');
}

type Up = { readonly url: string; readonly port: number; readonly serverPid: number; readonly sharePid: number };

/** Waits for the line that says noisy is up, and reads the server's address and both pids from the output. */
async function waitUp(run: Run): Promise<Up> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const { stdout, stderr } = run.output();
    const pids = /server pid (\d+), share pid (\d+)/.exec(stdout);
    const address = /serve: production mode on (http:\/\/127\.0\.0\.1:(\d+)\/)/.exec(stdout);
    if (pids !== null && address !== null) {
      started.push(Number(pids[1]), Number(pids[2]));
      assert.match(stdout, /noisy is up at https:\/\/stub\.example\.ts\.net\/\n/);
      return { url: address[1] ?? '', port: Number(address[2]), serverPid: Number(pids[1]), sharePid: Number(pids[2]) };
    }
    if (run.child.exitCode !== null || Date.now() > deadline) assert.fail(`start never came up:\n${stdout}\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function calls(r: Rig): Promise<z.infer<typeof Call>[]> {
  const text = await readFile(path.join(r.stubDir, 'calls.jsonl'), 'utf8');
  return text.split('\n').filter(Boolean).map((line) => Call.parse(JSON.parse(line)));
}

/** Waits until the stub has been called with `command`, and returns that call's pid. */
async function calledWith(r: Rig, command: string): Promise<number> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const call = (await calls(r)).find((c) => 'args' in c && c.args.join(' ') === command);
    if (call !== undefined) {
      started.push(call.pid);
      return call.pid;
    }
    if (Date.now() > deadline) assert.fail(`the stub was never called with ${command}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Waits, at most 2 s, for a process to be gone, and says whether it is. */
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 40 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  return !alive(pid);
}

const commands = async (r: Rig): Promise<string[]> => (await calls(r)).flatMap((c) => ('args' in c ? [c.args.join(' ')] : []));

const serveJson = async (r: Rig): Promise<unknown> => JSON.parse(await readFile(path.join(r.stubDir, 'serve.json'), 'utf8'));

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

/** A refusal: exit 3, one line on stderr, only the two status queries made, and nothing fetched, built, or started. */
async function assertRefused(r: Rig, run: Run, pattern: RegExp, expectedCommands: readonly string[]): Promise<string> {
  const { code, stderr } = await run.done;
  assert.equal(code, 3, stderr);
  const lines = stderr.trim().split('\n');
  assert.equal(lines.length, 1, stderr);
  assert.match(lines[0] ?? '', pattern);
  assert.match(lines[0] ?? '', /run npm start again\.$/);
  if (await exists(path.join(r.stubDir, 'calls.jsonl'))) assert.deepEqual(await commands(r), expectedCommands);
  assert.equal(await exists(r.outdir), false, 'nothing was built');
  return lines[0] ?? '';
}

test('--help documents every flag', async () => {
  const r = await rig({ status: HEALTHY });
  const { code, stdout } = await start(r, ['--help']).done;
  assert.equal(code, 0);
  for (const flag of ['--port', '--outdir', '--models', '--lock', '--help']) assert.ok(stdout.includes(flag), flag);
  assert.match(stdout, /default 8791/);
});

test('a usage error exits 2 with one sentence', async () => {
  const r = await rig({ status: HEALTHY });
  for (const args of [['--bogus'], ['--port', '70000']]) {
    const { code, stderr } = await start(r, args).done;
    assert.equal(code, 2, args.join(' '));
    assert.equal(stderr.trim().split('\n').length, 1, stderr);
  }
  assert.deepEqual(await commands(r), []);
});

test('refuses while a serve configuration exists, and leaves it exactly as it was', async () => {
  const r = await rig({ status: HEALTHY }, { serveConfig: SHARE_CONFIG });
  const before = await readFile(path.join(r.stubDir, 'serve.json'), 'utf8');
  await assertRefused(r, start(r), /a Tailscale serve configuration is already up .*end that sitting/, ['status --json', 'serve status --json']);
  assert.equal(await readFile(path.join(r.stubDir, 'serve.json'), 'utf8'), before);
});

test('refuses when Tailscale is not running or not logged in, quoting its Health lines', async () => {
  const stopped = await rig({ status: { BackendState: 'Stopped', Self: { Online: false, DNSName: 'stub.example.ts.net.' }, Health: ['Tailscale is stopped.'] } });
  const line = await assertRefused(stopped, start(stopped), /Tailscale is not running \(BackendState Stopped\)/, ['status --json']);
  assert.ok(line.includes('"Tailscale is stopped."'), line);
  const login = await rig({ status: { BackendState: 'NeedsLogin', Health: [] } });
  await assertRefused(login, start(login), /Tailscale is not logged in \(BackendState NeedsLogin\); log in/, ['status --json']);
});

test('refuses when Tailscale runs but cannot reach its coordination server, quoting every Health line', async () => {
  const r = await rig({ status: { BackendState: 'Running', Self: { Online: false, DNSName: 'stub.example.ts.net.' }, Health: OFFLINE_HEALTH } });
  const line = await assertRefused(r, start(r), /this Mac is offline on the tailnet/, ['status --json']);
  for (const health of OFFLINE_HEALTH) assert.ok(line.includes(`"${health}"`), health);
});

test('refuses when tailscale status fails or tailscale is not installed', async () => {
  const down = await rig({ statusExit: 1, statusStderr: 'failed to connect to local tailscaled; it doesn\'t appear to be running' });
  await assertRefused(down, start(down), /^start: tailscale status --json failed with exit 1 \(failed to connect to local tailscaled/, ['status --json']);
  const missing = await rig({}, { path: 'empty' });
  await assertRefused(missing, start(missing), /tailscale is not on PATH/, []);
});

test('refuses when its port is taken, before fetching or building', async () => {
  const r = await rig({ status: HEALTHY });
  const holder = net.createServer();
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', () => resolve()));
  const address = holder.address();
  assert.ok(address !== null && typeof address === 'object');
  try {
    await assertRefused(r, start(r, ['--port', String(address.port)]), new RegExp(`port ${address.port} on 127\\.0\\.0\\.1 is not free`), ['status --json', 'serve status --json']);
  } finally {
    holder.close();
  }
});

test('a model file the fetch refuses stops the start before anything is built or served', async () => {
  const r = await rig({ status: HEALTHY });
  const [file] = (await readFile(r.lock, 'utf8')).match(/tiny-[0-9a-f]{8}\.onnx/) ?? [];
  await writeFile(path.join(r.models, file ?? ''), 'tampered');
  const { code, stdout, stderr } = await start(r).done;
  assert.equal(code, 1, stdout + stderr);
  assert.match(stderr, /^fetch-models: .*tiny-[0-9a-f]{8}\.onnx/m);
  assert.match(stderr, /^start: tools\/fetch-models\.mjs exited with code 1, so noisy did not start; its message is above\.$/m);
  assert.equal(await exists(r.outdir), false);
  assert.deepEqual(await commands(r), ['status --json', 'serve status --json']);
});

test('Ctrl-C stops the share and the server, and leaves no listener and no configuration', async () => {
  const r = await rig({ status: HEALTHY });
  const run = start(r);
  const up = await waitUp(run);
  assert.equal((await fetch(up.url)).status, 200);
  // The share is polled for until it shows in the configuration, so the number of status queries varies.
  const queried = await commands(r);
  assert.deepEqual(queried.slice(0, 2), ['status --json', 'serve status --json']);
  assert.deepEqual(queried.filter((c) => c !== 'serve status --json'), ['status --json', `serve --https=443 http://127.0.0.1:${up.port}`]);
  assert.notDeepEqual(await serveJson(r), {});
  run.child.kill('SIGINT');
  const { code, stdout, stderr } = await run.done;
  assert.equal(code, 0, stdout + stderr);
  assert.match(stdout, /stopped; nothing it started is running and no configuration of its share is left\./);
  assert.equal(await listening(up.port), false);
  assert.equal(alive(up.serverPid), false);
  assert.equal(alive(up.sharePid), false);
  assert.deepEqual(await serveJson(r), {});
  const signals = (await calls(r)).flatMap((c) => ('signal' in c ? [{ pid: c.pid, signal: c.signal }] : []));
  assert.deepEqual(signals, [{ pid: up.sharePid, signal: 'SIGINT' }]);
  const ran = await commands(r);
  assert.ok(!ran.some((c) => c.endsWith(' off') || c === 'serve reset'), ran.join('\n'));
});

test('the share exiting on its own stops the server, and the command exits 1', async () => {
  const r = await rig({ status: HEALTHY, serveExitAfterMs: 2_000 });
  const run = start(r);
  const up = await waitUp(run);
  const { code, stderr } = await run.done;
  assert.equal(code, 1);
  assert.match(stderr, new RegExp(`^start: tailscale serve --https=443 http://127\\.0\\.0\\.1:${up.port} exited with code 1 on its own, so start is stopping the server\\.$`, 'm'));
  assert.equal(await listening(up.port), false);
  assert.equal(alive(up.serverPid), false);
  assert.deepEqual(await serveJson(r), {});
});

test('the server exiting on its own stops the share, and the command exits 1', async () => {
  const r = await rig({ status: HEALTHY });
  const run = start(r);
  const up = await waitUp(run);
  process.kill(up.serverPid, 'SIGKILL');
  const { code, stderr } = await run.done;
  assert.equal(code, 1);
  assert.match(stderr, /^start: tools\/serve\.mjs --mode production was ended by SIGKILL on its own, so start is stopping the share\.$/m);
  assert.equal(alive(up.sharePid), false);
  assert.deepEqual(await serveJson(r), {});
});

test('a configuration the share leaves behind is removed with exactly its off command, never a reset', async () => {
  const r = await rig({ status: HEALTHY, leaveConfig: true });
  const run = start(r);
  const up = await waitUp(run);
  run.child.kill('SIGINT');
  const { code, stdout, stderr } = await run.done;
  assert.equal(code, 0, stdout + stderr);
  assert.match(stdout, /the share's configuration outlived it; removing it \(tailscale serve --https=443 off\)/);
  assert.deepEqual(await serveJson(r), {});
  assert.equal(await listening(up.port), false);
  const ran = await commands(r);
  assert.deepEqual(ran.filter((c) => c.endsWith(' off') || c === 'serve reset'), ['serve --https=443 off']);
});

test('a configuration that cannot be removed is reported, and the command exits 1', async () => {
  const r = await rig({ status: HEALTHY, leaveConfig: true, ignoreOff: true });
  const run = start(r);
  const up = await waitUp(run);
  run.child.kill('SIGINT');
  const { code, stderr } = await run.done;
  assert.equal(code, 1);
  assert.match(stderr, new RegExp(`the configuration for http://127\\.0\\.0\\.1:${up.port} may still be up; run tailscale serve status`));
  assert.equal(await listening(up.port), false);
  assert.ok(!(await commands(r)).includes('serve reset'));
});

/** A `tailscale status --json` that never answers, behind a wrapper shaped like the real one. */
const HANGING_STATUS: Behavior = { status: HEALTHY, delayMs: { 'status --json': 3_600_000 } };

test('a Ctrl-C while a Tailscale check runs exits 130 and leaves no query running', async () => {
  const r = await rig(HANGING_STATUS, { wrapper: 'sh' });
  const run = start(r, [], { group: true });
  const query = await calledWith(r, 'status --json');
  interrupt(run);
  const { code, stderr } = await run.done;
  assert.equal(code, 130, stderr);
  assert.equal(stderr, 'start: interrupted before anything was started.\n');
  assert.ok(await gone(query), 'the hanging query was killed');
  assert.equal(await exists(r.outdir), false);
});

test('a Tailscale check that never answers refuses after 15 s and leaves no query running', async () => {
  const r = await rig(HANGING_STATUS, { wrapper: 'sh' });
  const run = start(r);
  const query = await calledWith(r, 'status --json');
  await assertRefused(r, run, /^start: tailscale status --json did not answer within 15 s, so Tailscale is not usable;/, ['status --json']);
  assert.ok(await gone(query), 'the hanging query was killed');
});

test('a second Ctrl-C while the leftover configuration is removed does not interrupt the removal', async () => {
  const r = await rig({ status: HEALTHY, leaveConfig: true, delayMs: { 'serve --https=443 off': 3_000 } }, { wrapper: 'sh' });
  const run = start(r, [], { group: true });
  const up = await waitUp(run);
  interrupt(run);
  await calledWith(r, 'serve --https=443 off');
  interrupt(run);
  const { code, stdout, stderr } = await run.done;
  assert.equal(code, 0, stdout + stderr);
  assert.match(stdout, /stopped; nothing it started is running and no configuration of its share is left\./);
  assert.deepEqual(await serveJson(r), {});
  assert.equal(await listening(up.port), false);
});
