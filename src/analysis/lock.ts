// The model lock's one shape: the schema of models.lock.json, its parse, which
// files each analysis operation needs, the lock hash, the names of the model
// caches, and the key of a model file's entry, which the model loader writes
// and the sequence worker reads. Node tests import this module as it is, so it
// reads no compile-time constant and no browser global; the browser's copy of
// the lock arrives through analysis/bundled-lock.ts.

import type { AnalysisOp } from '../core/derive.ts';
import { isModelId, type ModelId, type NonEmpty } from '../core/ids.ts';
import { err, ok, type Result } from '../core/result.ts';
import { describeIssues } from '../core/schema.ts';
import { z } from '../core/zod.ts';

/** Face tracking is live input, outside the scene's analysis/reconcile operations. */
export type ModelOp = AnalysisOp | 'face';

const NAME = /^[a-z][a-z0-9-]*$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** `/models/<model name>-<8 hex>.<extension>`: same-origin, under the one route that serves models. */
const SERVED = /^\/models\/[a-z][a-z0-9-]*-[0-9a-f]{8}\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;

const modelIdSchema = z.custom<ModelId>((value) => typeof value === 'string' && isModelId(value), {
  message: "expected '<model name>@<64 lowercase hex digits>'",
});

const fileFields = {
  session: z.string().regex(NAME),
  source: z.url(),
  sha256: z.string().regex(HEX64),
  bytes: z.number().int().positive(),
  served: z.string().regex(SERVED),
};

/** One file of a model: a graph, or the external data its graph names by `externalDataPath`. */
export const lockedFileSchema = z.discriminatedUnion('role', [
  z.strictObject({ ...fileFields, role: z.literal('graph') }),
  z.strictObject({ ...fileFields, role: z.literal('external-data'), externalDataPath: z.string().min(1) }),
]);

export const lockedModelSchema = z.strictObject({
  modelId: modelIdSchema,
  repo: z.string().min(1),
  commit: z.string().regex(HEX40),
  license: z.enum(['Apache-2.0', 'MIT']),
  licenseSource: z.url(),
  files: z.array(lockedFileSchema).min(1),
});

/** models.lock.json. */
export const modelLockSchema = z.strictObject({
  lockVersion: z.literal(1),
  models: z.record(z.string().regex(NAME), lockedModelSchema),
});

export type ModelLock = z.infer<typeof modelLockSchema>;
export type LockedModel = z.infer<typeof lockedModelSchema>;
export type LockedFile = z.infer<typeof lockedFileSchema>;

/** The model and the ONNX Runtime session whose files each operation needs; the files themselves are the lock's. */
export const OP_SESSIONS = {
  depth: { model: 'depth', session: 'depth' },
  encode: { model: 'sam', session: 'encoder' },
  decode: { model: 'sam', session: 'decoder' },
  inpaint: { model: 'migan', session: 'migan' },
  face: { model: 'face', session: 'face' },
} as const satisfies Readonly<Record<ModelOp, { readonly model: string; readonly session: string }>>;

/** The files one operation needs: one session of one model, in the lock's order, its graph among them. */
export type OpFiles = { readonly model: ModelId; readonly session: string; readonly files: NonEmpty<LockedFile> };

/** A parsed lock with each operation's files looked up, so no caller indexes the lock by name. */
export type ParsedLock = { readonly lock: ModelLock; readonly ops: Readonly<Record<ModelOp, OpFiles>> };

/** The files of the session `op` needs, or why the lock has none. */
function opFiles(lock: ModelLock, op: ModelOp): Result<OpFiles, string> {
  const { model: name, session } = OP_SESSIONS[op];
  const model = lock.models[name];
  const [first, ...rest] = model?.files.filter((f) => f.session === session) ?? [];
  if (model === undefined || first === undefined) return err(`the model lock has no ${name} model with a ${session} session, which ${op} needs.`);
  const files: NonEmpty<LockedFile> = [first, ...rest];
  if (!files.some((f) => f.role === 'graph')) return err(`the model lock's ${name} ${session} session has no graph file.`);
  return ok({ model: model.modelId, session, files });
}

/**
 * Parses a lock. Beyond the schema it refuses a `served` path used twice, a
 * `modelId` whose name is not its model's, and a lock missing the session an
 * operation needs or that session's graph file.
 */
export function parseLock(json: unknown): Result<ParsedLock, string> {
  const parsed = modelLockSchema.safeParse(json);
  if (!parsed.success) return err(`the model lock does not parse: ${describeIssues(parsed.error.issues)}`);
  const lock = parsed.data;
  const served = new Set<string>();
  for (const [name, model] of Object.entries(lock.models)) {
    if (!model.modelId.startsWith(`${name}@`)) return err(`the model lock's ${name} has the modelId ${model.modelId}, which names another model.`);
    for (const file of model.files) {
      if (served.has(file.served)) return err(`the model lock serves two files at ${file.served}.`);
      served.add(file.served);
    }
  }
  const depth = opFiles(lock, 'depth');
  if (!depth.ok) return depth;
  const encode = opFiles(lock, 'encode');
  if (!encode.ok) return encode;
  const decode = opFiles(lock, 'decode');
  if (!decode.ok) return decode;
  const inpaint = opFiles(lock, 'inpaint');
  if (!inpaint.ok) return inpaint;
  const face = opFiles(lock, 'face');
  if (!face.ok) return face;
  return ok({ lock, ops: { depth: depth.value, encode: encode.value, decode: decode.value, inpaint: inpaint.value, face: face.value } });
}

/**
 * The text the lock hash is the SHA-256 of: for each model in ascending code
 * unit order of its name, and each of its files in the lock's order, one line
 * of `<served> <sha256> <bytes>` ended by a line feed. Those three fields are
 * what a cached file is stored under and checked against, so a lock that
 * changes any of them names a new cache, and one that changes only a license
 * or a source does not.
 */
export function lockHashText(lock: ModelLock): string {
  const names = Object.keys(lock.models).sort();
  return names
    .flatMap((name) => lock.models[name]?.files ?? [])
    .map((f) => `${f.served} ${f.sha256} ${f.bytes}\n`)
    .join('');
}

/** Lowercase hex of a digest. */
export function hex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The lock hash, 64 lowercase hex digits: the SHA-256 of `lockHashText(lock)` as UTF-8. */
export async function lockHash(lock: ModelLock, subtle: Pick<SubtleCrypto, 'digest'>): Promise<string> {
  return hex(await subtle.digest('SHA-256', new TextEncoder().encode(lockHashText(lock))));
}

/** Every model cache's name starts with this; the model loader deletes, at startup, any such cache but the current lock's two. */
export const MODEL_CACHE_PREFIX = 'noisy-models-';

/** The model caches of the lock whose hash is `hash`: the verified files, and the segments of downloads not yet verified. */
export function modelCacheNames(hash: string): { readonly verified: string; readonly partial: string } {
  return { verified: `${MODEL_CACHE_PREFIX}${hash}`, partial: `${MODEL_CACHE_PREFIX}${hash}-partial` };
}

/** The key a model file is cached under, and the URL it is fetched from: its served path on `origin`, absolute. */
export function modelFileUrl(file: Pick<LockedFile, 'served'>, origin: string): string {
  return new URL(file.served, origin).href;
}
