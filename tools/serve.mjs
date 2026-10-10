#!/usr/bin/env node
// noisy's server: static files with the headers.json contract. Dependency-free; Node 25.
//
//   node tools/serve.mjs --mode dev|production [--port 8790] [--root build/<mode>]
//        [--models models] [--vendor-ort <root>/vendor/ort] [--headers headers.json]
//        [--host 127.0.0.1] [--tls .local/tls]
//        [--results test-results] [--request-log test-results/requests.jsonl]   (dev only)
//
// Dev mode adds the dev-only surfaces: the fault state (/dev/fault), the
// results sink (/api/log), the request log (/dev/requests), a report-only
// copy of the CSP whose reports land at /dev/csp-report, and the synth
// fixture's master as raw RGBA bytes (/dev/synth/master).
// Production mode, which tools/start.mjs runs, has none of them, writes
// nothing to disk, and answers 404 for /dev and /api and every path under
// them, however the request spells them, and for a file under dev/ or api/ of
// its root reached through any mount. A request Node's HTTP parser rejects
// gets Node's own answer before this server sees it.
// docs/ARCHITECTURE.md ("Dev server") documents every route, the fault
// grammar, and the file formats.

import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { expectedHeaders, loadHeaderContract } from './headers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Largest JSON row the sink accepts. */
const MAX_ROW_BYTES = 1024 * 1024;
/** Largest binary capture the sink accepts. */
const MAX_CAPTURE_BYTES = 256 * 1024 * 1024;
const FAULT_PREFIXES = ['/models/', '/vendor/ort/'];
/** Longest delay a slow fault takes: setTimeout's limit. */
const MAX_SLOW_MS = 2 ** 31 - 1;
/** Where browsers send the report-only CSP's violation reports, in dev mode. */
const CSP_REPORT_PATH = '/dev/csp-report';
/** Largest CSP report the endpoint accepts. */
const MAX_REPORT_BYTES = 64 * 1024;
/** Where dev mode serves the synth fixture's master, and the module it paints with. */
const SYNTH_MASTER_PATH = '/dev/synth/master';
const SYNTH_MODULE = path.join(REPO, 'test', 'fixtures', 'synth', 'synth.ts');
/** The largest side the synth master route paints. */
const MAX_SYNTH_SIDE = 4096;
/** How many painted masters the route keeps, the least recently asked for dropped first. */
const SYNTH_HELD = 4;
/**
 * Each mode says whether it carries the dev-only surfaces (fault state,
 * results sink, request log, and their routes) and which build output it
 * serves at / unless --root says otherwise.
 */
const MODES = {
  dev: { dev: true, root: 'build/dev' },
  production: { dev: false, root: 'build/production' },
};
/**
 * The first path segments of the dev-only surfaces and dev pages, which
 * production mode answers 404 for, compared without regard to case.
 */
const DEV_ONLY_SEGMENTS = new Set(['dev', 'api']);

const USAGE = `usage: node tools/serve.mjs --mode dev|production [flags]
  --mode         dev (with the fault state, sink, request log, and CSP reports) or production (none of them)
  --port         port (default 8790; 0 picks a free port)
  --host         bind address (default 127.0.0.1; 0.0.0.0 for LAN access)
  --tls          certificate directory containing server.pem and server-key.pem (default HTTP)
  --root         build output to serve at / (default build/<mode>)
  --models       directory served at /models/ (default models)
  --vendor-ort   directory served at /vendor/ort/ (default <root>/vendor/ort, the build's copy)
  --headers      response-header contract (default headers.json)
  --results      dev mode only: results sink directory (default test-results)
  --request-log  dev mode only: request log JSONL file (default test-results/requests.jsonl)`;

// ---------------------------------------------------------------- arguments

function die(sentence) {
  process.stderr.write(`serve: ${sentence}\n`);
  process.exit(1);
}

function parseFlags() {
  const fromRepo = (p) => path.join(REPO, p);
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        mode: { type: 'string' },
        port: { type: 'string', default: '8790' },
        host: { type: 'string', default: '127.0.0.1' },
        tls: { type: 'string' },
        root: { type: 'string' },
        models: { type: 'string', default: fromRepo('models') },
        'vendor-ort': { type: 'string' },
        results: { type: 'string' },
        'request-log': { type: 'string' },
        headers: { type: 'string', default: fromRepo('headers.json') },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (e) {
    die(`${e.message}\n${USAGE}`);
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  if (values.mode === undefined || !Object.hasOwn(MODES, values.mode)) die(`--mode must be one of ${Object.keys(MODES).join(', ')}.\n${USAGE}`);
  if (!MODES[values.mode].dev && (values.results !== undefined || values['request-log'] !== undefined)) {
    die(`--results and --request-log place the dev surfaces' files, and ${values.mode} mode has no dev surfaces.`);
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) die(`--port must be an integer from 0 to 65535, not "${values.port}".`);
  const root = path.resolve(values.root ?? fromRepo(MODES[values.mode].root));
  if (values.host.trim() === '') die('--host must be a nonempty address.');
  return {
    mode: values.mode,
    port,
    host: values.host,
    tls: values.tls === undefined ? null : path.resolve(values.tls),
    root,
    models: path.resolve(values.models),
    vendorOrt: path.resolve(values['vendor-ort'] ?? path.join(root, 'vendor', 'ort')),
    results: path.resolve(values.results ?? fromRepo('test-results')),
    requestLog: path.resolve(values['request-log'] ?? fromRepo('test-results/requests.jsonl')),
    headers: path.resolve(values.headers),
  };
}

// ---------------------------------------------------------------- fault state

const WHOLE = /^[1-9]\d*$/;

/**
 * Parses one fault rule (docs/ARCHITECTURE.md, "Fault grammar"):
 *   no-isolation
 *   path:<prefix>:<kind>[:times=<n>]
 *   kind = http500 | corrupt | truncate=<bytes> | stall | slow=<ms>
 * Returns { ok: true, rule } or { ok: false, error }.
 */
function parseFaultRule(spec) {
  const fail = (why) => ({ ok: false, error: `fault rule ${JSON.stringify(spec)}: ${why}` });
  if (typeof spec !== 'string') return fail('must be a string');
  if (spec === 'no-isolation') return { ok: true, rule: { spec, kind: 'no-isolation', remaining: null } };
  const parts = spec.split(':');
  if (parts[0] !== 'path' || parts.length < 3 || parts.length > 4) return fail('is not "no-isolation" or "path:<prefix>:<kind>[:times=<n>]"');
  const [, prefix, kindSpec, timesSpec] = parts;
  if (!FAULT_PREFIXES.some((p) => prefix.startsWith(p))) return fail(`the prefix must start with ${FAULT_PREFIXES.join(' or ')}`);
  let remaining = null;
  if (timesSpec !== undefined) {
    const n = /^times=(.*)$/.exec(timesSpec)?.[1];
    if (n === undefined || !WHOLE.test(n)) return fail('the fourth field must be times=<n> with n at least 1');
    remaining = Number(n);
  }
  if (kindSpec === 'http500' || kindSpec === 'corrupt' || kindSpec === 'stall') {
    return { ok: true, rule: { spec, prefix, kind: kindSpec, remaining } };
  }
  const [, name, arg] = /^(truncate|slow)=(.*)$/.exec(kindSpec) ?? [];
  if (name === undefined || arg === undefined || !WHOLE.test(arg)) {
    return fail('the kind must be http500, corrupt, truncate=<bytes>, stall, or slow=<ms>, with numbers at least 1');
  }
  if (name === 'truncate') return { ok: true, rule: { spec, prefix, kind: name, bytes: Number(arg), remaining } };
  if (Number(arg) > MAX_SLOW_MS) return fail(`slow=<ms> takes at most ${MAX_SLOW_MS} ms`);
  return { ok: true, rule: { spec, prefix, kind: name, ms: Number(arg), remaining } };
}

function createFaultState() {
  let rules = [];
  return {
    /** Replaces every rule at once; on any invalid rule nothing changes. */
    set(specs) {
      if (!Array.isArray(specs)) return { ok: false, error: 'the body must be {"rules": [<rule>, ...]}' };
      const parsed = specs.map(parseFaultRule);
      const failed = parsed.find((p) => !p.ok);
      if (failed) return failed;
      rules = parsed.map((p) => ({ ...p.rule, hits: 0 }));
      return { ok: true };
    },
    clear() {
      rules = [];
    },
    get isolation() {
      return !rules.some((r) => r.kind === 'no-isolation');
    },
    /** The first live path rule matching urlPath, with its count consumed. */
    take(urlPath) {
      const rule = rules.find((r) => r.kind !== 'no-isolation' && r.remaining !== 0 && urlPath.startsWith(r.prefix));
      if (!rule) return null;
      rule.hits += 1;
      if (rule.remaining !== null) rule.remaining -= 1;
      return rule;
    },
    snapshot() {
      return {
        isolation: this.isolation,
        rules: rules.map(({ spec, hits, remaining }) => ({ spec, hits, remaining })),
      };
    },
  };
}

// ---------------------------------------------------------------- responses

/** Resolves a decoded URL path under root, or null when it would leave root. */
async function resolveUnder(root, rel) {
  if (rel.includes('\0') || rel.includes('\\')) return null;
  if (rel.split('/').some((seg) => seg === '..' || seg === '.')) return null;
  const file = path.resolve(root, `.${path.posix.sep}${rel}`);
  let realRoot;
  let realFile;
  try {
    realRoot = await realpath(root);
    realFile = await realpath(file);
  } catch {
    return { missing: true };
  }
  if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) return null;
  return { file: realFile };
}

/**
 * Whether a decoded URL path names a dev-only surface or dev page: its first
 * segment, once dot segments are resolved and empty segments collapsed, is
 * dev or api in any case. So //dev/x, /%2Fdev/x, /DEV/x, /./dev/x, and
 * /assets/../dev/x all count.
 */
function namesDevOnly(urlPath) {
  const first = path.posix.normalize(`/${urlPath}`).split('/').find((seg) => seg !== '');
  return first !== undefined && DEV_ONLY_SEGMENTS.has(first.toLowerCase());
}

/**
 * Whether a file's real path lies under dev/ or api/, in any case, of the
 * production root's real path, whichever mount reached it.
 */
async function isDevOnlyFile(realFile, root) {
  let realRoot;
  try {
    realRoot = await realpath(root);
  } catch {
    return false;
  }
  const rel = path.relative(realRoot, realFile);
  const [first = ''] = rel.split(path.sep);
  return !path.isAbsolute(rel) && DEV_ONLY_SEGMENTS.has(first.toLowerCase());
}

/** Parses a single-range Range header against size: {start,end} | 'unsatisfiable' | null (serve whole). */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (size === 0) return 'unsatisfiable';
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Appends one line to the request log, recreating its directory if it was
 * removed while the server runs. Any other failure is reported once on stderr
 * and the response goes on, so a broken log never stops the server serving.
 */
function createLogWriter(file) {
  let reported = false;
  return (line) => {
    try {
      try {
        appendFileSync(file, line);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        mkdirSync(path.dirname(file), { recursive: true });
        appendFileSync(file, line);
      }
      reported = false;
    } catch (e) {
      if (!reported) process.stderr.write(`serve: cannot write the request log ${file}, so requests go unlogged until it can: ${e.message}\n`);
      reported = true;
    }
  };
}

/** The last seq in an existing request log, so seq keeps rising across restarts. */
async function lastSeq(file) {
  try {
    const last = (await readFile(file, 'utf8')).trimEnd().split('\n').at(-1);
    return last ? Number(JSON.parse(last).seq) || 0 : 0;
  } catch {
    return 0;
  }
}

/**
 * A synth master side from the query: the one value given for `name`, an
 * even whole number from 2 to MAX_SYNTH_SIDE written in plain digits, or
 * null for anything else (missing, repeated, odd, zero, negative,
 * fractional, or not a number).
 */
function synthSide(query, name) {
  const values = query.getAll(name);
  if (values.length !== 1 || !WHOLE.test(values[0])) return null;
  const side = Number(values[0]);
  return side % 2 === 0 && side <= MAX_SYNTH_SIDE ? side : null;
}

/**
 * Paints synth masters on demand with test/fixtures/synth, imported the
 * first time one is asked for, and keeps the last SYNTH_HELD sizes painted.
 * A size asked for again while it is being painted shares that painting.
 */
function createSynthMasters() {
  /** Painted masters by "<width>x<height>", least recently asked for first. */
  const held = new Map();
  let fixture = null;
  return (width, height) => {
    const key = `${width}x${height}`;
    const seen = held.get(key);
    if (seen !== undefined) {
      held.delete(key);
      held.set(key, seen);
      return seen;
    }
    const painting = (async () => {
      fixture ??= import(pathToFileURL(SYNTH_MODULE).href);
      const { synthScene } = await fixture;
      const rgba = synthScene({ width, height }).masterRgba();
      return Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    })();
    held.set(key, painting);
    painting.catch(() => {
      if (held.get(key) === painting) held.delete(key);
    });
    while (held.size > SYNTH_HELD) held.delete(held.keys().next().value);
    return painting;
  };
}

function createServer(options, contract, firstSeq, tls) {
  const mode = MODES[options.mode];
  const faults = mode.dev ? createFaultState() : null;
  const isolation = () => faults?.isolation ?? true;
  /** The fault rule applied to each in-flight response, for its log row. */
  const appliedFault = new WeakMap();
  const writeLog = mode.dev ? createLogWriter(options.requestLog) : null;
  const synthMaster = mode.dev ? createSynthMasters() : null;
  let seq = firstSeq;

  const csp = contract.all['Content-Security-Policy'];

  /**
   * Every response starts here: the contract's headers, then the request log
   * row. In dev mode a response gets a report-only copy of the contract's CSP
   * that reports to CSP_REPORT_PATH, and a response the fault state altered
   * (a fault rule applied to it, or no-isolation is set) is sent no-store, so
   * a browser never caches it under the contract's immutable rule.
   */
  function head(req, res, status, urlPath, extra = {}, { contentType = null } = {}) {
    const headers = expectedHeaders(contract, urlPath, { isolation: isolation(), status });
    if (contentType !== null) headers['Content-Type'] = contentType;
    Object.assign(headers, extra);
    const fault = appliedFault.get(res) ?? null;
    if (mode.dev) {
      if (csp !== undefined) headers['Content-Security-Policy-Report-Only'] = `${csp}; report-uri ${CSP_REPORT_PATH}`;
      if (fault !== null || !isolation()) headers['Cache-Control'] = 'no-store';
    }
    res.writeHead(status, headers);
    if (mode.dev) {
      const row = { seq: ++seq, at: new Date().toISOString(), scheme: tls === null ? 'http' : 'https', method: req.method, path: req.url, headers: req.headers, status, fault };
      writeLog(`${JSON.stringify(row)}\n`);
    }
  }

  function sendText(req, res, status, urlPath, text) {
    head(req, res, status, urlPath, {}, { contentType: 'text/plain; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : `${text}\n`);
  }

  function sendJson(req, res, status, urlPath, value) {
    head(req, res, status, urlPath, {}, { contentType: 'application/json' });
    res.end(`${JSON.stringify(value)}\n`);
  }

  /**
   * The request body, or null when it exceeds limit. An oversized body is
   * still read to its end and discarded, so the client receives the 413
   * instead of a broken pipe.
   */
  async function readBody(req, limit) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    }
    return size > limit ? null : Buffer.concat(chunks);
  }

  /**
   * A request whose path cannot name a file: 400 with the reason in dev mode,
   * and in production mode the 404 every other path it does not serve gets.
   */
  const badPath = (req, res, urlPath, reason) => (mode.dev ? sendText(req, res, 400, urlPath, reason) : sendText(req, res, 404, urlPath, 'not found'));

  async function serveFile(req, res, urlPath, { dir: root }, rel, fault) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(req, res, 405, urlPath, 'method not allowed');
    if (fault?.kind === 'http500') return sendText(req, res, 500, urlPath, 'fault: http500');
    if (fault?.kind === 'slow') await wait(fault.ms);
    const found = await resolveUnder(root, rel === '' ? 'index.html' : rel);
    if (found === null) return badPath(req, res, urlPath, 'bad path');
    let size;
    try {
      if (found.missing) throw new Error('missing');
      // In production mode a file reached through a symlink, another
      // spelling, or another mount that lands in dev/ or api/ under the
      // production root is refused like the path itself.
      if (!mode.dev && (await isDevOnlyFile(found.file, options.root))) throw new Error('dev only');
      const info = await stat(found.file);
      if (!info.isFile()) throw new Error('not a file');
      size = info.size;
    } catch {
      return sendText(req, res, 404, urlPath, 'not found');
    }
    const range = parseRange(req.headers.range, size);
    if (range === 'unsatisfiable') {
      head(req, res, 416, urlPath, { 'Content-Range': `bytes */${size}` }, { contentType: 'text/plain; charset=utf-8' });
      return res.end();
    }
    const { start, end } = range ?? { start: 0, end: size - 1 };
    const length = size === 0 ? 0 : end - start + 1;
    const extra = { 'Accept-Ranges': 'bytes', 'Content-Length': String(length) };
    if (range) extra['Content-Range'] = `bytes ${start}-${end}/${size}`;
    head(req, res, range ? 206 : 200, urlPath, extra);
    if (fault?.kind === 'stall') {
      // Headers go out now; then nothing until the client goes away or the
      // server stops.
      res.flushHeaders();
      return undefined;
    }
    if (req.method === 'HEAD') return res.end();
    if (length === 0) return res.end();
    const stream = createReadStream(found.file, { start, end });
    if (fault?.kind === 'corrupt') {
      // Same length, every byte inverted.
      await pipeline(stream, async function* (src) {
        for await (const chunk of src) yield chunk.map((b) => b ^ 0xff);
      }, res);
      return undefined;
    }
    if (fault?.kind === 'truncate' && fault.bytes < length) {
      // The full length is declared; after fault.bytes the connection drops.
      await pipeline(stream, async function* (src) {
        let left = fault.bytes;
        for await (const chunk of src) {
          yield chunk.subarray(0, left);
          left -= Math.min(left, chunk.length);
          if (left === 0) return;
        }
      }, res, { end: false });
      res.socket?.end();
      return undefined;
    }
    await pipeline(stream, res);
    return undefined;
  }

  async function handleFault(req, res, urlPath) {
    if (req.method === 'GET') return sendJson(req, res, 200, urlPath, faults.snapshot());
    if (req.method === 'DELETE') {
      faults.clear();
      return sendJson(req, res, 200, urlPath, faults.snapshot());
    }
    if (req.method !== 'POST') return sendText(req, res, 405, urlPath, 'method not allowed');
    const body = await readBody(req, MAX_ROW_BYTES);
    if (body === null) return sendText(req, res, 413, urlPath, 'fault body too large');
    let parsed;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return sendJson(req, res, 400, urlPath, { error: 'the body must be JSON: {"rules": [<rule>, ...]}' });
    }
    const result = faults.set(parsed?.rules);
    if (!result.ok) return sendJson(req, res, 400, urlPath, { error: result.error });
    return sendJson(req, res, 200, urlPath, faults.snapshot());
  }

  async function handleRequests(req, res, urlPath, query) {
    if (req.method !== 'GET') return sendText(req, res, 405, urlPath, 'method not allowed');
    const since = Number(query.get('since') ?? 0);
    if (!Number.isInteger(since)) return sendText(req, res, 400, urlPath, 'since must be an integer');
    let text = '';
    try {
      text = await readFile(options.requestLog, 'utf8');
    } catch {
      // No request logged yet.
    }
    const rows = text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((row) => row.seq > since);
    return sendJson(req, res, 200, urlPath, rows);
  }

  async function handleSink(req, res, urlPath, query) {
    if (req.method !== 'POST') return sendText(req, res, 405, urlPath, 'method not allowed');
    await mkdir(path.join(options.results, 'captures'), { recursive: true });
    const rowsFile = path.join(options.results, 'log.jsonl');
    const type = String(req.headers['content-type'] ?? '');
    const mediaType = type.split(';', 1)[0].trim().toLowerCase();
    if (mediaType === 'application/json') {
      const body = await readBody(req, MAX_ROW_BYTES);
      if (body === null) return sendText(req, res, 413, urlPath, `a JSON row is limited to ${MAX_ROW_BYTES} bytes`);
      let row;
      try {
        row = JSON.parse(body.toString('utf8'));
      } catch {
        return sendJson(req, res, 400, urlPath, { error: 'the body is not JSON' });
      }
      if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        return sendJson(req, res, 400, urlPath, { error: 'a row must be a JSON object' });
      }
      appendFileSync(rowsFile, `${JSON.stringify({ at: new Date().toISOString(), row })}\n`);
      return sendJson(req, res, 200, urlPath, { ok: true });
    }
    const name = sanitizeName(query.get('name') ?? 'capture.bin');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('.', '');
    const rel = path.posix.join('captures', `${stamp}-${randomBytes(3).toString('hex')}-${name}`);
    const file = path.join(options.results, rel);
    const partial = `${file}.part`;
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      await pipeline(
        req,
        async function* (source) {
          // Past the bound, the rest of the body is read and discarded.
          for await (const chunk of source) {
            bytes += chunk.length;
            if (bytes > MAX_CAPTURE_BYTES) continue;
            hash.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(partial, { flags: 'wx' }),
      );
    } catch (e) {
      await unlink(partial).catch(() => {});
      throw e;
    }
    if (bytes > MAX_CAPTURE_BYTES) {
      await unlink(partial);
      return sendText(req, res, 413, urlPath, `a capture is limited to ${MAX_CAPTURE_BYTES} bytes`);
    }
    await rename(partial, file);
    const capture = { path: rel, file, bytes, sha256: hash.digest('hex'), contentType: type || null, name };
    appendFileSync(rowsFile, `${JSON.stringify({ at: new Date().toISOString(), capture })}\n`);
    return sendJson(req, res, 200, urlPath, { ok: true, ...capture });
  }

  /**
   * POST stores one CSP violation report, in any media type browsers use
   * (application/csp-report, application/reports+json), as a line of
   * <results>/csp-reports.jsonl; GET returns the stored lines as an array.
   */
  async function handleCspReport(req, res, urlPath) {
    const file = path.join(options.results, 'csp-reports.jsonl');
    if (req.method === 'GET') {
      let text = '';
      try {
        text = await readFile(file, 'utf8');
      } catch {
        // No report yet.
      }
      return sendJson(req, res, 200, urlPath, text.split('\n').filter(Boolean).map((line) => JSON.parse(line)));
    }
    if (req.method !== 'POST') return sendText(req, res, 405, urlPath, 'method not allowed');
    const body = await readBody(req, MAX_REPORT_BYTES);
    if (body === null) return sendText(req, res, 413, urlPath, `a CSP report is limited to ${MAX_REPORT_BYTES} bytes`);
    let report;
    try {
      report = JSON.parse(body.toString('utf8'));
    } catch {
      return sendJson(req, res, 400, urlPath, { error: 'the body is not JSON' });
    }
    await mkdir(options.results, { recursive: true });
    const row = { at: new Date().toISOString(), contentType: req.headers['content-type'] ?? null, userAgent: req.headers['user-agent'] ?? null, report };
    appendFileSync(file, `${JSON.stringify(row)}\n`);
    return sendJson(req, res, 200, urlPath, { ok: true });
  }

  /**
   * The synth fixture's master at ?width=&height= as raw RGBA bytes, alpha
   * 255, so every client reads the bytes node paints rather than painting
   * its own, whose last bits may differ between engines.
   */
  async function handleSynthMaster(req, res, urlPath, query) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(req, res, 405, urlPath, 'method not allowed');
    const width = synthSide(query, 'width');
    const height = synthSide(query, 'height');
    if (width === null || height === null) {
      return sendText(req, res, 400, urlPath, `width and height must each be given once, as an even whole number from 2 to ${MAX_SYNTH_SIDE}`);
    }
    const body = await synthMaster(width, height);
    head(req, res, 200, urlPath, { 'Content-Length': String(body.length), 'Cache-Control': 'no-store' }, { contentType: 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : body);
    return undefined;
  }

  const endpoints = mode.dev
    ? { '/dev/fault': handleFault, '/dev/requests': handleRequests, '/api/log': handleSink, [CSP_REPORT_PATH]: handleCspReport, [SYNTH_MASTER_PATH]: handleSynthMaster }
    : {};
  const mounts = [
    { prefix: '/models/', dir: options.models, faultable: mode.dev },
    { prefix: '/vendor/ort/', dir: options.vendorOrt, faultable: mode.dev },
    { prefix: '/', dir: options.root, faultable: false },
  ];

  const handler = async (req, res) => {
    const target = req.url ?? '';
    const queryAt = target.indexOf('?');
    const rawPath = queryAt === -1 ? target : target.slice(0, queryAt);
    const query = new URLSearchParams(queryAt === -1 ? '' : target.slice(queryAt + 1));
    try {
      if (!rawPath.startsWith('/')) return badPath(req, res, '/', 'bad request target');
      let urlPath;
      try {
        urlPath = decodeURIComponent(rawPath);
      } catch {
        return badPath(req, res, '/', 'bad path encoding');
      }
      if (!mode.dev && namesDevOnly(urlPath)) return sendText(req, res, 404, urlPath, 'not found');
      if (Object.hasOwn(endpoints, urlPath)) return await endpoints[urlPath](req, res, urlPath, query);
      const mount = mounts.find((m) => urlPath.startsWith(m.prefix));
      const readable = req.method === 'GET' || req.method === 'HEAD';
      const fault = mount.faultable && readable ? faults.take(urlPath) : null;
      if (fault !== null) appliedFault.set(res, fault.spec);
      return await serveFile(req, res, urlPath, mount, urlPath.slice(mount.prefix.length), fault);
    } catch (e) {
      if (!res.headersSent) return sendText(req, res, 500, '/', `server error: ${e.message}`);
      res.destroy();
      return undefined;
    }
  };
  return tls === null ? http.createServer(handler) : https.createServer(tls, handler);
}

/** A capture's name with anything but [A-Za-z0-9._-] replaced, no leading dot, at most 100 characters. */
function sanitizeName(name) {
  const clean = name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 100);
  return clean === '' ? 'capture.bin' : clean;
}

async function main() {
  const options = parseFlags();
  let contract;
  try {
    contract = await loadHeaderContract(options.headers);
  } catch (e) {
    die(e.message);
  }
  if (MODES[options.mode].dev) {
    try {
      await mkdir(path.dirname(options.requestLog), { recursive: true });
      await mkdir(options.results, { recursive: true });
      appendFileSync(options.requestLog, '');
    } catch (e) {
      die(`the request log ${options.requestLog} or the results directory ${options.results} cannot be written: ${e.message}`);
    }
  }
  let server;
  try {
    const tls = options.tls === null ? null : {
      cert: await readFile(path.join(options.tls, 'server.pem')),
      key: await readFile(path.join(options.tls, 'server-key.pem')),
    };
    server = createServer(options, contract, MODES[options.mode].dev ? await lastSeq(options.requestLog) : 0, tls);
  } catch (e) { die(`cannot start server: ${e.message}`); }
  server.on('error', (e) => die(`cannot listen on ${options.host}:${options.port}: ${e.message}`));
  server.listen(options.port, options.host, () => {
    const { port } = server.address();
    const host = options.host.includes(':') ? `[${options.host}]` : options.host;
    process.stdout.write(`serve: ${options.mode} mode on ${options.tls === null ? 'http' : 'https'}://${host}:${port}/\n`);
    process.stdout.write(`  root ${options.root}\n  /models/ ${options.models}\n  /vendor/ort/ ${options.vendorOrt}\n`);
    if (MODES[options.mode].dev) process.stdout.write(`  results ${options.results}\n  request log ${options.requestLog}\n`);
  });
  const stop = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

await main();
