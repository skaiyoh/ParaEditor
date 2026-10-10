// The pure arithmetic around the analysis models, the three heavy stages' and
// SAM's decoder: what goes into each model and what its outputs become.
// Reading a bitmap's pixels and running the sessions are the workers'
// (analysis/sequence-worker.ts and analysis/decode-worker.ts); everything
// between those steps is here, so node tests run it as the workers do.
// Worker-safe: no DOM global, no clock, no ONNX Runtime value. A model's
// outputs are taken as a structural map of tensors, which ONNX Runtime's own
// output map satisfies.
//
// Every function checks what it is given and returns a Result whose error is
// one line naming the value and what was wrong with it, and checks sizes
// before it allocates, so its cost is in proportion to its input. None throws
// but decodeCandidates, which makes its masks at the size it is given: a size
// too large to allocate throws a RangeError.

import type { ModelId, NonEmpty } from '../core/ids.ts';
import { nearestRank, rank } from '../core/percentile.ts';
import type { Plane, Rgb8, Size } from '../core/raster.ts';
import { err, ok, type Result } from '../core/result.ts';
import type { DepthStats, TapPoint } from '../core/types.ts';
import type { Candidate, DecodeResult, SamEmbeddings, SamTensor } from './protocol.ts';

/** Interleaved R, G, B, A bytes, row-major, as a canvas's ImageData holds them. */
export type RgbaBytes = Uint8ClampedArray | Uint8Array;

/** One output tensor as a model returns it; an ONNX Runtime Tensor is one. */
export type TensorLike = { readonly dims: readonly number[]; readonly data: unknown };
/** A model's outputs by name; ONNX Runtime's `InferenceSession.ReturnType` is one. */
export type TensorMap = { readonly [name: string]: TensorLike };

/** A model input this module built: the dims to give the tensor and its data, a new array over its own ArrayBuffer. */
export type InputTensor<D extends Float32Array | Uint8Array | BigInt64Array> = { readonly dims: readonly number[]; readonly data: D };

/** The depth model's and the SAM encoder's input name. */
export const PIXEL_VALUES = 'pixel_values';
/** The depth model's output name. */
export const DEPTH_OUTPUT = 'predicted_depth';
/** The SAM encoder's input size: the master is stretched to it, its aspect not kept. */
export const SAM_INPUT_SIZE: Size = { width: 1024, height: 1024 };
/** The SAM encoder's outputs, in the order a SamEmbeddings holds them; the decoder takes the same names and dims. */
export const SAM_EMBEDDING_TENSORS = [
  { name: 'image_embeddings.0', dims: [1, 32, 256, 256] },
  { name: 'image_embeddings.1', dims: [1, 64, 128, 128] },
  { name: 'image_embeddings.2', dims: [1, 256, 64, 64] },
] as const satisfies readonly { readonly name: string; readonly dims: readonly number[] }[];
/** MI-GAN's output name; its inputs are named as MiganInput's fields. */
export const MIGAN_OUTPUT = 'result';
/** A hole byte at or above this is in the hole: 0.5 of 255, as a mask is read everywhere else. */
export const MIGAN_HOLE_THRESHOLD = 128;

/** The ImageNet mean and standard deviation of R, G, and B, on values scaled to 0..1. */
export const IMAGENET_MEAN = [0.485, 0.456, 0.406] as const;
export const IMAGENET_STD = [0.229, 0.224, 0.225] as const;

/** A channel's normalized value of every byte, (byte / 255 - mean) / std, computed in doubles and held as float32. */
function imagenetTable(channel: 0 | 1 | 2): Float32Array {
  const mean = IMAGENET_MEAN[channel];
  const std = IMAGENET_STD[channel];
  const table = new Float32Array(256);
  for (let v = 0; v < 256; v += 1) table[v] = (v / 255 - mean) / std;
  return table;
}

const IMAGENET_RED = imagenetTable(0);
const IMAGENET_GREEN = imagenetTable(1);
const IMAGENET_BLUE = imagenetTable(2);

// ---------------------------------------------------------------------------
// checks

function isWhole(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

/** The pixel count of `size`, or the reason it is not a size. */
function pixelCount(size: Size, what: string): Result<number, string> {
  if (!isWhole(size.width) || !isWhole(size.height)) {
    return err(`${what}: expected whole sides of at least 1, got ${size.width} x ${size.height}`);
  }
  return ok(size.width * size.height);
}

/** Up to eight dims as `[1, 3, 4, 5]`, or how many there are. */
function formatDims(dims: readonly number[]): string {
  return dims.length <= 8 ? `[${dims.join(', ')}]` : `a list of ${dims.length} dims`;
}

function sameDims(dims: readonly number[], expected: readonly number[]): boolean {
  return dims.length === expected.length && expected.every((dim, i) => dims[i] === dim);
}

/** A value's built-in kind, such as `Uint8Array` or `Array`. */
function kindOf(value: unknown): string {
  return value === null ? 'null' : typeof value === 'object' ? Object.prototype.toString.call(value).slice(8, -1) : typeof value;
}

/** At most eight of the names in `outputs`. */
function namesIn(outputs: TensorMap): string {
  const names = Object.keys(outputs);
  const shown = names.slice(0, 8).map((name) => `'${name}'`).join(', ');
  return names.length === 0 ? 'none' : names.length > 8 ? `${shown}, and ${names.length - 8} more` : shown;
}

function checkRgba(rgba: RgbaBytes, size: Size, what: string): Result<number, string> {
  const count = pixelCount(size, `${what} size`);
  if (!count.ok) return count;
  if (rgba.length !== count.value * 4) {
    return err(`${what}: expected ${count.value * 4} bytes for ${size.width} x ${size.height} RGBA, got ${rgba.length}`);
  }
  return count;
}

/** The output named `name`, with data of the kind `is` accepts, the dims `expected`, and as many elements as they give. */
function takeOutput<D extends Float32Array | Uint8Array>(
  outputs: TensorMap,
  name: string,
  expected: readonly number[],
  dataKind: string,
  is: (value: unknown) => value is D,
): Result<D, string> {
  const tensor = Object.hasOwn(outputs, name) ? outputs[name] : undefined;
  if (tensor === undefined) return err(`${name}: the outputs hold no tensor of this name; they hold ${namesIn(outputs)}`);
  if (!sameDims(tensor.dims, expected)) return err(`${name}: expected dims ${formatDims(expected)}, got ${formatDims(tensor.dims)}`);
  const data = tensor.data;
  if (!is(data)) return err(`${name}: expected ${dataKind} data, got ${kindOf(data)}`);
  const length = expected.reduce((total, dim) => total * dim, 1);
  if (data.length !== length) return err(`${name}: expected ${length} elements for dims ${formatDims(expected)}, got ${data.length}`);
  return ok(data);
}

function isFloat32Array(value: unknown): value is Float32Array {
  return value instanceof Float32Array;
}

function isUint8Array(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

/** The index of the first element that is NaN or an infinity, or -1. */
function firstNonFinite(data: Float32Array): number {
  for (let i = 0; i < data.length; i += 1) {
    if (!Number.isFinite(data[i])) return i;
  }
  return -1;
}

function nonFinite(name: string, data: Float32Array, at: number): string {
  return `${name}: element ${at} is ${data[at]}, not a finite number`;
}

// ---------------------------------------------------------------------------
// depth and the SAM encoder's input

/**
 * The depth model's and the SAM encoder's input: `rgba`'s pixels as planar float32, R then G then B,
 * each (byte / 255 - mean) / std with the ImageNet constants, and alpha dropped; dims [1, 3, height, width].
 */
export function imagenetInput(rgba: RgbaBytes, size: Size): Result<InputTensor<Float32Array<ArrayBuffer>>, string> {
  const count = checkRgba(rgba, size, 'pixels');
  if (!count.ok) return count;
  const n = count.value;
  const data = new Float32Array(3 * n);
  for (let i = 0, j = 0; i < n; i += 1, j += 4) {
    data[i] = IMAGENET_RED[rgba[j] ?? 0] ?? 0;
    data[n + i] = IMAGENET_GREEN[rgba[j + 1] ?? 0] ?? 0;
    data[2 * n + i] = IMAGENET_BLUE[rgba[j + 2] ?? 0] ?? 0;
  }
  return ok({ dims: [1, 3, size.height, size.width], data });
}

/** The depth stage's product: the map, inverse depth normalized 0..1 with larger nearer, and its statistics. */
export type DepthResult = { readonly map: Plane<'f32'>; readonly stats: DepthStats };

/**
 * The depth stage's product from the model's outputs, for an input of `inputSize`, which is depthInputSize(master).
 * `predicted_depth` must be float32 with dims [1, height, width] of `inputSize` and every element finite.
 * The map is min-max normalized, (value - min) / (max - min), so its nearest point is 1 and its farthest 0;
 * a flat output, max equal to min, has no nearer or farther point and becomes all zeros.
 * The statistics are the nearest-rank p10, median, and p90 of the normalized map.
 */
export function depthProduct(outputs: TensorMap, inputSize: Size): Result<DepthResult, string> {
  const count = pixelCount(inputSize, 'depth input size');
  if (!count.ok) return count;
  const raw = takeOutput(outputs, DEPTH_OUTPUT, [1, inputSize.height, inputSize.width], 'float32', isFloat32Array);
  if (!raw.ok) return raw;
  const values = raw.value;
  const bad = firstNonFinite(values);
  if (bad >= 0) return err(nonFinite(DEPTH_OUTPUT, values, bad));
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const range = max - min;
  const data = new Float32Array(values.length);
  if (range > 0) {
    for (let i = 0; i < values.length; i += 1) data[i] = ((values[i] ?? min) - min) / range;
  }
  const ranked = rank(data);
  if (!ranked.ok) return ranked;
  const p10 = nearestRank(ranked.value, 0.1);
  const median = nearestRank(ranked.value, 0.5);
  const p90 = nearestRank(ranked.value, 0.9);
  if (!p10.ok) return p10;
  if (!median.ok) return median;
  if (!p90.ok) return p90;
  return ok({
    map: { format: 'f32', size: { width: inputSize.width, height: inputSize.height }, data },
    stats: { p10: p10.value, median: median.value, p90: p90.value },
  });
}

// ---------------------------------------------------------------------------
// the SAM encoder's output

function embeddingTensor(outputs: TensorMap, spec: (typeof SAM_EMBEDDING_TENSORS)[number]): Result<SamTensor, string> {
  const taken = takeOutput(outputs, spec.name, spec.dims, 'float32', isFloat32Array);
  if (!taken.ok) return taken;
  const bad = firstNonFinite(taken.value);
  if (bad >= 0) return err(nonFinite(spec.name, taken.value, bad));
  return ok({ name: spec.name, dims: [...spec.dims], data: transferable(taken.value) });
}

/**
 * `data` itself when it spans the whole of an ArrayBuffer that is not shared, as each output ONNX Runtime returns
 * does, so the worker can transfer it without a second copy at the encoder's memory peak; otherwise a copy over
 * a new ArrayBuffer of its own.
 */
function transferable(data: Float32Array): Float32Array {
  const { buffer } = data;
  const whole = buffer instanceof ArrayBuffer && data.byteOffset === 0 && data.byteLength === buffer.byteLength;
  return whole ? data : new Float32Array(data);
}

/**
 * The SAM encoder's three outputs as SamEmbeddings, in SAM_EMBEDDING_TENSORS's order, with `model`, the encoder's ModelId.
 * Each must be float32 with its table's name and dims and every element finite; outputs of other names are ignored.
 * Each tensor's data is the output's own array when that array spans the whole of an ArrayBuffer that is not shared,
 * and otherwise a copy over a new one, so the worker can always transfer it.
 */
export function samEmbeddings(outputs: TensorMap, model: ModelId): Result<SamEmbeddings, string> {
  const [first, second, third] = SAM_EMBEDDING_TENSORS;
  const a = embeddingTensor(outputs, first);
  if (!a.ok) return a;
  const b = embeddingTensor(outputs, second);
  if (!b.ok) return b;
  const c = embeddingTensor(outputs, third);
  if (!c.ok) return c;
  return ok({ model, tensors: [a.value, b.value, c.value] });
}

// ---------------------------------------------------------------------------
// MI-GAN

/** MI-GAN's two inputs, each field named as the model's input. */
export type MiganInput = { readonly image: InputTensor<Uint8Array<ArrayBuffer>>; readonly mask: InputTensor<Uint8Array<ArrayBuffer>> };

/**
 * MI-GAN's inputs from the master's pixels and the hole, both of `size`.
 * `image` is the pixels as planar uint8, R then G then B, alpha dropped, dims [1, 3, height, width].
 * `hole` is in the repository's polarity, 255 in the hole as holeMask writes it; MI-GAN's `mask` is the inverse,
 * 255 to keep and 0 in the hole, dims [1, 1, height, width]. A hole byte of MIGAN_HOLE_THRESHOLD (128) or more is in the hole,
 * so a soft hole is cut at 0.5.
 */
export function miganInput(rgba: RgbaBytes, size: Size, hole: Plane<'u8'>): Result<MiganInput, string> {
  const count = checkRgba(rgba, size, 'pixels');
  if (!count.ok) return count;
  const n = count.value;
  if (hole.size.width !== size.width || hole.size.height !== size.height) {
    return err(`hole: expected the pixels' size ${size.width} x ${size.height}, got ${hole.size.width} x ${hole.size.height}`);
  }
  if (hole.data.length !== n) return err(`hole: expected ${n} bytes for ${size.width} x ${size.height}, got ${hole.data.length}`);
  const image = new Uint8Array(3 * n);
  for (let i = 0, j = 0; i < n; i += 1, j += 4) {
    image[i] = rgba[j] ?? 0;
    image[n + i] = rgba[j + 1] ?? 0;
    image[2 * n + i] = rgba[j + 2] ?? 0;
  }
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) mask[i] = (hole.data[i] ?? 0) >= MIGAN_HOLE_THRESHOLD ? 0 : 255;
  const dims = (channels: number): readonly number[] => [1, channels, size.height, size.width];
  return ok({ image: { dims: dims(3), data: image }, mask: { dims: dims(1), data: mask } });
}

/**
 * The plate from MI-GAN's outputs for a master of `size`: `result` must be uint8 with dims [1, 3, height, width],
 * planar R then G then B, and becomes an interleaved Rgb8 of `size`.
 */
export function plateFromResult(outputs: TensorMap, size: Size): Result<Rgb8, string> {
  const count = pixelCount(size, 'plate size');
  if (!count.ok) return count;
  const n = count.value;
  const result = takeOutput(outputs, MIGAN_OUTPUT, [1, 3, size.height, size.width], 'uint8', isUint8Array);
  if (!result.ok) return result;
  const planar = result.value;
  const data = new Uint8Array(3 * n);
  for (let i = 0, j = 0; i < n; i += 1, j += 3) {
    data[j] = planar[i] ?? 0;
    data[j + 1] = planar[n + i] ?? 0;
    data[j + 2] = planar[2 * n + i] ?? 0;
  }
  return ok({ size: { width: size.width, height: size.height }, data });
}

// ---------------------------------------------------------------------------
// the SAM decoder

/** The SAM decoder's prompt inputs, named as the model's inputs. */
export const DECODER_POINTS = 'input_points';
export const DECODER_LABELS = 'input_labels';
export const DECODER_BOXES = 'input_boxes';
/** The SAM decoder's outputs: one score per candidate, and each candidate's mask as logits. */
export const DECODER_SCORES = 'iou_scores';
export const DECODER_MASKS = 'pred_masks';
/** How many candidate masks SAM's decoder returns for one prompt. */
export const SAM_CANDIDATES = 3;
/** The size of each candidate's logits, which cover the whole SAM_INPUT_SIZE input. */
export const SAM_MASK_SIZE: Size = { width: 256, height: 256 };
/** A tap's label as the decoder takes it. */
const SAM_LABELS = { include: 1n, exclude: 0n } as const satisfies Record<TapPoint['label'], bigint>;

/** The decoder's three prompt inputs, each field named as the model's input. */
export type DecoderPrompt = {
  readonly input_points: InputTensor<Float32Array<ArrayBuffer>>;
  readonly input_labels: InputTensor<BigInt64Array<ArrayBuffer>>;
  readonly input_boxes: InputTensor<Float32Array<ArrayBuffer>>;
};

/**
 * The decoder's prompt for `points`, tap points in frame fractions of the master.
 * The encoder's input is the master stretched to SAM_INPUT_SIZE, so a point's input coordinates are its fractions
 * times 1024 on each axis: `input_points` float32 [1, 1, n, 2] holds x then y for each point in order, and
 * `input_labels` int64 [1, 1, n] holds 1 for `include` and 0 for `exclude`; `input_boxes` is float32 [1, 0, 4],
 * no box. A coordinate outside 0 to 1 or not finite is refused.
 */
export function decoderPrompt(points: NonEmpty<TapPoint>): Result<DecoderPrompt, string> {
  const n = points.length;
  const coords = new Float32Array(2 * n);
  const labels = new BigInt64Array(n);
  for (let i = 0; i < n; i += 1) {
    const point = points[i];
    if (point === undefined) return err(`points[${i}]: missing`);
    const { x, y } = point.at;
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return err(`points[${i}].at: expected x and y from 0 to 1, got ${x}, ${y}`);
    coords[2 * i] = x * SAM_INPUT_SIZE.width;
    coords[2 * i + 1] = y * SAM_INPUT_SIZE.height;
    labels[i] = SAM_LABELS[point.label];
  }
  return ok({
    input_points: { dims: [1, 1, n, 2], data: coords },
    input_labels: { dims: [1, 1, n], data: labels },
    input_boxes: { dims: [1, 0, 4], data: new Float32Array(0) },
  });
}

/**
 * The embeddings' tensors when `embeddings` is what the decoder of `model` takes: made by `model`, the decoder's own
 * ModelId, and holding SAM_EMBEDDING_TENSORS's names and dims in its order; otherwise the reason it is not.
 */
export function decoderEmbeddings(embeddings: SamEmbeddings, model: ModelId): Result<SamEmbeddings['tensors'], string> {
  if (embeddings.model !== model) return err(`embeddings: made by ${embeddings.model}, not by the decoder's model ${model}`);
  for (let i = 0; i < SAM_EMBEDDING_TENSORS.length; i += 1) {
    const spec = SAM_EMBEDDING_TENSORS[i];
    const tensor = embeddings.tensors[i];
    if (spec === undefined || tensor === undefined) return err(`embeddings.tensors: expected ${SAM_EMBEDDING_TENSORS.length} tensors`);
    if (tensor.name !== spec.name || !sameDims(tensor.dims, spec.dims)) {
      return err(`embeddings.tensors[${i}]: expected ${spec.name} with dims ${formatDims(spec.dims)}, got ${tensor.name} with dims ${formatDims(tensor.dims)}`);
    }
    const length = spec.dims.reduce<number>((total, dim) => total * dim, 1);
    if (tensor.data.length !== length) return err(`embeddings.tensors[${i}]: expected ${length} elements for dims ${formatDims(spec.dims)}, got ${tensor.data.length}`);
  }
  return ok(embeddings.tensors);
}

/**
 * For each of `outLength` texels along one axis, the two source texels of a bilinear resample from `inLength`
 * texels and the weight of the second: texel centers are aligned (half-pixel), so output texel `o` reads source
 * position `(o + 0.5) x inLength / outLength - 0.5`, clamped to the first and last texel.
 */
function bilinearAxis(inLength: number, outLength: number): { readonly lo: Int32Array; readonly hi: Int32Array; readonly weight: Float64Array } {
  const lo = new Int32Array(outLength);
  const hi = new Int32Array(outLength);
  const weight = new Float64Array(outLength);
  const scale = inLength / outLength;
  for (let o = 0; o < outLength; o += 1) {
    const at = Math.min(Math.max((o + 0.5) * scale - 0.5, 0), inLength - 1);
    const first = Math.floor(at);
    lo[o] = first;
    hi[o] = Math.min(first + 1, inLength - 1);
    weight[o] = at - first;
  }
  return { lo, hi, weight };
}

/**
 * A logit at or beyond this magnitude reads 255, or 0 below its negative, without the sigmoid: 255 x sigmoid(6.3) is
 * 254.53, which rounds to 255, the sigmoid is monotonic, and the formula is symmetric about 127.5.
 */
const MASK_SATURATION = 6.3;

/**
 * A logit as a mask byte, `round(255 x sigmoid(logit))`, so a logit of 0 or more gives 128 or more; a logit below 0
 * that rounding would carry to 128 is held at 127, so a byte is 128 or more exactly when its logit is 0 or more.
 */
function maskByte(logit: number): number {
  if (logit >= MASK_SATURATION) return 255;
  if (logit <= -MASK_SATURATION) return 0;
  const byte = Math.round(255 / (1 + Math.exp(-logit)));
  return logit < 0 && byte > 127 ? 127 : byte;
}

/**
 * One candidate's logits, `SAM_MASK_SIZE` texels from `offset` in `logits`, resampled bilinearly to `size` and read
 * as mask bytes. The logits cover the whole stretched input, so resampling them to the master's aspect undoes the stretch.
 * Each output row first blends its two source rows into one row of logits, then reads each output texel from that row.
 */
function candidateMask(logits: Float32Array, offset: number, size: Size, columns: ReturnType<typeof bilinearAxis>, rows: ReturnType<typeof bilinearAxis>): Plane<'u8'> {
  const stride = SAM_MASK_SIZE.width;
  const data = new Uint8Array(size.width * size.height);
  const blended = new Float64Array(stride);
  for (let y = 0; y < size.height; y += 1) {
    const top = offset + (rows.lo[y] ?? 0) * stride;
    const bottom = offset + (rows.hi[y] ?? 0) * stride;
    const wy = rows.weight[y] ?? 0;
    for (let c = 0; c < stride; c += 1) blended[c] = (logits[top + c] ?? 0) * (1 - wy) + (logits[bottom + c] ?? 0) * wy;
    const row = y * size.width;
    for (let x = 0; x < size.width; x += 1) {
      const wx = columns.weight[x] ?? 0;
      data[row + x] = maskByte((blended[columns.lo[x] ?? 0] ?? 0) * (1 - wx) + (blended[columns.hi[x] ?? 0] ?? 0) * wx);
    }
  }
  return { format: 'u8', size: { width: size.width, height: size.height }, data };
}

/**
 * The decode's candidates from the decoder's outputs, each mask at `size`, the guide's size.
 * `iou_scores` must be float32 with dims [1, 1, 3] and `pred_masks` float32 with dims [1, 1, 3, 256, 256], every
 * element of both finite. Each candidate's logits are resampled bilinearly to `size` and read as
 * `round(255 x sigmoid(logit))` (see maskByte); the three are ordered by score, highest first, a tie keeping the
 * decoder's order. A candidate with no byte of 128 or more, an empty one, is kept.
 */
export function decodeCandidates(outputs: TensorMap, size: Size): Result<DecodeResult, string> {
  const count = pixelCount(size, 'mask size');
  if (!count.ok) return count;
  const scores = takeOutput(outputs, DECODER_SCORES, [1, 1, SAM_CANDIDATES], 'float32', isFloat32Array);
  if (!scores.ok) return scores;
  const badScore = firstNonFinite(scores.value);
  if (badScore >= 0) return err(nonFinite(DECODER_SCORES, scores.value, badScore));
  const masks = takeOutput(outputs, DECODER_MASKS, [1, 1, SAM_CANDIDATES, SAM_MASK_SIZE.height, SAM_MASK_SIZE.width], 'float32', isFloat32Array);
  if (!masks.ok) return masks;
  const badLogit = firstNonFinite(masks.value);
  if (badLogit >= 0) return err(nonFinite(DECODER_MASKS, masks.value, badLogit));
  const columns = bilinearAxis(SAM_MASK_SIZE.width, size.width);
  const rows = bilinearAxis(SAM_MASK_SIZE.height, size.height);
  const plane = SAM_MASK_SIZE.width * SAM_MASK_SIZE.height;
  const candidate = (index: number): Candidate => ({
    mask: candidateMask(masks.value, index * plane, size, columns, rows),
    score: scores.value[index] ?? 0,
  });
  const [first, second, third] = [0, 1, 2].sort((a, b) => (scores.value[b] ?? 0) - (scores.value[a] ?? 0));
  if (first === undefined || second === undefined || third === undefined) return err(`${DECODER_SCORES}: expected ${SAM_CANDIDATES} scores`);
  return ok({ candidates: [candidate(first), candidate(second), candidate(third)] });
}
