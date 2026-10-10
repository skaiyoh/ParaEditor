#!/usr/bin/env node
// Fetches the model files that models.lock.json pins into the models
// directory, and verifies every file there against the lock.
// Dependency-free; Node 25.
//
//   node tools/fetch-models.mjs [--models models] [--lock models.lock.json] [--verify-only]
//        [--origin https://huggingface.co]
//
// A file is placed at its served name only after its SHA-256 and length match
// the lock: it downloads to a temporary name beside it and is renamed into
// place. A file already present that does not match the lock is refused and
// left as it is; nothing is downloaded until every present file verifies.
// Every source must be its model's pinned Hugging Face URL, so the tool asks
// no other host unless --origin names one.
// docs/ARCHITECTURE.md ("Models") documents the lock, the flags, and the exit
// codes.

import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream, rmSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVED = /^\/models\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const HF = 'https://huggingface.co';
const HF_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COMMIT = /^[0-9a-f]{40}$/;
/** A partial download: `<served name>.part-<pid of the run writing it>`. */
const PARTIAL = /^(.+)\.part-(\d+)$/;

/** Exit codes, documented in docs/ARCHITECTURE.md. */
const EXIT = { ok: 0, mismatch: 1, usage: 2, missing: 3, download: 4, interrupted: 130 };

const USAGE = `usage: node tools/fetch-models.mjs [--models <dir>] [--lock <file>] [--verify-only] [--origin <url>]
  --models       directory served at /models/ (default models)
  --lock         the lock file (default models.lock.json)
  --verify-only  check the files present against the lock and download nothing
  --origin       fetch each source's path from this origin instead of ${HF}, such as a mirror
exit: 0 every file verified, 1 a present file does not match the lock, 2 usage or lock error,
      3 files missing (with --verify-only), 4 a download failed or did not match the lock, 130 interrupted`;

function fail(code, sentence) {
  process.stderr.write(`fetch-models: ${sentence}\n`);
  process.exit(code);
}

function parseFlags() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        models: { type: 'string', default: path.join(REPO, 'models') },
        lock: { type: 'string', default: path.join(REPO, 'models.lock.json') },
        'verify-only': { type: 'boolean', default: false },
        origin: { type: 'string', default: HF },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (e) {
    fail(EXIT.usage, `${e.message}\n${USAGE}`);
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(EXIT.ok);
  }
  const origin = URL.parse(values.origin);
  if ((origin?.protocol !== 'https:' && origin?.protocol !== 'http:') || origin.pathname !== '/' || origin.search !== '') {
    fail(EXIT.usage, `--origin must be an http or https origin with no path, not "${values.origin}".`);
  }
  return { models: path.resolve(values.models), lock: path.resolve(values.lock), verifyOnly: values['verify-only'], origin: origin.origin };
}

/**
 * Every file the lock pins, in lock order, with the URL to fetch it from;
 * exits 2 with one sentence on a malformed lock.
 */
async function readLock(file, origin) {
  let lock;
  try {
    lock = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    fail(EXIT.usage, `cannot read the lock ${file}: ${e.message}`);
  }
  const bad = (what) => fail(EXIT.usage, `the lock ${file} is malformed: ${what}`);
  if (lock?.lockVersion !== 1 || lock.models === null || typeof lock.models !== 'object') bad('it needs "lockVersion": 1 and a "models" object.');
  const files = [];
  const served = new Set();
  for (const [name, model] of Object.entries(lock.models)) {
    if (!Array.isArray(model?.files) || model.files.length === 0) bad(`model "${name}" has no files.`);
    if (typeof model.repo !== 'string' || !HF_REPO.test(model.repo)) bad(`model "${name}" has no Hugging Face repo of the form <owner>/<name>.`);
    if (typeof model.commit !== 'string' || !COMMIT.test(model.commit)) bad(`model "${name}" has no 40-hex commit.`);
    const pinned = `${HF}/${model.repo}/resolve/${model.commit}/`;
    for (const f of model.files) {
      if (typeof f?.served !== 'string' || !SERVED.test(f.served)) bad(`a file of "${name}" has no served path of the form /models/<file>.`);
      if (served.has(f.served)) bad(`${f.served} is the served path of more than one file.`);
      served.add(f.served);
      if (typeof f.sha256 !== 'string' || !SHA256.test(f.sha256)) bad(`${f.served} has no lowercase hex sha256.`);
      if (!Number.isSafeInteger(f.bytes) || f.bytes < 0) bad(`${f.served} has no byte length.`);
      const source = typeof f.source === 'string' ? URL.parse(f.source) : null;
      if (source === null || !f.source.startsWith(pinned) || source.href !== f.source || f.source.length === pinned.length) {
        bad(`${f.served}'s source is not a file under ${pinned}.`);
      }
      files.push({ name: f.served.slice('/models/'.length), url: new URL(source.pathname, origin).href, sha256: f.sha256, bytes: f.bytes });
    }
  }
  return files;
}

/** { bytes, sha256 } of a file on disk, null when there is none, or { unreadable } when it cannot be read. */
async function digest(file) {
  try {
    if (!(await stat(file)).isFile()) return { unreadable: 'it is not a file' };
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    return { unreadable: `it cannot be read (${e.code ?? e.message})` };
  }
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of createReadStream(file)) {
      bytes += chunk.length;
      hash.update(chunk);
    }
  } catch (e) {
    return { unreadable: `it cannot be read (${e.code ?? e.message})` };
  }
  return { bytes, sha256: hash.digest('hex') };
}

const matches = (got, want) => got.bytes === want.bytes && got.sha256 === want.sha256;

/** The download in progress, removed if the run is interrupted. */
let inProgress = null;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (inProgress !== null) rmSync(inProgress, { force: true });
    process.exit(EXIT.interrupted);
  });
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/**
 * Removes each partial download of a lock file whose run has exited, as one
 * killed by a signal it cannot catch leaves behind; a live run's is kept.
 */
async function removeStalePartials(dir, files) {
  const names = new Set(files.map((f) => f.name));
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const [, name, pid] = PARTIAL.exec(entry) ?? [];
    if (name === undefined || !names.has(name) || isAlive(Number(pid))) continue;
    try {
      await unlink(path.join(dir, entry));
      process.stdout.write(`fetch-models: removed ${entry}, a partial download a stopped run left\n`);
    } catch (e) {
      if (e.code !== 'ENOENT') process.stderr.write(`fetch-models: cannot remove ${entry}: ${e.message}\n`);
    }
  }
}

/** The source answered with bytes the lock does not pin, which a rerun would get again. */
class PinMismatch extends Error {}

/**
 * Downloads one file to a temporary name, verifies it, and renames it into
 * place. It stops reading once the body is longer than the lock says.
 */
async function download(want, dir) {
  const target = path.join(dir, want.name);
  const partial = `${target}.part-${process.pid}`;
  inProgress = partial;
  const hash = createHash('sha256');
  let bytes = 0;
  /** The partial file's stream, once the body is being read. */
  let out = null;
  try {
    const res = await fetch(want.url);
    if (!res.ok || res.body === null) throw new Error(`HTTP ${res.status} from ${want.url}`);
    out = createWriteStream(partial, { flags: 'wx' });
    await pipeline(
      Readable.fromWeb(res.body),
      async function* (source) {
        for await (const chunk of source) {
          bytes += chunk.length;
          if (bytes > want.bytes) throw new PinMismatch(`${want.url} sent more than the lock's ${want.bytes} bytes`);
          hash.update(chunk);
          yield chunk;
        }
      },
      out,
    );
    if (bytes < want.bytes) throw new Error(`${want.url} sent only ${bytes} of the lock's ${want.bytes} bytes`);
    const sha256 = hash.digest('hex');
    if (sha256 !== want.sha256) throw new PinMismatch(`${want.url} sent bytes with SHA-256 ${sha256}, not the lock's ${want.sha256}`);
    await rename(partial, target);
    inProgress = null;
  } catch (e) {
    // The stream opens its file on the thread pool, and pipeline rejects
    // without waiting for that, so the file can appear after an unlink made
    // at once; once the stream has closed, the file is there or never was.
    if (out !== null && !out.closed) await once(out, 'close').catch(() => {});
    await unlink(partial).catch(() => {});
    if (e instanceof PinMismatch) {
      fail(EXIT.download, `${want.name} was not placed, because ${e.message}, which are not the bytes the lock pins; check the lock's entry against its source.`);
    }
    fail(EXIT.download, `${want.name} was not placed, because ${e.cause?.message ?? e.message}; check the network and rerun.`);
  }
}

async function main() {
  const flags = parseFlags();
  const files = await readLock(flags.lock, flags.origin);
  const missing = [];
  let refused = false;
  for (const want of files) {
    const got = await digest(path.join(flags.models, want.name));
    if (got === null) {
      missing.push(want);
    } else if (!('unreadable' in got) && matches(got, want)) {
      process.stdout.write(`fetch-models: verified ${want.name}\n`);
    } else {
      refused = true;
      let why = `it has ${got.bytes} bytes, not the lock's ${want.bytes}`;
      if ('unreadable' in got) why = got.unreadable;
      else if (got.bytes === want.bytes) why = "its SHA-256 differs from the lock's";
      process.stderr.write(
        `fetch-models: ${path.join(flags.models, want.name)} does not match the lock, because ${why}; delete it and run \`node tools/fetch-models.mjs\` to download it again.\n`,
      );
    }
  }
  if (refused) process.exit(EXIT.mismatch);
  if (missing.length > 0 && flags.verifyOnly) {
    fail(
      EXIT.missing,
      `${missing.length} of ${files.length} model files are missing from ${flags.models} (first: ${missing[0].name}); run \`node tools/fetch-models.mjs\` to download and verify them.`,
    );
  }
  await removeStalePartials(flags.models, files);
  if (missing.length > 0) {
    try {
      await mkdir(flags.models, { recursive: true });
    } catch (e) {
      fail(EXIT.download, `cannot create the models directory ${flags.models}: ${e.message}`);
    }
  }
  for (const want of missing) {
    process.stdout.write(`fetch-models: downloading ${want.name} (${want.bytes} bytes)\n`);
    await download(want, flags.models);
    process.stdout.write(`fetch-models: verified ${want.name}\n`);
  }
  process.stdout.write(`fetch-models: ${files.length} files verified in ${flags.models}, ${missing.length} downloaded\n`);
}

await main();
