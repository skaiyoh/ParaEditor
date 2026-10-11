import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMathLibrary, MATH_PRESET_FUNCTIONS } from '../src/core/math-definition.ts';
import { MATH_LIMITS, type MathResult } from '../src/core/math-expression.ts';
import { admitMathRecipeBytes, createMathBlock, createMathPresets, GRAIN_BLOCK_SOURCE, mathGraphLocation,
  packageMathBlock, readMathValue, reopenMathBlock, replaceMathNode, resolveMathParameters, TEXTURE_BLOCK_SOURCE,
  type MathBlockSource } from '../src/core/math-graph.ts';
import { evaluateMathBlock, evaluateMathFunction } from '../src/render/math-program.ts';

function value<T>(result: MathResult<T>): T { assert.ok(result.ok, JSON.stringify(result)); return result.value; }
const presets = value(createMathPresets());
const sample = { color: { type: 'srgb', value: [0.5, 0.4, 0.6] }, position: { type: 'coord', value: [12, 4] },
  seed: { type: 'seed', value: 123456789 }, hold: { type: 'hold', value: 7 }, clarity: { type: 'coverage', value: 0 } };

test('block execution follows its typed DAG, including dependencies listed after their consumers', () => {
  const reversed = value(createMathBlock({ ...GRAIN_BLOCK_SOURCE, nodes: [...GRAIN_BLOCK_SOURCE.nodes].reverse() }, presets.library));
  assert.deepEqual(value(evaluateMathBlock(reversed, { inputs: sample })), value(evaluateMathBlock(presets.grain, { inputs: sample })));
  assert.equal(reversed.nodes[0]?.source.id, 'cells');
  assert.equal(reversed.nodes.at(-1)?.source.id, 'color');
});

test('packaging carries the immutable full closure and reopens without the original library', () => {
  const packed = packageMathBlock(presets.grain);
  assert.equal(packed.functions.length, 6);
  const reopened = value(reopenMathBlock(JSON.parse(JSON.stringify(packed))));
  assert.deepEqual(value(evaluateMathBlock(reopened, { inputs: sample })), value(evaluateMathBlock(presets.grain, { inputs: sample })));
  assert.equal(Reflect.set(packed.block.nodes, '0', null), false);
  assert.equal(Reflect.set(packed.functions, '0', null), false);
  assert.equal(Reflect.set(packed.functions[0] ?? {}, 'source', 'wrong'), false);
  const missing = reopenMathBlock({ ...packed, functions: packed.functions.slice(1) });
  assert.ok(!missing.ok); assert.equal(missing.error.kind, 'missing');
});

test('compatible function replacement executes and incompatible replacement retains the original', () => {
  const changed = value(replaceMathNode({ block: presets.grain, node: 'remap0', replacement: { id: 'grain-threshold', revision: 1 },
    ref: { id: 'speckle', revision: 1 }, library: presets.library }));
  assert.notDeepEqual(value(evaluateMathBlock(changed, { inputs: sample })), value(evaluateMathBlock(presets.grain, { inputs: sample })));
  const invalid = replaceMathNode({ block: presets.grain, node: 'remap0', replacement: { id: 'texture-coverage', revision: 1 },
    ref: { id: 'bad', revision: 1 }, library: presets.library });
  assert.ok(!invalid.ok); assert.equal(invalid.error.kind, 'type');
  assert.equal(presets.grain.source.nodes.find((node) => node.id === 'remap0')?.function.id, 'grain-remap');
  assert.ok(!replaceMathNode({ block: presets.grain, node: 'remap0', replacement: { id: 'grain-threshold', revision: 1 },
    ref: presets.grain.ref, library: presets.library }).ok);
});

test('two compatible function arrangements compute different results', () => {
  const library = value(createMathLibrary([...MATH_PRESET_FUNCTIONS, { id: 'bias', revision: 1, libraryRevision: 1,
    source: 'fn bias(n: coverage) -> coverage { return coverage(value(n) + 0.5); }', dependencies: [] }]));
  const make = (first: string, second: string) => value(createMathBlock({ id: 'chain', revision: 1, name: 'Chain',
    inputs: [{ name: 'n', type: 'coverage' }], parameters: [], outputType: 'coverage', output: { kind: 'node', node: 'second' },
    nodes: [{ id: 'first', function: { id: first, revision: 1 }, args: [{ kind: 'input', name: 'n' }] },
      { id: 'second', function: { id: second, revision: 1 }, args: [{ kind: 'node', node: 'first' }] }] }, library));
  const input = { inputs: { n: { type: 'coverage', value: 0.25 } } };
  assert.deepEqual(value(evaluateMathBlock(make('bias', 'grain-threshold'), input)), { type: 'coverage', value: 1 });
  assert.deepEqual(value(evaluateMathBlock(make('grain-threshold', 'bias'), input)), { type: 'coverage', value: 0.5 });
});

test('cycles, missing nodes, unavailable inputs and bad port connections refuse at a JSON source path', () => {
  const base: MathBlockSource = { id: 'test', revision: 1, name: 'Test', inputs: [{ name: 'n', type: 'coverage' }], parameters: [],
    nodes: [{ id: 'a', function: { id: 'grain-remap', revision: 1 }, args: [{ kind: 'input', name: 'n' }] }],
    output: { kind: 'node', node: 'a' }, outputType: 'coverage' };
  const cases = [
    { kind: 'cycle', binding: { kind: 'node', node: 'a' } },
    { kind: 'missing', binding: { kind: 'node', node: 'absent' } },
    { kind: 'context', binding: { kind: 'input', name: 'photo' } },
    { kind: 'missing', binding: { kind: 'parameter', name: 'unknown' } },
    { kind: 'type', binding: { kind: 'literal', value: { type: 'noise', value: 0.5 } } },
  ];
  for (const entry of cases) {
    const result = createMathBlock({ ...base, nodes: base.nodes.map((node) => ({ ...node, args: [entry.binding] })) }, presets.library);
    assert.ok(!result.ok, JSON.stringify(entry)); assert.equal(result.error.kind, entry.kind);
    assert.equal(result.error.path, '/nodes/0/args/0'); assert.ok(result.error.span.start > 0);
  }
  const cycle = createMathBlock({ ...base, nodes: [
    { id: 'a', function: { id: 'grain-remap', revision: 1 }, args: [{ kind: 'node', node: 'b' }] },
    { id: 'b', function: { id: 'grain-remap', revision: 1 }, args: [{ kind: 'node', node: 'a' }] },
  ] }, presets.library);
  assert.ok(!cycle.ok); assert.equal(cycle.error.kind, 'cycle');
  const at = mathGraphLocation(presets.grain, '/nodes/0/args/0');
  assert.equal(presets.grain.document.text.slice(at.span.start, at.span.end), '{"kind":"input","name":"position"}');
});

test('graph nodes, ports, parameters, budgets and semantic values are checked before replacing valid work', () => {
  for (const input of [
    { ...TEXTURE_BLOCK_SOURCE, nodes: Array.from({ length: 17 }, () => TEXTURE_BLOCK_SOURCE.nodes[0]) },
    { ...TEXTURE_BLOCK_SOURCE, inputs: [...TEXTURE_BLOCK_SOURCE.inputs, TEXTURE_BLOCK_SOURCE.inputs[0]] },
    { ...TEXTURE_BLOCK_SOURCE, parameters: [{ name: 'grainSize', type: 'scalar', default: 1, min: 4, max: 1, integer: true }] },
    { ...TEXTURE_BLOCK_SOURCE, parameters: [{ name: 'grainSize', type: 'coverage', default: 0.5, min: 0, max: 2, integer: false }] },
    { ...TEXTURE_BLOCK_SOURCE, outputType: 'srgb' },
  ]) assert.ok(!createMathBlock(input, presets.library).ok);
  for (const parameters of [{ grainSize: 0 }, { grainSize: 1.5 }, { grainSize: 5 }, { grainSize: NaN }, { grainSize: Infinity }, { missing: 1 }]) {
    assert.ok(!resolveMathParameters(presets.grain, parameters).ok);
  }
  assert.equal(value(resolveMathParameters(presets.grain, {}))['grainSize']?.value, 1);
  for (const input of [ { type: 'coverage', value: -1 }, { type: 'noise', value: 2 }, { type: 'seed', value: -1 },
    { type: 'seed', value: 0x100000000 }, { type: 'hold', value: 0.5 }, { type: 'scalar', value: NaN },
    { type: 'coord', value: [Infinity, 0] }, { type: 'cell', value: [1.5, 0] }, { type: 'time', value: 0.5 } ]) assert.ok(!readMathValue(input).ok);
  assert.deepEqual(value(readMathValue({ type: 'seed', value: 0xffffffff })), { type: 'seed', value: 0xffffffff });
  assert.ok(!evaluateMathBlock(presets.grain, { inputs: { ...sample, color: { type: 'coverage', value: 0.5 } } }).ok);
  assert.ok(!evaluateMathBlock(presets.grain, { inputs: { ...sample, injected: { type: 'scalar', value: 1 } } }).ok);
});

test('recipe and recoverable draft byte limits reject before loss, including UTF-8 text', () => {
  assert.equal(value(admitMathRecipeBytes('x'.repeat(MATH_LIMITS.recipeBytes), [])), MATH_LIMITS.recipeBytes);
  assert.ok(!admitMathRecipeBytes('x'.repeat(MATH_LIMITS.recipeBytes), ['x']).ok);
  assert.ok(!admitMathRecipeBytes('', ['😀'.repeat(MATH_LIMITS.draftBytes / 4 + 1)]).ok);
  assert.equal(value(admitMathRecipeBytes('recipe', ['draft'])), 11);
  assert.equal(value(admitMathRecipeBytes('', ['x'.repeat(MATH_LIMITS.draftBytes)])), MATH_LIMITS.draftBytes);
});

test('graph admission propagates parameter ranges through every function and rejects range-incompatible reuse', () => {
  const library = value(createMathLibrary([
    { id: 'reciprocal', revision: 1, libraryRevision: 1, dependencies: [], source: 'fn f(x: scalar[1,4]) -> scalar { return 8.0 / x; }' },
    { id: 'half', revision: 1, libraryRevision: 1, dependencies: [], source: 'fn f(x: scalar[0,4]) -> scalar { return x * 0.5; }' },
  ]));
  const source: MathBlockSource = { id: 'ranges', revision: 1, name: 'Ranges', inputs: [],
    parameters: [{ name: 'x', type: 'scalar', min: 2, max: 4, default: 4, integer: false }],
    nodes: [{ id: 'first', function: { id: 'reciprocal', revision: 1 }, args: [{ kind: 'parameter', name: 'x' }] },
      { id: 'second', function: { id: 'half', revision: 1 }, args: [{ kind: 'node', node: 'first' }] }],
    output: { kind: 'node', node: 'second' }, outputType: 'scalar' };
  const block = value(createMathBlock(source, library));
  assert.deepEqual(block.nodes[0]?.ranges.output, [{ min: 2, max: 4 }]); assert.deepEqual(block.outputRange, [{ min: 1, max: 2 }]);
  assert.deepEqual(value(evaluateMathBlock(block, { inputs: {}, parameters: { x: 2 } })), { type: 'scalar', value: 2 });
  const unprovable = createMathBlock({ ...source, parameters: [{ ...source.parameters[0], min: 1 }] }, library);
  assert.ok(!unprovable.ok); assert.equal(unprovable.error.kind, 'domain'); assert.equal(unprovable.error.sourceId, 'half@1');
  const unsafe = createMathBlock({ ...source, parameters: [{ ...source.parameters[0], min: 0 }] }, library);
  assert.ok(!unsafe.ok); assert.equal(unsafe.error.kind, 'domain');
  const narrow = value(createMathLibrary([...MATH_PRESET_FUNCTIONS, { id: 'narrow', revision: 1, libraryRevision: 1, dependencies: [],
    source: 'fn f(n: coverage[0,0.5]) -> coverage { return n; }' }]));
  const replacement = replaceMathNode({ block: presets.grain, node: 'remap0', replacement: { id: 'narrow', revision: 1 },
    ref: { id: 'narrow-grain', revision: 1 }, library: narrow });
  assert.ok(!replacement.ok); assert.equal(replacement.error.kind, 'domain');
  assert.equal(presets.grain.nodes.length, 14);
});

test('the sixteen-node boundary and block input ranges are admitted and checked at execution', () => {
  const source: MathBlockSource = { id: 'sixteen', revision: 1, name: 'Sixteen',
    inputs: [{ name: 'n', type: 'coverage', range: [{ min: 0.25, max: 0.75 }] }], parameters: [],
    nodes: Array.from({ length: 16 }, (_, index) => ({ id: `n${index}`, function: { id: 'grain-remap', revision: 1 },
      args: [index ? { kind: 'node', node: `n${index - 1}` } : { kind: 'input', name: 'n' }] })),
    output: { kind: 'node', node: 'n15' }, outputType: 'coverage' };
  const block = value(createMathBlock(source, presets.library));
  assert.deepEqual(block.outputRange, [{ min: 0.25, max: 0.75 }]);
  assert.deepEqual(value(evaluateMathBlock(block, { inputs: { n: { type: 'coverage', value: 0.5 } } })), { type: 'coverage', value: 0.5 });
  const outside = evaluateMathBlock(block, { inputs: { n: { type: 'coverage', value: 1 } } });
  assert.ok(!outside.ok); assert.equal(outside.error.kind, 'domain');
  const tooMany = createMathBlock({ ...source, nodes: [...source.nodes, source.nodes[0]] }, presets.library);
  assert.ok(!tooMany.ok); assert.equal(tooMany.error.kind, 'budget');
});

test('direct functions and graph calls check the same inspectable float execution domain', () => {
  const source = { id: 'decimal', revision: 1, libraryRevision: 1, dependencies: [],
    source: 'fn f(x: scalar[0.1,0.1]) -> scalar { return x; }' };
  const library = value(createMathLibrary([source])), fn = library.get(source); assert.ok(fn);
  const sample = { type: 'scalar', value: Math.fround(0.1) };
  assert.deepEqual(fn.parsed.inputs[0]?.range, [{ min: 0.1, max: 0.1 }]); // Author's text is retained.
  assert.ok((fn.ranges.inputs[0]?.[0]?.min ?? 1) <= sample.value && (fn.ranges.inputs[0]?.[0]?.max ?? 0) >= sample.value);
  const block = value(createMathBlock({ id: 'decimal-block', revision: 1, name: 'Decimal', inputs: [], parameters: [],
    nodes: [{ id: 'n', function: { id: 'decimal', revision: 1 }, args: [{ kind: 'literal', value: sample }] }],
    output: { kind: 'node', node: 'n' }, outputType: 'scalar' }, library));
  assert.deepEqual(value(evaluateMathBlock(block, { inputs: {} })), value(evaluateMathFunction(library, fn, [sample])));
  const parameterBlock = value(createMathBlock({ ...block.source,
    parameters: [{ name: 'x', type: 'scalar', min: 0.1, max: 0.1, default: 0.1, integer: false }],
    nodes: [{ id: 'n', function: { id: 'decimal', revision: 1 }, args: [{ kind: 'parameter', name: 'x' }] }] }, library));
  assert.deepEqual(value(evaluateMathBlock(parameterBlock, { inputs: {}, parameters: { x: sample.value } })),
    value(evaluateMathFunction(library, fn, [sample])));
  assert.ok(!evaluateMathFunction(library, fn, [{ type: 'scalar', value: 0.2 }]).ok);
  const invalid = createMathBlock({ ...block.source, nodes: [{ ...block.source.nodes[0], args: [{ kind: 'literal', value: { type: 'scalar', value: 0.2 } }] }] }, library);
  assert.ok(!invalid.ok); assert.equal(invalid.error.kind, 'domain');
  const literal = value(createMathBlock({ ...block.source, nodes: [], output: { kind: 'literal', value: { type: 'scalar', value: 0.1 } } }, library));
  assert.deepEqual(literal.outputRange, fn.ranges.inputs[0]);
});
