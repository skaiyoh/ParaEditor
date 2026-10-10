// The response-header contract in headers.json, read by tools/serve.mjs and
// tools/check-headers.mjs. Dependency-free; Node 25.
//
// Shape (validated by loadHeaderContract):
//   all                 headers every response carries
//   byPath              [{ path, headers }]; on a response below 400, the
//                       first rule whose path matches adds its headers. A path
//                       is exact ("/index.html"), a prefix ending in "*"
//                       ("/assets/*"), or "*" for any.
//   errors              headers a response of 400 or above carries instead of
//                       its path rule's, so an error is never cached as a file
//   contentTypes        file extension -> Content-Type
//   defaultContentType  Content-Type for any other extension

import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** The isolation headers the dev server's `no-isolation` fault drops. */
export const ISOLATION_HEADERS = ['Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy'];

const isStringMap = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');

/** Reads and validates headers.json; throws with one sentence naming the fault. */
export async function loadHeaderContract(file) {
  const raw = JSON.parse(await readFile(file, 'utf8'));
  const fail = (what) => {
    throw new Error(`${file}: ${what}`);
  };
  if (!isStringMap(raw.all)) fail('"all" must map header names to strings.');
  if (!Array.isArray(raw.byPath)) fail('"byPath" must be a list.');
  for (const rule of raw.byPath) {
    if (typeof rule?.path !== 'string' || !isStringMap(rule.headers)) fail('each "byPath" rule needs a string "path" and a "headers" map.');
    if (rule.path !== '*' && !rule.path.startsWith('/')) fail(`path "${rule.path}" must start with "/" or be "*".`);
    if (rule.path.slice(0, -1).includes('*')) fail(`path "${rule.path}" may use "*" only at its end.`);
  }
  if (!isStringMap(raw.errors)) fail('"errors" must map header names to strings.');
  if (!isStringMap(raw.contentTypes)) fail('"contentTypes" must map extensions to strings.');
  if (typeof raw.defaultContentType !== 'string') fail('"defaultContentType" must be a string.');
  return raw;
}

function pathMatches(pattern, urlPath) {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return urlPath.startsWith(pattern.slice(0, -1));
  return urlPath === pattern;
}

/** The Content-Type the contract assigns to a URL path; "/" and "…/" are index.html. */
export function contentTypeFor(contract, urlPath) {
  const file = urlPath.endsWith('/') ? 'index.html' : urlPath;
  return contract.contentTypes[path.posix.extname(file).toLowerCase()] ?? contract.defaultContentType;
}

/**
 * Every header the contract requires on a response for `urlPath` (a decoded
 * path without query) with `status`, Content-Type included. A status of 400 or
 * above takes the contract's `errors` headers in place of the path rule's.
 * With `isolation: false` the COOP and COEP headers are left out, as the
 * `no-isolation` fault does.
 */
export function expectedHeaders(contract, urlPath, { isolation = true, status = 200 } = {}) {
  const byStatus = status >= 400 ? contract.errors : (contract.byPath.find((r) => pathMatches(r.path, urlPath))?.headers ?? {});
  const headers = { ...contract.all, ...byStatus, 'Content-Type': contentTypeFor(contract, urlPath) };
  if (!isolation) for (const name of ISOLATION_HEADERS) delete headers[name];
  return headers;
}
