// Smoke test: headers.json names the isolation headers and the CSP
// (docs/ARCHITECTURE.md, "Response-header contract"). The dev server's
// behavior against the same file is checked end to end in serve.test.ts.

import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

const Contract = z.object({ all: z.record(z.string(), z.string()) });
const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com; worker-src 'self'; img-src 'self' blob: data:; media-src blob:; connect-src 'self' https://cloudflareinsights.com";

test('headers.json names COOP, COEP, and the CSP', async () => {
  const contract = Contract.parse(JSON.parse(await readFile(new URL('../headers.json', import.meta.url), 'utf8')));
  assert.equal(contract.all['Cross-Origin-Opener-Policy'], 'same-origin');
  assert.equal(contract.all['Cross-Origin-Embedder-Policy'], 'require-corp');
  assert.equal(contract.all['Content-Security-Policy'], CSP);
});
