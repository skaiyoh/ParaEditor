#!/usr/bin/env node
// Checks a running server's responses against headers.json. Dependency-free;
// Node 25. Works against the dev server, any later server mode, or the AWS
// host at release, since it only takes a base URL.
//
//   node tools/check-headers.mjs <base-url> [--path <path>]... [--headers headers.json]
//
// Always checks "/" and "/index.html", plus every same-origin src or href in
// the index page (the hashed app script, the manifest, the icon), plus each
// --path. Prints one JSON line per path and exits 0 when every response is a
// 200 with every header the contract requires for it, 1 when one is not, 2 on
// a usage error, and 3 when a request gets no response at all.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { expectedHeaders, loadHeaderContract } from './headers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: node tools/check-headers.mjs <base-url> [--path <path>]... [--headers headers.json]';

function die(sentence) {
  process.stderr.write(`check-headers: ${sentence}\n${USAGE}\n`);
  process.exit(2);
}

/** Fetches url and reads its body, or exits 3 with one sentence when that fails. */
async function get(url) {
  try {
    const res = await fetch(url);
    return { res, body: Buffer.from(await res.arrayBuffer()) };
  } catch (e) {
    process.stderr.write(`check-headers: no response from ${url}: ${e.cause?.message ?? e.message}\n`);
    process.exit(3);
  }
}

function decodePath(p) {
  try {
    return decodeURIComponent(p);
  } catch {
    return null;
  }
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      path: { type: 'string', multiple: true, default: [] },
      headers: { type: 'string', default: path.join(REPO, 'headers.json') },
    },
  });
} catch (e) {
  die(e.message);
}
const [base] = parsed.positionals;
const origin = URL.parse(base ?? '');
if (origin === null || (origin.protocol !== 'http:' && origin.protocol !== 'https:')) die('give the base URL, such as http://127.0.0.1:8790/.');
for (const p of parsed.values.path) {
  if (!p.startsWith('/') || decodePath(p) === null) die(`--path ${JSON.stringify(p)} must start with "/" and be validly percent-encoded.`);
}
let contract;
try {
  contract = await loadHeaderContract(path.resolve(parsed.values.headers));
} catch (e) {
  die(`cannot read the header contract: ${e.message}`);
}

const html = (await get(new URL('/', origin))).body.toString('utf8');
const linked = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)]
  .map((m) => URL.parse(m[1], origin))
  .filter((u) => u !== null && u.origin === origin.origin)
  .map((u) => u.pathname);
const paths = [...new Set(['/', '/index.html', ...linked, ...parsed.values.path])];

let failed = false;
for (const p of paths) {
  const { res } = await get(new URL(p, origin));
  const mismatches = [];
  if (res.status !== 200) mismatches.push({ header: ':status', expected: '200', actual: String(res.status) });
  for (const [name, value] of Object.entries(expectedHeaders(contract, decodePath(p) ?? p))) {
    const actual = res.headers.get(name);
    if (actual !== value) mismatches.push({ header: name, expected: value, actual });
  }
  failed ||= mismatches.length > 0;
  process.stdout.write(`${JSON.stringify({ path: p, status: res.status, ok: mismatches.length === 0, mismatches })}\n`);
}
process.exit(failed ? 1 : 0);
