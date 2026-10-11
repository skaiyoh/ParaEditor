import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMathLibrary, forkMathFunction, MATH_PRESET_FUNCTIONS, reviseMathFunction } from '../src/core/math-definition.ts';
import { MATH_BUILTINS, MATH_OPERATOR_TABLE, type MathResult } from '../src/core/math-expression.ts';
import { createMathBlock, createMathPresets, GRAIN_BLOCK_SOURCE, packageMathBlock, reopenMathBlock, replaceMathNode,
  type MathValue } from '../src/core/math-graph.ts';
import { grainHash, grainNoise } from '../src/render/grain.ts';
import { compileBrushCoverage, compileMathBlock, compilePhotoRack, evaluateBrushCoverage, evaluateMathBlock, evaluateMathFunction,
  evaluatePhotoRack, mathShaderDiagnostic, mathSourceAt, trustedMathLibrary, type MathPhotoSample } from '../src/render/math-program.ts';

function value<T>(result: MathResult<T>): T { assert.ok(result.ok, JSON.stringify(result)); return result.value; }
const presets = value(createMathPresets());
const sample: MathPhotoSample = { color: [0.5, 0.4, 0.6], position: [12, 4], seed: 123456789, hold: 7, clarity: 0 };
/** Independent transcription of shaders/grain.ts + shared.ts. No production hash/color helper is called. */
function legacyHash(seed: number, hold: number, x: number, y: number, channel: number): number {
  function fmix(h: number): number {
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); return (h ^ (h >>> 16)) >>> 0;
  }
  const salt = [0x243f6a88, 0x85a308d3, 0x13198a2e][channel]; assert.notEqual(salt, undefined);
  return fmix(fmix(fmix(fmix(seed ^ (salt ?? 0)) ^ hold) ^ x) ^ y);
}
function legacyHold(frame: number, count: number, length: number): number {
  const wrapped = ((frame % count) + count) % count; return Math.floor(wrapped / length) % Math.ceil(count / length);
}
function legacyColor(sample: MathPhotoSample, size: number, amount: number, colorNoise: number): readonly [number, number, number] {
  const [r, g, b] = sample.color;
  const toLinear = (v: number): number => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  const lr = toLinear(r), lg = toLinear(g), lb = toLinear(b);
  const lRoot = (lr * 0.4122214708 + lg * 0.5363325363 + lb * 0.0514459929) ** (1 / 3);
  const mRoot = (lr * 0.2119034982 + lg * 0.6806995451 + lb * 0.1073969566) ** (1 / 3);
  const sRoot = (lr * 0.0883024619 + lg * 0.2817188376 + lb * 0.6299787005) ** (1 / 3);
  const x = Math.trunc(sample.position[0] / size), y = Math.trunc(sample.position[1] / size);
  const n = (channel: number): number => (legacyHash(sample.seed, sample.hold, x, y, channel) >>> 8) / 16777215 * 2 - 1;
  const scale = 1 - 0.5 * sample.clarity;
  const L = 0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot + scale * (0.12 * amount * n(0));
  const a = 1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot + scale * (0.06 * colorNoise * n(1));
  const bb = 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot + scale * (0.06 * colorNoise * n(2));
  const l = L + 0.3963377774 * a + 0.2158037573 * bb, m = L - 0.1055613458 * a - 0.0638541728 * bb, s = L - 0.0894841775 * a - 1.291485548 * bb;
  const lc = l * l * l, mc = m * m * m, sc = s * s * s;
  const fromLinear = (v: number): number => v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055;
  const clamp = (v: number): number => Math.max(0, Math.min(1, fromLinear(v)));
  return [clamp(4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc),
    clamp(-1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc),
    clamp(-0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc)];
}
function legacy(sample: MathPhotoSample, size: number, amount: number, colorNoise: number): readonly number[] {
  const color = amount === 0 && colorNoise === 0 ? sample.color : legacyColor(sample, size, amount, colorNoise);
  return color.map((n) => Math.round(n * 255)).concat(255);
}
function photoInputs(sample: MathPhotoSample) {
  return { color: { type: 'srgb', value: sample.color }, position: { type: 'coord', value: sample.position },
    seed: { type: 'seed', value: sample.seed }, hold: { type: 'hold', value: sample.hold }, clarity: { type: 'coverage', value: sample.clarity } };
}

test('authored seeded noise matches the current hash reference values in all three channels', () => {
  const fn = presets.library.get({ id: 'grain-noise', revision: 1 }); assert.ok(fn);
  assert.equal(grainHash(0, 0, 0, 0, 0), 1459986880);
  assert.equal(grainHash(123456789, 7, 123, 456, 1), 473632032);
  assert.equal(grainHash(0xffffffff, 34, 2047, 1535, 2), 3192946190);
  assert.equal(legacyHash(0, 0, 0, 0, 0), 1459986880);
  assert.equal(legacyHash(123456789, 7, 123, 456, 1), 473632032);
  assert.equal(legacyHash(0xffffffff, 34, 2047, 1535, 2), 3192946190);
  for (const seed of [0, 123456789, 0xffffffff]) for (const hold of [0, 7, 34]) for (let channel = 0; channel < 3; channel++) {
    for (const [x, y] of [[0, 0], [123, 456], [2047, 1535], [0xffffffff, 0xffffffff]] satisfies readonly (readonly [number, number])[]) {
      const inputs: MathValue[] = [{ type: 'seed', value: seed }, { type: 'hold', value: hold }, { type: 'cell', value: [x, y] }, { type: 'scalar', value: channel }];
      assert.deepEqual(value(evaluateMathFunction(presets.library, fn, inputs)), { type: 'noise', value: (legacyHash(seed, hold, x, y, channel) >>> 8) / 16777215 * 2 - 1 });
    }
  }
});

test('authored Grain matches independent legacy color math and per-pass bytes across seeded fixtures', (t) => {
  const colors: MathPhotoSample['color'][] = [[0, 0, 0], [1, 1, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1], [128 / 255, 102 / 255, 153 / 255]];
  let compared = 0;
  for (const grainSize of [1, 2, 3, 4]) for (const [amount, colorNoise] of [[0, 0], [1, 0], [0, 1], [0.5, 0.3], [1, 1]] satisfies readonly (readonly [number, number])[]) {
    const rack = value(compilePhotoRack([{ block: presets.grain, parameters: { grainSize, amount, colorNoise }, enabled: true }]));
    for (const seed of [0, 123456789, 0xffffffff]) for (const clarity of [0, 0.5, 1]) for (const color of colors) {
      for (const position of [[0, 0], [grainSize - 1, grainSize], [grainSize, grainSize - 1], [123, 456], [2047, 1535]] satisfies MathPhotoSample['position'][]) {
        for (const frame of [-1, 0, 68, 69]) {
          const input = { color, seed, clarity, position, hold: legacyHold(frame, 69, 2) };
          assert.deepEqual(value(evaluatePhotoRack(rack, input)).bytes, legacy(input, grainSize, amount, colorNoise), JSON.stringify({ input, grainSize, amount, colorNoise }));
          const raw = value(evaluateMathBlock(presets.grain, { inputs: photoInputs(input), parameters: { grainSize, amount, colorNoise } }));
          assert.deepEqual(raw, { type: 'srgb', value: legacyColor(input, grainSize, amount, colorNoise) }, JSON.stringify({ input, grainSize, amount, colorNoise }));
          compared++;
        }
      }
    }
  }
  t.diagnostic(`${compared} exact legacy CPU raw-color and RGBA8 comparisons passed; GPU parity is LEAD.`);
});

test('composition hold helper retains wrap, negative frame and one-frame tail semantics', () => {
  const library = value(createMathLibrary([{ id: 'hold', revision: 1, libraryRevision: 1,
    source: 'fn f(frame: time, count: scalar, length: scalar) -> hold { return holdAt(frame, count, length); }', dependencies: [] }]));
  const fn = library.get({ id: 'hold', revision: 1 }); assert.ok(fn);
  for (const frame of [-1, 0, 1, 2, 67, 68, 69, 70]) assert.deepEqual(value(evaluateMathFunction(library, fn,
    [{ type: 'time', value: frame }, { type: 'scalar', value: 69 }, { type: 'scalar', value: 2 }])), { type: 'hold', value: legacyHold(frame, 69, 2) });
});

test('Identity, Curve and Threshold expose the same normalized signature and execute authored source', () => {
  for (const id of ['grain-remap', 'grain-curve', 'grain-threshold']) {
    const fn = presets.library.get({ id, revision: 1 }); assert.ok(fn);
    assert.deepEqual(fn.signature, { inputs: ['coverage'], output: 'coverage' });
    assert.equal(fn.label, 'Editable'); assert.deepEqual(fn.ranges.output, [{ min: 0, max: 1 }]);
  }
  const cases = [
    ['grain-remap', [0, 0.25, 0.5, 0.75, 1]],
    ['grain-curve', [0, 0.15625, 0.5, 0.84375, 1]],
    ['grain-threshold', [0, 0, 1, 1, 1]],
  ] satisfies readonly (readonly [string, readonly number[]])[];
  for (const [id, expected] of cases) {
    const fn = presets.library.get({ id, revision: 1 }); assert.ok(fn);
    [0, 0.25, 0.5, 0.75, 1].forEach((n, index) => assert.deepEqual(value(evaluateMathFunction(presets.library, fn,
      [{ type: 'coverage', value: n }])), { type: 'coverage', value: expected[index] }));
  }
});

test('only the exact pinned Identity lowers photo normalization away; edited identity-like source stays authored', () => {
  const original = value(compileMathBlock(presets.grain));
  assert.deepEqual(original.lowerings.map((entry) => [entry.node, entry.from, entry.stage]),
    [['signed0', 'noise0', 'remap0'], ['signed1', 'noise1', 'remap1'], ['signed2', 'noise2', 'remap2']]);
  assert.ok(!original.sources.some((entry) => ['grain-remap@1', 'texture-coverage@1', 'coverage-noise@1'].includes(entry.id)));
  assert.equal(original.fragment.slice(original.fragment.indexOf('vec3 m_block(')).match(/m_n\d+ =/g)?.length, 5);
  const text = 'fn identity(n: coverage) -> coverage { return coverage(value(n)); }';
  for (const library of [
    value(forkMathFunction({ library: presets.library, from: { id: 'grain-remap', revision: 1 }, id: 'owned-identity', source: text })),
    value(reviseMathFunction({ library: presets.library, from: { id: 'grain-remap', revision: 1 }, revision: 2, source: text })),
  ]) {
    const replacement = library.get({ id: 'owned-identity', revision: 1 })?.ref ?? { id: 'grain-remap', revision: 2 };
    const block = value(replaceMathNode({ block: presets.grain, node: 'remap0', replacement,
      ref: { id: 'identity-edited', revision: 1 }, library }));
    const compiled = value(compileMathBlock(block)); assert.equal(compiled.lowerings.length, 2);
    assert.ok(compiled.sources.some((entry) => entry.id === `${replacement.id}@${replacement.revision}`));
    assert.ok(compiled.sources.some((entry) => entry.id === 'texture-coverage@1'));
    assert.ok(compiled.sources.some((entry) => entry.id === 'coverage-noise@1'));
  }
  const brush = value(compileBrushCoverage(presets.texture)); assert.equal(brush.lowerings.length, 0);
  assert.ok(brush.sources.some((entry) => entry.id === 'texture-coverage@1'));
  assert.ok(!brush.sources.some((entry) => entry.id === 'coverage-noise@1'));
});

test('neutral Grain bypass is restricted to the unchanged definition and enabled state', () => {
  const off = value(compilePhotoRack([{ block: presets.grain, parameters: { amount: 0, colorNoise: 0 }, enabled: true }]));
  assert.equal(off.passes[0]?.bypass, true);
  assert.deepEqual(value(evaluatePhotoRack(off, sample)).color, sample.color);
  const disabled = value(compilePhotoRack([{ block: presets.grain, parameters: {}, enabled: false }]));
  assert.equal(disabled.passes[0]?.bypass, true);
  assert.deepEqual(value(evaluatePhotoRack(disabled, sample)).color, sample.color);
  const fork = value(replaceMathNode({ block: presets.grain, node: 'remap0', replacement: { id: 'grain-threshold', revision: 1 },
    ref: { id: 'speckle', revision: 1 }, library: presets.library }));
  assert.equal(value(compilePhotoRack([{ block: fork, parameters: { amount: 0, colorNoise: 0 }, enabled: true }])).passes[0]?.bypass, false);
});

test('a compatible threshold swap and two block orders change actual pixels substantially', (t) => {
  const swapped = value(replaceMathNode({ block: presets.grain, node: 'remap0', replacement: { id: 'grain-threshold', revision: 1 },
    ref: { id: 'speckle', revision: 1 }, library: presets.library }));
  const grain = { block: presets.grain, parameters: { amount: 1, colorNoise: 0.5 }, enabled: true };
  const contrast = { block: presets.contrast, parameters: { strength: 2 }, enabled: true };
  const original = value(compilePhotoRack([grain])), modified = value(compilePhotoRack([{ ...grain, block: swapped }]));
  const first = value(compilePhotoRack([grain, contrast])), second = value(compilePhotoRack([contrast, grain]));
  let swapDifferences = 0, orderDifferences = 0, maximum = 0;
  for (let x = 0; x < 64; x++) {
    const input = { ...sample, position: [x, 4] }, a = value(evaluatePhotoRack(first, input)), b = value(evaluatePhotoRack(second, input));
    if (JSON.stringify(value(evaluatePhotoRack(original, input))) !== JSON.stringify(value(evaluatePhotoRack(modified, input)))) swapDifferences++;
    if (a.bytes.some((byte, index) => byte !== b.bytes[index])) orderDifferences++;
    maximum = Math.max(maximum, ...a.bytes.map((byte, index) => Math.abs(byte - (b.bytes[index] ?? 0))));
  }
  // RGBA8 quantization can leave near-endpoint samples unchanged by thresholding.
  assert.ok(swapDifferences > 60); assert.ok(orderDifferences > 60); assert.ok(maximum > 20);
  t.diagnostic(`64 pixels: threshold swap changed ${swapDifferences}; block order changed ${orderDifferences}; largest channel difference ${maximum}/255.`);
  const afterGrain = value(evaluatePhotoRack(original, sample));
  assert.deepEqual(value(evaluatePhotoRack(first, sample)), value(evaluatePhotoRack(value(compilePhotoRack([contrast])), { ...sample, color: afterGrain.color })));
  assert.equal(first.maxAdditionalTargets, 2); assert.equal(first.passes.length, 2);
});

test('both adapters share and execute a forked pinned remap; brush output is explicit coverage times tip and opacity', () => {
  const library = value(forkMathFunction({ library: presets.library, from: { id: 'grain-remap', revision: 1 }, id: 'owned-remap',
    source: 'fn remap(n: coverage) -> coverage { return coverage(value(n) + 0.3); }' }));
  const changedPhoto = value(replaceMathNode({ block: presets.grain, node: 'remap0', replacement: { id: 'owned-remap', revision: 1 }, ref: { id: 'owned-photo', revision: 1 }, library }));
  const changedTexture = value(replaceMathNode({ block: presets.texture, node: 'remap', replacement: { id: 'owned-remap', revision: 1 }, ref: { id: 'owned-texture', revision: 1 }, library }));
  const photo = value(compilePhotoRack([{ block: changedPhoto, parameters: {}, enabled: true }]));
  const brush = value(compileBrushCoverage(changedTexture));
  const initialBrush = value(compileBrushCoverage(presets.texture));
  assert.equal(photo.passes[0]?.block.functions.find((fn) => fn.ref.id === 'owned-remap'), brush.block.functions.find((fn) => fn.ref.id === 'owned-remap'));
  const stroke = { position: [12, 4], seed: 123456789, hold: 7, roundTip: 0.8, opacity: 0.7, ink: [0.8, 0.2, 0.1] };
  const before = value(evaluateBrushCoverage(initialBrush, stroke)), after = value(evaluateBrushCoverage(brush, stroke));
  assert.notEqual(after.texture, before.texture);
  assert.equal(after.coverage, after.texture * 0.8 * 0.7);
  assert.deepEqual(after.premultiplied, [0.8 * after.coverage, 0.2 * after.coverage, 0.1 * after.coverage, after.coverage]);
  assert.notDeepEqual(value(evaluatePhotoRack(photo, sample)).bytes, value(evaluatePhotoRack(value(compilePhotoRack([{ block: presets.grain, parameters: {}, enabled: true }])), sample)).bytes);
  assert.equal(value(evaluateBrushCoverage(brush, { ...stroke, opacity: 0 })).coverage, 0);
  assert.equal(value(evaluateBrushCoverage(brush, { ...stroke, roundTip: 0 })).coverage, 0);
  assert.equal(value(evaluateBrushCoverage(brush, { ...stroke, ink: [0, 1, 0] })).coverage, after.coverage);
  const reopened = value(compileBrushCoverage(value(reopenMathBlock(JSON.parse(JSON.stringify(packageMathBlock(changedTexture)))))));
  assert.deepEqual(value(evaluateBrushCoverage(reopened, stroke)), after);
});

test('brush cells anchor in stroke-plane coordinates including negative cells, not dab origins', () => {
  const brush = value(compileBrushCoverage(presets.texture, { grainSize: 2 }));
  const base = { seed: 0xffffffff, hold: 34, roundTip: 1, opacity: 1, ink: [1, 1, 1] };
  for (const [x, y] of [[-1, -1], [0, 0], [1.9, 1.9], [2, 2], [2047, 1535]] satisfies readonly (readonly [number, number])[]) {
    assert.equal(value(evaluateBrushCoverage(brush, { ...base, position: [x, y] })).texture,
      grainNoise(base.seed, base.hold, Math.floor(x / 2) >>> 0, Math.floor(y / 2) >>> 0, 0) * 0.5 + 0.5);
  }
});

test('adapters refuse wrong outputs, unavailable context, invalid values and rack over-budget operations', () => {
  const wrongOutput = compileBrushCoverage(presets.grain); assert.ok(!wrongOutput.ok); assert.equal(wrongOutput.error.kind, 'type');
  assert.ok(!compilePhotoRack([{ block: presets.texture, parameters: {}, enabled: true }]).ok);
  const photoOnlyCoverage = value(createMathBlock({ id: 'photo-only', revision: 1, name: 'Photo only',
    inputs: [{ name: 'clarity', type: 'coverage' }], parameters: [], nodes: [], output: { kind: 'input', name: 'clarity' }, outputType: 'coverage' }, presets.library));
  const context = compileBrushCoverage(photoOnlyCoverage); assert.ok(!context.ok); assert.equal(context.error.kind, 'context');
  const nine = compilePhotoRack(Array.from({ length: 9 }, () => ({ block: presets.grain, parameters: {}, enabled: true })));
  assert.ok(!nine.ok); assert.equal(nine.error.kind, 'budget');
  const brush = value(compileBrushCoverage(presets.texture));
  assert.ok(!evaluateBrushCoverage(brush, { position: [0, 0], seed: NaN, hold: 0, roundTip: 1, opacity: 1, ink: [1, 0, 0] }).ok);
  const photo = value(compilePhotoRack([{ block: presets.grain, parameters: {}, enabled: true }]));
  assert.ok(!evaluatePhotoRack(photo, { ...sample, seed: 0x100000000 }).ok);
  assert.ok(!evaluatePhotoRack(photo, { ...sample, position: [-1, 0] }).ok);
  assert.ok(!evaluatePhotoRack(photo, { ...sample, position: [2048, 0] }).ok);
  const narrowContext = value(createMathBlock({ id: 'narrow-brush', revision: 1, name: 'Narrow brush',
    inputs: [{ name: 'pressure', type: 'pressure', range: [{ min: 0, max: 0.5 }] }], parameters: [], nodes: [],
    output: { kind: 'literal', value: { type: 'coverage', value: 1 } }, outputType: 'coverage' }, presets.library));
  const invalidDomain = compileBrushCoverage(narrowContext); assert.ok(!invalidDomain.ok); assert.equal(invalidDomain.error.kind, 'domain');
  assert.equal(value(compilePhotoRack(Array.from({ length: 8 }, () => ({ block: presets.grain, parameters: {}, enabled: true })))).passes.length, 8);
});

test('compiled source maps resolve expressions, graph ports and adapters and remain stable after reopen/reorder', () => {
  const compiled = value(compilePhotoRack([{ block: presets.grain, parameters: {}, enabled: true }])).passes[0]; assert.ok(compiled);
  const literal = compiled.sourceMap.find((entry) => entry.original.sourceId === 'grain-color@1' &&
    compiled.sources.find((doc) => doc.id === 'grain-color@1')?.text.slice(entry.original.span.start, entry.original.span.end) === '0.12');
  assert.ok(literal); assert.equal(compiled.fragment.slice(literal.generated.start, literal.generated.end), '0.12');
  assert.deepEqual(mathSourceAt(compiled, literal.generated.line, literal.generated.column), literal.original);
  const mappedError = mathShaderDiagnostic(compiled, literal.generated.line, literal.generated.column, 'driver failure');
  assert.equal(mappedError.sourceId, 'grain-color@1'); assert.match(mappedError.message, /driver failure/);
  const port = compiled.sourceMap.find((entry) => entry.original.path === '/nodes/0/args/0'); assert.ok(port);
  assert.deepEqual(mathSourceAt(compiled, port.generated.line, port.generated.column), port.original);
  const main = compiled.sourceMap.find((entry) => entry.original.sourceId === 'adapter:photo-color@1'); assert.ok(main);
  assert.equal(mathSourceAt(compiled, main.generated.line + 1, 1)?.sourceId, 'adapter:photo-color@1');
  assert.equal(mathSourceAt(compiled, -1), null); assert.equal(mathSourceAt(compiled, 99999), null);
  const reversed = value(createMathLibrary([...MATH_PRESET_FUNCTIONS].reverse()));
  const same = value(compilePhotoRack([{ block: value(createMathBlock(GRAIN_BLOCK_SOURCE, reversed)), parameters: {}, enabled: true }])).passes[0];
  assert.deepEqual(same?.fragment, compiled.fragment); assert.deepEqual(same?.sourceMap, compiled.sourceMap);
  const reopened = value(compilePhotoRack([{ block: value(reopenMathBlock(JSON.parse(JSON.stringify(packageMathBlock(presets.grain))))), parameters: {}, enabled: true }])).passes[0];
  assert.deepEqual(reopened?.fragment, compiled.fragment); assert.deepEqual(reopened?.sourceMap, compiled.sourceMap);
  assert.ok(Object.isFrozen(compiled.sourceMap));
});

test('trusted registry is inspectable and source maps point to exact generated builtin implementations', () => {
  assert.deepEqual(trustedMathLibrary.builtins.map((entry) => entry.name), MATH_BUILTINS.map((entry) => entry.name));
  const kernel = value(compileMathBlock(presets.texture));
  for (const entry of trustedMathLibrary.builtins) {
    const mapped = kernel.sourceMap.find((item) => item.original.sourceId === `builtin:${entry.name}@1`); assert.ok(mapped);
    assert.equal(kernel.fragment.slice(mapped.generated.start, mapped.generated.end).trim(), entry.source);
    assert.equal(typeof entry.evaluate, 'function');
  }
  const cells = trustedMathLibrary.builtins.find((entry) => entry.name === 'cells'); assert.ok(cells);
  assert.deepEqual(cells.evaluate([[3, 4], 0]), [3, 4]);
  const noise = trustedMathLibrary.builtins.find((entry) => entry.name === 'hashNoise'); assert.ok(noise);
  assert.equal(noise.evaluate([0, 0, [0, 0], 100]), grainNoise(0, 0, 0, 0, 2));
  assert.equal(noise.evaluate([0, 0, [0, 0], -100]), grainNoise(0, 0, 0, 0, 0));
  assert.equal(trustedMathLibrary.label, 'Built-in');
  for (const entry of trustedMathLibrary.builtins) {
    assert.equal(entry.label, 'Built-in'); assert.equal(entry.rangeRule, MATH_OPERATOR_TABLE.find((rule) => rule.kind === 'builtin' && rule.name === entry.name));
  }
  assert.match(trustedMathLibrary.support, /0x243f6a88u/); assert.match(trustedMathLibrary.support, /0.4122214708/);
  assert.doesNotMatch(kernel.fragment, /m_safe|m_div|isnan|isinf/);
});

test('canonical graph output and adapter bytes agree while semantic values remain distinct', () => {
  const direct = value(evaluateMathBlock(presets.grain, { inputs: {
    color: { type: 'srgb', value: sample.color }, position: { type: 'coord', value: sample.position }, seed: { type: 'seed', value: sample.seed },
    hold: { type: 'hold', value: sample.hold }, clarity: { type: 'coverage', value: sample.clarity },
  } }));
  assert.equal(direct.type, 'srgb'); if (direct.type !== 'srgb') return;
  const rack = value(compilePhotoRack([{ block: presets.grain, parameters: {}, enabled: true }]));
  assert.deepEqual(value(evaluatePhotoRack(rack, sample)).bytes, [...direct.value.map((n) => Math.round(n * 255)), 255]);
});
