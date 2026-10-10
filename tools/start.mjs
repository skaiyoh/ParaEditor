#!/usr/bin/env node
// npm start: runs the current production build of noisy on this Mac and
// shares it to the tailnet until Ctrl-C. Dependency-free; Node 25.
//
//   node tools/start.mjs [--port 8791] [--outdir build/production] [--models models]
//        [--lock models.lock.json]
//
// In order: refuse unless Tailscale is usable and no serve configuration
// exists; fetch and verify the model files (tools/fetch-models.mjs); build the
// production bundle (tools/build.mjs); start tools/serve.mjs --mode production
// on 127.0.0.1; run `tailscale serve --https=443` to it in the foreground;
// print the tailnet URL. Ctrl-C stops both children, and either child exiting
// stops the other. Afterwards no process it started is running, and if the
// share's configuration outlived the share, the command removes that one
// configuration with `tailscale serve --https=443 off`; it never runs
// `tailscale serve reset`.
// docs/ARCHITECTURE.md ("The start command") documents the output, the
// refusals, and the exit codes.

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';
/** The owner's port; the dev server's default is 8790. */
const DEFAULT_PORT = 8791;
/** Exit codes, documented in docs/ARCHITECTURE.md. */
const EXIT = { stopped: 0, failed: 1, usage: 2, refused: 3, interrupted: 130 };
/** How long a tailscale query may take before it counts as failed. */
const QUERY_MS = 15_000;
/** How long the server has to print its address, and the share to appear in the serve configuration. */
const START_MS = 30_000;
/** How long a child has to exit after its signal before it is killed. */
const STOP_MS = 5_000;
const LISTENING = /^serve: production mode on (http:\/\/127\.0\.0\.1:(\d+)\/)$/m;

const USAGE = `usage: npm start [-- flags]   (or node tools/start.mjs [flags])

Runs the current production build of noisy on this Mac and shares it to your
tailnet over HTTPS until you press Ctrl-C. It refuses to start while a Tailscale
serve configuration exists, as a phone sitting leaves it, or while Tailscale is
not usable.

Flags:
  --port <n>       port of the production server on ${HOST} (default ${DEFAULT_PORT}; 0 picks a free one)
  --outdir <dir>   where the production build is written and served from (default build/production)
  --models <dir>   the model files, fetched and verified, served at /models/ (default models)
  --lock <file>    the model lock the fetch verifies and the build carries (default models.lock.json)
  -h, --help       print this help

Exit status: 0 stopped by Ctrl-C (or SIGTERM or SIGHUP) with both children stopped
and no configuration of its share left; 1 a step failed or a child exited on its
own; 2 a usage error; 3 refused before changing anything; 130 interrupted before
noisy was up.`;

const say = (line) => process.stdout.write(`start: ${line}\n`);
const complain = (line) => process.stderr.write(`start: ${line}\n`);

// A closed terminal must not turn a write into an uncaught exception.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

function parseFlags() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        port: { type: 'string', default: String(DEFAULT_PORT) },
        outdir: { type: 'string', default: path.join(REPO, 'build/production') },
        models: { type: 'string', default: path.join(REPO, 'models') },
        lock: { type: 'string', default: path.join(REPO, 'models.lock.json') },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (e) {
    complain(`${e.message}; npm start -- --help lists the flags.`);
    process.exit(EXIT.usage);
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(EXIT.stopped);
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    complain(`--port must be an integer from 0 to 65535, not "${values.port}".`);
    process.exit(EXIT.usage);
  }
  return { port, outdir: path.resolve(values.outdir), models: path.resolve(values.models), lock: path.resolve(values.lock) };
}

// ---------------------------------------------------------------- tailscale queries

/** The tailscale queries in flight, each in a process group of its own. */
const queries = new Set();

/** Kills every query in flight, with its whole process group. */
function killQueries() {
  for (const child of queries) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

// A query must not outlive the command, whichever way it exits.
process.on('exit', killQueries);

/**
 * Runs a command to completion and collects its output; never rejects. The
 * command runs in a process group of its own, so a Ctrl-C in the terminal does
 * not reach it, and after QUERY_MS the whole group is killed and the query
 * resolves as timed out, whatever the group's processes still hold open (the
 * `tailscale` on PATH can be a shell script that runs the real CLI as its own
 * child).
 */
function query(command, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', error: e, timedOut: false });
      return;
    }
    queries.add(child);
    let stdout = '';
    let stderr = '';
    const finish = (result) => {
      clearTimeout(timer);
      queries.delete(child);
      resolve({ stdout, stderr, ...result });
    };
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
      child.stdout.destroy();
      child.stderr.destroy();
      finish({ code: null, signal: null, error: null, timedOut: true });
    }, QUERY_MS);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (error) => finish({ code: null, signal: null, error, timedOut: false }));
    child.on('close', (code, signal) => finish({ code, signal, error: null, timedOut: false }));
  });
}

const firstLine = (text) => text.trim().split('\n')[0] ?? '';

/** Why a finished query failed, in a clause, or null when it succeeded. */
function queryFailure(command, result) {
  if (result.error?.code === 'ENOENT') return null;
  if (result.error) return `${command} could not run (${result.error.message})`;
  if (result.timedOut) return `${command} did not answer within ${QUERY_MS / 1000} s`;
  if (result.signal) return `${command} was ended by ${result.signal}`;
  if (result.code !== 0) return `${command} failed with exit ${result.code}${result.stderr.trim() ? ` (${firstLine(result.stderr)})` : ''}`;
  return null;
}

/** The serve configuration as `tailscale serve status --json` prints it, or { failure }. */
async function serveConfig() {
  const command = 'tailscale serve status --json';
  const result = await query('tailscale', ['serve', 'status', '--json']);
  const failure = queryFailure(command, result) ?? (result.error ? `${command} could not run: tailscale is not on PATH` : null);
  if (failure !== null) return { failure };
  try {
    const config = JSON.parse(result.stdout.trim() || '{}');
    if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new Error('not an object');
    return { config };
  } catch {
    return { failure: `${command} printed something that is not a JSON object` };
  }
}

/** Whether a serve configuration holds anything at all; `{}` is no configuration. */
function hasAnyConfig(config) {
  return Object.values(config).some((v) => v !== null && v !== false && !(typeof v === 'object' && Object.keys(v).length === 0));
}

/** Whether any handler anywhere in the configuration, foreground sessions included, proxies to `target`. */
function proxiesTo(config, target) {
  if (config === null || typeof config !== 'object') return false;
  if (config.Proxy === target) return true;
  return Object.values(config).some((v) => proxiesTo(v, target));
}

/**
 * Refuses, with one sentence and exit 3, unless Tailscale is usable and no
 * serve configuration exists. Returns this Mac's MagicDNS name.
 */
async function preflight() {
  const refuse = (sentence) => {
    complain(sentence);
    process.exit(EXIT.refused);
  };
  const status = await query('tailscale', ['status', '--json']);
  if (status.error?.code === 'ENOENT') {
    refuse('tailscale is not on PATH, so noisy cannot be shared to the phone; install Tailscale with its command-line tool, then run npm start again.');
  }
  const failed = queryFailure('tailscale status --json', status);
  if (failed !== null) refuse(`${failed}, so Tailscale is not usable; open the Tailscale app and connect it, then run npm start again.`);
  let parsed;
  try {
    parsed = JSON.parse(status.stdout);
  } catch {
    refuse('tailscale status --json printed something that is not JSON, so start cannot tell whether Tailscale is usable; check that tailscale status works, then run npm start again.');
  }
  const health = Array.isArray(parsed?.Health) ? parsed.Health.filter((h) => typeof h === 'string') : [];
  const reports = health.length > 0 ? `; Tailscale reports: ${health.map((h) => `"${h.trim()}"`).join('; ')}` : '';
  const state = parsed?.BackendState;
  if (state === 'NeedsLogin' || state === 'NeedsMachineAuth') {
    refuse(`Tailscale is not logged in (BackendState ${state})${reports}; log in from the Tailscale app or with tailscale up, then run npm start again.`);
  }
  if (state !== 'Running') {
    refuse(`Tailscale is not running (BackendState ${state ?? 'missing'})${reports}; connect it from the Tailscale app or with tailscale up, then run npm start again.`);
  }
  if (parsed?.Self?.Online !== true) {
    refuse(`Tailscale is running but this Mac is offline on the tailnet, so the phone could not reach noisy${reports}; connect to a network where Tailscale can reach its coordination server, then run npm start again.`);
  }
  const dnsName = typeof parsed.Self.DNSName === 'string' ? parsed.Self.DNSName.replace(/\.$/, '') : '';
  if (dnsName === '') refuse('tailscale status --json shows no MagicDNS name for this Mac, so there is no tailnet URL to share; turn on MagicDNS for the tailnet, then run npm start again.');
  const serve = await serveConfig();
  if (serve.failure !== undefined) refuse(`${serve.failure}, so start cannot tell whether a share is already up; check that tailscale serve status works, then run npm start again.`);
  if (hasAnyConfig(serve.config)) {
    refuse('a Tailscale serve configuration is already up (tailscale serve status shows it), as a phone sitting or another npm start leaves it; end that sitting or stop the other npm start, then run npm start again.');
  }
  return dnsName;
}

/** Refuses with exit 3 when the fixed port is already taken, before anything is fetched or built. */
async function checkPortFree(port) {
  if (port === 0) return;
  const probe = net.createServer();
  const error = await new Promise((resolve) => {
    probe.once('error', resolve);
    probe.listen(port, HOST, () => probe.close(() => resolve(null)));
  });
  if (error !== null) {
    complain(`port ${port} on ${HOST} is not free (${error.code ?? error.message}), perhaps held by an earlier npm start; stop whatever listens there or pass --port with a free port, then run npm start again.`);
    process.exit(EXIT.refused);
  }
}

// ---------------------------------------------------------------- children

/**
 * A child in a process group of its own, so the terminal's Ctrl-C does not
 * reach it, and this command stops each child in turn. Output is passed
 * through, and `onOutput` sees it as it arrives.
 */
function startChild(label, command, args, onOutput = () => {}) {
  const child = spawn(command, args, { cwd: REPO, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: null, signal: null, error }));
    child.once('exit', (code, signal) => resolve({ code, signal, error: null }));
  });
  for (const [stream, sink] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.on('data', (d) => {
      sink.write(d);
      onOutput(d.toString());
    });
  }
  let exited = false;
  exit.then(() => (exited = true));
  return {
    label,
    child,
    exit,
    get exited() {
      return exited;
    },
    /** Signals the child's group, then SIGKILLs it if it has not exited within STOP_MS. */
    async stop(signal) {
      if (exited) return exit;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // Already gone.
      }
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }, STOP_MS);
      const result = await exit;
      clearTimeout(timer);
      return result;
    },
  };
}

const describeExit = ({ code, signal, error }) => (error ? `could not run (${error.message})` : signal ? `was ended by ${signal}` : `exited with code ${code}`);

/** Runs one preparation step to completion; a signal meanwhile is passed on to it. */
async function step(label, args, state) {
  const child = startChild(label, process.execPath, args);
  state.current = child;
  const result = await child.exit;
  state.current = null;
  if (state.signal !== null) {
    complain(`interrupted during ${label}; nothing was started.`);
    process.exit(EXIT.interrupted);
  }
  if (result.code !== 0) {
    complain(`${label} ${describeExit(result)}, so noisy did not start; its message is above.`);
    process.exit(EXIT.failed);
  }
}

async function main() {
  const flags = parseFlags();
  // Before noisy is up, a signal interrupts the step in progress.
  const prep = { current: null, signal: null };
  const onPrepSignal = (signal) => {
    if (prep.current === null) {
      // Only the Tailscale checks run outside a step, and they change nothing;
      // the exit handler kills a query still in flight.
      complain('interrupted before anything was started.');
      process.exit(EXIT.interrupted);
    }
    prep.signal = signal;
    // The build is left to finish, so it never leaves its staging directory
    // behind; the fetch removes its partial download on SIGINT.
    if (prep.current?.label.startsWith('tools/fetch-models.mjs')) prep.current.stop('SIGINT');
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const s of signals) process.on(s, onPrepSignal);

  say('checking Tailscale (tailscale status --json, tailscale serve status --json)');
  const dnsName = await preflight();
  await checkPortFree(flags.port);

  say('fetching and verifying the model files (tools/fetch-models.mjs)');
  await step('tools/fetch-models.mjs', [path.join(REPO, 'tools/fetch-models.mjs'), '--models', flags.models, '--lock', flags.lock], prep);
  say('building the production bundle (tools/build.mjs --mode production)');
  await step('tools/build.mjs --mode production', [path.join(REPO, 'tools/build.mjs'), '--mode', 'production', '--outdir', flags.outdir, '--lock', flags.lock], prep);

  // From here on two children run, and every way out goes through stopAll.
  const children = [];
  let stopping = null;
  let up = false;
  /** The server's URL once it listens, which the share proxies to. */
  let target = null;
  /** Stops the share, then the server, removes a configuration the share left, and exits. */
  const stopAll = (why, code) =>
    (stopping ??= (async () => {
      if (why) complain(why);
      say('stopping the share and the server');
      // The share first, with the SIGINT a Ctrl-C would give it, so it takes
      // down its own configuration; then the server.
      for (const c of [...children].reverse()) {
        const result = await c.stop(c.label.startsWith('tailscale') ? 'SIGINT' : 'SIGTERM');
        if (result.signal === 'SIGKILL') complain(`${c.label} did not stop within ${STOP_MS / 1000} s and was killed.`);
      }
      // A configuration that could not be removed outranks how the run ended.
      if (target !== null && (await removeLeftover(target)) !== EXIT.stopped) code = EXIT.failed;
      if (code === EXIT.stopped) say(`stopped; nothing it started is running and no configuration of its share is left.`);
      process.exit(code);
    })());
  let firstSignalAt = 0;
  for (const s of signals) {
    process.off(s, onPrepSignal);
    process.on(s, () => {
      if (stopping === null) {
        firstSignalAt = Date.now();
        return stopAll(null, up ? EXIT.stopped : EXIT.interrupted);
      }
      // Under npm start one Ctrl-C in a terminal reaches this process twice,
      // so only a signal more than a second after the first is the owner
      // asking again.
      if (Date.now() - firstSignalAt > 1000) say(`already stopping; each child gets at most ${STOP_MS / 1000} s before it is killed`);
      return undefined;
    });
  }
  process.on('uncaughtException', (e) => stopAll(`start failed: ${e.stack ?? e.message}`, EXIT.failed));
  process.on('unhandledRejection', (e) => stopAll(`start failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`, EXIT.failed));
  if (prep.signal !== null) return stopAll(null, EXIT.interrupted);

  say(`starting the production server (tools/serve.mjs --mode production on ${HOST}:${flags.port})`);
  let serveOutput = '';
  let announce;
  const listening = new Promise((resolve) => (announce = resolve));
  const serve = startChild(
    'tools/serve.mjs --mode production',
    process.execPath,
    [path.join(REPO, 'tools/serve.mjs'), '--mode', 'production', '--port', String(flags.port), '--root', flags.outdir, '--models', flags.models],
    (text) => {
      serveOutput += text;
      const m = LISTENING.exec(serveOutput);
      if (m !== null) announce({ url: m[1], port: Number(m[2]) });
    },
  );
  children.push(serve);
  serve.exit.then((result) => stopAll(`${serve.label} ${describeExit(result)}${target === null ? ' before it was listening' : ' on its own'}, so start is stopping the share.`, EXIT.failed));
  const address = await Promise.race([listening, sleep(START_MS).then(() => null)]);
  if (address === null) return stopAll(`${serve.label} printed no address within ${START_MS / 1000} s.`, EXIT.failed);
  if (stopping !== null) return undefined;

  target = `http://${HOST}:${address.port}`;
  const shareLabel = `tailscale serve --https=443 ${target}`;
  say(`sharing it over Tailscale (${shareLabel})`);
  const share = startChild(shareLabel, 'tailscale', ['serve', '--https=443', target]);
  children.push(share);
  share.exit.then((result) => stopAll(`${shareLabel} ${describeExit(result)} on its own, so start is stopping the server.`, EXIT.failed));
  if (!(await shareAppears(target, () => stopping !== null))) {
    return stopAll(`${shareLabel} did not show up in tailscale serve status --json within ${START_MS / 1000} s; its output is above.`, EXIT.failed);
  }
  if (stopping !== null) return undefined;
  up = true;
  say(`noisy is up at https://${dnsName}/`);
  say(`server pid ${serve.child.pid}, share pid ${share.child.pid}; press Ctrl-C to stop both`);
  return undefined;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls the serve configuration until a handler proxies to `target`; false on timeout or when `cancelled`. */
async function shareAppears(target, cancelled) {
  const deadline = Date.now() + START_MS;
  while (Date.now() < deadline && !cancelled()) {
    const serve = await serveConfig();
    if (serve.config !== undefined && proxiesTo(serve.config, target)) return true;
    await sleep(250);
  }
  return false;
}

/**
 * After both children stopped: if the serve configuration still proxies to
 * this command's server, remove exactly that with `tailscale serve
 * --https=443 off`, the share this command created, and check again.
 * Returns the exit code the outcome calls for.
 */
async function removeLeftover(target) {
  const before = await serveConfig();
  if (before.failure !== undefined) {
    complain(`${before.failure}, so start cannot tell whether its share's configuration is gone; run tailscale serve status, and if it lists ${target}, run tailscale serve --https=443 off.`);
    return EXIT.failed;
  }
  if (!proxiesTo(before.config, target)) return EXIT.stopped;
  say(`the share's configuration outlived it; removing it (tailscale serve --https=443 off)`);
  const off = await query('tailscale', ['serve', '--https=443', 'off']);
  const offFailed = queryFailure('tailscale serve --https=443 off', off) ?? (off.error ? 'tailscale serve --https=443 off could not run' : null);
  const after = await serveConfig();
  if (offFailed !== null || after.failure !== undefined || proxiesTo(after.config, target)) {
    complain(`${offFailed ?? 'tailscale serve --https=443 off ran'} but the configuration for ${target} may still be up; run tailscale serve status to see it before the next npm start or phone sitting.`);
    return EXIT.failed;
  }
  return EXIT.stopped;
}

await main();
