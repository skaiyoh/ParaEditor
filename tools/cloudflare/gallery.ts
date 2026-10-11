import { GALLERY_LIMITS, galleryDraftSchema, galleryManifestSchema, galleryListItemSchema, isGalleryId,
  type GalleryAsset, type GalleryPoster, type GalleryManifest } from '../../src/core/gallery.ts';
import { isAssetId } from '../../src/core/ids.ts';
import { z } from '../../src/core/zod.ts';
import type { ProjectsEnv } from './projects.ts';

export type GalleryEnv = {
  readonly GALLERY_ADMIN_KEY?: string;
  readonly PROJECTS: Omit<ProjectsEnv['PROJECTS'], 'put' | 'list'> & {
    put(key: string, value: ArrayBuffer, options: { httpMetadata: { contentType: string }; onlyIf?: { etagDoesNotMatch: string } }): Promise<unknown>;
    list(options: { prefix: string; cursor?: string; limit?: number }): ReturnType<ProjectsEnv['PROJECTS']['list']>;
  };
};
const secretSchema = z.strictObject({ tokenHash: z.string().regex(/^[a-f0-9]{64}$/) });
const storedDraftSchema = z.strictObject({ draft: galleryDraftSchema, tokenHash: secretSchema.shape.tokenHash });
const encoder = new TextEncoder();
const jsonBytes = (value: unknown): ArrayBuffer => encoder.encode(JSON.stringify(value)).buffer;
const piecePrefix = (id: string): string => `gallery/pieces/${id}/`;
const INDEX_TIME_CEILING = 8_640_000_000_000_000;
const LIST_SIZE = 60;
const LIST_SCAN_LIMIT = 120;
// R2 lists ascending keys. Invert the immutable publication time, with UUIDs
// as deterministic tie-breakers, so the first keys are the newest pieces.
const indexKey = (id: string, publishedAt: string): string =>
  `gallery/index/${String(INDEX_TIME_CEILING - Date.parse(publishedAt)).padStart(16, '0')}-${id}`;
const deletedKey = (id: string): string => `gallery/deleted/${id}`;
const mediaType = (asset: GalleryAsset | GalleryPoster): string => 'mediaType' in asset ? asset.mediaType : 'application/octet-stream';

async function digest(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
// Both inputs are fixed-length digests. Never short circuit a secret comparison.
function equalDigest(left: string, right: string): boolean {
  let difference = 0;
  for (let i = 0; i < 64; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}
async function jsonObject(bucket: GalleryEnv['PROJECTS'], key: string): Promise<unknown> {
  const object = await bucket.get(key);
  return object === null ? null : await new Response(object.body).json();
}
async function readBody(request: Pick<Request, 'headers' | 'body'>, limit: number): Promise<ArrayBuffer | null> {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && Number(declared) > limit) { await request.body?.cancel(); return null; }
  if (request.body === null) return new ArrayBuffer(0);
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) { await reader.cancel(); return null; }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}
async function* keys(bucket: GalleryEnv['PROJECTS'], prefix: string): AsyncGenerator<string> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor === undefined ? {} : { cursor }) });
    for (const { key } of page.objects) yield key;
    if (!page.truncated) return;
    if (!page.cursor || page.cursor === cursor) throw new Error('Gallery pagination failed.');
    cursor = page.cursor;
  } while (true);
}
async function cleanup(bucket: GalleryEnv['PROJECTS'], id: string, publishedAt: string | null = null): Promise<void> {
  // Visibility disappears before any referenced object does.
  const raw = publishedAt === null ? await jsonObject(bucket, `${piecePrefix(id)}manifest`) : null;
  const time = publishedAt ?? (raw === null ? null : galleryManifestSchema.parse(raw).publishedAt);
  if (time !== null) await bucket.delete(indexKey(id, time));
  for await (const key of keys(bucket, piecePrefix(id))) await bucket.delete(key);
}

function matchesETag(condition: string | null, etag: string): boolean {
  return (condition ?? '').split(',').some((value) => {
    const candidate = value.trim();
    return candidate === '*' || candidate === etag || candidate === `W/${etag}`;
  });
}

// JPEG marker headers carry dimensions without decoding pixels or loading a codec.
function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xda || marker === 0xd9) return null;
    const high = bytes[offset], low = bytes[offset + 1];
    if (high === undefined || low === undefined) return null;
    const length = high * 256 + low;
    if (length < 2 || offset + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      const h1 = bytes[offset + 3], h2 = bytes[offset + 4], w1 = bytes[offset + 5], w2 = bytes[offset + 6];
      if (length < 8 || h1 === undefined || h2 === undefined || w1 === undefined || w2 === undefined) return null;
      return { width: w1 * 256 + w2, height: h1 * 256 + h2 };
    }
    offset += length;
  }
  return null;
}

export async function handleGallery(request: Request, pathname: string, env: GalleryEnv,
  baseHeaders: Readonly<Record<string, string>>): Promise<Response> {
  const headers = { ...baseHeaders, 'Cache-Control': 'no-cache', 'Content-Type': 'application/json' };
  const reply = (value: unknown, status = 200): Response => new Response(request.method === 'HEAD' ? null : `${JSON.stringify(value)}\n`, { status, headers });
  const error = (status: number, sentence: string): Response => reply({ error: sentence }, status);
  const missing = (): Response => error(404, 'The gallery piece was not found.');
  const deleted = (): Response => error(410, 'The gallery piece was unpublished.');
  const method = (): Response => error(405, 'This gallery method is not supported.');
  const [, , , id, resource, asset, extra] = pathname.split('/');
  if (pathname !== '/api/gallery' && (id === undefined || !isGalleryId(id) || extra !== undefined ||
    (resource === 'assets' ? !isAssetId(asset ?? '') : asset !== undefined) ||
    (resource !== undefined && !['assets', 'poster', 'publish'].includes(resource)))) return error(400, 'The gallery path is invalid.');
  const bucket = env.PROJECTS;
  const publicJson = async (value: unknown): Promise<Response> => {
    const bytes = encoder.encode(`${JSON.stringify(value)}\n`);
    const etag = `"${await digest(bytes.buffer)}"`;
    const notModified = matchesETag(request.headers.get('If-None-Match'), etag);
    return new Response(notModified ? null : bytes, { status: notModified ? 304 : 200, headers: { ...headers, ETag: etag } });
  };
  try {
    if (pathname === '/api/gallery') {
      if (request.method === 'GET') {
        const pieces: z.infer<typeof galleryListItemSchema>[] = [];
        let examined = 0, cursor: string | undefined;
        // Limit both entries and pages: short or empty pages cannot turn an
        // anonymous read into an unbounded walk. Deleted entries use the same
        // fixed budget, so a deletion backlog can yield fewer than 60 pieces.
        for (let pages = 0; pages < LIST_SCAN_LIMIT && examined < LIST_SCAN_LIMIT && pieces.length < LIST_SIZE; pages++) {
          const page = await bucket.list({ prefix: 'gallery/index/', limit: Math.min(LIST_SIZE - pieces.length, LIST_SCAN_LIMIT - examined),
            ...(cursor === undefined ? {} : { cursor }) });
          for (const { key } of page.objects) {
            if (examined >= LIST_SCAN_LIMIT || pieces.length >= LIST_SIZE) break;
            examined++;
            const raw = await jsonObject(bucket, key);
            if (raw === null) continue;
            const entry = galleryListItemSchema.parse(raw);
            if (key !== indexKey(entry.id, entry.publishedAt)) throw new Error('The gallery index is invalid.');
            if (await bucket.head(deletedKey(entry.id)) === null) pieces.push(entry);
          }
          if (!page.truncated || pieces.length >= LIST_SIZE || examined >= LIST_SCAN_LIMIT) break;
          if (!page.cursor || page.cursor === cursor) throw new Error('Gallery pagination failed.');
          cursor = page.cursor;
        }
        return await publicJson({ pieces });
      }
      if (request.method !== 'POST') return method();
      if ((request.headers.get('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/json') return error(400, 'The gallery draft must be JSON.');
      const bytes = await readBody(request, GALLERY_LIMITS.draft);
      if (bytes === null) return error(413, 'The gallery draft is too large.');
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder().decode(bytes)); } catch { return error(400, 'The gallery draft is invalid.'); }
      const draft = galleryDraftSchema.safeParse(raw);
      if (!draft.success) return error(400, 'The gallery draft or its asset descriptors are invalid.');
      const newId = crypto.randomUUID();
      const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
      const tokenHash = await digest(encoder.encode(token).buffer);
      await bucket.put(`${piecePrefix(newId)}draft`, jsonBytes({ draft: draft.data, tokenHash }), { httpMetadata: { contentType: 'application/json' } });
      return reply({ id: newId, token }, 201);
    }
    if (id === undefined) return error(400, 'The gallery path is invalid.');
    const prefix = piecePrefix(id);
    const isDeleted = async (): Promise<boolean> => await bucket.head(deletedKey(id)) !== null;
    const afterWrite = async (publishedAt: string | null = null): Promise<boolean> => {
      if (!await isDeleted()) return false;
      await cleanup(bucket, id, publishedAt);
      return true;
    };
    if (request.method === 'GET') {
      if (resource === 'publish') return method();
      if (await isDeleted()) return missing();
      const raw = await jsonObject(bucket, `${prefix}manifest`);
      if (raw === null) return missing();
      const manifest = galleryManifestSchema.parse(raw);
      if (await bucket.head(indexKey(id, manifest.publishedAt)) === null) return missing();
      if (resource === undefined) {
        const response = await publicJson(manifest);
        return await isDeleted() ? missing() : response;
      }
      const descriptor = resource === 'poster' ? manifest.poster : manifest.assets.find((item) => item.id === asset);
      if (descriptor === undefined) return missing();
      const object = await bucket.get(`${prefix}${resource === 'poster' ? 'poster' : `assets/${asset}`}`);
      if (object === null) return missing();
      if (object.size !== descriptor.byteLength || await isDeleted()) { await object.body.cancel(); return missing(); }
      const byteHeaders = { ...headers, 'Content-Type': mediaType(descriptor), ETag: `"${descriptor.id}"`, 'X-Content-Type-Options': 'nosniff' };
      if (matchesETag(request.headers.get('If-None-Match'), byteHeaders.ETag)) {
        await object.body.cancel();
        return new Response(null, { status: 304, headers: byteHeaders });
      }
      return new Response(object.body, { headers: { ...byteHeaders, 'Content-Length': String(object.size) } });
    }
    if (!((request.method === 'DELETE' && resource === undefined) || (request.method === 'PUT' && (resource === 'assets' || resource === 'poster')) ||
      (request.method === 'POST' && resource === 'publish'))) return method();
    const authorization = /^Bearer ([^\s]+)$/.exec(request.headers.get('Authorization') ?? '')?.[1];
    if (authorization === undefined) return error(403, 'The gallery token is invalid.');
    const suppliedHash = await digest(encoder.encode(authorization).buffer);
    const tombstone = await jsonObject(bucket, deletedKey(id));
    const stored = await jsonObject(bucket, `${prefix}draft`);
    const current = stored === null ? null : storedDraftSchema.parse(stored);
    const secret = tombstone === null ? current : secretSchema.parse(tombstone);
    const adminHash = await digest(encoder.encode(env.GALLERY_ADMIN_KEY ?? '').buffer);
    const admin = equalDigest(suppliedHash, adminHash) && Boolean(env.GALLERY_ADMIN_KEY) && request.method === 'DELETE';
    const device = equalDigest(suppliedHash, secret?.tokenHash ?? '0'.repeat(64));
    if (!admin && !device) return error(403, 'The gallery token is invalid.');
    if (request.method === 'DELETE') {
      if (secret === null) return missing();
      await bucket.put(deletedKey(id), jsonBytes({ tokenHash: secret.tokenHash }), { httpMetadata: { contentType: 'application/json' } });
      await cleanup(bucket, id);
      return reply({ ok: true });
    }
    if (tombstone !== null) return deleted();
    if (current === null) return missing();
    if (resource === 'publish') {
      for (const descriptor of [...current.draft.assets, current.draft.poster]) {
        const key = `${prefix}${descriptor.kind === 'poster' ? 'poster' : `assets/${descriptor.id}`}`;
        const object = await bucket.get(key);
        if (object === null) return await isDeleted() ? deleted() : error(409, 'The gallery assets are missing or incomplete.');
        if (object.size !== descriptor.byteLength) { await object.body.cancel(); return error(409, 'The gallery assets are missing or incomplete.'); }
        const bytes = await readBody(new Response(object.body), descriptor.byteLength);
        if (bytes === null || bytes.byteLength !== descriptor.byteLength) return error(409, 'The gallery assets are missing or incomplete.');
        if (await digest(bytes) !== descriptor.id) return error(409, 'The gallery asset bytes do not match their id.');
      }
      const manifest: GalleryManifest = galleryManifestSchema.parse({ ...current.draft, version: 1, id, publishedAt: new Date().toISOString() });
      await bucket.put(`${prefix}manifest`, jsonBytes(manifest), { httpMetadata: { contentType: 'application/json' }, onlyIf: { etagDoesNotMatch: '*' } });
      if (await afterWrite()) return deleted();
      const raw = await jsonObject(bucket, `${prefix}manifest`);
      if (raw === null && await isDeleted()) return deleted();
      const saved = galleryManifestSchema.parse(raw);
      await bucket.put(indexKey(id, saved.publishedAt), jsonBytes({ id, publishedAt: saved.publishedAt, poster: `/api/gallery/${id}/poster`, size: saved.poster.size }), { httpMetadata: { contentType: 'application/json' } });
      // A concurrent DELETE may already have removed the manifest. Retain its
      // timestamp locally so this late writer can still erase its index entry.
      if (await afterWrite(saved.publishedAt)) return deleted();
      return reply(saved);
    }
    if (await bucket.head(`${prefix}manifest`) !== null) return error(409, 'The published gallery piece cannot be changed.');
    const descriptor = resource === 'poster' ? current.draft.poster : current.draft.assets.find((item) => item.id === asset);
    if (descriptor === undefined) return error(400, 'The gallery asset was not declared.');
    const type = (request.headers.get('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (type !== mediaType(descriptor)) return error(400, 'The gallery asset content type is invalid.');
    const bytes = await readBody(request, descriptor.byteLength);
    if (bytes === null) return error(413, 'The gallery asset is too large.');
    if (bytes.byteLength !== descriptor.byteLength) return error(400, 'The gallery asset length is invalid.');
    if (await digest(bytes) !== descriptor.id) return error(400, 'The gallery asset bytes do not match their id.');
    if (descriptor.kind === 'poster') {
      const size = jpegSize(new Uint8Array(bytes));
      if (size === null || size.width !== descriptor.size.width || size.height !== descriptor.size.height || Math.max(size.width, size.height) > 1280) return error(400, 'The gallery poster must be a JPEG no larger than 1280 pixels.');
    }
    await bucket.put(`${prefix}${resource === 'poster' ? 'poster' : `assets/${asset}`}`, bytes, { httpMetadata: { contentType: type } });
    if (await afterWrite()) return deleted();
    return reply({ ok: true });
  } catch {
    return error(502, 'The gallery store is unavailable.');
  }
}
