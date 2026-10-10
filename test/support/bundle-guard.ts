// The bundle guard's checks over a production build's output directory, read
// from disk rather than from build.json: no dev page, no dev-only surface or
// route named in any file the build wrote, no console reference in any
// bundle esbuild wrote, and every vendored runtime file byte-identical to the
// pinned package's. test/bundle-guard.test.ts runs it.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { REPO } from './cli.ts';

export type Finding = { readonly file: string; readonly problem: string };

/**
 * Strings that name a dev-only surface or route; no file of a production
 * build may contain one. A part adds a dev-only route, or a name only dev code
 * uses, here; never a test surface member's name, which is an ordinary
 * identifier a production bundle may also hold (see docs/ARCHITECTURE.md,
 * "Bundle guard").
 */
export const DEV_ONLY_STRINGS: readonly string[] = ['__noisyTest', '/dev/', '/dev/fault', '/dev/csp-report', '/dev/requests', '/api/log'];

/** Files of the build that are text the guard reads; anything else (the wasm) is checked only under vendor/. */
const TEXT = /\.(?:js|mjs|html|json|webmanifest|svg|css)$/;
const ORT_PACKAGE = path.join(REPO, 'node_modules', 'onnxruntime-web');

/**
 * Every reference to the global `console`, bare or through `window`,
 * `globalThis`, or `self` (`window.console.log`, which esbuild's
 * `drop: ['console']` keeps): `console.x`, `console?.x`, `console[...]`, and
 * the bare name, as in `const { log } = console`, which the drop does not
 * remove either. A property named `console` of any other object (`x.console`)
 * is not one. The word inside a string also matches, which fails safe.
 */
const CONSOLE = /(?<![\w$.])((?:window|globalThis|self)\s*\??\.\s*)?console(?![\w$])(\s*\??\.\s*[A-Za-z_$][\w$]*|\s*\[)?/g;

/** Findings for one bundle esbuild wrote: dev-only strings and console references. */
export function checkBundle(file: string, text: string): readonly Finding[] {
  const findings: Finding[] = DEV_ONLY_STRINGS.filter((s) => text.includes(s)).map((s) => ({ file, problem: `names the dev-only "${s}"` }));
  const references = [...text.matchAll(CONSOLE)].map((m) => `${(m[1] ?? '').replace(/\s+/g, '')}console${(m[2] ?? '').replace(/\s+/g, '')}`);
  if (references.length > 0) findings.push({ file, problem: `${references.length} console references: ${references.join(', ')}` });
  return findings;
}

async function listFiles(dir: string, base = dir): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name), base) : Promise.resolve([path.relative(base, path.join(dir, e.name))]))),
  );
  return nested.flat().sort();
}

/** Every finding in a production build's output directory; empty when the guard passes. */
export async function checkProductionBuild(outdir: string): Promise<readonly Finding[]> {
  const findings: Finding[] = [];
  const { version } = z.object({ version: z.string() }).parse(JSON.parse(await readFile(path.join(ORT_PACKAGE, 'package.json'), 'utf8')));
  const vendorDir = `vendor/ort/${version}/`;
  for (const file of await listFiles(outdir)) {
    const posix = file.split(path.sep).join('/');
    if (posix.startsWith('dev/')) findings.push({ file: posix, problem: 'a dev page in a production build' });
    if (posix.startsWith('vendor/')) {
      if (!posix.startsWith(vendorDir)) {
        findings.push({ file: posix, problem: `vendored outside ${vendorDir}, the installed onnxruntime-web's directory` });
        continue;
      }
      const name = posix.slice(vendorDir.length);
      const pinned = await readFile(path.join(ORT_PACKAGE, 'dist', name)).catch(() => null);
      const shipped = await readFile(path.join(outdir, file));
      if (pinned === null) findings.push({ file: posix, problem: 'no file of that name in node_modules/onnxruntime-web/dist/' });
      else if (!pinned.equals(shipped)) findings.push({ file: posix, problem: 'differs from node_modules/onnxruntime-web/dist/' });
      continue;
    }
    if (!TEXT.test(posix)) continue;
    const text = await readFile(path.join(outdir, file), 'utf8');
    if (posix.endsWith('.js')) findings.push(...checkBundle(posix, text));
    else findings.push(...DEV_ONLY_STRINGS.filter((s) => text.includes(s)).map((s) => ({ file: posix, problem: `names the dev-only "${s}"` })));
  }
  return findings;
}
