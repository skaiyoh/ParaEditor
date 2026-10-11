import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createMathLibrary, forkMathFunction, mathFunctionClosure, MATH_PRESET_FUNCTIONS, reviseMathFunction, type MathFunctionSource } from '../src/core/math-definition.ts';
import { type MathResult } from '../src/core/math-expression.ts';
import { evaluateMathFunction } from '../src/render/math-program.ts';

function value<T>(result: MathResult<T>): T { assert.ok(result.ok, JSON.stringify(result)); return result.value; }
const source = (id: string, text = 'fn f(x: scalar) -> scalar { return x; }'): MathFunctionSource =>
  ({ id, revision: 1, libraryRevision: 1, source: text.replaceAll('x: scalar', 'x: scalar[-10,10]'), dependencies: [] });

test('a function fork is immutable, executable, and leaves existing pinned uses unchanged', () => {
  const original = source('original'), library = value(createMathLibrary([original]));
  const fork = value(forkMathFunction({ library, from: original, id: 'owned', source: 'fn f(x: scalar[-10,10]) -> scalar { return x * 2.0; }' }));
  const before = fork.get(original), after = fork.get({ id: 'owned', revision: 1 }); assert.ok(before && after);
  assert.deepEqual(value(evaluateMathFunction(fork, before, [{ type: 'scalar', value: 3 }])), { type: 'scalar', value: 3 });
  assert.deepEqual(value(evaluateMathFunction(fork, after, [{ type: 'scalar', value: 3 }])), { type: 'scalar', value: 6 });
  assert.equal(library.get({ id: 'owned', revision: 1 }), undefined);
  assert.equal(Reflect.set(before.source, 'source', 'evil'), false);
  assert.equal(Reflect.set(before.parsed.inputs, '0', null), false);
  assert.equal(Reflect.set(fork.definitions, '0', null), false);
  assert.equal(original.source, before.source.source);
  assert.ok(!forkMathFunction({ library, from: original, id: 'original', source: original.source }).ok);
});

test('dependency closure is transitive, ordered, deduplicated and pins exact revisions', () => {
  const leaf = source('leaf', 'fn leaf(x: scalar) -> scalar { return x * 2; }');
  const branch = { ...source('branch', 'fn branch(x: scalar) -> scalar { return borrowed(x) + borrowed(x); }'), dependencies: [{ name: 'borrowed', ref: leaf }] };
  // Dependency refs are only id + revision, never a source record.
  const cleanBranch = { ...branch, dependencies: [{ name: 'borrowed', ref: { id: leaf.id, revision: leaf.revision } }] };
  const root = { ...source('root', 'fn root(x: scalar) -> scalar { return branch(x); }'), dependencies: [{ name: 'branch', ref: { id: 'branch', revision: 1 } }] };
  const library = value(createMathLibrary([root, leaf, cleanBranch, { ...leaf, revision: 2, source: 'fn leaf(x: scalar[-10,10]) -> scalar { return x * 9; }' }]));
  assert.deepEqual(value(mathFunctionClosure(library, [root, leaf])).map((fn) => `${fn.ref.id}@${fn.ref.revision}`), ['leaf@1', 'branch@1', 'root@1']);
  const fn = library.get(root); assert.ok(fn);
  assert.deepEqual(value(evaluateMathFunction(library, fn, [{ type: 'scalar', value: 3 }])), { type: 'scalar', value: 12 });
  assert.equal(fn.evaluationSteps, 13);
});

test('source is the sole admitted representation and the boundary copies caller records', () => {
  const raw = { ...source('base'), dependencies: [] };
  const library = value(createMathLibrary([raw]));
  raw.source = 'fn f(x: scalar) -> scalar { return 9; }';
  assert.equal(library.sources[0]?.source, source('base').source);
  assert.ok(!createMathLibrary([{ ...raw, parsed: { result: 1 } }]).ok);
  assert.ok(!createMathLibrary([{ ...raw, libraryRevision: 2 }]).ok);
  assert.ok(!createMathLibrary([source('same'), source('same', 'fn f(x: scalar) -> scalar { return 3; }')]).ok);
  assert.equal(value(createMathLibrary([source('same'), source('same')])).definitions.length, 1);
});

test('cycles, missing revisions and dependency-name conflicts have local positioned refusals', () => {
  const a = { ...source('a', 'fn a(x: scalar) -> scalar {\n  return other(x);\n}'), dependencies: [{ name: 'other', ref: { id: 'b', revision: 1 } }] };
  const b = { ...source('b', 'fn b(x: scalar) -> scalar { return other(x); }'), dependencies: [{ name: 'other', ref: { id: 'a', revision: 1 } }] };
  for (const [input, kind] of [[ [a, b], 'cycle' ], [ [a], 'missing' ], [ [{ ...a, dependencies: [{ name: 'min', ref: { id: 'b', revision: 1 } }] }, b], 'type' ]] satisfies readonly (readonly [unknown, string])[]) {
    const result = createMathLibrary(input); assert.ok(!result.ok); assert.equal(result.error.kind, kind);
    assert.ok(result.error.span.line >= 1 && result.error.span.column >= 1);
    assert.ok(result.error.message.length > 10); assert.ok(result.error.sourceId.endsWith('@1'));
  }
});

test('unique function budget and transitive call expansion are admitted before execution', () => {
  const tooMany = createMathLibrary(Array.from({ length: 65 }, (_, index) => source(`f${index}`)));
  assert.ok(!tooMany.ok); assert.equal(tooMany.error.kind, 'budget');
  assert.equal(value(createMathLibrary(Array.from({ length: 65 }, () => source('same')))).definitions.length, 1);
  assert.equal(value(createMathLibrary(Array.from({ length: 64 }, (_, index) => source(`f${index}`)))).definitions.length, 64);
  const doubling = [source('f0')];
  for (let index = 1; index < 17; index++) doubling.push({ ...source(`f${index}`, 'fn f(x: scalar) -> scalar { return prior(x) + prior(x); }'),
    dependencies: [{ name: 'prior', ref: { id: `f${index - 1}`, revision: 1 } }] });
  const exponential = createMathLibrary(doubling); assert.ok(!exponential.ok); assert.equal(exponential.error.kind, 'budget');
  assert.match(exponential.error.message, /65536/);
});

test('revisions are additive and invalid edits retain all prior pinned source and range proofs', () => {
  const library = value(createMathLibrary([source('owned')])), from = { id: 'owned', revision: 1 };
  const revised = value(reviseMathFunction({ library, from, revision: 2, source: 'fn f(x: scalar[-10,10]) -> scalar { return x * 3.0; }' }));
  assert.equal(revised.get(from)?.source.source, library.get(from)?.source.source);
  const latest = revised.get({ id: 'owned', revision: 2 }); assert.ok(latest);
  assert.deepEqual(latest.ranges.output, [{ min: -30, max: 30 }]);
  assert.deepEqual(value(evaluateMathFunction(revised, latest, [{ type: 'scalar', value: 3 }])), { type: 'scalar', value: 9 });
  assert.ok(!reviseMathFunction({ library: revised, from, revision: 2, source: latest.source.source }).ok);
  const invalid = reviseMathFunction({ library: revised, from, revision: 3, source: 'fn f(x: scalar[-10,10]) -> scalar { return 1.0 / x; }' });
  assert.ok(!invalid.ok); assert.equal(invalid.error.kind, 'domain');
  assert.equal(revised.get({ id: 'owned', revision: 3 }), undefined); assert.equal(revised.definitions.length, 2);
});

test('CSP without string code generation admits, compiles and executes the real presets', () => {
  const graph = new URL('../src/core/math-graph.ts', import.meta.url).href;
  const program = new URL('../src/render/math-program.ts', import.meta.url).href;
  const script = `import {createMathPresets} from ${JSON.stringify(graph)};
import {compilePhotoRack,evaluatePhotoRack} from ${JSON.stringify(program)};
const p=createMathPresets(); if(!p.ok)throw Error(p.error.message);
const r=compilePhotoRack([{block:p.value.grain,parameters:{},enabled:true}]); if(!r.ok)throw Error(r.error.message);
const e=evaluatePhotoRack(r.value,{color:[0.5,0.4,0.6],position:[12,4],seed:123456789,hold:7,clarity:0});
if(!e.ok)throw Error(e.error.message); console.log(e.value.bytes.join(','));`;
  const result = spawnSync(process.execPath, ['--disallow-code-generation-from-strings', '--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '120,88,151,255');
  assert.equal(value(createMathLibrary(MATH_PRESET_FUNCTIONS)).definitions.length, 9);
});
