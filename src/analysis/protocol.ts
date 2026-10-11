// What the analysis module reports when an operation fails, and the messages
// the page and the two analysis workers exchange.
//
// The model loader (analysis/models.ts) returns the download, integrity,
// quota, and cancelled variants of AnalysisError; the analysis service
// (analysis/service.ts) ends a sequence, and resolves a decode, with `worker`
// or `cancelled`; and `timeout` is for the watchdogs of the code that decides
// what to run, which is not built yet.
//
// A worker is a boundary: nothing that crosses postMessage is trusted until it
// is parsed. There is one parser per direction, for the side that receives it;
// each takes `unknown` and returns a Result holding the typed message or the
// paths that failed. The parsers read the value they are given, which after
// postMessage is a structured clone: plain objects and arrays of own data
// properties, typed arrays, and bitmaps. They are strict: an unknown `type`,
// an unknown key at any depth, an array with a hole or with an own key that is
// not an index, or a missing field fails. A value the caller built in its own
// realm is read the way zod reads it, so an inherited field or a getter counts
// as present; for such a value the parse promises only that it never throws.
// They read no browser global, so node tests run them as the workers will.

import type { AnalysisOp } from '../core/derive.ts';
import { isModelId, type ModelId, type NonEmpty } from '../core/ids.ts';
import type { Plane, PlaneFormat } from '../core/raster.ts';
import { err, ok, type Result } from '../core/result.ts';
import { depthStatsSchema, formatPath, tapPointSchema } from '../core/schema.ts';
import { z } from '../core/zod.ts';

export type AnalysisError =
  /** A model file did not arrive: the HTTP status of the answer, `offline` when the request or its body failed, a redirect included, or `stalled` when no byte came for the stall timeout. */
  | { readonly kind: 'download'; readonly model: ModelId; readonly status: number | 'offline' | 'stalled' }
  /** A model file's bytes did not hash to the lock's SHA-256, which the model's id carries. */
  | { readonly kind: 'integrity'; readonly model: ModelId }
  /** An operation ran past its watchdog, counted in visible time. */
  | { readonly kind: 'timeout'; readonly op: AnalysisOp; readonly visibleMs: number }
  /** A worker failed inside an operation. */
  | { readonly kind: 'worker'; readonly op: AnalysisOp; readonly message: string }
  /** Cache Storage refused an operation, as it does when the bytes do not fit. */
  | { readonly kind: 'quota' }
  /** The caller's abort signal fired. */
  | { readonly kind: 'cancelled' };

/** A stage the sequence worker runs; inpaint carries the hole it fills, as core/derive.ts's holeMask makes it. */
export type HeavyStage =
  | { readonly kind: 'depth' }
  | { readonly kind: 'encode' }
  | { readonly kind: 'inpaint'; readonly hole: Plane<'u8'> };

// ---------------------------------------------------------------------------
// structured-clone values

/** A getter of a built-in prototype, read once when this module loads; every runtime the app supports has each one. */
function intrinsicGetter(target: object, key: PropertyKey): (this: unknown) => unknown {
  const get = Object.getOwnPropertyDescriptor(target, key)?.get;
  if (get === undefined) throw new TypeError(`this runtime has no getter for ${String(key)}`);
  return get;
}

/**
 * The %TypedArray%.prototype getters for the name, the length, and the buffer,
 * and ArrayBuffer.prototype's byteLength getter. Each reads an internal slot
 * and works on a value of any realm; the name getter answers undefined for a
 * value that is not a typed array. A structured clone carries no `length` of
 * its own and no subclass, so reading the length through the getter matters
 * only for a value of the caller's own realm.
 */
const TYPED_ARRAY_PROTOTYPE: object = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayNameGetter = intrinsicGetter(TYPED_ARRAY_PROTOTYPE, Symbol.toStringTag);
const typedArrayLengthGetter = intrinsicGetter(TYPED_ARRAY_PROTOTYPE, 'length');
const typedArrayBufferGetter = intrinsicGetter(TYPED_ARRAY_PROTOTYPE, 'buffer');
const arrayBufferByteLengthGetter = intrinsicGetter(ArrayBuffer.prototype, 'byteLength');

function typedArrayName(value: unknown): unknown {
  return Reflect.apply(typedArrayNameGetter, value, []);
}

function isUint8Array(value: unknown): value is Uint8Array {
  return typedArrayName(value) === 'Uint8Array';
}

function isFloat32Array(value: unknown): value is Float32Array {
  return typedArrayName(value) === 'Float32Array';
}

/** The view's real element count, whatever a `length` of its own or of a subclass says. */
function typedArrayLength(view: Uint8Array | Float32Array): number {
  const length: unknown = Reflect.apply(typedArrayLengthGetter, view, []);
  if (typeof length !== 'number') throw new TypeError('a typed array answered a length that is not a number');
  return length;
}

/**
 * Whether the view's memory is a SharedArrayBuffer, which the sender still
 * holds after postMessage, so it could change a length or an element the parse
 * has checked. ArrayBuffer.prototype's byteLength getter throws on a shared
 * buffer and on nothing else a typed array can hold.
 */
function isShared(view: Uint8Array | Float32Array): boolean {
  const buffer: unknown = Reflect.apply(typedArrayBufferGetter, view, []);
  try {
    Reflect.apply(arrayBufferByteLengthGetter, buffer, []);
    return false;
  } catch {
    return true;
  }
}

/**
 * An ImageBitmap, recognized by its tag, `[object ImageBitmap]`, rather than by
 * the ImageBitmap global, which node lacks. A structured clone keeps neither a
 * prototype nor a symbol-keyed property, so after postMessage only a real
 * ImageBitmap carries that tag; a node test passes an object of its own that
 * declares the tag and a width and height.
 */
function isImageBitmap(value: unknown): value is ImageBitmap {
  return typeof value === 'object' && value !== null && Object.prototype.toString.call(value) === '[object ImageBitmap]';
}

/** `[object <tag>]`'s tag: a built-in's name, such as `Map` or `String`, and `Object` for a plain object. */
function tagOf(value: object): string {
  return Object.prototype.toString.call(value).slice('[object '.length, -1);
}

/** What `value` is, for a reason: a typed array or a bitmap by its name, a built-in by its tag, anything else by its type. */
function kindOf(value: unknown): string {
  const name = typedArrayName(value);
  if (typeof name === 'string') return `a ${name}`;
  if (isImageBitmap(value)) return 'an ImageBitmap';
  if (Array.isArray(value)) return 'an array';
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return `a ${typeof value}`;
  const tag = tagOf(value);
  if (tag === 'Object') return 'an object';
  return `${/^[AEIOU]/.test(tag) ? 'an' : 'a'} ${tag} object`;
}

/** A typed array of one kind that is not over a SharedArrayBuffer, returned as received. */
function viewSchema<T extends Uint8Array | Float32Array>(name: string, is: (value: unknown) => value is T) {
  return z.unknown().transform((value, ctx) => {
    if (!is(value)) ctx.addIssue({ code: 'custom', message: `expected a ${name}, got ${kindOf(value)}` });
    else if (isShared(value)) ctx.addIssue({ code: 'custom', message: `expected a ${name} over an ArrayBuffer, not a SharedArrayBuffer` });
    else return value;
    return z.NEVER;
  });
}

const uint8DataSchema = viewSchema('Uint8Array', isUint8Array);
const float32DataSchema = viewSchema('Float32Array', isFloat32Array);

function isWholeAtLeastOne(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** An open bitmap, returned as received: a closed or transferred one has a width and height of 0. */
const imageBitmapSchema = z.unknown().transform((value, ctx) => {
  if (!isImageBitmap(value)) ctx.addIssue({ code: 'custom', message: `expected an ImageBitmap, got ${kindOf(value)}` });
  else if (!(isWholeAtLeastOne(value.width) && isWholeAtLeastOne(value.height))) {
    ctx.addIssue({ code: 'custom', message: 'expected an open bitmap, its width and height whole and at least 1' });
  } else return value;
  return z.NEVER;
});

/** Whether `key` names an element of an array: a canonical index below 2^32 - 1. */
function isArrayIndex(key: string): boolean {
  const index = Number(key);
  return String(index) === key && Number.isInteger(index) && index >= 0 && index < 2 ** 32 - 1;
}

/** Why `array` is not dense, its own string keys exactly its indices 0 to length - 1, or undefined when it is. */
function notDense(array: readonly unknown[]): string | undefined {
  const keys = Object.keys(array);
  const extra = keys.find((key) => !isArrayIndex(key));
  if (extra !== undefined) return `expected an array whose only keys are its indices, got the key ${quoted(extra)}`;
  if (keys.length !== array.length) return `expected an array without holes, got ${keys.length} elements of ${array.length}`;
  return undefined;
}

/** `value` when it is a dense array, its own string keys exactly its indices, or why it is not. */
function denseOrReason(value: unknown): readonly unknown[] | string {
  if (!Array.isArray(value)) return `expected an array, got ${kindOf(value)}`;
  return notDense(value) ?? value;
}

/**
 * `schema` behind a guard that takes only a dense array. A structured clone
 * keeps a hole, the length around it, and an own key that is not an index;
 * zod's array schemas read each index up to the length and no other key, so a
 * message of a few bytes could claim 2^32 - 1 elements, and an extra key would
 * go unseen. The guard reads only the array's own keys and fails at the
 * array's path with one reason before `schema` reads an element.
 */
function denseArray<T extends z.ZodType>(schema: T) {
  return z
    .unknown()
    .transform((value, ctx): unknown => {
      const array = denseOrReason(value);
      if (typeof array !== 'string') return array;
      ctx.addIssue({ code: 'custom', message: array });
      return z.NEVER;
    })
    .pipe(schema);
}

/**
 * `value` as a dense array of any length, behind the same guard, its elements
 * parsed by `each` in one pass, frozen; undefined, with its issues added to
 * `ctx`, when it fails. The pass stops at the first element `each` refuses and
 * reports only its issues: zod reports an issue for every element that fails,
 * and under node a list of 200,000 issues overflows the call stack as zod
 * copies it into the enclosing object's. An object the array holds more than
 * once is parsed once, and its output stands at each of its places: a
 * structured clone writes a repeated object as a reference of a few bytes, and
 * a new output for each would cost many times the message's size.
 */
function parseList<T extends z.ZodType>(each: T, value: unknown, ctx: z.RefinementCtx): readonly z.output<T>[] | undefined {
  const elements = denseOrReason(value);
  if (typeof elements === 'string') {
    ctx.addIssue({ code: 'custom', message: elements });
    return undefined;
  }
  const parsed = new Map<unknown, z.output<T>>();
  const list: z.output<T>[] = [];
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];
    const known = parsed.get(element);
    if (known !== undefined) {
      list.push(known);
      continue;
    }
    const result = each.safeParse(element);
    if (!result.success) {
      // addIssue fills in each issue's input with the array.
      for (const { input: _, ...issue } of result.error.issues) ctx.addIssue({ ...issue, path: [i, ...issue.path] });
      return undefined;
    }
    if (typeof element === 'object' && element !== null) parsed.set(element, result.data);
    list.push(result.data);
  }
  return Object.freeze(list);
}

/** A dense array of any length whose every element `each` takes. */
function listOf<T extends z.ZodType>(each: T) {
  return z.unknown().transform((value, ctx) => parseList(each, value, ctx) ?? z.NEVER);
}

/** A dense array of one or more elements, each of which `each` takes. */
function nonEmptyListOf<T extends z.ZodType>(each: T) {
  return z.unknown().transform((value, ctx): NonEmpty<z.output<T>> => {
    const list = parseList(each, value, ctx);
    if (list === undefined) return z.NEVER;
    if (isNonEmpty(list)) return list;
    ctx.addIssue({ code: 'custom', message: 'expected at least one element' });
    return z.NEVER;
  });
}

/** Whether `list` has an element. */
function isNonEmpty<E>(list: readonly E[]): list is NonEmpty<E> {
  return list.length > 0;
}

/**
 * `schema`, an object schema, behind a guard that takes only a plain object,
 * as every object of a structured clone is that is not an array or a
 * built-in. zod's object schemas go through the value's enumerable keys with
 * for-in, and a typed array's or a String object's are its indices, so one
 * where an object belongs would make an unknown-keys issue listing every
 * element's index and cost many times its own size in memory; the guard fails
 * it at its path with one reason before `schema` reads it.
 */
function plainObject<T extends z.ZodType>(schema: T) {
  return z
    .unknown()
    .transform((value, ctx): unknown => {
      if (typeof value === 'object' && value !== null && tagOf(value) === 'Object') return value;
      ctx.addIssue({ code: 'custom', message: `expected an object, got ${kindOf(value)}` });
      return z.NEVER;
    })
    .pipe(schema);
}

/** A strict object behind the plain-object guard. */
function strictObject<S extends z.core.$ZodLooseShape>(shape: S) {
  return plainObject(z.strictObject(shape));
}

/**
 * For a check that compares fields: it runs only when nothing else in its
 * object has failed, so its reason never rests on a field that did not parse.
 */
const WHEN_PARSED = { when: (payload: z.core.ParsePayload) => payload.issues.length === 0 };

/** Both sides whole and at least 1. */
const sizeSchema = strictObject({ width: z.int().min(1), height: z.int().min(1) }).readonly();

/** Reports the first element of `data` that is NaN or infinite, at its index under `path`. */
function checkFinite(data: Float32Array, path: readonly PropertyKey[], ctx: z.RefinementCtx): void {
  const length = typedArrayLength(data);
  for (let i = 0; i < length; i++) {
    const value = data[i];
    if (value === undefined || !Number.isFinite(value)) {
      ctx.addIssue({ code: 'custom', path: [...path, i], message: 'expected a finite number' });
      return;
    }
  }
}

/** Reports `data` when its length is not `expected`, naming what the length must equal. */
function checkLength(data: Uint8Array | Float32Array, expected: number, what: string, ctx: z.RefinementCtx): void {
  const length = typedArrayLength(data);
  if (length !== expected) {
    ctx.addIssue({ code: 'custom', path: ['data'], message: `expected ${expected} elements (${what}), got ${length}` });
  }
}

/**
 * A plane of `format` whose data is a typed array of that format's kind with
 * exactly width x height elements; an f32 plane's elements are also finite.
 */
function planeSchema<F extends PlaneFormat>(format: F, data: z.ZodType<Plane<F>['data']>) {
  return strictObject({ format: z.literal(format), size: sizeSchema, data })
    .superRefine((plane, ctx) => {
      checkLength(plane.data, plane.size.width * plane.size.height, 'width x height', ctx);
      if (isFloat32Array(plane.data)) checkFinite(plane.data, ['data'], ctx);
    }, WHEN_PARSED)
    .readonly();
}

const u8PlaneSchema = planeSchema('u8', uint8DataSchema);
const f32PlaneSchema = planeSchema('f32', float32DataSchema);

/** An Rgb8 image: a Uint8Array of exactly width x height x 3 bytes. */
const rgb8Schema = strictObject({ size: sizeSchema, data: uint8DataSchema })
  .superRefine((image, ctx) => checkLength(image.data, image.size.width * image.size.height * 3, 'width x height x 3', ctx), WHEN_PARSED)
  .readonly();

// ---------------------------------------------------------------------------
// what the messages carry

const modelIdSchema = z.custom<ModelId>((value) => typeof value === 'string' && isModelId(value), {
  message: "expected '<model name>@<64 lowercase hex digits>'",
});

const heavyStageKindSchema = z.enum(['depth', 'encode', 'inpaint']);

/** Milliseconds to create the stage's session and to run it, and the wasm memory's high-water mark in bytes. */
const stageTimingsSchema = strictObject({ sessionMs: z.number().min(0), inferMs: z.number().min(0), wasmHighWaterBytes: z.int().min(0) }).readonly();

/** The document's depth statistics and tap point, each object in them behind the plain-object guard. */
const statsSchema = plainObject(depthStatsSchema);
const tapPointShape = tapPointSchema.unwrap().shape;
const tapSchema = strictObject({ at: plainObject(tapPointShape.at), label: tapPointShape.label }).readonly();

/** One named output of SAM's encoder: its dims, each whole and at least 1, multiply to its data's length, and every element is finite. */
const samTensorSchema = strictObject({ name: z.string().min(1), dims: listOf(z.int().min(1)), data: float32DataSchema })
  .superRefine((tensor, ctx) => {
    const product = tensor.dims.reduce((total, dim) => total * dim, 1);
    checkLength(tensor.data, product, 'the product of dims', ctx);
    checkFinite(tensor.data, ['data'], ctx);
  }, WHEN_PARSED)
  .readonly();

/** The encoder's three outputs for one image, each name once, and the ModelId of the model that made them; the parser checks the id's form, not which model it names. */
const samEmbeddingsSchema = strictObject({
    model: modelIdSchema,
    tensors: denseArray(
      z
        .tuple([samTensorSchema, samTensorSchema, samTensorSchema])
        .superRefine((tensors, ctx) => {
          tensors.forEach((tensor, i) => {
            if (tensors.findIndex((other) => other.name === tensor.name) < i) {
              ctx.addIssue({ code: 'custom', path: [i, 'name'], message: 'tensor names must be unique' });
            }
          });
        }, WHEN_PARSED)
        .readonly(),
    ),
  })
  .readonly();

/** One of SAM's masks and the score SAM gave it. */
const candidateSchema = strictObject({ mask: u8PlaneSchema, score: z.number() }).readonly();

/** Exactly three candidates, highest score first, every mask the size of the first. */
const decodeResultSchema = strictObject({
    candidates: denseArray(
      z
        .tuple([candidateSchema, candidateSchema, candidateSchema])
        .superRefine((candidates, ctx) => {
          const [first] = candidates;
          candidates.forEach((candidate, i) => {
            const previous = candidates[i - 1];
            if (previous !== undefined && candidate.score > previous.score) {
              ctx.addIssue({ code: 'custom', path: [i, 'score'], message: 'candidates must be in descending order of score' });
            }
            const { width, height } = candidate.mask.size;
            if (width !== first.mask.size.width || height !== first.mask.size.height) {
              ctx.addIssue({ code: 'custom', path: [i, 'mask', 'size'], message: 'every candidate mask must be the size of the first' });
            }
          });
        }, WHEN_PARSED)
        .readonly(),
    ),
  })
  .readonly();

const ortBaseSchema = z.string().min(1);
const jobIdSchema = z.int().min(0);

// ---------------------------------------------------------------------------
// the messages

/** The page to the sequence worker. */
const sequenceRequestSchema = z
  .discriminatedUnion('type', [
    /** Asks the worker to load ORT from `ortBase` with `threads` wasm threads, or ORT's default. */
    z.strictObject({ type: z.literal('init'), ortBase: ortBaseSchema, threads: z.union([z.int().min(1), z.literal('default')]) }),
    /** Asks the worker to run one stage on `image`; an inpaint run carries the hole it fills. */
    z.discriminatedUnion('stage', [
      z.strictObject({ type: z.literal('run'), stage: z.enum(['depth', 'encode']), image: imageBitmapSchema }),
      z.strictObject({ type: z.literal('run'), stage: z.literal('inpaint'), image: imageBitmapSchema, hole: u8PlaneSchema }),
    ]),
    /** Asks the worker to answer each run still queued with `failed` and close itself; each stage releases its session before its product is posted, so none is alive by then. */
    z.strictObject({ type: z.literal('end') }),
  ])
  .readonly();

/** The sequence worker to the page. */
const sequenceReplySchema = z
  .discriminatedUnion('type', [
    /** A stage's progress: creating its session, or running it; `fraction` in 0 to 1, or null when unknown. */
    z.strictObject({
      type: z.literal('phase'),
      stage: heavyStageKindSchema,
      phase: z.enum(['session', 'infer']),
      fraction: z.number().min(0).max(1).nullable(),
    }),
    z.strictObject({ type: z.literal('depth'), map: f32PlaneSchema, stats: statsSchema, timings: stageTimingsSchema }),
    z.strictObject({ type: z.literal('embeddings'), embeddings: samEmbeddingsSchema, timings: stageTimingsSchema }),
    z.strictObject({ type: z.literal('plate'), image: rgb8Schema, timings: stageTimingsSchema }),
    z.strictObject({ type: z.literal('failed'), stage: heavyStageKindSchema, message: z.string() }),
  ])
  .readonly();

/** The page to the decode worker. */
const decodeRequestSchema = z
  .discriminatedUnion('type', [
    /** Asks the worker to load ORT and the decoder and to keep the embeddings and the guide's size for every decode; the guide's size is not checked here. */
    z.strictObject({ type: z.literal('init'), ortBase: ortBaseSchema, embeddings: samEmbeddingsSchema, guide: rgb8Schema }),
    z.strictObject({ type: z.literal('decode'), jobId: jobIdSchema, points: nonEmptyListOf(tapSchema) }),
  ])
  .readonly();

/** The decode worker to the page, each reply naming the decode it answers. */
const decodeReplySchema = z
  .discriminatedUnion('type', [
    z.strictObject({ type: z.literal('decoded'), jobId: jobIdSchema, result: decodeResultSchema, timings: stageTimingsSchema }),
    z.strictObject({ type: z.literal('failed'), jobId: jobIdSchema, message: z.string() }),
  ])
  .readonly();

export type StageTimings = z.infer<typeof stageTimingsSchema>;
export type SamTensor = z.infer<typeof samTensorSchema>;
export type SamEmbeddings = z.infer<typeof samEmbeddingsSchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export type DecodeResult = z.infer<typeof decodeResultSchema>;
export type SequenceRequest = z.infer<typeof sequenceRequestSchema>;
export type SequenceReply = z.infer<typeof sequenceReplySchema>;
export type DecodeRequest = z.infer<typeof decodeRequestSchema>;
export type DecodeReply = z.infer<typeof decodeReplySchema>;

const faceCandidateShape = {
  center: strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
  size: z.number().positive().max(1),
  confidence: z.number().min(0).max(1).optional(),
  clipped: z.boolean().optional(),
  box: strictObject({ x0: z.number().min(0).max(1), y0: z.number().min(0).max(1), x1: z.number().min(0).max(1), y1: z.number().min(0).max(1) })
    .refine((box) => box.x0 < box.x1 && box.y0 < box.y1, 'Face box must have positive area.').optional(),
};
const faceCandidateSchema = strictObject(faceCandidateShape).readonly();
const faceDetectionSchema = strictObject({ ...faceCandidateShape, candidates: z.array(faceCandidateSchema).max(8).optional() }).readonly();
const faceRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('init'), ortBase: ortBaseSchema }),
  z.strictObject({ type: z.literal('track'), jobId: jobIdSchema, frame: imageBitmapSchema }),
]).readonly();
const faceReplySchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready') }),
  z.strictObject({ type: z.literal('tracked'), jobId: jobIdSchema, face: faceDetectionSchema.nullable() }),
  z.strictObject({ type: z.literal('failed'), jobId: jobIdSchema.nullable(), message: z.string() }),
]).readonly();
export type FaceDetection = z.infer<typeof faceDetectionSchema>;
export type FaceRequest = z.infer<typeof faceRequestSchema>;
export type FaceReply = z.infer<typeof faceReplySchema>;

// ---------------------------------------------------------------------------
// the parsers

/**
 * Why a received value is not a message: the path of each failure found, and
 * one line naming each with its reason. It names at least one failure, not
 * every one: an f32 array reports only its first element that is not finite,
 * a tensor's dims and a decode's points only their first element that fails,
 * an object lists only its first few unknown keys, and a check that compares
 * fields, such as a plane's length against its size or the candidates' order
 * and sizes, runs only when nothing else in the object holding those fields
 * has failed.
 */
export type MessageError = { readonly paths: readonly string[]; readonly detail: string };

const ROOT = '(message)';

/** How many of one object's unknown keys are listed at their own paths; the rest are counted at the object's path. */
const UNKNOWN_KEYS_LISTED = 8;

type Failure = { readonly path: readonly PropertyKey[]; readonly message: string };

/**
 * The characters that end a line: line feed, vertical tab, form feed, carriage
 * return, next line, line separator, and paragraph separator.
 */
const LINE_BREAKS = /[\n\v\f\r\u{85}\u{2028}\u{2029}]+/gu;

/** `text` with each run of line breaks made one space, as a `failed` reply's message is written. */
export function oneLine(text: string): string {
  return text.replace(LINE_BREAKS, ' ');
}

/**
 * `text`, quoted by JSON.stringify, with each line break written as a `\u`
 * escape: JSON.stringify escapes the first four line breaks above and leaves
 * the last three raw.
 */
function escapeLineBreaks(text: string): string {
  return text.replace(LINE_BREAKS, (breaks) =>
    Array.from(breaks, (char) => `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`).join(''),
  );
}

/** `key` quoted on one line, as a reason names it. */
function quoted(key: string): string {
  return escapeLineBreaks(JSON.stringify(key));
}

/** `path` as text on one line; formatPath quotes a key with JSON.stringify. */
function pathText(path: readonly PropertyKey[]): string {
  return path.length === 0 ? ROOT : escapeLineBreaks(formatPath(path));
}

/** A thrown value as text, without letting a hostile value throw again. */
function describeThrown(thrown: unknown): string {
  try {
    return thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : `a thrown ${thrown === null ? 'null' : typeof thrown}`;
  } catch {
    return 'a value that could not be described';
  }
}

function messageError(failures: readonly Failure[]): MessageError {
  const lines = failures.map((failure) => ({ path: pathText(failure.path), message: oneLine(failure.message) }));
  return { paths: lines.map((line) => line.path), detail: lines.map((line) => `${line.path}: ${line.message}`).join('; ') };
}

/** The failures one zod issue stands for: an unknown key at its own path, up to the listed number per object, then a count of the rest. */
function failuresOf(issue: z.core.$ZodIssue): Failure[] {
  if (issue.code !== 'unrecognized_keys') return [{ path: issue.path, message: issue.message }];
  const listed: Failure[] = issue.keys.slice(0, UNKNOWN_KEYS_LISTED).map((key) => ({ path: [...issue.path, key], message: 'unknown key' }));
  const more = issue.keys.length - listed.length;
  return more > 0 ? [...listed, { path: issue.path, message: `${more} more unknown keys` }] : listed;
}

/**
 * Parses `value` with `schema`; never throws. A message is an object with a
 * `type`, so a typed array or a bitmap as the whole value fails at the root
 * before the schema reads it. A getter or proxy trap that throws while the
 * value is read fails at the root too, which a structured clone cannot
 * produce but a caller in the same realm can.
 */
function parseMessage<T>(schema: z.ZodType<T>, value: unknown): Result<T, MessageError> {
  try {
    if (typeof typedArrayName(value) === 'string' || isImageBitmap(value)) {
      return err(messageError([{ path: [], message: `expected an object with a type, got ${kindOf(value)}` }]));
    }
    const parsed = schema.safeParse(value);
    return parsed.success ? ok(parsed.data) : err(messageError(parsed.error.issues.flatMap(failuresOf)));
  } catch (thrown) {
    return err(messageError([{ path: [], message: `the parse threw ${describeThrown(thrown)}` }]));
  }
}

/** The sequence worker parses each message it receives from the page with this. */
export function parseSequenceRequest(value: unknown): Result<SequenceRequest, MessageError> {
  return parseMessage(sequenceRequestSchema, value);
}

/** The page parses each message it receives from the sequence worker with this. */
export function parseSequenceReply(value: unknown): Result<SequenceReply, MessageError> {
  return parseMessage(sequenceReplySchema, value);
}

/** The decode worker parses each message it receives from the page with this. */
export function parseDecodeRequest(value: unknown): Result<DecodeRequest, MessageError> {
  return parseMessage(decodeRequestSchema, value);
}

/** The page parses each message it receives from the decode worker with this. */
export function parseDecodeReply(value: unknown): Result<DecodeReply, MessageError> {
  return parseMessage(decodeReplySchema, value);
}

export function parseFaceRequest(value: unknown): Result<FaceRequest, MessageError> {
  return parseMessage(faceRequestSchema, value);
}
export function parseFaceReply(value: unknown): Result<FaceReply, MessageError> {
  return parseMessage(faceReplySchema, value);
}
