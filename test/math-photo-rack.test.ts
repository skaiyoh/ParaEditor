import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMathBlock, createMathPresets } from '../src/core/math-graph.ts';
import type { MathResult } from '../src/core/math-expression.ts';
import { admitPhotoRack, compilePhotoRack } from '../src/render/math-program.ts';

function unwrap<T>(result: MathResult<T>): T { assert.ok(result.ok, JSON.stringify(result)); return result.value; }
const presets = unwrap(createMathPresets());
const grain = { block: presets.grain, parameters: { amount: .52, colorNoise: .32 }, enabled: true };

test('renderer admission reconstructs the complete immutable rack and preserves pass boundaries', () => {
  const compiled = unwrap(compilePhotoRack([grain, { block: presets.contrast, parameters: {}, enabled: true }]));
  const admitted = unwrap(admitPhotoRack(compiled));
  assert.deepEqual(admitted, compiled);
  assert.notEqual(admitted, compiled);
  assert.equal(admitted.passes.length, 2);
  assert.ok(Object.isFrozen(admitted) && Object.isFrozen(admitted.passes));
  assert.ok(admitted.passes.every(pass => pass.targetFormat === 'rgba8' && Object.isFrozen(pass)));
});

test('copied, forged shader, bypass and budget metadata cannot cross renderer admission', () => {
  const compiled = unwrap(compilePhotoRack([grain]));
  const pass = compiled.passes[0]; assert.ok(pass);
  for (const rack of [{ ...compiled }, { ...compiled, passes: [{ ...pass, fragment: '#version 300 es\nvoid main() {}' }] },
    { ...compiled, passes: [{ ...pass, bypass: true }] }, { ...compiled, passes: Array(9).fill(pass) }]) {
    const refused = admitPhotoRack(rack);
    assert.ok(!refused.ok); assert.equal(refused.error.kind, 'context');
    assert.match(refused.error.message, /unadmitted/);
  }
  assert.ok(admitPhotoRack(compiled).ok);
});

test('structurally forged function closure cannot bypass source re-admission', () => {
  const forged = { ...presets.grain, functions: [] };
  const compiled = unwrap(compilePhotoRack([{ ...grain, block: forged }]));
  const refused = admitPhotoRack(compiled);
  assert.ok(!refused.ok); assert.equal(refused.error.kind, 'missing');
});

test('adapter-owned Grain hold is checked before GPU compilation', () => {
  const block = unwrap(createMathBlock({ ...presets.grain.source, id: 'hold-grain',
    parameters: [...presets.grain.source.parameters, { name: 'grainHold', type: 'scalar', default: 2, min: -1, max: 4, integer: false }] }, presets.library));
  for (const grainHold of [-1, 0, 1.5]) {
    const compiled = unwrap(compilePhotoRack([{ ...grain, block, parameters: { ...grain.parameters, grainHold } }]));
    const refused = admitPhotoRack(compiled);
    assert.ok(!refused.ok); assert.equal(refused.error.kind, 'domain'); assert.equal(refused.error.path, '/parameters');
  }
  assert.ok(admitPhotoRack(unwrap(compilePhotoRack([{ ...grain, block, parameters: { grainHold: 3 } }]))).ok);
});

test('zero and disabled racks retain bypass without extra pass execution', () => {
  const zero = unwrap(admitPhotoRack(unwrap(compilePhotoRack([{ ...grain, parameters: { amount: 0, colorNoise: 0 } }]))));
  const disabled = unwrap(admitPhotoRack(unwrap(compilePhotoRack([{ ...grain, enabled: false }]))));
  assert.equal(zero.passes[0]?.bypass, true); assert.equal(disabled.passes[0]?.bypass, true);
  assert.equal(unwrap(admitPhotoRack(unwrap(compilePhotoRack([])))).passes.length, 0);
});
