// The import graph of src/ follows the dependency direction
// (docs/ARCHITECTURE.md, "Module map and the import graph"), and the checker
// is shown failing on synthetic trees that break it.

import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { checkImportGraph, readImports, type Violation } from './support/import-graph.ts';
import { REPO, tempDir, writeTree } from './support/cli.ts';

let scratch = '';
before(async () => {
  scratch = await tempDir('graph');
});
after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

let trees = 0;
async function check(files: Readonly<Record<string, string>>): Promise<readonly string[]> {
  trees += 1;
  const root = path.join(scratch, `tree-${trees}`);
  await writeTree(root, files);
  return (await checkImportGraph(root)).map(describe);
}

const describe = (v: Violation): string => `${v.file}:${v.line} ${v.specifier ?? '-'}: ${v.rule}`;

test('src/ follows the dependency direction', async () => {
  assert.deepEqual((await checkImportGraph(path.join(REPO, 'src'))).map(describe), []);
});

test('gallery is a second composition entry while every incoming and dev-entry rule stays closed', async () => {
  assert.deepEqual(await check({
    'gallery.ts': "import './app/page.ts';\nimport './session/viewer.ts';\nimport './ui/page.tsx';\nimport './core/types.ts';\nimport 'preact';\n",
    'app/page.ts': 'export {};', 'session/viewer.ts': 'export {};',
    'ui/page.tsx': 'export const Page = () => <main />;', 'core/types.ts': 'export {};',
  }), []);
  assert.deepEqual(await check({
    'main.tsx': 'export {};',
    'gallery.ts': "import './main.tsx';\nimport './dev/page.ts';\n",
    'app/page.ts': "import '../gallery.ts';\n",
    'dev/page.ts': 'export {};',
  }), [
    'app/page.ts:1 ../gallery.ts: nothing imports gallery.ts',
    'gallery.ts:1 ./main.tsx: nothing imports main.tsx',
    'gallery.ts:2 ./dev/page.ts: the dev pages are entries: nothing outside dev/ imports them',
  ]);
});

test('gallery cannot reach analysis through direct imports, types, dynamic imports or re-exports', async () => {
  for (const source of ["import './analysis/a.ts';", "import type { A } from './analysis/a.ts';",
    "export * from './analysis/a.ts';", "const a = import('./analysis/a.ts');"]) {
    assert.deepEqual(await check({ 'gallery.ts': source, 'analysis/a.ts': 'export type A = 1;' }), [
      'gallery.ts:1 ./analysis/a.ts: gallery entry cannot reach analysis/',
    ]);
  }
});

test('gallery cannot reach analysis through composition modules, session modules or a type cycle', async () => {
  assert.deepEqual(await check({
    'main.tsx': "import './app/editor.ts';",
    'gallery.ts': "import './app/page.ts';",
    'app/editor.ts': "import '../analysis/a.ts';",
    'app/page.ts': "import '../session/viewer.ts';",
    'session/viewer.ts': "import type { State } from './state.ts';",
    'session/state.ts': "import type { Viewer } from './viewer.ts';\nimport type { A } from '../analysis/a.ts';\nexport type State = 1;",
    'analysis/a.ts': 'export type A = 1;',
  }), ['gallery.ts:1 ./app/page.ts: gallery entry cannot reach analysis/']);
});

test('a leaf that imports app/ fails, with import type too', async () => {
  const found = await check({
    'app/events.ts': 'export type E = { readonly event: string };\nexport const x = 1;\n',
    'analysis/a.ts': "import { x } from '../app/events.ts';\nexport const y = x;\n",
    'render/b.ts': "import type { E } from '../app/events.ts';\nexport type F = E;\n",
  });
  assert.deepEqual(found, [
    'analysis/a.ts:1 ../app/events.ts: only main.tsx imports app/',
    'render/b.ts:1 ../app/events.ts: only main.tsx imports app/',
  ]);
});

test('a platform module that imports analysis fails', async () => {
  const found = await check({
    'analysis/service.ts': 'export const service = 1;\n',
    'platform/p.ts': "import { service } from '../analysis/service.ts';\nexport const p = service;\n",
  });
  assert.deepEqual(found, ['platform/p.ts:1 ../analysis/service.ts: platform imports only platform and core/ids.ts']);
});

test('a module that imports zod directly fails; core/zod.ts alone may', async () => {
  const found = await check({
    'core/zod.ts': "import { z } from 'zod';\nz.config({ jitless: true });\nexport { z };\n",
    'core/schema.ts': "import { z } from './zod.ts';\nexport const S = z.object({});\n",
    'store/s.ts': "import { z } from 'zod';\nexport const S = z.string();\n",
    'core/other.ts': "import * as zod from 'zod/v4';\nexport const S = zod;\n",
  });
  assert.deepEqual(found, [
    "core/other.ts:1 zod/v4: only core/zod.ts imports the zod package; import `z` from core/zod.ts",
    "store/s.ts:1 zod: only core/zod.ts imports the zod package; import `z` from core/zod.ts",
  ]);
});

test('every rule of the direction, allowed and forbidden edges side by side', async () => {
  const found = await check({
    'main.tsx': "import { a } from './app/a.ts';\nimport { render } from 'preact';\nrender(a, document.body);\n",
    'app/a.ts': "import { s } from '../session/s.ts';\nimport { r } from '../render/r.ts';\nexport const a = [s, r];\n",
    'app/bad.ts': "import '../main.tsx';\nimport '../dev/page.ts';\n",
    'core/ids.ts': 'export type Id = string;\n',
    'core/raster.ts': "import type { Id } from './ids.ts';\nexport type R = Id;\n",
    'core/leaky.ts': "import { p } from '../platform/p.ts';\nexport const l = p;\n",
    'platform/p.ts': "import type { Id } from '../core/ids.ts';\nexport const p: Id = 'p';\n",
    'platform/q.ts': "import type { R } from '../core/raster.ts';\nexport type Q = R;\n",
    'render/r.ts': "import { p } from '../platform/p.ts';\nimport 'mediabunny';\nimport 'noisy:vendor-ort';\nexport const r = p;\nexport type Renderer = { readonly r: 1 };\nexport type Other = 2;\n",
    'export/ok.ts': "import type { Renderer } from '../render/r.ts';\nimport { Output } from 'mediabunny';\nexport type O = [Renderer, Output];\n",
    'export/value.ts': "import { r } from '../render/r.ts';\nexport const v = r;\n",
    'export/more.ts': "import type { Renderer, Other } from '../render/r.ts';\nexport type M = [Renderer, Other];\n",
    'export/star.ts': "export type * from '../render/r.ts';\n",
    'analysis/w.ts': "const ort = await import('noisy:vendor-ort');\nexport const w = ort;\nexport * from '../store/s.ts';\n",
    'store/s.ts': "import { h } from '../session/s.ts';\nexport const st = h;\n",
    'session/s.ts': "import { r } from '../render/r.ts';\nimport { p } from '../platform/p.ts';\nimport type { A } from '../app/a.ts';\nexport const s = [r, p];\nexport const h = 1;\n",
    'ui/u.tsx': "import { s } from '../session/s.ts';\nimport type { Id } from '../core/ids.ts';\nimport { p } from '../platform/p.ts';\nexport const U = () => <p>{s}{p}</p>;\n",
    'ui/v.ts': "import { r } from '../render/r.ts';\nimport { useState } from 'preact/hooks';\nexport const v = [r, useState];\n",
    'dev/page.ts': "import type { A } from '../app/a.ts';\nimport { a } from '../app/a.ts';\nimport { p } from '../platform/p.ts';\nimport { s } from '../session/s.ts';\nimport './helper.ts';\nimport { w } from '../analysis/w.ts';\nimport { r } from '../render/r.ts';\nimport { st } from '../store/s.ts';\n",
    'dev/helper.ts': 'export {};\n',
    'core/view.tsx': 'export const V = () => <div />;\n',
    'photo/x.ts': "import { readFile } from 'node:fs/promises';\nimport _ from 'lodash';\nimport { h } from 'preact';\nimport '/abs.ts';\nimport './missing.ts';\nimport './Y.ts';\nimport '../../outside.ts';\nconst m = import('../app/' + 'a.ts');\n",
    'photo/y.ts': 'export {};\n',
    'misc/stray.ts': 'export {};\n',
    'core/legacy.js': 'export {};\n',
    'types.d.ts': "declare module 'x' { export * from 'anything'; }\n",
  });
  assert.deepEqual(found, [
    'analysis/w.ts:3 ../store/s.ts: a leaf imports only itself, core, and platform',
    'app/bad.ts:1 ../main.tsx: nothing imports main.tsx',
    'app/bad.ts:2 ../dev/page.ts: the dev pages are entries: nothing outside dev/ imports them',
    'core/leaky.ts:1 ../platform/p.ts: core imports only core',
    'core/legacy.js:0 -: modules under the source root are .ts or .tsx',
    'core/view.tsx:0 -: a .tsx module uses JSX, which imports preact, and only ui/, app/, main.tsx, and dev/ import preact',
    'dev/page.ts:2 ../app/a.ts: a dev page imports app/ with `import type` only',
    'dev/page.ts:4 ../session/s.ts: a dev page imports only dev/, core, platform, analysis, store, and app/ types',
    'dev/page.ts:7 ../render/r.ts: a dev page imports only dev/, core, platform, analysis, store, and app/ types',
    'export/more.ts:1 ../render/r.ts: export imports from render only `import type { Renderer }`',
    'export/star.ts:1 ../render/r.ts: export imports from render only `import type { Renderer }`',
    'export/value.ts:1 ../render/r.ts: export imports from render only `import type { Renderer }`',
    'misc/stray.ts:0 -: the file is outside the module map',
    'photo/x.ts:1 node:fs/promises: node:fs/promises is not a package any module may import',
    'photo/x.ts:2 lodash: lodash is not a package any module may import',
    'photo/x.ts:3 preact: only ui/, app/, main.tsx, and dev/ import preact',
    'photo/x.ts:4 /abs.ts: the import is an absolute path',
    'photo/x.ts:5 ./missing.ts: the import does not name a module file, extension and case exact',
    'photo/x.ts:6 ./Y.ts: the import does not name a module file, extension and case exact',
    'photo/x.ts:7 ../../outside.ts: the import leaves the source root',
    'photo/x.ts:8 -: the checker cannot read the module: a dynamic import() whose specifier is not a string literal cannot be checked',
    'platform/q.ts:1 ../core/raster.ts: platform imports only platform and core/ids.ts',
    'render/r.ts:2 mediabunny: only export/ imports mediabunny',
    'render/r.ts:3 noisy:vendor-ort: only analysis/ and dev/ import noisy:vendor-ort',
    'session/s.ts:3 ../app/a.ts: only main.tsx imports app/',
    'store/s.ts:1 ../session/s.ts: a leaf imports only itself, core, and platform',
    'ui/u.tsx:3 ../platform/p.ts: ui imports only ui, session, and core',
    'ui/v.ts:1 ../render/r.ts: ui imports only ui, session, and core',
  ]);
});

test('the compiler finds imports wherever code holds them, and nowhere else', async () => {
  const source = [
    "import a, { b as c, type D } from './one.ts';", // 1: a value import despite the inline type modifier
    "import type { E } from './two.ts';", // 2
    "import type from './three.ts';", // 3: a default binding named type
    "// import { x } from './comment.ts';",
    "/* import { y } from './block.ts'; */",
    "const s = \"import z from './string.ts'\";",
    "const re = /['\"`]import\\/x/g;",
    'const t = `${import(\'./template.ts\')} import(\'./text.ts\')`;', // 8
    "export * as ns from './four.ts';", // 9
    "export { f } from './five.ts';", // 10
    'export { local };',
    'const local = import.meta.url;',
    'const obj = { import: 1, export: 2 }; obj.import;',
    'const View = () => (',
    "  <div title=\"it's\" data-x={import('./attribute.ts')}>",
    "    Don't {/* import('./jsx-comment.ts') */} <b>{import('./child.ts')}</b> it's {a < 2 ? 1 : 2}", // 16
    '  </div>',
    ');',
    "type R = import('./six.ts').Renderer;", // 19
    "export type { G } from './seven.ts';", // 20
  ].join('\n');
  const root = path.join(scratch, 'reader');
  await writeTree(root, { 'ui/a.tsx': source });
  const read = readImports(root, ['ui/a.tsx']).get('ui/a.tsx');
  assert.deepEqual(read?.unreadable, []);
  const found = (read?.imports ?? []).map((i) => `${i.line} ${i.kind}${i.typeOnly ? ' type' : ''} ${i.specifier} ${JSON.stringify(i.names)}`);
  assert.deepEqual(found, [
    '1 static ./one.ts ["b","D"]',
    '2 static type ./two.ts ["E"]',
    '3 static ./three.ts null',
    '9 re-export ./four.ts null',
    '10 re-export ./five.ts ["f"]',
    '20 re-export type ./seven.ts ["G"]',
    '8 dynamic ./template.ts null',
    '15 dynamic ./attribute.ts null',
    '16 dynamic ./child.ts null',
    '19 import-type type ./six.ts ["Renderer"]',
  ]);
});

test('code a hand-written scanner misreads is read as the compiler reads it', async () => {
  const found = await check({
    'app/x.ts': 'export const x = 1;\n',
    'platform/p.ts': 'export const p = 1;\n',
    // A generic arrow in .tsx is not JSX; the import after it is still seen.
    'ui/a.tsx': [
      'const pick = <T,>(xs: readonly T[]): T | undefined => xs[0];',
      'export const first = <T extends object>(xs: readonly T[]) => xs[0];',
      "export const lazy = () => import('../platform/p.ts');",
      '// </T>',
      'export const V = () => <div>{pick([1])}</div>;',
    ].join('\n'),
    // An import spread into an object, and a division after a postfix increment.
    'photo/a.ts': [
      "export const m = { ...import('../app/x.ts') };",
      "let i = 0; export const k = i++ / 2; export const z = import('zod'); export const q = 1 / 2;",
    ].join('\n'),
  });
  assert.deepEqual(found, [
    'photo/a.ts:1 ../app/x.ts: only main.tsx imports app/',
    "photo/a.ts:2 zod: only core/zod.ts imports the zod package; import `z` from core/zod.ts",
    'ui/a.tsx:3 ../platform/p.ts: ui imports only ui, session, and core',
  ]);
});

test('what the checker cannot read is a violation, never skipped', async () => {
  const found = await check({
    'photo/broken.ts': "import { a } from './a.ts'\nexport const b = (;\n",
    'photo/a.ts': 'export const a = 1;\n',
    'photo/req.ts': "declare const require: (s: string) => unknown;\nexport const z = require('zod');\n",
    'photo/computed.ts': "const name = 'zod';\nexport const z = import(name);\n",
  });
  assert.equal(found.length, 3, found.join('\n'));
  assert.match(found[0] ?? '', /^photo\/broken\.ts:2 -: the checker cannot read the module: the module does not parse: /);
  assert.deepEqual(found.slice(1), [
    'photo/computed.ts:2 -: the checker cannot read the module: a dynamic import() whose specifier is not a string literal cannot be checked',
    'photo/req.ts:2 -: the checker cannot read the module: a module loads others with import, never require()',
  ]);
});

test('a package named like an Object.prototype member is reported, not a crash', async () => {
  const found = await check({
    'photo/a.ts': "import x from 'constructor';\nimport y from '__proto__';\nimport z from 'toString';\nexport const v = [x, y, z];\n",
  });
  assert.deepEqual(found, [
    'photo/a.ts:1 constructor: constructor is not a package any module may import',
    'photo/a.ts:2 __proto__: __proto__ is not a package any module may import',
    'photo/a.ts:3 toString: toString is not a package any module may import',
  ]);
});
