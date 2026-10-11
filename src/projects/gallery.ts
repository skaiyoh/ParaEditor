import {
  galleryAckSchema, galleryAssetSchema, galleryCreatedSchema, galleryDraftSchema,
  galleryIdSchema, galleryListSchema, galleryManifestSchema, galleryPosterSchema,
  type GalleryAsset, type GalleryCreated, type GalleryDraft, type GalleryId,
  type GalleryListItem, type GalleryManifest, type GalleryPoster,
} from '../core/gallery.ts';
import { isAssetId, type AssetId } from '../core/ids.ts';
import { z } from '../core/zod.ts';

export type GalleryError = {
  readonly kind: 'http' | 'network' | 'aborted' | 'invalid';
  readonly message: string;
  readonly status: number | null;
};
export type GalleryResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: GalleryError };
type Options = { readonly signal?: AbortSignal };
type PieceOptions = Options & { readonly id: GalleryId };
type AuthorizedOptions = PieceOptions & { readonly token: string };
type Bytes = Blob | ArrayBuffer | Uint8Array;
type Ack = z.infer<typeof galleryAckSchema>;
const tokenSchema = z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/);
const serverErrorSchema = z.object({ error: z.string().min(1).max(1000).regex(/^[^\r\n]+\.$/) });
const fail = (kind: GalleryError['kind'], message: string, status: number | null = null): GalleryResult<never> => ({ ok: false, error: { kind, message, status } });
const invalid = () => fail('invalid', 'The gallery request is invalid.');
const base = (id: GalleryId): string => `/api/gallery/${id}`;
const authorized = (options: AuthorizedOptions): boolean => galleryIdSchema.safeParse(options.id).success && tokenSchema.safeParse(options.token).success;
const authHeaders = (token: string, contentType?: string): Headers => {
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  if (contentType !== undefined) headers.set('Content-Type', contentType);
  return headers;
};

async function request<T>(path: string, init: RequestInit, schema: z.ZodType<T>, options: Options): Promise<GalleryResult<T>> {
  const timeout = AbortSignal.timeout(15_000);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
  try {
    const response = await fetch(path, { ...init, signal, cache: 'no-store' });
    if (!response.ok) {
      let message = `The gallery request failed (HTTP ${response.status}).`;
      try {
        const parsed = serverErrorSchema.safeParse(await response.json());
        if (parsed.success) message = parsed.data.error;
      } catch { /* Keep the HTTP status even when the error body is not JSON. */ }
      return fail('http', message, response.status);
    }
    let json: unknown;
    try { json = await response.json(); }
    catch (error) {
      if (signal.aborted) throw error;
      return fail('invalid', 'The gallery returned an invalid response.', response.status);
    }
    const parsed = schema.safeParse(json);
    return parsed.success ? { ok: true, value: parsed.data } : fail('invalid', 'The gallery returned an invalid response.', response.status);
  } catch {
    if (options.signal?.aborted) return fail('aborted', 'The gallery request was cancelled.');
    if (timeout.aborted) return fail('network', 'The gallery request timed out. Please try again.');
    return fail('network', 'The gallery could not be reached. Check your connection and try again.');
  }
}

/** Snapshot validation happens before the first network write. */
export async function createDraft(options: Options & { readonly draft: GalleryDraft }): Promise<GalleryResult<GalleryCreated>> {
  try {
    const parsed = galleryDraftSchema.safeParse(options.draft);
    if (!parsed.success) return invalid();
    return request('/api/gallery', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed.data) }, galleryCreatedSchema, options);
  } catch { return invalid(); }
}

function uploadBody(bytes: Bytes, expected: number): Blob | null {
  const body = bytes instanceof Blob ? bytes : new Blob([bytes instanceof Uint8Array ? new Uint8Array(bytes) : bytes]);
  return body.size === expected ? body : null;
}
export async function uploadAsset(options: AuthorizedOptions & { readonly asset: GalleryAsset; readonly bytes: Bytes }): Promise<GalleryResult<Ack>> {
  try {
    if (!authorized(options)) return invalid();
    const parsed = galleryAssetSchema.safeParse(options.asset);
    if (!parsed.success) return invalid();
    const body = uploadBody(options.bytes, parsed.data.byteLength);
    if (body === null) return invalid();
    const type = parsed.data.kind === 'source' ? parsed.data.mediaType : 'application/octet-stream';
    return request(`${base(options.id)}/assets/${parsed.data.id}`, { method: 'PUT', headers: authHeaders(options.token, type), body }, galleryAckSchema, options);
  } catch { return invalid(); }
}
export async function uploadPoster(options: AuthorizedOptions & { readonly poster: GalleryPoster; readonly bytes: Bytes }): Promise<GalleryResult<Ack>> {
  try {
    if (!authorized(options)) return invalid();
    const parsed = galleryPosterSchema.safeParse(options.poster);
    if (!parsed.success) return invalid();
    const body = uploadBody(options.bytes, parsed.data.byteLength);
    if (body === null) return invalid();
    return request(`${base(options.id)}/poster`, { method: 'PUT', headers: authHeaders(options.token, 'image/jpeg'), body }, galleryAckSchema, options);
  } catch { return invalid(); }
}
export async function publishDraft(options: AuthorizedOptions): Promise<GalleryResult<GalleryManifest>> {
  if (!authorized(options)) return invalid();
  return request(`${base(options.id)}/publish`, { method: 'POST', headers: authHeaders(options.token) },
    galleryManifestSchema.refine((value) => value.id === options.id), options);
}
export async function list(options: Options = {}): Promise<GalleryResult<readonly GalleryListItem[]>> {
  const result = await request('/api/gallery', {}, galleryListSchema, options);
  return result.ok ? { ok: true, value: result.value.pieces } : result;
}
export async function manifest(options: PieceOptions): Promise<GalleryResult<GalleryManifest>> {
  if (!galleryIdSchema.safeParse(options.id).success) return invalid();
  return request(base(options.id), {}, galleryManifestSchema.refine((value) => value.id === options.id), options);
}
/** Relative, same-origin URL; callers own fetching and decoding asset bytes. */
export function assetUrl(options: { readonly id: GalleryId; readonly asset: AssetId }): GalleryResult<string> {
  if (!galleryIdSchema.safeParse(options.id).success || typeof options.asset !== 'string' || !isAssetId(options.asset)) return invalid();
  return { ok: true, value: `${base(options.id)}/assets/${options.asset}` };
}
/** The token can be the publishing device token or an admin key. */
export async function unpublish(options: AuthorizedOptions): Promise<GalleryResult<Ack>> {
  if (!authorized(options)) return invalid();
  return request(base(options.id), { method: 'DELETE', headers: authHeaders(options.token) }, galleryAckSchema, options);
}
