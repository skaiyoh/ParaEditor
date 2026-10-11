// The worker protocol's parsers under node: every message parses in each of
// its valid forms, as built and after a structured clone, and each malformed
// form fails at the path of the field that broke it. The messages' types are
// checked against the protocol's shapes, written out by hand here.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import type { ModelId, NonEmpty } from '../src/core/ids.ts';
import type { Plane, Rgb8 } from '../src/core/raster.ts';
import type { Result } from '../src/core/result.ts';
import type { DepthStats, TapPoint } from '../src/core/types.ts';
import {
  parseDecodeReply,
  parseDecodeLifecycleReply,
  parseDecodeRequest,
  parseSequenceReply,
  parseSequenceRequest,
  type Candidate,
  type DecodeReply,
  type DecodeRequest,
  type DecodeResult,
  type HeavyStage,
  type MessageError,
  type SamEmbeddings,
  type SamTensor,
  type SequenceReply,
  type SequenceRequest,
  type StageTimings,
} from '../src/analysis/protocol.ts';

// ---------------------------------------------------------------------------
// fixtures

/**
 * Node has no ImageBitmap; this stands in for one the way the parser
 * recognizes a real one, by its tag, with the width and height an open bitmap
 * has. A closed bitmap has both at 0.
 */
class FakeImageBitmap {
  readonly width: number;
  readonly height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  get [Symbol.toStringTag](): string {
    return 'ImageBitmap';
  }
  close(): void {}
}

const MODEL = `sam@${'a'.repeat(64)}`;

function u8Plane(width: number, height: number, fill = 0): { format: 'u8'; size: { width: number; height: number }; data: Uint8Array } {
  return { format: 'u8', size: { width, height }, data: new Uint8Array(width * height).fill(fill) };
}

function f32Plane(width: number, height: number): { format: 'f32'; size: { width: number; height: number }; data: Float32Array } {
  const data = new Float32Array(width * height);
  data.forEach((_, i) => (data[i] = i / data.length));
  return { format: 'f32', size: { width, height }, data };
}

function rgb8(width: number, height: number) {
  return { size: { width, height }, data: new Uint8Array(width * height * 3) };
}

function tensor(name: string, dims: number[]) {
  return { name, dims, data: new Float32Array(dims.reduce((a, b) => a * b, 1)).fill(0.5) };
}

function embeddings() {
  return {
    model: MODEL,
    tensors: [tensor('image_embed', [1, 4, 2, 2]), tensor('high_res_feats_0', [1, 2, 4, 4]), tensor('high_res_feats_1', [1, 3, 2, 3])],
  };
}

function timings() {
  return { sessionMs: 812.5, inferMs: 2210, wasmHighWaterBytes: 348_000_000 };
}

type CandidateJson = { mask: ReturnType<typeof u8Plane>; score: number };

/** Three candidates in score order, the first two tied. */
function candidates(): [CandidateJson, CandidateJson, CandidateJson] {
  return [
    { mask: u8Plane(4, 3, 255), score: 0.93 },
    { mask: u8Plane(4, 3, 0), score: 0.93 },
    { mask: u8Plane(4, 3, 128), score: -0.25 },
  ];
}

const tap = { at: { x: 0.25, y: 0.75 }, label: 'include' };

const VALID_SEQUENCE_REQUESTS: Record<string, unknown> = {
  'init with a thread count': { type: 'init', ortBase: '/vendor/ort/1.30.0/', threads: 2 },
  'init with the default threads': { type: 'init', ortBase: '/vendor/ort/1.30.0/', threads: 'default' },
  'run depth': { type: 'run', stage: 'depth', image: new FakeImageBitmap(2048, 1536) },
  'run encode': { type: 'run', stage: 'encode', image: new FakeImageBitmap(1536, 2048) },
  'run inpaint': { type: 'run', stage: 'inpaint', image: new FakeImageBitmap(4, 3), hole: u8Plane(4, 3, 255) },
  end: { type: 'end' },
};

const VALID_SEQUENCE_REPLIES: Record<string, unknown> = {
  'phase with a fraction': { type: 'phase', stage: 'encode', phase: 'session', fraction: 0.5 },
  'phase at 0 and unknown': { type: 'phase', stage: 'depth', phase: 'infer', fraction: null },
  'phase at 1': { type: 'phase', stage: 'inpaint', phase: 'infer', fraction: 1 },
  depth: { type: 'depth', map: f32Plane(5, 4), stats: { p10: 0.1, median: 0.5, p90: 0.9 }, timings: timings() },
  embeddings: { type: 'embeddings', embeddings: embeddings(), timings: timings() },
  plate: { type: 'plate', image: rgb8(4, 3), timings: { sessionMs: 0, inferMs: 0, wasmHighWaterBytes: 0 } },
  failed: { type: 'failed', stage: 'inpaint', message: 'RangeError: out of memory' },
};

const VALID_DECODE_REQUESTS: Record<string, unknown> = {
  init: { type: 'init', ortBase: '/vendor/ort/1.30.0/', embeddings: embeddings(), guide: rgb8(8, 6) },
  initialize: { type: 'initialize', requestId: 11, ortBase: '/vendor/ort/1.30.0/', embeddings: embeddings(), guide: rgb8(8, 6) },
  dispose: { type: 'dispose', requestId: 12 },
  'decode one point': { type: 'decode', jobId: 0, points: [tap] },
  'decode three points': {
    type: 'decode',
    jobId: 41,
    points: [tap, { at: { x: 0, y: 1 }, label: 'exclude' }, { at: { x: 1, y: 0 }, label: 'include' }],
  },
};

const VALID_DECODE_REPLIES: Record<string, unknown> = {
  decoded: { type: 'decoded', jobId: 7, result: { candidates: candidates() }, timings: timings() },
  failed: { type: 'failed', jobId: 7, message: 'Error: decoder session failed' },
};

type Parser = (value: unknown) => Result<unknown, MessageError>;

const DIRECTIONS: readonly { readonly name: string; readonly parse: Parser; readonly valid: Record<string, unknown> }[] = [
  { name: 'SequenceRequest', parse: parseSequenceRequest, valid: VALID_SEQUENCE_REQUESTS },
  { name: 'SequenceReply', parse: parseSequenceReply, valid: VALID_SEQUENCE_REPLIES },
  { name: 'DecodeRequest', parse: parseDecodeRequest, valid: VALID_DECODE_REQUESTS },
  { name: 'DecodeReply', parse: parseDecodeReply, valid: VALID_DECODE_REPLIES },
];

/** The value at `path` of a JSON-shaped message, or undefined. */
function at(value: unknown, path: readonly (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

/**
 * A structured clone of `message`, its fake bitmap carried across as it is: a
 * real ImageBitmap survives a clone, but the fake, like any class instance,
 * would come back a plain object without its tag.
 */
function cloneAroundBitmap(message: unknown): unknown {
  const image = at(message, ['image']);
  if (!(image instanceof FakeImageBitmap) || typeof message !== 'object' || message === null) return structuredClone(message);
  return { ...structuredClone({ ...message, image: null }), image };
}

/** The message's failing paths, and its detail as the assertion message; fails when it parses. */
function failingPaths(result: Result<unknown, MessageError>): readonly string[] {
  if (result.ok) assert.fail('expected the message to fail');
  assert.ok(result.error.paths.length > 0);
  assert.equal(result.error.detail.split('; ').length, result.error.paths.length, result.error.detail);
  return result.error.paths;
}

function assertFailsAt(result: Result<unknown, MessageError>, paths: readonly string[]): void {
  if (result.ok) assert.fail(`expected a failure at ${paths.join(', ')}`);
  assert.deepEqual(failingPaths(result), paths, result.error.detail);
}

// ---------------------------------------------------------------------------
// valid forms

for (const { name, parse, valid } of DIRECTIONS) {
  test(`every ${name} form parses, as built and after a structured clone`, () => {
    for (const [form, message] of Object.entries(valid)) {
      const parsed = parse(message);
      assert.ok(parsed.ok, `${form}: ${parsed.ok ? '' : parsed.error.detail}`);
      assert.deepEqual(parsed.value, message, form);
      assert.ok(Object.isFrozen(parsed.value), form);
      const cloned = parse(cloneAroundBitmap(message));
      assert.ok(cloned.ok, `${form} cloned: ${cloned.ok ? '' : cloned.error.detail}`);
    }
  });
}

test('a parse returns new frozen objects but keeps every typed array and bitmap by reference, so a large plane is never copied', () => {
  const message = { type: 'depth', map: f32Plane(5, 4), stats: { p10: 0.1, median: 0.5, p90: 0.9 }, timings: timings() };
  const parsed = parseSequenceReply(message);
  assert.ok(parsed.ok && parsed.value.type === 'depth');
  assert.equal(parsed.value.map.data, message.map.data);
  assert.notEqual(parsed.value.map, message.map);
  for (const inner of [parsed.value.map, parsed.value.map.size, parsed.value.stats, parsed.value.timings]) assert.ok(Object.isFrozen(inner));
  assert.equal(Object.isFrozen(message.map), false);

  const decoded = parseDecodeReply({ type: 'decoded', jobId: 1, result: { candidates: candidates() }, timings: timings() });
  assert.ok(decoded.ok && decoded.value.type === 'decoded');
  for (const inner of [decoded.value.result, decoded.value.result.candidates, decoded.value.result.candidates[0], decoded.value.result.candidates[0].mask]) assert.ok(Object.isFrozen(inner));

  const run = { type: 'run', stage: 'inpaint', image: new FakeImageBitmap(4, 3), hole: u8Plane(4, 3, 255) };
  const request = parseSequenceRequest(run);
  assert.ok(request.ok && request.value.type === 'run' && request.value.stage === 'inpaint');
  assert.equal(request.value.image, run.image);
  assert.equal(request.value.hole.data, run.hole.data);
});

test('a typed array from a node Buffer or a view into a larger buffer is accepted at its own length', () => {
  const backing = new ArrayBuffer(64);
  const mask = { format: 'u8', size: { width: 4, height: 3 }, data: new Uint8Array(backing, 8, 12) };
  assert.ok(parseSequenceRequest({ type: 'run', stage: 'inpaint', image: new FakeImageBitmap(4, 3), hole: mask }).ok);
  const buffer = { format: 'u8', size: { width: 4, height: 3 }, data: Buffer.alloc(12) };
  assert.ok(parseSequenceRequest({ type: 'run', stage: 'inpaint', image: new FakeImageBitmap(4, 3), hole: buffer }).ok);
});

// ---------------------------------------------------------------------------
// the envelope: type, unknown keys, missing fields

test('an unknown type fails at type, in every direction', () => {
  for (const { parse } of DIRECTIONS) {
    assertFailsAt(parse({ type: 'stub' }), ['type']);
    assertFailsAt(parse({}), ['type']);
  }
});

test('a whole message that is not an object fails at the root', () => {
  for (const { parse } of DIRECTIONS) {
    for (const value of [null, undefined, 3, 'init', [], [{ type: 'end' }]]) {
      assertFailsAt(parse(value), ['(message)']);
    }
  }
});

test('an unknown key fails at its own path, at the top and at every depth', () => {
  assertFailsAt(parseSequenceRequest({ type: 'end', extra: 1 }), ['extra']);
  assertFailsAt(parseSequenceRequest({ type: 'run', stage: 'depth', image: new FakeImageBitmap(4, 3), hole: u8Plane(4, 3) }), ['hole']);
  assertFailsAt(parseSequenceReply({ ...VALID_SEQUENCE_REPLIES['depth'] as object, map: { ...f32Plane(5, 4), stride: 5 } }), ['map.stride']);
  assertFailsAt(parseSequenceReply({ type: 'plate', image: rgb8(4, 3), timings: { ...timings(), gpuMs: 3 } }), ['timings.gpuMs']);
  const tensors = embeddings().tensors;
  assertFailsAt(
    parseSequenceReply({ type: 'embeddings', embeddings: { ...embeddings(), tensors: [tensors[0], tensors[1], { ...tensors[2], dtype: 'float32' }] }, timings: timings() }),
    ['embeddings.tensors[2].dtype'],
  );
  const [first, second, third] = candidates();
  assertFailsAt(
    parseDecodeReply({ type: 'decoded', jobId: 1, result: { candidates: [first, { ...second, iou: 0.9 }, third] }, timings: timings() }),
    ['result.candidates[1].iou'],
  );
  assertFailsAt(parseDecodeRequest({ type: 'decode', jobId: 1, points: [{ ...tap, at: { x: 0.5, y: 0.5, z: 0 } }] }), ['points[0].at.z']);
});

test('a missing field fails at its path, in every message', () => {
  for (const { parse, valid } of DIRECTIONS) {
    for (const [form, message] of Object.entries(valid)) {
      if (typeof message !== 'object' || message === null) continue;
      for (const key of Object.keys(message)) {
        if (key === 'type') continue;
        const without = Object.fromEntries(Object.entries(message).filter(([k]) => k !== key));
        const result = parse(without);
        assert.deepEqual(failingPaths(result), [key], `${form} without ${key}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// stages

test('a stage name outside the heavy stages fails at stage', () => {
  assertFailsAt(parseSequenceRequest({ type: 'run', stage: 'decode', image: new FakeImageBitmap(4, 3) }), ['stage']);
  assertFailsAt(parseSequenceReply({ type: 'phase', stage: 'decode', phase: 'infer', fraction: null }), ['stage']);
  assertFailsAt(parseSequenceReply({ type: 'failed', stage: 'auto-subject', message: 'x' }), ['stage']);
  assertFailsAt(parseSequenceReply({ type: 'phase', stage: 'depth', phase: 'download', fraction: null }), ['phase']);
});

test('an inpaint run without its hole fails at hole, and a hole of the wrong kind at its data', () => {
  assertFailsAt(parseSequenceRequest({ type: 'run', stage: 'inpaint', image: new FakeImageBitmap(4, 3) }), ['hole']);
  const floatHole = { format: 'u8', size: { width: 4, height: 3 }, data: new Float32Array(12) };
  assertFailsAt(parseSequenceRequest({ type: 'run', stage: 'inpaint', image: new FakeImageBitmap(4, 3), hole: floatHole }), ['hole.data']);
  assertFailsAt(parseSequenceRequest({ type: 'run', stage: 'inpaint', image: new FakeImageBitmap(4, 3), hole: f32Plane(4, 3) }), ['hole.format', 'hole.data']);
});

test('a run without an open ImageBitmap fails at image', () => {
  const run = (image: unknown) => parseSequenceRequest({ type: 'run', stage: 'depth', image });
  assertFailsAt(run(new FakeImageBitmap(0, 0)), ['image']);
  assertFailsAt(run(new FakeImageBitmap(4.5, 3)), ['image']);
  assertFailsAt(run({ width: 4, height: 3 }), ['image']);
  assertFailsAt(run(structuredClone(new FakeImageBitmap(4, 3))), ['image']);
  assertFailsAt(run(structuredClone({ [Symbol.toStringTag]: 'ImageBitmap', width: 4, height: 3 })), ['image']);
  assertFailsAt(run(new Uint8Array(12)), ['image']);
  assertFailsAt(run(null), ['image']);
});

test('init: threads are whole and at least 1, or default, and ortBase is not empty', () => {
  for (const threads of [0, -1, 1.5, Number.NaN, 'auto', null]) {
    assertFailsAt(parseSequenceRequest({ type: 'init', ortBase: '/vendor/ort/1.30.0/', threads }), ['threads']);
  }
  assertFailsAt(parseSequenceRequest({ type: 'init', ortBase: '', threads: 1 }), ['ortBase']);
  assertFailsAt(parseDecodeRequest({ ...VALID_DECODE_REQUESTS['init'] as object, ortBase: 3 }), ['ortBase']);
});

test('phase: the fraction is in 0 to 1 or null', () => {
  for (const fraction of [-0.01, 1.01, Number.POSITIVE_INFINITY, Number.NaN, '0.5']) {
    assertFailsAt(parseSequenceReply({ type: 'phase', stage: 'depth', phase: 'infer', fraction }), ['fraction']);
  }
});

// ---------------------------------------------------------------------------
// planes and images

test('a plane of the wrong typed array kind fails at its data', () => {
  const depth = (data: unknown) => parseSequenceReply({ type: 'depth', map: { format: 'f32', size: { width: 2, height: 2 }, data }, stats: { p10: 0, median: 0.5, p90: 1 }, timings: timings() });
  for (const data of [new Float64Array(4), new Uint8Array(4), new Int32Array(4), [0, 0.5, 0.75, 1], new ArrayBuffer(16), new DataView(new ArrayBuffer(16))]) {
    assertFailsAt(depth(data), ['map.data']);
  }
  const mask = (data: unknown) => parseSequenceRequest({ type: 'run', stage: 'inpaint', image: new FakeImageBitmap(2, 2), hole: { format: 'u8', size: { width: 2, height: 2 }, data } });
  for (const data of [new Uint8ClampedArray(4), new Int8Array(4), new Uint16Array(4), new Float32Array(4)]) {
    assertFailsAt(mask(data), ['hole.data']);
  }
});

test('a typed array made in another realm is recognized by its kind', () => {
  const data: unknown = runInNewContext('new Float32Array(20).fill(0.5)');
  assert.equal(data instanceof Float32Array, false);
  const map = { format: 'f32', size: { width: 5, height: 4 }, data };
  assert.ok(parseSequenceReply({ type: 'depth', map, stats: { p10: 0, median: 0.5, p90: 1 }, timings: timings() }).ok);
  const wrong: unknown = runInNewContext('new Float64Array(20)');
  assertFailsAt(parseSequenceReply({ type: 'depth', map: { ...map, data: wrong }, stats: { p10: 0, median: 0.5, p90: 1 }, timings: timings() }), ['map.data']);
});

test('an object that only pretends to be a typed array fails', () => {
  const forged = Object.create(Float32Array.prototype);
  Object.defineProperty(forged, 'length', { value: 4 });
  const tagged = { length: 4, [Symbol.toStringTag]: 'Float32Array' };
  for (const data of [forged, tagged, new Proxy(new Float32Array(4), {})]) {
    const result = parseSequenceReply({ type: 'depth', map: { format: 'f32', size: { width: 2, height: 2 }, data }, stats: { p10: 0, median: 0.5, p90: 1 }, timings: timings() });
    assertFailsAt(result, ['map.data']);
  }
});

test('a plane whose data is not exactly width x height elements fails at its data', () => {
  for (const length of [0, 19, 21, 40]) {
    const map = { format: 'f32', size: { width: 5, height: 4 }, data: new Float32Array(length) };
    const result = parseSequenceReply({ type: 'depth', map, stats: { p10: 0, median: 0.5, p90: 1 }, timings: timings() });
    assertFailsAt(result, ['map.data']);
    assert.ok(!result.ok && result.error.detail.includes(`expected 20 elements (width x height), got ${length}`), result.ok ? '' : result.error.detail);
  }
  const [first, second, third] = candidates();
  const short = { ...first, mask: { ...first.mask, data: new Uint8Array(11) } };
  assertFailsAt(parseDecodeReply({ type: 'decoded', jobId: 1, result: { candidates: [short, second, third] }, timings: timings() }), ['result.candidates[0].mask.data']);
});

test('a transferred-away buffer reads as length 0 and fails', () => {
  const map = f32Plane(5, 4);
  structuredClone(map.data.buffer, { transfer: [map.data.buffer] });
  assert.equal(map.data.length, 0);
  assertFailsAt(parseSequenceReply({ type: 'depth', map, stats: { p10: 0, median: 0.5, p90: 1 }, timings: timings() }), ['map.data']);
});

test('a plane size must be whole and at least 1 on both sides', () => {
  for (const [width, height, path] of [[0, 4, 'width'], [5, 0, 'height'], [2.5, 4, 'width'], [-5, 4, 'width'], [Number.NaN, 4, 'width']] as const) {
    const map = { format: 'f32', size: { width, height }, data: new Float32Array(20) };
    const result = parseSequenceReply({ type: 'depth', map, stats: { p10: 0, median: 0.5, p90: 1 }, timings: timings() });
    assert.ok(failingPaths(result).includes(`map.size.${path}`), result.ok ? '' : result.error.detail);
  }
});

test('a depth map with a NaN or an infinite element fails at that element', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const map = f32Plane(5, 4);
    map.data[13] = bad;
    map.data[17] = bad;
    assertFailsAt(parseSequenceReply({ type: 'depth', map, stats: { p10: 0, median: 0.5, p90: 1 }, timings: timings() }), ['map.data[13]']);
  }
});

test('depth statistics are the document\'s: each in 0 to 1, strict', () => {
  const depth = (stats: unknown) => parseSequenceReply({ type: 'depth', map: f32Plane(5, 4), stats, timings: timings() });
  assertFailsAt(depth({ p10: -0.1, median: 0.5, p90: 1 }), ['stats.p10']);
  assertFailsAt(depth({ p10: 0, median: Number.NaN, p90: 1 }), ['stats.median']);
  assertFailsAt(depth({ p10: 0, median: 0.5 }), ['stats.p90']);
  assertFailsAt(depth({ p10: 0, median: 0.5, p90: 1, p50: 0.5 }), ['stats.p50']);
});

test('an Rgb8 image must hold exactly width x height x 3 bytes in a Uint8Array', () => {
  const plate = (image: unknown) => parseSequenceReply({ type: 'plate', image, timings: timings() });
  assertFailsAt(plate({ size: { width: 4, height: 3 }, data: new Uint8Array(12) }), ['image.data']);
  assertFailsAt(plate({ size: { width: 4, height: 3 }, data: new Uint8Array(48) }), ['image.data']);
  assertFailsAt(plate({ size: { width: 4, height: 3 }, data: new Uint8ClampedArray(36) }), ['image.data']);
  assertFailsAt(plate({ format: 'u8', size: { width: 4, height: 3 }, data: new Uint8Array(36) }), ['image.format']);
  assertFailsAt(parseDecodeRequest({ ...VALID_DECODE_REQUESTS['init'] as object, guide: rgb8(0, 6) }), ['guide.size.width']);
});

// ---------------------------------------------------------------------------
// timings

test('a timing that is not finite, or below 0, fails at its field', () => {
  const plate = (t: unknown) => parseSequenceReply({ type: 'plate', image: rgb8(4, 3), timings: t });
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, '12']) {
    assertFailsAt(plate({ ...timings(), sessionMs: bad }), ['timings.sessionMs']);
    assertFailsAt(plate({ ...timings(), inferMs: bad }), ['timings.inferMs']);
    assertFailsAt(plate({ ...timings(), wasmHighWaterBytes: bad }), ['timings.wasmHighWaterBytes']);
  }
  assertFailsAt(plate({ ...timings(), wasmHighWaterBytes: 1.5 }), ['timings.wasmHighWaterBytes']);
  assertFailsAt(parseDecodeReply({ type: 'decoded', jobId: 1, result: { candidates: candidates() }, timings: { ...timings(), inferMs: Number.POSITIVE_INFINITY } }), ['timings.inferMs']);
});

// ---------------------------------------------------------------------------
// embeddings

test('a SAM tensor whose data length is not the product of its dims fails at its data', () => {
  const [a, b] = embeddings().tensors;
  const bad = { name: 'high_res_feats_1', dims: [1, 3, 2, 3], data: new Float32Array(17) };
  const result = parseSequenceReply({ type: 'embeddings', embeddings: { model: MODEL, tensors: [a, b, bad] }, timings: timings() });
  assertFailsAt(result, ['embeddings.tensors[2].data']);
  assert.ok(!result.ok && result.error.detail.includes('expected 18 elements (the product of dims), got 17'));
});

test('a SAM tensor with a dim that is not whole and at least 1, or a non-finite element, fails at it', () => {
  const embed = (third: unknown) => parseSequenceReply({ type: 'embeddings', embeddings: { model: MODEL, tensors: [embeddings().tensors[0], embeddings().tensors[1], third] }, timings: timings() });
  assertFailsAt(embed({ name: 'c', dims: [1, 0, 3], data: new Float32Array(0) }), ['embeddings.tensors[2].dims[1]']);
  assertFailsAt(embed({ name: 'c', dims: [2, 1.5], data: new Float32Array(3) }), ['embeddings.tensors[2].dims[1]']);
  assertFailsAt(embed({ name: 'c', dims: [3], data: new Float64Array(3) }), ['embeddings.tensors[2].data']);
  assertFailsAt(embed({ name: '', dims: [3], data: new Float32Array(3) }), ['embeddings.tensors[2].name']);
  const nan = tensor('c', [2, 2]);
  nan.data[2] = Number.NaN;
  assertFailsAt(embed(nan), ['embeddings.tensors[2].data[2]']);
});

test('embeddings hold exactly three tensors, each name once, and a well-formed ModelId', () => {
  const { tensors } = embeddings();
  const [a, b, c] = tensors;
  const embed = (value: unknown) => parseDecodeRequest({ type: 'init', ortBase: '/vendor/ort/1.30.0/', embeddings: value, guide: rgb8(8, 6) });
  assertFailsAt(embed({ model: MODEL, tensors: [a, b] }), ['embeddings.tensors']);
  assertFailsAt(embed({ model: MODEL, tensors: [a, b, c, tensor('extra', [1])] }), ['embeddings.tensors']);
  assertFailsAt(embed({ model: MODEL, tensors: [a, b, { ...c, name: a?.name }] }), ['embeddings.tensors[2].name']);
  assertFailsAt(embed({ model: 'sam', tensors }), ['embeddings.model']);
  assertFailsAt(embed({ model: `SAM@${'a'.repeat(64)}`, tensors }), ['embeddings.model']);
});

// ---------------------------------------------------------------------------
// decode

test('a decode result holds exactly three candidates: a fourth, or a missing one, fails at candidates', () => {
  const [first, second, third] = candidates();
  const decoded = (list: unknown) => parseDecodeReply({ type: 'decoded', jobId: 3, result: { candidates: list }, timings: timings() });
  assertFailsAt(decoded([first, second, third, { mask: u8Plane(4, 3), score: -1 }]), ['result.candidates']);
  assertFailsAt(decoded([first, second]), ['result.candidates']);
  assertFailsAt(decoded([]), ['result.candidates']);
});

test("a candidate's mask is a u8 plane and its score finite", () => {
  const [first, second, third] = candidates();
  const decoded = (list: unknown) => parseDecodeReply({ type: 'decoded', jobId: 3, result: { candidates: list }, timings: timings() });
  assertFailsAt(decoded([first, second, { ...third, score: Number.NaN }]), ['result.candidates[2].score']);
  assertFailsAt(decoded([{ ...first, score: Number.POSITIVE_INFINITY }, second, third]), ['result.candidates[0].score']);
  assertFailsAt(decoded([first, { ...second, mask: { ...second.mask, format: 'f32' } }, third]), ['result.candidates[1].mask.format']);
  assertFailsAt(decoded([first, { ...second, mask: f32Plane(4, 3) }, third]), ['result.candidates[1].mask.format', 'result.candidates[1].mask.data']);
});

test('candidates come highest score first, every mask the size of the first', () => {
  const [first, second, third] = candidates();
  const decoded = (list: unknown) => parseDecodeReply({ type: 'decoded', jobId: 3, result: { candidates: list }, timings: timings() });
  assertFailsAt(decoded([first, second, { ...third, score: 0.95 }]), ['result.candidates[2].score']);
  assertFailsAt(decoded([first, { ...second, mask: u8Plane(3, 4) }, third]), ['result.candidates[1].mask.size']);
});

test('a decode carries a whole jobId of at least 0 and one or more tap points inside the frame', () => {
  const decode = (fields: object) => parseDecodeRequest({ type: 'decode', jobId: 1, points: [tap], ...fields });
  for (const jobId of [-1, 0.5, Number.NaN, '1']) assertFailsAt(decode({ jobId }), ['jobId']);
  assertFailsAt(decode({ points: [] }), ['points']);
  assertFailsAt(decode({ points: [tap, { at: { x: 1.01, y: 0.5 }, label: 'include' }] }), ['points[1].at.x']);
  assertFailsAt(decode({ points: [{ ...tap, label: 'maybe' }] }), ['points[0].label']);
  assertFailsAt(parseDecodeReply({ type: 'failed', jobId: -2, message: 'x' }), ['jobId']);
});

// ---------------------------------------------------------------------------
// hostile values

test('a value whose getter or proxy trap throws gets a Result, at the root, its detail on one line', () => {
  const throwing = new Proxy({}, { get: () => { throw new RangeError('trap'); } });
  for (const { parse } of DIRECTIONS) {
    const result = parse(throwing);
    assertFailsAt(result, ['(message)']);
    assert.ok(!result.ok && result.error.detail.includes('RangeError: trap'));
  }
  const getters = [
    { get type(): never { throw new Error('getter'); } },
    { type: 'init', ortBase: '/vendor/ort/1.30.0/', get threads(): never { throw new Error('getter'); } },
  ];
  for (const getter of getters) {
    const result = parseSequenceRequest(getter);
    assertFailsAt(result, ['(message)']);
    assert.ok(!result.ok && result.error.detail === '(message): the parse threw Error: getter', result.ok ? '' : result.error.detail);
  }
  const multiline = parseSequenceRequest(new Proxy({}, { get: () => { throw new Error('first\nsecond\r\nthird fourth'); } }));
  assert.ok(!multiline.ok);
  assert.equal(multiline.error.detail, '(message): the parse threw Error: first second third fourth');
});

test('a typed array or a bitmap as the whole message fails at the root, naming what it is', () => {
  for (const { parse } of DIRECTIONS) {
    for (const [value, name] of [[new Uint8Array(3), 'a Uint8Array'], [new Float32Array(1_000_000), 'a Float32Array'], [new FakeImageBitmap(4, 3), 'an ImageBitmap']] as const) {
      const result = parse(value);
      assertFailsAt(result, ['(message)']);
      assert.equal(result.ok ? '' : result.error.detail, `(message): expected an object with a type, got ${name}`);
    }
  }
});

/** Each array field of the protocol: a message carrying `list` there, a valid list for it, and the field's path. */
const ARRAY_FIELDS: readonly { readonly path: string; readonly parse: Parser; readonly valid: () => unknown[]; readonly carry: (list: unknown) => unknown }[] = [
  {
    path: 'result.candidates',
    parse: parseDecodeReply,
    valid: candidates,
    carry: (list) => ({ type: 'decoded', jobId: 1, result: { candidates: list }, timings: timings() }),
  },
  {
    path: 'embeddings.tensors',
    parse: parseSequenceReply,
    valid: () => embeddings().tensors,
    carry: (list) => ({ type: 'embeddings', embeddings: { model: MODEL, tensors: list }, timings: timings() }),
  },
  { path: 'points', parse: parseDecodeRequest, valid: () => [tap, tap, tap], carry: (list) => ({ type: 'decode', jobId: 1, points: list }) },
  {
    path: 'embeddings.tensors[2].dims',
    parse: parseSequenceReply,
    valid: () => [1, 3, 1],
    carry: (dims) => {
      const [a, b] = embeddings().tensors;
      return { type: 'embeddings', embeddings: { model: MODEL, tensors: [a, b, { name: 'c', dims, data: new Float32Array(3) }] }, timings: timings() };
    },
  },
];

test('an array field with a hole, an own key that is not an index, a huge claimed length, or a typed array in its place fails at the field, as built and after a structured clone', () => {
  for (const { path, parse, valid, carry } of ARRAY_FIELDS) {
    assert.ok(parse(carry(valid())).ok, path);
    const holed = valid();
    delete holed[1];
    const keyed: unknown[] & { extra?: number } = valid();
    keyed.extra = 1;
    const huge: unknown[] = [];
    huge.length = 2 ** 32 - 1;
    const cases: readonly (readonly [unknown, string])[] = [
      [holed, 'expected an array without holes, got 2 elements of 3'],
      [keyed, 'expected an array whose only keys are its indices, got the key "extra"'],
      [huge, 'expected an array without holes, got 0 elements of 4294967295'],
      [new Float32Array([1, 3, 1]), 'expected an array, got a Float32Array'],
    ];
    for (const [list, reason] of cases) {
      for (const message of [carry(list), structuredClone(carry(list))]) {
        const started = performance.now();
        const result = parse(message);
        assert.ok(performance.now() - started < 1000, `${path}: ${reason}: took ${performance.now() - started} ms`);
        assertFailsAt(result, [path]);
        assert.equal(result.ok ? '' : result.error.detail, `${path}: ${reason}`);
      }
    }
  }
});

test('a tensor\'s dims or a decode\'s points of a million elements that each fail report the first, not every one', () => {
  const [a, b] = embeddings().tensors;
  const dims = new Array<number>(1_000_000).fill(0);
  const points = new Array<unknown>(1_000_000).fill({ ...tap, label: 'maybe' });
  const cases: readonly (readonly [Result<unknown, MessageError>, string])[] = [
    [parseSequenceReply({ type: 'embeddings', embeddings: { model: MODEL, tensors: [a, b, { name: 'c', dims, data: new Float32Array(0) }] }, timings: timings() }), 'embeddings.tensors[2].dims[0]'],
    [parseDecodeRequest(structuredClone({ type: 'decode', jobId: 1, points })), 'points[0].label'],
  ];
  for (const [result, path] of cases) {
    assertFailsAt(result, [path]);
    assert.ok(!result.ok && !result.error.detail.includes('threw'), result.ok ? '' : result.error.detail);
  }
});

test("an object a decode's points hold many times is parsed once, and its one frozen output stands at each place", () => {
  // A clone writes each repeat of the object as a reference of a few bytes,
  // so a new output per place would cost many times the message's size.
  const points = new Array<unknown>(1_000_000).fill(tap);
  for (const received of [points, structuredClone(points)]) {
    const result = parseDecodeRequest({ type: 'decode', jobId: 1, points: received });
    assert.ok(result.ok && result.value.type === 'decode', result.ok ? '' : result.error.detail);
    const [first, ...rest] = result.value.points;
    assert.ok(Object.isFrozen(first) && Object.isFrozen(result.value.points));
    assert.ok(rest.every((point) => point === first));
  }
});

test('a typed array where a number belongs fails there, and where an object belongs at that object, each kept unfrozen', () => {
  const floats = new Float32Array(2);
  assertFailsAt(parseSequenceReply({ type: 'plate', image: rgb8(4, 3), timings: { ...timings(), inferMs: floats } }), ['timings.inferMs']);
  const point = parseDecodeRequest({ type: 'decode', jobId: 1, points: [{ ...tap, at: floats }] });
  assertFailsAt(point, ['points[0].at']);
  assert.equal(point.ok ? '' : point.error.detail, 'points[0].at: expected an object, got a Float32Array');
  const bytes = new Uint8Array(3);
  assertFailsAt(parseSequenceReply({ type: 'depth', map: f32Plane(5, 4), stats: bytes, timings: timings() }), ['stats']);
  assert.equal(Object.isFrozen(floats) || Object.isFrozen(bytes), false);
});

test('a typed array or a String object of millions of elements, or another built-in, where an object belongs fails at once at that object with one reason', () => {
  const plate = (size: unknown) => ({ type: 'plate', image: { size, data: new Uint8Array(3) }, timings: timings() });
  const cases: readonly (readonly [unknown, string])[] = [
    [plate(new Uint8Array(2048 * 1536 * 3)), 'image.size: expected an object, got a Uint8Array'],
    [plate(new String('x'.repeat(4_000_000))), 'image.size: expected an object, got a String object'],
    [plate(new Map([['width', 1]])), 'image.size: expected an object, got a Map object'],
    [plate([1, 1]), 'image.size: expected an object, got an array'],
    [{ type: 'depth', map: f32Plane(5, 4), stats: new Float32Array(1_000_000), timings: timings() }, 'stats: expected an object, got a Float32Array'],
    [{ ...plate({ width: 1, height: 1 }), timings: 3 }, 'timings: expected an object, got a number'],
  ];
  for (const [message, detail] of cases) {
    for (const received of [message, structuredClone(message)]) {
      const started = performance.now();
      const result = parseSequenceReply(received);
      const ms = performance.now() - started;
      assert.equal(result.ok ? '' : result.error.detail, detail);
      assert.ok(ms < 1000, `${detail}: took ${ms} ms`);
    }
  }
});

test('a check that compares fields runs only when nothing else in its object has failed, so its reason never rests on a field that did not parse', () => {
  const [a, b] = embeddings().tensors;
  const embed = (third: unknown) => parseSequenceReply(structuredClone({ type: 'embeddings', embeddings: { model: MODEL, tensors: [a, b, third] }, timings: timings() }));
  assertFailsAt(embed({ name: 'c', dims: [2, -1, 3], data: new Float32Array(6) }), ['embeddings.tensors[2].dims[1]']);
  assertFailsAt(embed({ name: 'c', dims: [2, -1, -3], data: new Float32Array(6) }), ['embeddings.tensors[2].dims[1]']);
  const zeroWide = { format: 'f32', size: { width: 0, height: 2 }, data: new Float32Array(4) };
  assertFailsAt(parseSequenceReply({ type: 'depth', map: zeroWide, stats: { p10: 0, median: 0.5, p90: 1 }, timings: timings() }), ['map.size.width']);
  assertFailsAt(parseSequenceReply({ type: 'plate', image: { size: { width: 0, height: 1 }, data: new Uint8Array(3) }, timings: timings() }), ['image.size.width']);
  const [first, second, third] = candidates();
  const decoded = parseDecodeReply({ type: 'decoded', jobId: 3, result: { candidates: [first, { ...second, mask: { ...second.mask, size: { width: 0, height: 3 } } }, third] }, timings: timings() });
  assertFailsAt(decoded, ['result.candidates[1].mask.size.width']);
  assertFailsAt(embed({ name: '', dims: [3], data: new Float32Array(3) }), ['embeddings.tensors[2].name']);
});

test('an object with many unknown keys lists the first eight at their paths and counts the rest at its own', () => {
  const extra = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]));
  const listed = Array.from({ length: 8 }, (_, i) => `k${i}`);
  const top = parseSequenceRequest({ type: 'end', ...extra });
  assertFailsAt(top, [...listed, '(message)']);
  assert.ok(!top.ok && top.error.detail.endsWith('(message): 92 more unknown keys'), top.ok ? '' : top.error.detail);
  const nested = parseSequenceReply({ type: 'plate', image: rgb8(4, 3), timings: { ...timings(), ...extra } });
  assertFailsAt(nested, [...listed.map((key) => `timings.${key}`), 'timings']);
  const eight = parseSequenceRequest({ type: 'end', ...Object.fromEntries(listed.map((key) => [key, 0])) });
  assertFailsAt(eight, listed);
});

test('a structure that shares its parts 64 levels deep fails at once: under an unknown key at the key, and under a known key at the fields it does not fit', () => {
  // Each level holds the one below twice; a clone keeps the sharing, so the
  // message stays small while a walk of every path would take 2^64 steps.
  const started = performance.now();
  let shared: unknown = 0;
  for (let i = 0; i < 64; i++) shared = [shared, shared];
  let sharedObject: unknown = 0;
  for (let i = 0; i < 64; i++) sharedObject = { left: sharedObject, right: sharedObject };
  for (const value of [shared, sharedObject]) {
    for (const clone of [false, true]) {
      const copy = (message: unknown) => (clone ? structuredClone(message) : message);
      assertFailsAt(parseSequenceRequest(copy({ type: 'end', extra: value })), ['extra']);
      assertFailsAt(parseSequenceReply(copy({ type: 'plate', image: rgb8(4, 3), timings: { ...timings(), extra: value } })), ['timings.extra']);
    }
  }
  assertFailsAt(parseDecodeRequest(structuredClone({ type: 'decode', jobId: 1, points: shared })), ['points[0]']);
  const failed = parseSequenceReply(structuredClone({ type: 'depth', map: f32Plane(5, 4), stats: sharedObject, timings: timings() }));
  assertFailsAt(failed, ['stats.p10', 'stats.median', 'stats.p90', 'stats.left', 'stats.right']);
  const deep = { type: 'decode', jobId: 1, points: Array.from({ length: 64 }, () => tap) };
  assert.ok(parseDecodeRequest(structuredClone(deep)).ok);
  const ms = performance.now() - started;
  assert.ok(ms < 1000, `took ${ms} ms`);
});

test('a cycle at a known key fails at that key or under it, as built and after a structured clone', () => {
  const result: { candidates: unknown } = { candidates: null };
  result.candidates = [result, result, result];
  const embedded: { model: string; tensors: unknown } = { model: MODEL, tensors: null };
  embedded.tensors = [embedded, embedded, embedded];
  const message: Record<string, unknown> = { type: 'end' };
  message['self'] = message;
  const cases: readonly (readonly [Parser, unknown, string])[] = [
    [parseDecodeReply, { type: 'decoded', jobId: 1, result, timings: timings() }, 'result.candidates[0]'],
    [parseSequenceReply, { type: 'embeddings', embeddings: embedded, timings: timings() }, 'embeddings.tensors[0]'],
    [parseSequenceRequest, message, 'self'],
  ];
  for (const [parse, value, prefix] of cases) {
    for (const received of [value, structuredClone(value)]) {
      const paths = failingPaths(parse(received));
      assert.ok(paths.every((path) => path.startsWith(prefix.replace(/\[0\]$/, ''))), paths.join(', '));
    }
  }
  const shared = candidates()[0];
  assert.ok(parseDecodeReply({ type: 'decoded', jobId: 1, result: { candidates: [shared, shared, shared] }, timings: timings() }).ok);
});

test("a key's line break is escaped in its path and in a reason that names it, and a reason's own is made a space, so the detail is one line", () => {
  const LINE_BREAK = /[\n\v\f\r\u{85}\u{2028}\u{2029}]/u;
  const keys = ['a\u{2028}b', 'c\u{2029}d', 'e\u{85}f', 'g\nh'];
  const result = parseSequenceRequest(structuredClone({ type: 'end', ...Object.fromEntries(keys.map((key) => [key, 1])) }));
  assert.ok(!result.ok);
  assert.deepEqual(result.error.paths, ['["a\\u2028b"]', '["c\\u2029d"]', '["e\\u0085f"]', '["g\\nh"]']);
  assert.ok(!LINE_BREAK.test(result.error.detail), result.error.detail);
  const candidatesWithKey = Object.assign(candidates(), { 'a\u{2028}b': 1 });
  for (const received of [candidatesWithKey, structuredClone(candidatesWithKey)]) {
    const keyed = parseDecodeReply({ type: 'decoded', jobId: 1, result: { candidates: received }, timings: timings() });
    assert.equal(keyed.ok ? '' : keyed.error.detail, 'result.candidates: expected an array whose only keys are its indices, got the key "a\\u2028b"');
  }
  const thrown = parseSequenceRequest(new Proxy({}, { get: () => { throw new Error('a\vb\fc\u{85}d\u{2029}e'); } }));
  assert.ok(!thrown.ok);
  assert.equal(thrown.error.detail, '(message): the parse threw Error: a b c d e');
});

test('a typed array over a SharedArrayBuffer, growable or not, fails at its data', () => {
  const depth = (data: unknown) => parseSequenceReply({ type: 'depth', map: { format: 'f32', size: { width: 2, height: 2 }, data }, stats: { p10: 0, median: 0.5, p90: 1 }, timings: timings() });
  for (const buffer of [new SharedArrayBuffer(16), new SharedArrayBuffer(16, { maxByteLength: 64 })]) {
    const result = depth(new Float32Array(buffer));
    assertFailsAt(result, ['map.data']);
    assert.ok(!result.ok && result.error.detail === 'map.data: expected a Float32Array over an ArrayBuffer, not a SharedArrayBuffer', result.ok ? '' : result.error.detail);
  }
  const hole = { format: 'u8', size: { width: 2, height: 2 }, data: new Uint8Array(new SharedArrayBuffer(4)) };
  assertFailsAt(parseSequenceRequest({ type: 'run', stage: 'inpaint', image: new FakeImageBitmap(2, 2), hole }), ['hole.data']);
  assert.ok(depth(new Float32Array(new ArrayBuffer(16, { maxByteLength: 64 }))).ok);
});

test("a typed array's length is its real one, whatever a length of its own or a subclass's getter says", () => {
  const ownLength = new Uint8Array(0);
  Object.defineProperty(ownLength, 'length', { value: 4 });
  class LongerThanItIs extends Uint8Array {
    override get length(): number {
      return 4;
    }
  }
  for (const data of [ownLength, new LongerThanItIs(0)]) {
    assert.equal(data.length, 4);
    const result = parseSequenceRequest({ type: 'run', stage: 'inpaint', image: new FakeImageBitmap(2, 2), hole: { format: 'u8', size: { width: 2, height: 2 }, data } });
    assertFailsAt(result, ['hole.data']);
    assert.ok(!result.ok && result.error.detail.includes('expected 4 elements (width x height), got 0'));
  }
  const rgb = new Uint8Array(0);
  Object.defineProperty(rgb, 'length', { value: 3 });
  assertFailsAt(parseSequenceReply({ type: 'plate', image: { size: { width: 1, height: 1 }, data: rgb }, timings: timings() }), ['image.data']);
  const hidden = new Float32Array([0, 0, Number.NaN]);
  Object.defineProperty(hidden, 'length', { value: 2 });
  const [a, b] = embeddings().tensors;
  const embedded = parseSequenceReply({ type: 'embeddings', embeddings: { model: MODEL, tensors: [a, b, { name: 'c', dims: [2], data: hidden }] }, timings: timings() });
  assertFailsAt(embedded, ['embeddings.tensors[2].data', 'embeddings.tensors[2].data[2]']);
});

// ---------------------------------------------------------------------------
// types

/** True only when A and B are the same type. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** The protocol's shapes, written out by hand, so a change to a schema that changes a type fails here. */
type ExpectedSequenceRequest =
  | { readonly type: 'init'; readonly ortBase: string; readonly threads: number | 'default' }
  | { readonly type: 'run'; readonly stage: 'depth' | 'encode'; readonly image: ImageBitmap }
  | { readonly type: 'run'; readonly stage: 'inpaint'; readonly image: ImageBitmap; readonly hole: Plane<'u8'> }
  | { readonly type: 'end' };
type ExpectedSequenceReply =
  | { readonly type: 'phase'; readonly stage: HeavyStage['kind']; readonly phase: 'session' | 'infer'; readonly fraction: number | null }
  | { readonly type: 'depth'; readonly map: Plane<'f32'>; readonly stats: DepthStats; readonly timings: StageTimings }
  | { readonly type: 'embeddings'; readonly embeddings: SamEmbeddings; readonly timings: StageTimings }
  | { readonly type: 'plate'; readonly image: Rgb8; readonly timings: StageTimings }
  | { readonly type: 'failed'; readonly stage: HeavyStage['kind']; readonly message: string; readonly fatal?: boolean | undefined };
type ExpectedDecodeRequest =
  | { readonly type: 'control'; readonly port: MessagePort }
  | { readonly type: 'init'; readonly ortBase: string; readonly embeddings: SamEmbeddings; readonly guide: Rgb8 }
  | { readonly type: 'initialize'; readonly requestId: number; readonly ortBase: string; readonly embeddings: SamEmbeddings; readonly guide: Rgb8 }
  | { readonly type: 'decode'; readonly jobId: number; readonly points: NonEmpty<TapPoint> }
  | { readonly type: 'release' }
  | { readonly type: 'dispose'; readonly requestId: number };
type ExpectedDecodeReply =
  | { readonly type: 'decoded'; readonly jobId: number; readonly result: DecodeResult; readonly timings: StageTimings }
  | { readonly type: 'failed'; readonly jobId: number; readonly message: string };

test("the parsed types equal the protocol's shapes written out by hand", () => {
  const checks = [
    true satisfies Equal<SequenceRequest, ExpectedSequenceRequest>,
    true satisfies Equal<SequenceReply, ExpectedSequenceReply>,
    true satisfies Equal<DecodeRequest, ExpectedDecodeRequest>,
    true satisfies Equal<DecodeReply, ExpectedDecodeReply>,
    true satisfies Equal<StageTimings, { readonly sessionMs: number; readonly inferMs: number; readonly wasmHighWaterBytes: number }>,
    true satisfies Equal<SamEmbeddings, { readonly model: ModelId; readonly tensors: readonly [SamTensor, SamTensor, SamTensor] }>,
    true satisfies Equal<SamTensor, { readonly name: string; readonly dims: readonly number[]; readonly data: Float32Array }>,
    true satisfies Equal<DecodeResult, { readonly candidates: readonly [Candidate, Candidate, Candidate] }>,
    true satisfies Equal<Candidate, { readonly mask: Plane<'u8'>; readonly score: number }>,
    true satisfies Equal<HeavyStage['kind'], 'depth' | 'encode' | 'inpaint'>,
  ];
  assert.deepEqual(checks, checks.map(() => true));
});

test('decoder release is a strict payload-free request, as built and after cloning', () => {
  for (const request of [{ type: 'release' }, structuredClone({ type: 'release' })]) {
    const parsed = parseDecodeRequest(request);
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.error.detail);
    assert.deepEqual(parsed.value, request);
    assert.ok(Object.isFrozen(parsed.value));
  }
  assertFailsAt(parseDecodeRequest({ type: 'release', jobId: 0 }), ['jobId']);
  assertFailsAt(parseDecodeRequest({ type: 'release', embeddings: embeddings() }), ['embeddings']);
});

test('a decoder lifetime control endpoint is a transferred MessagePort, with a strict request envelope', () => {
  const channel = new MessageChannel();
  const transferred: unknown = structuredClone({ type: 'control', port: channel.port2 }, { transfer: [channel.port2] });
  let received: MessagePort | null = null;
  try {
    const parsed = parseDecodeRequest(transferred);
    assert.ok(parsed.ok);
    assert.equal(parsed.value.type, 'control');
    if (parsed.value.type !== 'control') return assert.fail('not a control request');
    received = parsed.value.port;
    assert.ok(received instanceof MessagePort);
    assert.ok(Object.isFrozen(parsed.value));
    assertFailsAt(parseDecodeRequest({ type: 'control', port: channel.port1, extra: true }), ['extra']);
    for (const port of [null, {}, { [Symbol.toStringTag]: 'MessagePort' }]) {
      assertFailsAt(parseDecodeRequest({ type: 'control', port }), ['port']);
    }
  } finally { channel.port1.close(); channel.port2.close(); received?.close(); }
});

test('private lifecycle acknowledgements validate identity and completion without changing the public decode reply parser', () => {
  for (const value of [
    { type: 'initialized', requestId: 3, message: null },
    { type: 'initialized', requestId: 4, message: 'the embeddings did not match' },
    { type: 'disposed', requestId: 5 },
  ]) {
    for (const received of [value, structuredClone(value)]) {
      const parsed = parseDecodeLifecycleReply(received);
      assert.ok(parsed.ok, parsed.ok ? '' : parsed.error.detail);
      assert.deepEqual(parsed.value, received);
      assert.ok(Object.isFrozen(parsed.value));
      assert.equal(parseDecodeReply(received).ok, false);
    }
  }
  for (const requestId of [-1, 0.1, '1', Number.NaN]) {
    assertFailsAt(parseDecodeLifecycleReply({ type: 'initialized', requestId, message: null }), ['requestId']);
    assertFailsAt(parseDecodeRequest({ type: 'dispose', requestId }), ['requestId']);
  }
  assertFailsAt(parseDecodeLifecycleReply({ type: 'disposed', requestId: 1, message: null }), ['message']);
  assertFailsAt(parseDecodeLifecycleReply({ type: 'initialized', requestId: 1 }), ['message']);
});
