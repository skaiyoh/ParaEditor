// A stand-in for the `tailscale` command, so tools/start.mjs can be tested
// with no tailnet. test/start.test.ts puts a `tailscale` script that runs this
// file first on PATH. Its state lives in the directory TAILSCALE_STUB_DIR names:
//
//   behavior.json  what it answers (Behavior below)
//   serve.json     the serve configuration, as `tailscale serve status --json` prints it
//   calls.jsonl    one line per invocation ({ pid, args }) and per signal ({ pid, signal })
//
// It answers `status --json`, `serve status [--json]`, a foreground
// `serve --https=443 <target>`, which writes its configuration under
// Foreground and stays up until signalled, `serve --https=443 off`, which
// removes every port-443 handler, and `serve reset`, which it records and
// obeys so a test can assert it never ran. Any answer can be delayed
// (Behavior.delayMs). The shape of serve.json (TCP, Web, and Foreground keyed
// by session) is a model of what `tailscale serve status --json` prints, not
// checked against a real share's output; the stub is a model of tailscale, not
// tailscale.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type Behavior = {
  /** What `status --json` prints. */
  readonly status?: unknown;
  /** `status --json` exits with this code and prints statusStderr instead. */
  readonly statusExit?: number;
  readonly statusStderr?: string;
  /** The foreground share exits with code 1 on its own this many ms after it starts. */
  readonly serveExitAfterMs?: number;
  /** On a signal the foreground share exits without removing its configuration. */
  readonly leaveConfig?: boolean;
  /** `serve --https=443 off` succeeds without removing anything. */
  readonly ignoreOff?: boolean;
  /**
   * Milliseconds the stub waits before answering, by command line (such as
   * `status --json`); a slow tailscaled, or with an hour, one that never answers.
   */
  readonly delayMs?: Readonly<Record<string, number>>;
};

type Config = Record<string, unknown>;

const dir = process.env['TAILSCALE_STUB_DIR'];
if (dir === undefined) {
  process.stderr.write('tailscale stub: TAILSCALE_STUB_DIR is not set\n');
  process.exit(2);
}
const file = (name: string): string => path.join(dir, name);
const args = process.argv.slice(2);
const record = (row: Record<string, unknown>): void => appendFileSync(file('calls.jsonl'), `${JSON.stringify({ pid: process.pid, ...row })}\n`);

function readJson(name: string, fallback: unknown): unknown {
  try {
    return JSON.parse(readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

const behavior = readJson('behavior.json', {}) as Behavior;
const readConfig = (): Config => readJson('serve.json', {}) as Config;
const writeConfig = (config: Config): void => writeFileSync(file('serve.json'), JSON.stringify(config));

/** The configuration with every port-443 handler removed, foreground sessions included. */
function without443(config: Config): Config {
  const strip = (c: Config): Config => {
    const out: Config = {};
    for (const [key, value] of Object.entries(c)) {
      if (key === 'TCP' || key === 'Web') {
        const kept = Object.fromEntries(Object.entries(value as Config).filter(([k]) => k !== '443' && !k.endsWith(':443')));
        if (Object.keys(kept).length > 0) out[key] = kept;
      } else if (key === 'Foreground') {
        const sessions = Object.fromEntries(Object.entries(value as Config).map(([id, s]) => [id, strip(s as Config)]).filter(([, s]) => Object.keys(s as Config).length > 0));
        if (Object.keys(sessions).length > 0) out[key] = sessions;
      } else {
        out[key] = value;
      }
    }
    return out;
  };
  return strip(config);
}

record({ args });
const command = args.join(' ');
const delay = behavior.delayMs?.[command];
if (delay === undefined) answer();
else setTimeout(answer, delay);

function answer(): void {
  if (command === 'status --json') {
    if (behavior.statusExit !== undefined) {
      process.stderr.write(`${behavior.statusStderr ?? ''}\n`);
      process.exit(behavior.statusExit);
    }
    process.stdout.write(`${JSON.stringify(behavior.status ?? {}, null, 2)}\n`);
    process.exit(0);
  }

  if (command === 'serve status --json') {
    process.stdout.write(`${JSON.stringify(readConfig(), null, 2)}\n`);
    process.exit(0);
  }

  if (command === 'serve status') {
    const config = readConfig();
    process.stdout.write(Object.keys(config).length === 0 ? 'No serve config\n' : `${JSON.stringify(config, null, 2)}\n`);
    process.exit(0);
  }

  if (command === 'serve --https=443 off') {
    if (behavior.ignoreOff !== true) writeConfig(without443(readConfig()));
    process.exit(0);
  }

  if (command === 'serve reset') {
    writeConfig({});
    process.exit(0);
  }

  const share = /^serve --https=443 (\S+)$/.exec(command);
  if (share !== null) {
    const target = share[1] ?? '';
    const session = `stub-${process.pid}`;
    const handler = { TCP: { '443': { HTTPS: true } }, Web: { 'stub.example.ts.net:443': { Handlers: { '/': { Proxy: target } } } } };
    const config = readConfig();
    writeConfig({ ...config, Foreground: { ...(config['Foreground'] as Config | undefined), [session]: handler } });
    process.stdout.write(`Available within your tailnet:\n\nhttps://stub.example.ts.net/\n|-- proxy ${target}\n\nPress Ctrl+C to exit.\n`);
    const end = (code: number): never => {
      if (behavior.leaveConfig !== true) {
        const now = readConfig();
        const sessions = { ...(now['Foreground'] as Config | undefined) };
        delete sessions[session];
        const { Foreground: _, ...rest } = now;
        writeConfig(Object.keys(sessions).length > 0 ? { ...rest, Foreground: sessions } : rest);
      }
      process.exit(code);
    };
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => {
        record({ signal });
        end(0);
      });
    }
    if (behavior.serveExitAfterMs !== undefined) {
      setTimeout(() => {
        process.stderr.write('tailscale stub: the share ended on its own\n');
        end(1);
      }, behavior.serveExitAfterMs);
    }
    setInterval(() => {}, 1 << 30);
  } else {
    process.stderr.write(`tailscale stub: unexpected arguments: ${command}\n`);
    process.exit(2);
  }
}
