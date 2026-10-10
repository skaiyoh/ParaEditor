// package.json lists exactly the approved dependencies at exactly the
// approved versions (docs/DECISIONS.md, ADR-001), the installed copies match, and nothing from the rejected list
// is anywhere in the locked tree. A newer version failing here is the check
// working: moving a pin is a separate decision.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { REPO } from './support/cli.ts';

const RUNTIME = { mediabunny: '1.60.0', 'onnxruntime-web': '1.30.0', preact: '10.29.8', zod: '4.6.5' };
const DEV = { '@types/node': '25.9.8', esbuild: '0.28.2', typescript: '7.0.2' };
const REJECTED = ['gifenc', 'fflate', 'libheif-js', '@huggingface/transformers', 'three', 'regl', 'vite', 'playwright', 'vitest'];

const Manifest = z.object({
  dependencies: z.record(z.string(), z.string()),
  devDependencies: z.record(z.string(), z.string()),
});
const Installed = z.object({ version: z.string() });
const Lock = z.object({ packages: z.record(z.string(), z.unknown()) });

const readJson = async (rel: string): Promise<unknown> => JSON.parse(await readFile(path.join(REPO, rel), 'utf8'));

test('package.json pins exactly the approved dependencies, and the installed versions equal them', async () => {
  const manifest = Manifest.parse(await readJson('package.json'));
  assert.deepEqual(manifest.dependencies, RUNTIME);
  assert.deepEqual(manifest.devDependencies, DEV);
  for (const [name, version] of Object.entries({ ...RUNTIME, ...DEV })) {
    assert.equal(Installed.parse(await readJson(`node_modules/${name}/package.json`)).version, version, name);
  }
});

test('nothing from the rejected list is in the locked dependency tree', async () => {
  const lock = Lock.parse(await readJson('package-lock.json'));
  const names = Object.keys(lock.packages).map((key) => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length));
  assert.ok(names.length > 7, 'the lock lists the installed tree');
  assert.deepEqual(names.filter((name) => REJECTED.includes(name)), []);
});
