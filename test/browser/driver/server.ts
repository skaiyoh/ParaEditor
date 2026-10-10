// The server a scenario runs against. A scenario names a target, the kind of
// server and the build it serves; the driver starts that server for the
// scenario alone, on a free port, with its results sink, request log, and CSP
// reports in the scenario's directory, or attaches to one already running at
// a base URL. The levers (fault state, sink, request log, CSP reports) are
// the dev server's dev-mode routes and files; the production mode has none.

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from '../../../src/core/zod.ts';
import { EnvironmentError, exited, killGroup, stopGroup, type Cleanup } from './processes.ts';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export type BuildMode = 'dev' | 'production';

/**
 * The tools/serve.mjs modes a target can name, as its MODES table defines
 * them: whether the mode has the dev surfaces (the fault state, the sink, the
 * request log, and the CSP report endpoint) and takes the flags that place
 * their files.
 */
export const SERVER_MODES = {
  dev: { devSurfaces: true },
  production: { devSurfaces: false },
} as const satisfies Record<string, { readonly devSurfaces: boolean }>;

export type ServerMode = keyof typeof SERVER_MODES;

/** How a target's server is started: the tools/serve.mjs mode and the build output it serves. */
export type TargetSpec = { readonly server: ServerMode; readonly build: BuildMode; readonly summary: string };

export const TARGETS = {
  dev: { server: 'dev', build: 'dev', summary: 'the dev server serving the dev build' },
  'dev-production-build': { server: 'dev', build: 'production', summary: 'the dev server serving the production build (--root)' },
  production: { server: 'production', build: 'production', summary: 'the production server, as npm start runs it, serving the production build' },
} as const satisfies Record<string, TargetSpec>;

export type TargetName = keyof typeof TARGETS;

export function isTargetName(name: string): name is TargetName {
  return Object.hasOwn(TARGETS, name);
}

/** The served build's build.json (docs/ARCHITECTURE.md, "Build"), as far as scenarios read it. */
export const BuildInfo = z.object({
  mode: z.enum(['dev', 'production']),
  buildId: z.string(),
  app: z.string(),
  workers: z.record(z.string(), z.string()),
  devPages: z.record(z.string(), z.string()),
  ort: z.object({ version: z.string(), dir: z.string(), files: z.array(z.string()) }),
});
export type BuildInfo = z.infer<typeof BuildInfo>;

/** A line of the sink's log.jsonl: a JSON row, or a binary capture's record. */
export const SinkLine = z.union([
  z.object({ at: z.string(), row: z.unknown() }),
  z.object({
    at: z.string(),
    capture: z.object({ path: z.string(), file: z.string(), bytes: z.number(), sha256: z.string(), contentType: z.string().nullable(), name: z.string() }),
  }),
]);
export type SinkLine = z.infer<typeof SinkLine>;

export const RequestLine = z.object({
  seq: z.number(),
  at: z.string(),
  method: z.string(),
  path: z.string(),
  headers: z.record(z.string(), z.string()),
  status: z.number(),
  fault: z.string().nullable(),
});
export type RequestLine = z.infer<typeof RequestLine>;

export type ServerLevers = {
  /** Replaces the fault state (POST /dev/fault); rejects with the server's reason when a rule is invalid. */
  setFaults(rules: readonly string[]): Promise<void>;
  clearFaults(): Promise<void>;
  /** The sink's log.jsonl, read from the file of a server this run started. */
  sinkLines(): Promise<readonly SinkLine[]>;
  /** The request log (GET /dev/requests), every row since the server started. */
  requestLog(): Promise<readonly RequestLine[]>;
  /** The CSP reports the server stored (GET /dev/csp-report). */
  cspReports(): Promise<readonly unknown[]>;
};

export type Server = {
  /** The origin with a trailing slash, such as http://127.0.0.1:53211/. */
  readonly url: string;
  readonly target: TargetName;
  /** Whether this run started the server, or attached to one at --base-url. */
  readonly started: boolean;
  /** Whether the server's mode has the dev surfaces; without them every lever throws. */
  readonly devSurfaces: boolean;
  /** The file holding the server's output, for a server this run started. */
  readonly logFile: string | null;
  readonly levers: ServerLevers;
  readonly build: BuildInfo;
  stop(): Promise<void>;
};

async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url} answered ${res.status}: ${(await res.text()).trim().slice(0, 300)}`);
  return res;
}

function createLevers(url: string, sinkFile: string | null, mode: ServerMode): ServerLevers {
  if (!SERVER_MODES[mode].devSurfaces) {
    const none = async (): Promise<never> => {
      throw new Error(`the ${mode} server has no fault state, sink, request log, or CSP report endpoint`);
    };
    return { setFaults: none, clearFaults: none, sinkLines: none, requestLog: none, cspReports: none };
  }
  return {
    async setFaults(rules) {
      await fetchOk(new URL('/dev/fault', url).href, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rules }) });
    },
    async clearFaults() {
      await fetchOk(new URL('/dev/fault', url).href, { method: 'DELETE' });
    },
    async sinkLines() {
      if (sinkFile === null) {
        throw new Error('the sink is read from the files of a server this run started, and this run attached to a server with --base-url; a scenario that reads it declares readsSinkFiles, so an attached run skips it');
      }
      let text = '';
      try {
        text = await readFile(sinkFile, 'utf8');
      } catch {
        return [];
      }
      return text.split('\n').filter(Boolean).map((line) => SinkLine.parse(JSON.parse(line)));
    },
    async requestLog() {
      return z.array(RequestLine).parse(await (await fetchOk(new URL('/dev/requests', url).href)).json());
    },
    async cspReports() {
      return z.array(z.unknown()).parse(await (await fetchOk(new URL('/dev/csp-report', url).href)).json());
    },
  };
}

/** The build output each mode's npm script writes, which the driver serves unless a flag names another. */
export const DEFAULT_ROOTS: Readonly<Record<BuildMode, string>> = { dev: path.join(REPO, 'build/dev'), production: path.join(REPO, 'build/production') };

const ROOT_FLAG: Readonly<Record<BuildMode, string>> = { dev: '--dev-root', production: '--production-root' };

/** What to do when `root` holds no `mode` build: run the npm script for the default root; for any other, name the flag and how to build one. */
function fixFor(mode: BuildMode, root: string): string {
  const script = mode === 'dev' ? 'npm run build' : 'npm run build:production';
  if (path.resolve(root) === DEFAULT_ROOTS[mode]) return `run ${script}`;
  return `pass a ${ROOT_FLAG[mode]} that holds a ${mode} build (node tools/build.mjs --mode ${mode} --outdir <dir> writes one), or drop ${ROOT_FLAG[mode]} and run ${script}`;
}

/** Checks a build output on disk before anything starts, so a missing build fails before Chrome launches. */
export async function checkBuildRoot(root: string, mode: BuildMode): Promise<void> {
  let info: BuildInfo;
  try {
    info = BuildInfo.parse(JSON.parse(await readFile(path.join(root, 'build.json'), 'utf8')));
  } catch (e) {
    throw new EnvironmentError(`${root} holds no readable build.json (${e instanceof Error ? e.message : String(e)}); ${fixFor(mode, root)}`);
  }
  if (info.mode !== mode) throw new EnvironmentError(`${root} holds a ${info.mode} build where a ${mode} build is needed; ${fixFor(mode, root)}`);
}

async function readBuild(url: string, target: TargetName, where: string, fix: string): Promise<BuildInfo> {
  const expected = TARGETS[target].build;
  let res: Response;
  try {
    res = await fetch(new URL('/build.json', url).href);
  } catch (e) {
    throw new EnvironmentError(`no server answers at ${url} (${e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e)}); start it, or check --base-url`);
  }
  let info: BuildInfo;
  try {
    if (!res.ok) throw new Error(`GET /build.json answered ${res.status}`);
    info = BuildInfo.parse(await res.json());
  } catch (e) {
    throw new EnvironmentError(`${where} serves no readable build.json (${e instanceof Error ? e.message : String(e)}); ${fix}`);
  }
  if (info.mode !== expected) throw new EnvironmentError(`${where} serves a ${info.mode} build, but target ${target} needs a ${expected} build; ${fix}`);
  return info;
}

const LISTENING = /^serve: \w+ mode on (http:\/\/127\.0\.0\.1:\d+\/)$/m;

/**
 * Starts tools/serve.mjs for one scenario: `--port 0`, the target's build
 * root, and its results, request log, and output (serve.log) under `dir`.
 */
export async function startServer(options: { readonly target: TargetName; readonly root: string; readonly dir: string; readonly cleanup: Cleanup }): Promise<Server> {
  const spec = TARGETS[options.target];
  const args = [
    path.join(REPO, 'tools/serve.mjs'),
    '--mode', spec.server,
    '--port', '0',
    '--root', options.root,
    ...(SERVER_MODES[spec.server].devSurfaces ? ['--results', path.join(options.dir, 'results'), '--request-log', path.join(options.dir, 'requests.jsonl')] : []),
  ];
  const child = spawn(process.execPath, args, { cwd: REPO, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => (stopping ??= stopGroup(child, 'SIGTERM', 5000));
  const unregister = options.cleanup.add(`the ${options.target} server`, stop, () => killGroup(child, 'SIGKILL'));
  const logFile = path.join(options.dir, 'serve.log');
  const log = createWriteStream(logFile);
  let output = '';
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new EnvironmentError(`tools/serve.mjs printed no URL within 10 s: ${output.trim()}`)), 10_000);
    const onData = (chunk: Buffer): void => {
      log.write(chunk);
      output += chunk.toString();
      const found = LISTENING.exec(output)?.[1];
      if (found !== undefined) {
        clearTimeout(timer);
        resolve(found);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', (e) => reject(new EnvironmentError(`tools/serve.mjs did not start: ${e.message}`)));
    child.once('exit', (code) => reject(new EnvironmentError(`tools/serve.mjs exited with ${code} before listening: ${output.trim()}`)));
  }).catch(async (e: unknown) => {
    await stop();
    throw e;
  });
  const build = await readBuild(url, options.target, `${options.root}, served by tools/serve.mjs`, fixFor(spec.build, options.root));
  return {
    url,
    target: options.target,
    started: true,
    devSurfaces: SERVER_MODES[spec.server].devSurfaces,
    logFile,
    levers: createLevers(url, path.join(options.dir, 'results', 'log.jsonl'), spec.server),
    build,
    async stop() {
      await stop();
      await exited(child);
      log.end();
      unregister();
    },
  };
}

/** A server someone else started; the driver neither starts nor stops it. */
export async function attachServer(baseUrl: string, target: TargetName): Promise<Server> {
  const url = new URL('/', baseUrl).href;
  return {
    url,
    target,
    started: false,
    devSurfaces: SERVER_MODES[TARGETS[target].server].devSurfaces,
    logFile: null,
    levers: createLevers(url, null, TARGETS[target].server),
    build: await readBuild(url, target, url, `serve a ${TARGETS[target].build} build there, or pass the --target that server serves`),
    stop: async () => undefined,
  };
}
