// analysis/stage-math.ts under node: each stage function on hand-computed
// inputs with exact outputs and on malformed inputs, each refused with its
// reason; the depth product, MI-GAN's input, and the plate on the synth
// fixtures at their real sizes; the decoder's prompt, its embeddings check,
// and its candidates, resampled from logits whose bilinear resample is known
// exactly; and the stage functions and the decoder's on ONNX Runtime's own
// tensors.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InferenceSession } from 'noisy:vendor-ort';
import * as ort from 'onnxruntime-web';
import { depthInputSize } from '../src/analysis/depth-size.ts';
import { parseDecodeReply, parseSequenceReply, type SamEmbeddings } from '../src/analysis/protocol.ts';
import {
  DECODER_MASKS,
  DECODER_SCORES,
  decodeCandidates,
  decoderEmbeddings,
  decoderPrompt,
  DEPTH_OUTPUT,
  depthProduct,
  IMAGENET_MEAN,
  IMAGENET_STD,
  imagenetInput,
  MIGAN_HOLE_THRESHOLD,
  MIGAN_OUTPUT,
  miganInput,
  plateFromResult,
  SAM_CANDIDATES,
  SAM_EMBEDDING_TENSORS,
  SAM_MASK_SIZE,
  samEmbeddings,
  type TensorMap,
} from '../src/analysis/stage-math.ts';
import { isModelId, type ModelId } from '../src/core/ids.ts';
import { percentile } from '../src/core/percentile.ts';
import type { Plane, Rgb8, Size } from '../src/core/raster.ts';
import type { Result } from '../src/core/result.ts';
import { synthScene } from './fixtures/synth/synth.ts';

function value<T>(result: Result<T, string>): T {
  if (!result.ok) assert.fail(result.error);
  return result.value;
}

function refused<T>(result: Result<T, string>, error: string): void {
  assert.deepEqual(result, { ok: false, error });
}

const TIMINGS = { sessionMs: 1, inferMs: 2, wasmHighWaterBytes: 3 };
const ENCODER = `sam@${'ab'.repeat(32)}`;
if (!isModelId(ENCODER)) throw new Error('the test ModelId is malformed');
const MODEL: ModelId = ENCODER;

/** ONNX Runtime's output map is a TensorMap, so the worker passes it as it comes; the type checker holds this. */
const fromOrt = (outputs: InferenceSession.ReturnType): TensorMap => outputs;

/** An Rgb8 as planar R, G, B, as MI-GAN's `result` holds it. */
function planar(image: Rgb8): Uint8Array {
  const n = image.size.width * image.size.height;
  const out = new Uint8Array(3 * n);
  for (let i = 0; i < n; i += 1) {
    out[i] = image.data[3 * i] ?? 0;
    out[n + i] = image.data[3 * i + 1] ?? 0;
    out[2 * n + i] = image.data[3 * i + 2] ?? 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// ImageNet input

/** (byte / 255 - mean) / std of a channel, held as float32: the definition, with the constants written out. */
const imagenet = {
  r: (v: number) => Math.fround((v / 255 - 0.485) / 0.229),
  g: (v: number) => Math.fround((v / 255 - 0.456) / 0.224),
  b: (v: number) => Math.fround((v / 255 - 0.406) / 0.225),
};

test('the ImageNet input is planar R, G, B of (byte / 255 - mean) / std with alpha dropped', () => {
  assert.deepEqual(IMAGENET_MEAN, [0.485, 0.456, 0.406]);
  assert.deepEqual(IMAGENET_STD, [0.229, 0.224, 0.225]);
  // two pixels, 2 x 1: (0, 128, 255, a 7) and (255, 0, 64, a 0)
  const rgba = new Uint8ClampedArray([0, 128, 255, 7, 255, 0, 64, 0]);
  const input = value(imagenetInput(rgba, { width: 2, height: 1 }));
  assert.deepEqual(input.dims, [1, 3, 1, 2]);
  assert.deepEqual(Array.from(input.data), [imagenet.r(0), imagenet.r(255), imagenet.g(128), imagenet.g(0), imagenet.b(255), imagenet.b(64)]);
  // the same values written as decimals to six places, from the formula apart from the code under test
  const decimals = [-2.117904, 2.248908, 0.205182, -2.035714, 2.64, -0.688976];
  input.data.forEach((v, i) => assert.ok(Math.abs(v - (decimals[i] ?? NaN)) < 5e-6, `element ${i}: ${v}`));
  // a Uint8Array of the same bytes gives the same input
  assert.deepEqual(value(imagenetInput(new Uint8Array(rgba), { width: 2, height: 1 })).data, input.data);
});

test('the ImageNet input covers every byte, row-major over a 3 x 2 image', () => {
  const size = { width: 3, height: 2 };
  const rgba = new Uint8Array(24).map((_, i) => (i * 37) % 256);
  const input = value(imagenetInput(rgba, size));
  assert.deepEqual(input.dims, [1, 3, 2, 3]);
  for (let i = 0; i < 6; i += 1) {
    assert.equal(input.data[i], imagenet.r(rgba[4 * i] ?? -1));
    assert.equal(input.data[6 + i], imagenet.g(rgba[4 * i + 1] ?? -1));
    assert.equal(input.data[12 + i], imagenet.b(rgba[4 * i + 2] ?? -1));
  }
  for (let v = 0; v < 256; v += 1) {
    const one = value(imagenetInput(new Uint8Array([v, v, v, 255]), { width: 1, height: 1 }));
    assert.deepEqual(Array.from(one.data), [imagenet.r(v), imagenet.g(v), imagenet.b(v)], `byte ${v}`);
  }
});

test('the ImageNet input refuses a size or a length that does not fit', () => {
  const rgba = new Uint8ClampedArray(8);
  refused(imagenetInput(rgba, { width: 3, height: 1 }), 'pixels: expected 12 bytes for 3 x 1 RGBA, got 8');
  refused(imagenetInput(rgba, { width: 0, height: 2 }), 'pixels size: expected whole sides of at least 1, got 0 x 2');
  refused(imagenetInput(rgba, { width: 1.5, height: 2 }), 'pixels size: expected whole sides of at least 1, got 1.5 x 2');
  refused(imagenetInput(rgba, { width: NaN, height: 1 }), 'pixels size: expected whole sides of at least 1, got NaN x 1');
  refused(imagenetInput(rgba, { width: Infinity, height: 1 }), 'pixels size: expected whole sides of at least 1, got Infinity x 1');
  // a size far larger than the bytes is refused before anything is allocated
  refused(imagenetInput(rgba, { width: 2 ** 26, height: 2 ** 26 }), `pixels: expected ${2 ** 54} bytes for ${2 ** 26} x ${2 ** 26} RGBA, got 8`);
});

// ---------------------------------------------------------------------------
// depth

function depthOutputs(dims: readonly number[], data: unknown): TensorMap {
  return { [DEPTH_OUTPUT]: { dims, data } };
}

test('the depth product: min-max normalized, nearest 1, with nearest-rank p10, median, and p90', () => {
  const raw = new Float32Array([12, 2, 8, 4, 10, 6]);
  const product = value(depthProduct(depthOutputs([1, 2, 3], raw), { width: 3, height: 2 }));
  assert.equal(product.map.format, 'f32');
  assert.deepEqual(product.map.size, { width: 3, height: 2 });
  // (v - 2) / 10
  assert.deepEqual(Array.from(product.map.data), [1, 0, 0.6, 0.2, 0.8, 0.4].map(Math.fround));
  // ascending 0 0.2 0.4 0.6 0.8 1: ranks ceil(0.6) = 1, ceil(3) = 3, ceil(5.4) = 6
  assert.deepEqual(product.stats, { p10: 0, median: Math.fround(0.4), p90: 1 });
  assert.notEqual(product.map.data, raw);
  assert.deepEqual(Array.from(raw), [12, 2, 8, 4, 10, 6], 'the output is only read');
  // negative raw values: (v + 1) / 2
  const signed = value(depthProduct(depthOutputs([1, 1, 2], new Float32Array([1, -1])), { width: 2, height: 1 }));
  assert.deepEqual(Array.from(signed.map.data), [1, 0]);
  assert.deepEqual(signed.stats, { p10: 0, median: 0, p90: 1 });
  // the reply the worker posts parses
  const reply = parseSequenceReply({ type: 'depth', map: product.map, stats: product.stats, timings: TIMINGS });
  assert.ok(reply.ok, reply.ok ? '' : reply.error.detail);
});

test('a flat depth output, max equal to min, becomes all zeros', () => {
  const product = value(depthProduct(depthOutputs([1, 2, 2], new Float32Array([5, 5, 5, 5])), { width: 2, height: 2 }));
  assert.deepEqual(Array.from(product.map.data), [0, 0, 0, 0]);
  assert.deepEqual(product.stats, { p10: 0, median: 0, p90: 0 });
});

test('the depth product at a real size: the synth truth as the raw output comes back as it went in', () => {
  for (const master of [
    { width: 2048, height: 1536 },
    { width: 2048, height: 512 },
  ]) {
    const size = depthInputSize(master);
    const truth = synthScene(master).depth(size);
    const product = value(depthProduct(depthOutputs([1, size.height, size.width], truth.data), size));
    assert.deepEqual(product.map.size, size);
    assert.deepEqual(product.map.data, truth.data, 'the truth is 0 at the sky and 1 at its nearest, so normalizing it changes nothing');
    assert.deepEqual(product.stats, {
      p10: value(percentile(truth.data, 0.1)),
      median: value(percentile(truth.data, 0.5)),
      p90: value(percentile(truth.data, 0.9)),
    });
    assert.ok(product.stats.p10 <= product.stats.median && product.stats.median <= product.stats.p90);
  }
});

test('the depth product refuses a missing output, wrong dims, a wrong length or type, and a non-finite element', () => {
  const size = { width: 3, height: 2 };
  const good = new Float32Array(6);
  refused(depthProduct({ depth: { dims: [1, 2, 3], data: good } }, size), "predicted_depth: the outputs hold no tensor of this name; they hold 'depth'");
  refused(depthProduct({}, size), 'predicted_depth: the outputs hold no tensor of this name; they hold none');
  refused(depthProduct(depthOutputs([1, 3, 2], good), size), 'predicted_depth: expected dims [1, 2, 3], got [1, 3, 2]');
  refused(depthProduct(depthOutputs([2, 3], good), size), 'predicted_depth: expected dims [1, 2, 3], got [2, 3]');
  refused(depthProduct(depthOutputs([1, 2, 3, 1], good), size), 'predicted_depth: expected dims [1, 2, 3], got [1, 2, 3, 1]');
  refused(depthProduct(depthOutputs(new Array<number>(9).fill(1), good), size), 'predicted_depth: expected dims [1, 2, 3], got a list of 9 dims');
  refused(depthProduct(depthOutputs([1, 2, 3], new Float32Array(5)), size), 'predicted_depth: expected 6 elements for dims [1, 2, 3], got 5');
  refused(depthProduct(depthOutputs([1, 2, 3], new Float64Array(6)), size), 'predicted_depth: expected float32 data, got Float64Array');
  refused(depthProduct(depthOutputs([1, 2, 3], [0, 0, 0, 0, 0, 0]), size), 'predicted_depth: expected float32 data, got Array');
  for (const [at, bad] of [
    [3, NaN],
    [0, Infinity],
    [5, -Infinity],
  ] as const) {
    const data = new Float32Array(6);
    data[at] = bad;
    refused(depthProduct(depthOutputs([1, 2, 3], data), size), `predicted_depth: element ${at} is ${bad}, not a finite number`);
  }
  refused(depthProduct(depthOutputs([1, 2, 3], good), { width: NaN, height: 2 }), 'depth input size: expected whole sides of at least 1, got NaN x 2');
  // dims that claim far more than the data holds are refused before anything is allocated
  refused(
    depthProduct(depthOutputs([1, 2 ** 26, 2 ** 26], good), { width: 2 ** 26, height: 2 ** 26 }),
    `predicted_depth: expected ${2 ** 52} elements for dims [1, ${2 ** 26}, ${2 ** 26}], got 6`,
  );
});

// ---------------------------------------------------------------------------
// SAM embeddings

/** The encoder's three outputs with every element set from its index, in the given order of names, with an extra output. */
function encoderOutputs(order: readonly number[] = [0, 1, 2]): Record<string, { dims: readonly number[]; data: Float32Array }> {
  const outputs: Record<string, { dims: readonly number[]; data: Float32Array }> = { iou_extra: { dims: [1], data: new Float32Array(1) } };
  for (const t of order) {
    const spec = SAM_EMBEDDING_TENSORS[t];
    if (spec === undefined) throw new Error(`no tensor ${t}`);
    const length = spec.dims.reduce((a: number, b: number) => a * b, 1);
    outputs[spec.name] = { dims: [...spec.dims], data: new Float32Array(length).map((_, i) => ((i * (t + 3)) % 1001) / 7 - 50) };
  }
  return outputs;
}

test("the SAM embeddings table holds the encoder's three outputs, by name and dims", () => {
  assert.deepEqual(
    SAM_EMBEDDING_TENSORS.map((t) => [t.name, [...t.dims]]),
    [
      ['image_embeddings.0', [1, 32, 256, 256]],
      ['image_embeddings.1', [1, 64, 128, 128]],
      ['image_embeddings.2', [1, 256, 64, 64]],
    ],
  );
});

test("the SAM embeddings hold the encoder's outputs in the table's order, uncopied, with the encoder's ModelId", () => {
  const outputs = encoderOutputs([2, 0, 1]);
  const embeddings = value(samEmbeddings(outputs, MODEL));
  assert.equal(embeddings.model, MODEL);
  assert.deepEqual(
    embeddings.tensors.map((t) => t.name),
    SAM_EMBEDDING_TENSORS.map((t) => t.name),
  );
  embeddings.tensors.forEach((tensor, i) => {
    const source = outputs[tensor.name];
    assert.ok(source !== undefined);
    assert.deepEqual(tensor.dims, [...(SAM_EMBEDDING_TENSORS[i]?.dims ?? [])]);
    assert.equal(tensor.data, source.data, 'an output over its own whole buffer is passed on, not copied');
  });
  const reply = parseSequenceReply({ type: 'embeddings', embeddings, timings: TIMINGS });
  assert.ok(reply.ok, reply.ok ? '' : reply.error.detail);
});

test('an encoder output that is a view into a larger or shared buffer is copied into a buffer of its own, so it can be transferred', () => {
  const name = 'image_embeddings.2';
  const outputs = encoderOutputs();
  const source = outputs[name];
  assert.ok(source !== undefined);
  const larger = new Float32Array(source.data.length + 8);
  larger.set(source.data, 4);
  const shared = new Float32Array(new SharedArrayBuffer(source.data.byteLength));
  shared.set(source.data);
  const views: readonly Float32Array[] = [larger.subarray(4, 4 + source.data.length), shared];
  for (const data of views) {
    const embeddings: SamEmbeddings = value(samEmbeddings({ ...outputs, [name]: { dims: source.dims, data } }, MODEL));
    const tensor = embeddings.tensors[2];
    assert.deepEqual(tensor.data, source.data);
    assert.notEqual(tensor.data, data, 'the view is copied');
    assert.ok(tensor.data.buffer instanceof ArrayBuffer);
    assert.equal(tensor.data.byteOffset, 0);
    assert.equal(tensor.data.buffer.byteLength, tensor.data.byteLength, 'the copy owns its whole buffer');
  }
});

test('the SAM embeddings refuse a missing name, wrong dims, a wrong length or type, and a non-finite element', () => {
  const renamed = encoderOutputs();
  const one = renamed['image_embeddings.1'];
  assert.ok(one !== undefined);
  delete renamed['image_embeddings.1'];
  renamed['image_embeddings_1'] = one;
  refused(
    samEmbeddings(renamed, MODEL),
    "image_embeddings.1: the outputs hold no tensor of this name; they hold 'iou_extra', 'image_embeddings.0', 'image_embeddings.2', 'image_embeddings_1'",
  );

  const swapped = encoderOutputs();
  swapped['image_embeddings.0'] = { dims: [1, 64, 128, 128], data: new Float32Array(64 * 128 * 128) };
  refused(samEmbeddings(swapped, MODEL), 'image_embeddings.0: expected dims [1, 32, 256, 256], got [1, 64, 128, 128]');

  const short = encoderOutputs();
  short['image_embeddings.2'] = { dims: [1, 256, 64, 64], data: new Float32Array(256 * 64 * 64 - 1) };
  refused(samEmbeddings(short, MODEL), `image_embeddings.2: expected ${256 * 64 * 64} elements for dims [1, 256, 64, 64], got ${256 * 64 * 64 - 1}`);

  const bytes: TensorMap = { ...encoderOutputs(), 'image_embeddings.1': { dims: [1, 64, 128, 128], data: new Uint8Array(64 * 128 * 128) } };
  refused(samEmbeddings(bytes, MODEL), 'image_embeddings.1: expected float32 data, got Uint8Array');

  for (const bad of [NaN, Infinity, -Infinity]) {
    const outputs = encoderOutputs();
    const two = outputs['image_embeddings.2'];
    assert.ok(two !== undefined);
    two.data[100] = bad;
    refused(samEmbeddings(outputs, MODEL), `image_embeddings.2: element 100 is ${bad}, not a finite number`);
  }
});

// ---------------------------------------------------------------------------
// MI-GAN

test("MI-GAN's input: planar uint8 pixels, and the hole inverted into its mask, cut at 128", () => {
  assert.equal(MIGAN_HOLE_THRESHOLD, 128);
  // 2 x 2 pixels, row-major, with alpha that is dropped
  const rgba = new Uint8ClampedArray([1, 2, 3, 9, 4, 5, 6, 9, 7, 8, 9, 0, 10, 11, 12, 255]);
  const size = { width: 2, height: 2 };
  const hole: Plane<'u8'> = { format: 'u8', size, data: new Uint8Array([0, 255, 127, 128]) };
  const input = value(miganInput(rgba, size, hole));
  assert.deepEqual(input.image.dims, [1, 3, 2, 2]);
  assert.deepEqual(Array.from(input.image.data), [1, 4, 7, 10, 2, 5, 8, 11, 3, 6, 9, 12]);
  assert.deepEqual(input.mask.dims, [1, 1, 2, 2]);
  // the repository's 255 in the hole is MI-GAN's 0 in the hole, and 0 outside is 255 to keep
  assert.deepEqual(Array.from(input.mask.data), [255, 0, 255, 0]);
  assert.deepEqual(Array.from(hole.data), [0, 255, 127, 128], 'the hole is only read');
});

test("MI-GAN's input refuses pixels or a hole that do not fit", () => {
  const size = { width: 2, height: 2 };
  const rgba = new Uint8ClampedArray(16);
  const hole = (width: number, height: number, length: number): Plane<'u8'> => ({ format: 'u8', size: { width, height }, data: new Uint8Array(length) });
  refused(miganInput(rgba, size, hole(2, 1, 2)), "hole: expected the pixels' size 2 x 2, got 2 x 1");
  refused(miganInput(rgba, size, hole(4, 1, 4)), "hole: expected the pixels' size 2 x 2, got 4 x 1");
  refused(miganInput(rgba, size, hole(2, 2, 3)), 'hole: expected 4 bytes for 2 x 2, got 3');
  refused(miganInput(new Uint8ClampedArray(12), size, hole(2, 2, 4)), 'pixels: expected 16 bytes for 2 x 2 RGBA, got 12');
  refused(miganInput(rgba, { width: 2, height: -2 }, hole(2, 2, 4)), 'pixels size: expected whole sides of at least 1, got 2 x -2');
  refused(miganInput(rgba, size, hole(NaN, 2, 4)), "hole: expected the pixels' size 2 x 2, got NaN x 2");
});

test('the plate: planar uint8 `result` interleaved into an Rgb8', () => {
  const size = { width: 2, height: 1 };
  const plate = value(plateFromResult({ [MIGAN_OUTPUT]: { dims: [1, 3, 1, 2], data: new Uint8Array([10, 11, 20, 21, 30, 31]) } }, size));
  assert.deepEqual(plate.size, size);
  assert.deepEqual(Array.from(plate.data), [10, 20, 30, 11, 21, 31]);
  const reply = parseSequenceReply({ type: 'plate', image: plate, timings: TIMINGS });
  assert.ok(reply.ok, reply.ok ? '' : reply.error.detail);
});

test('the plate refuses a missing output, wrong dims, a wrong length or type, and a malformed size', () => {
  const size = { width: 2, height: 1 };
  const data = new Uint8Array(6);
  refused(plateFromResult({ output: { dims: [1, 3, 1, 2], data } }, size), "result: the outputs hold no tensor of this name; they hold 'output'");
  refused(plateFromResult({ result: { dims: [1, 3, 2, 1], data } }, size), 'result: expected dims [1, 3, 1, 2], got [1, 3, 2, 1]');
  refused(plateFromResult({ result: { dims: [1, 3, 1, 2], data: new Uint8Array(5) } }, size), 'result: expected 6 elements for dims [1, 3, 1, 2], got 5');
  refused(plateFromResult({ result: { dims: [1, 3, 1, 2], data: new Float32Array(6) } }, size), 'result: expected uint8 data, got Float32Array');
  refused(plateFromResult({ result: { dims: [1, 3, 1, 2], data: new Uint8ClampedArray(6) } }, size), 'result: expected uint8 data, got Uint8ClampedArray');
  refused(plateFromResult({ result: { dims: [1, 3, 1, 2], data } }, { width: 2, height: 0 }), 'plate size: expected whole sides of at least 1, got 2 x 0');
});

test('packing the synth master and unpacking a result made of its plate give the plate back byte for byte', () => {
  for (const master of [
    { width: 2048, height: 1536 },
    { width: 512, height: 384 },
    { width: 2048, height: 512 },
  ] satisfies Size[]) {
    const scene = synthScene(master);
    const hole = scene.hole();
    const plate = scene.plate();
    const input = value(miganInput(scene.masterRgba(), master, hole));
    // the packed image is the master: unpacked as if the model changed nothing, it is the master's Rgb8
    assert.deepEqual(value(plateFromResult({ result: input.image }, master)).data, scene.master().data);
    // the mask inverts the hole's polarity
    assert.deepEqual(input.mask.data, hole.data.map((v) => 255 - v));
    const back = value(plateFromResult({ result: { dims: [1, 3, master.height, master.width], data: planar(plate) } }, master));
    assert.deepEqual(back.size, plate.size);
    assert.deepEqual(back.data, plate.data, `${master.width} x ${master.height}`);
  }
});

test("the stage functions read ONNX Runtime's own tensors", () => {
  const depth = fromOrt({ [DEPTH_OUTPUT]: new ort.Tensor('float32', new Float32Array([3, 1]), [1, 1, 2]) });
  assert.deepEqual(Array.from(value(depthProduct(depth, { width: 2, height: 1 })).map.data), [1, 0]);
  const result = fromOrt({ [MIGAN_OUTPUT]: new ort.Tensor('uint8', new Uint8Array([10, 11, 20, 21, 30, 31]), [1, 3, 1, 2]) });
  assert.deepEqual(Array.from(value(plateFromResult(result, { width: 2, height: 1 })).data), [10, 20, 30, 11, 21, 31]);
  const input = value(miganInput(new Uint8Array(16), { width: 2, height: 2 }, { format: 'u8', size: { width: 2, height: 2 }, data: new Uint8Array(4) }));
  const image = new ort.Tensor('uint8', input.image.data, input.image.dims);
  assert.deepEqual(image.dims, [1, 3, 2, 2]);
  const pixels = value(imagenetInput(new Uint8Array(4), { width: 1, height: 1 }));
  assert.deepEqual(new ort.Tensor('float32', pixels.data, pixels.dims).dims, [1, 3, 1, 1]);
});

// ---------------------------------------------------------------- the SAM decoder

test("the decoder's prompt: each point's fractions times 1024, x then y, include as 1 and exclude as 0 in int64, and no box", () => {
  const prompt = value(
    decoderPrompt([
      { at: { x: 0.25, y: 0.5 }, label: 'include' },
      { at: { x: 1, y: 0 }, label: 'exclude' },
      { at: { x: 0.38, y: 0.65 }, label: 'include' },
    ]),
  );
  assert.deepEqual(prompt.input_points.dims, [1, 1, 3, 2]);
  assert.deepEqual(Array.from(prompt.input_points.data), [256, 512, 1024, 0, Math.fround(0.38 * 1024), Math.fround(0.65 * 1024)]);
  assert.deepEqual(prompt.input_labels.dims, [1, 1, 3]);
  assert.ok(prompt.input_labels.data instanceof BigInt64Array);
  assert.deepEqual(Array.from(prompt.input_labels.data), [1n, 0n, 1n]);
  assert.deepEqual(prompt.input_boxes.dims, [1, 0, 4]);
  assert.equal(prompt.input_boxes.data.length, 0);
});

test("the decoder's prompt refuses a coordinate outside 0 to 1 or not finite", () => {
  refused(decoderPrompt([{ at: { x: 0.5, y: 0.5 }, label: 'include' }, { at: { x: 1.5, y: 0 }, label: 'include' }]), 'points[1].at: expected x and y from 0 to 1, got 1.5, 0');
  refused(decoderPrompt([{ at: { x: Number.NaN, y: 0 }, label: 'exclude' }]), 'points[0].at: expected x and y from 0 to 1, got NaN, 0');
  refused(decoderPrompt([{ at: { x: 0, y: -0.01 }, label: 'exclude' }]), 'points[0].at: expected x and y from 0 to 1, got 0, -0.01');
});

/** Embeddings of the table's names and dims, zero-filled, with `model`. */
function tableEmbeddings(model: ModelId): SamEmbeddings {
  const [a, b, c] = SAM_EMBEDDING_TENSORS.map((spec) => ({ name: spec.name, dims: [...spec.dims], data: new Float32Array(spec.dims.reduce<number>((n, d) => n * d, 1)) }));
  if (a === undefined || b === undefined || c === undefined) throw new Error('the table has three tensors');
  return { model, tensors: [a, b, c] };
}

test("the decoder's embeddings: the decoder's own model and the table's tensors in its order pass; another model, another name, other dims, another order, or a short tensor are refused", () => {
  const embeddings = tableEmbeddings(MODEL);
  assert.equal(value(decoderEmbeddings(embeddings, MODEL)), embeddings.tensors);
  const other = `depth@${'cd'.repeat(32)}`;
  if (!isModelId(other)) throw new Error('the test ModelId is malformed');
  refused(decoderEmbeddings(embeddings, other), `embeddings: made by ${MODEL}, not by the decoder's model ${other}`);
  const [t0, t1, t2] = embeddings.tensors;
  refused(decoderEmbeddings({ model: MODEL, tensors: [t0, { ...t1, name: 'image_embeddings.x' }, t2] }, MODEL), 'embeddings.tensors[1]: expected image_embeddings.1 with dims [1, 64, 128, 128], got image_embeddings.x with dims [1, 64, 128, 128]');
  refused(decoderEmbeddings({ model: MODEL, tensors: [t0, t1, { ...t2, dims: [1, 64, 256, 64] }] }, MODEL), 'embeddings.tensors[2]: expected image_embeddings.2 with dims [1, 256, 64, 64], got image_embeddings.2 with dims [1, 64, 256, 64]');
  refused(decoderEmbeddings({ model: MODEL, tensors: [t1, t0, t2] }, MODEL), 'embeddings.tensors[0]: expected image_embeddings.0 with dims [1, 32, 256, 256], got image_embeddings.1 with dims [1, 64, 128, 128]');
  refused(decoderEmbeddings({ model: MODEL, tensors: [t0, t1, { ...t2, data: new Float32Array(4) }] }, MODEL), 'embeddings.tensors[2]: expected 1048576 elements for dims [1, 256, 64, 64], got 4');
});

const MASK_TEXELS = SAM_MASK_SIZE.width * SAM_MASK_SIZE.height;

/** The decoder's outputs for three candidates whose logits `logit(candidate, column, row)` gives, with `scores`. */
function decoderOutputs(scores: readonly [number, number, number], logit: (candidate: number, column: number, row: number) => number): TensorMap {
  const masks = new Float32Array(SAM_CANDIDATES * MASK_TEXELS);
  for (let k = 0; k < SAM_CANDIDATES; k += 1) {
    for (let row = 0; row < SAM_MASK_SIZE.height; row += 1) {
      for (let column = 0; column < SAM_MASK_SIZE.width; column += 1) masks[k * MASK_TEXELS + row * SAM_MASK_SIZE.width + column] = logit(k, column, row);
    }
  }
  return {
    [DECODER_SCORES]: { dims: [1, 1, SAM_CANDIDATES], data: new Float32Array(scores) },
    [DECODER_MASKS]: { dims: [1, 1, SAM_CANDIDATES, SAM_MASK_SIZE.height, SAM_MASK_SIZE.width], data: masks },
  };
}

const byteOf = (logit: number): number => Math.round(255 / (1 + Math.exp(-logit)));

test('the candidates: each read as round(255 x sigmoid(logit)) at the asked size, ordered by score, an empty one kept', () => {
  const logits = [2, 0, -10];
  const outputs = decoderOutputs([0.2, 0.9, 0.5], (k) => logits[k] ?? 0);
  const size = { width: 5, height: 3 };
  const result = value(decodeCandidates(outputs, size));
  assert.deepEqual(
    result.candidates.map((c) => ({ score: c.score, size: c.mask.size, format: c.mask.format, bytes: [...new Set(c.mask.data)] })),
    [
      { score: Math.fround(0.9), size, format: 'u8', bytes: [128] },
      { score: Math.fround(0.5), size, format: 'u8', bytes: [0] },
      { score: Math.fround(0.2), size, format: 'u8', bytes: [byteOf(2)] },
    ],
  );
  assert.equal(byteOf(2), 225);
  assert.ok(result.candidates.every((c) => c.mask.data.length === 15));
  const reply = parseDecodeReply({ type: 'decoded', jobId: 0, result, timings: TIMINGS });
  assert.ok(reply.ok, 'the candidates make a reply the page parses');
});

test('the candidates keep the decoder\'s order between equal scores', () => {
  const result = value(decodeCandidates(decoderOutputs([0.5, 0.7, 0.5], (k) => k), { width: 1, height: 1 }));
  assert.deepEqual(result.candidates.map((c) => c.mask.data[0]), [byteOf(1), byteOf(0), byteOf(2)]);
});

test('a byte is 128 or more exactly when its logit is 0 or more: a logit just below 0 reads 127, where the sigmoid alone rounds it to 128', () => {
  const tiny = Math.fround(-1e-20);
  assert.equal(byteOf(tiny), 128, 'the sigmoid of a logit this close to 0 is 0.5 in doubles');
  const result = value(decodeCandidates(decoderOutputs([3, 2, 1], (k) => [0, tiny, Math.fround(1e-20)][k] ?? 0), { width: 2, height: 2 }));
  assert.deepEqual(result.candidates.map((c) => [...new Set(c.mask.data)]), [[128], [127], [128]]);
});

test('at the logits\' own size each byte is round(255 x sigmoid(logit)) of its own logit, over 196,608 logits from -10 to 10', () => {
  const total = SAM_CANDIDATES * MASK_TEXELS;
  const logitAt = (k: number, column: number, row: number): number => Math.fround(-10 + (20 * (k * MASK_TEXELS + row * SAM_MASK_SIZE.width + column)) / (total - 1));
  // Equal scores keep the decoder's order, so candidate k holds the kth third of the sweep.
  const result = value(decodeCandidates(decoderOutputs([1, 1, 1], logitAt), SAM_MASK_SIZE));
  let mismatches = 0;
  result.candidates.forEach((candidate, k) => {
    for (let i = 0; i < MASK_TEXELS; i += 1) {
      const logit = logitAt(k, i % SAM_MASK_SIZE.width, Math.floor(i / SAM_MASK_SIZE.width));
      if (candidate.mask.data[i] !== byteOf(logit)) mismatches += 1;
    }
  });
  assert.equal(mismatches, 0);
});

test('the resample is bilinear with texel centers aligned: a ramp across the columns lands exactly, and 0 falls at the middle', () => {
  // The logit of column c is c - 127.5, so it is 0 halfway across the 256 columns.
  const outputs = decoderOutputs([1, 0, 0], (_k, column) => column - 127.5);
  const size = { width: 512, height: 2 };
  const [best] = value(decodeCandidates(outputs, size)).candidates;
  for (let x = 0; x < size.width; x += 1) {
    // Output column x reads source position (x + 0.5) / 2 - 0.5, clamped to the first and last column.
    const at = Math.min(Math.max((x + 0.5) / 2 - 0.5, 0), 255);
    const expected = byteOf(at - 127.5);
    assert.equal(best.mask.data[x], at - 127.5 < 0 ? Math.min(expected, 127) : expected, `column ${x}`);
    assert.equal(best.mask.data[size.width + x], best.mask.data[x], `row 1 equals row 0 at column ${x}`);
  }
  assert.ok((best.mask.data[255] ?? 255) < 128 && (best.mask.data[256] ?? 0) >= 128, 'the left half is out and the right half in');
});

test('the resample undoes the stretch: a step at the middle of the logits lands at the middle of a 1024 x 768 guide, on each axis', () => {
  // The best candidate is positive on the right half of the 256 x 256 logits, the second on the bottom half; the encoder saw the master stretched to a square.
  const outputs = decoderOutputs([1, 0.5, 0], (k, column, row) => (k === 0 ? (column >= 128 ? 1 : -1) : row >= 128 ? 1 : -1));
  const size = { width: 1024, height: 768 };
  const [right, bottom] = value(decodeCandidates(outputs, size)).candidates;
  let mismatches = 0;
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      const i = y * size.width + x;
      if (((right.mask.data[i] ?? 0) >= 128) !== x >= 512) mismatches += 1;
      if (((bottom.mask.data[i] ?? 0) >= 128) !== y >= 384) mismatches += 1;
    }
  }
  assert.equal(mismatches, 0);
});

test('the resample on both axes at 1024 x 768: every texel is the bilinear blend at its aligned center, clamped at the first and last source texel', () => {
  // Unsaturated logits that change along both axes, so a shifted, unclamped, or unblended read changes bytes everywhere.
  const logit = (column: number, row: number): number => Math.fround((column - 127.5) / 40 + (row - 127.5) / 50);
  const outputs = decoderOutputs([1, 0, 0], (_k, column, row) => logit(column, row));
  const size = { width: 1024, height: 768 };
  const [best] = value(decodeCandidates(outputs, size)).candidates;
  // Output texel o of n reads source position (o + 0.5) x 256 / n - 0.5, clamped to 0 and 255.
  const source = (o: number, n: number): number => Math.min(Math.max(((o + 0.5) * 256) / n - 0.5, 0), 255);
  const byte = (l: number): number => (l < 0 ? Math.min(byteOf(l), 127) : byteOf(l));
  let mismatches = 0;
  for (let y = 0; y < size.height; y += 1) {
    const sy = source(y, size.height);
    const r0 = Math.floor(sy);
    const r1 = Math.min(r0 + 1, 255);
    const wy = sy - r0;
    for (let x = 0; x < size.width; x += 1) {
      const sx = source(x, size.width);
      const c0 = Math.floor(sx);
      const c1 = Math.min(c0 + 1, 255);
      const wx = sx - c0;
      const left = logit(c0, r0) * (1 - wy) + logit(c0, r1) * wy;
      const right = logit(c1, r0) * (1 - wy) + logit(c1, r1) * wy;
      if (best.mask.data[y * size.width + x] !== byte(left * (1 - wx) + right * wx)) mismatches += 1;
    }
  }
  assert.equal(mismatches, 0);
  assert.equal(best.mask.data[0], byte(logit(0, 0)), 'the first texel is the first logit, clamped, not blended with anything before it');
  assert.equal(best.mask.data[size.width * size.height - 1], byte(logit(255, 255)), 'the last texel is the last logit, clamped');
});

test('the candidates refuse missing outputs, wrong dims or kinds, a non-finite score or logit, and a size that is not one', () => {
  const good = decoderOutputs([0.3, 0.2, 0.1], () => 0);
  const size = { width: 4, height: 4 };
  const scores = good[DECODER_SCORES];
  const masks = good[DECODER_MASKS];
  if (scores === undefined || masks === undefined) throw new Error('the outputs hold both tensors');
  refused(decodeCandidates({ [DECODER_MASKS]: masks }, size), `iou_scores: the outputs hold no tensor of this name; they hold 'pred_masks'`);
  refused(decodeCandidates({ [DECODER_SCORES]: scores }, size), `pred_masks: the outputs hold no tensor of this name; they hold 'iou_scores'`);
  refused(decodeCandidates({ ...good, [DECODER_SCORES]: { dims: [1, 3], data: scores.data } }, size), 'iou_scores: expected dims [1, 1, 3], got [1, 3]');
  refused(decodeCandidates({ ...good, [DECODER_MASKS]: { dims: [1, 1, 3, 128, 512], data: masks.data } }, size), 'pred_masks: expected dims [1, 1, 3, 256, 256], got [1, 1, 3, 128, 512]');
  refused(decodeCandidates({ ...good, [DECODER_SCORES]: { dims: [1, 1, 3], data: new Uint8Array(3) } }, size), 'iou_scores: expected float32 data, got Uint8Array');
  refused(decodeCandidates({ ...good, [DECODER_SCORES]: { dims: [1, 1, 3], data: new Float32Array([0.1, Number.NaN, 0]) } }, size), 'iou_scores: element 1 is NaN, not a finite number');
  const badMasks = new Float32Array(masks.data instanceof Float32Array ? masks.data : []);
  badMasks[70_000] = Number.POSITIVE_INFINITY;
  refused(decodeCandidates({ ...good, [DECODER_MASKS]: { dims: masks.dims, data: badMasks } }, size), 'pred_masks: element 70000 is Infinity, not a finite number');
  refused(decodeCandidates(good, { width: 0, height: 4 }), 'mask size: expected whole sides of at least 1, got 0 x 4');
});

test("the decoder's functions read and make ONNX Runtime's own tensors", () => {
  const plain = decoderOutputs([0.1, 0.2, 0.3], (k) => k - 1);
  const scores = plain[DECODER_SCORES];
  const masks = plain[DECODER_MASKS];
  if (scores === undefined || masks === undefined || !(scores.data instanceof Float32Array) || !(masks.data instanceof Float32Array)) throw new Error('the outputs hold both tensors');
  const outputs = fromOrt({
    [DECODER_SCORES]: new ort.Tensor('float32', scores.data, scores.dims),
    [DECODER_MASKS]: new ort.Tensor('float32', masks.data, masks.dims),
  });
  assert.deepEqual(value(decodeCandidates(outputs, { width: 1, height: 1 })).candidates.map((c) => c.mask.data[0]), [byteOf(1), byteOf(0), byteOf(-1)]);
  const prompt = value(decoderPrompt([{ at: { x: 0.5, y: 0.5 }, label: 'include' }]));
  assert.deepEqual(new ort.Tensor('int64', prompt.input_labels.data, prompt.input_labels.dims).dims, [1, 1, 1]);
  assert.deepEqual(new ort.Tensor('float32', prompt.input_boxes.data, prompt.input_boxes.dims).dims, [1, 0, 4]);
});
