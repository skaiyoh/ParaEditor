// The thread probe's built-in model (src/dev/tiny-model.ts) is a valid ONNX
// model: ONNX Runtime Web's own Node build, the same package and version the
// browser runs from /vendor/ort/, loads it and computes the product.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as ort from 'onnxruntime-web';
import { matMulModel } from '../src/dev/tiny-model.ts';

test('matMulModel loads in ONNX Runtime and multiplies', async () => {
  ort.env.wasm.numThreads = 1;
  const size = 32;
  const session = await ort.InferenceSession.create(matMulModel(size), { executionProviders: ['wasm'] });
  assert.deepEqual([session.inputNames, session.outputNames], [['a', 'b'], ['c']]);
  const a = new ort.Tensor('float32', Float32Array.from({ length: size * size }, (_, i) => i % size), [size, size]);
  const b = new ort.Tensor('float32', new Float32Array(size * size).fill(1), [size, size]);
  const { c } = await session.run({ a, b });
  assert.deepEqual(c?.dims, [size, size]);
  // Row r of a is 0..size-1, so every element of a times a matrix of ones is their sum.
  const sum = (size * (size - 1)) / 2;
  assert.ok(c?.data instanceof Float32Array && c.data.every((v) => v === sum));
  await session.release();
});
