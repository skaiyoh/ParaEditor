import { sortedMasks } from '../core/produce.ts';
import { GALLERY_LIMITS, galleryDraftSchema, isGalleryId, type GalleryAsset, type GalleryCreated, type GalleryId } from '../core/gallery.ts';
import type { SceneDocument } from '../core/types.ts';
import type { Size } from '../core/raster.ts';
import * as client from '../projects/gallery.ts';
import { galleryTokens, type GalleryTokenStore } from '../projects/gallery-tokens.ts';
import { productAsset, type Products } from './products.ts';

export type PublishReadiness = { readonly kind: 'ready' } | {
  readonly kind: 'unavailable';
  readonly reason: 'no-photo' | 'depth' | 'plate' | 'masks' | 'gesture' | 'export' | 'publishing';
  readonly sentence: string;
};
export type PublishProgress = {
  readonly phase: 'snapshot' | 'creating' | 'uploading' | 'publishing' | 'published';
  readonly completed: number;
  readonly total: number;
  readonly sentence: string;
};
export type PublishResult = { readonly kind: 'published'; readonly id: GalleryId; readonly url: string;
  readonly device: 'persistent' | 'session'; readonly sentence: string } | { readonly kind: 'failed'; readonly sentence: string };
export type UnpublishResult = { readonly kind: 'unpublished'; readonly id: GalleryId } | { readonly kind: 'failed'; readonly sentence: string };
export type PublishInput = {
  readonly document: SceneDocument | null;
  readonly source: File | null;
  readonly products: Pick<Products, 'masks' | 'depths' | 'plates'>;
  readonly gesture: boolean;
  readonly exporting: boolean;
};
type Poster = { readonly blob: Blob; readonly size: Size };

async function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  let abort = (): void => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('Publishing was cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

/** The input promise already owns committed frame-zero pixels, before encoding yields. */
export async function encodeGalleryPoster(still: Promise<Blob>): Promise<Poster> {
  const bitmap = await createImageBitmap(await still);
  try {
    const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
    const size = { width: Math.max(1, Math.round(bitmap.width * scale)), height: Math.max(1, Math.round(bitmap.height * scale)) };
    const canvas = new OffscreenCanvas(size.width, size.height), context = canvas.getContext('2d', { alpha: false });
    if (context === null) throw new Error('The gallery poster canvas is unavailable.');
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    for (const quality of [.85, .7, .5, .3]) {
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      if (blob.type === 'image/jpeg' && blob.size <= GALLERY_LIMITS.poster) return { blob, size };
    }
    throw new Error('The gallery poster could not fit within 2 MiB.');
  } finally { bitmap.close(); }
}

export function createPublishSession({ read, renderStill, encodePoster = encodeGalleryPoster, tokens = galleryTokens }: {
  readonly read: () => PublishInput;
  /** Must capture pixels synchronously using this document, never the displayed preview. */
  readonly renderStill: (document: SceneDocument) => Promise<Blob>;
  readonly encodePoster?: (still: Promise<Blob>) => Promise<Poster>;
  readonly tokens?: GalleryTokenStore;
}) {
  let publishing = false;
  function readiness(input: PublishInput): PublishReadiness {
    const unavailable = (reason: Extract<PublishReadiness, { kind: 'unavailable' }>['reason'], sentence: string): PublishReadiness => ({ kind: 'unavailable', reason, sentence });
    const doc = input.document;
    if (doc === null || input.source === null || doc.frame.source === null) return unavailable('no-photo', 'Open a photo before publishing.');
    if (input.gesture) return unavailable('gesture', 'Finish the current adjustment before publishing.');
    if (input.exporting) return unavailable('export', 'Wait for the export to finish before publishing.');
    if (publishing) return unavailable('publishing', 'This photo is already being published.');
    if (doc.analysis.depth === null || !input.products.depths.has(doc.analysis.depth.map.asset)) return unavailable('depth', 'Depth is still preparing. Publish will be available when it is ready.');
    const plate = doc.analysis.plate;
    if (doc.objects.length === 0 && plate !== null) {
      return unavailable('plate', 'This photo retains a background plate from an earlier subject. Its saved plate cannot be omitted from a published piece.');
    }
    if (doc.objects.length > 0 && (plate === null || !input.products.plates.has(plate.image.asset) || JSON.stringify(plate.forMasks) !== JSON.stringify(sortedMasks(doc)))) {
      return unavailable('plate', doc.motion.enabled || doc.objects.some((object) => object.hidden)
        ? 'The background plate is still preparing. Publish will be available when it is ready.'
        : 'The background plate is not ready. Turn Motion on to prepare it.');
    }
    if (doc.objects.some((object) => !input.products.masks.has(object.produced.mask.asset))) return unavailable('masks', 'The subject masks are not ready to publish.');
    return { kind: 'ready' };
  }
  function unwrap<T>(result: client.GalleryResult<T>): T {
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }
  async function publish({ onProgress, signal }: { readonly onProgress?: (progress: PublishProgress) => void; readonly signal?: AbortSignal } = {}): Promise<PublishResult> {
    const input = read(), state = readiness(input);
    if (state.kind === 'unavailable') return { kind: 'failed', sentence: state.sentence };
    publishing = true;
    let created: GalleryCreated | null = null, published = false;
    const progress = (phase: PublishProgress['phase'], completed: number, total: number, sentence: string): void => {
      try { onProgress?.({ phase, completed, total, sentence }); } catch { /* Observers cannot change publication. */ }
    };
    try {
      signal?.throwIfAborted();
      if (input.document === null || input.source === null || input.document.frame.source === null) throw new Error('Open a photo before publishing.');
      // Clone before any await or callback. Copy planes while this import still owns them.
      const document = structuredClone(input.document), source = input.source;
      const ref = input.document.frame.source;
      const mediaType = source.type || 'application/octet-stream';
      const normalized = { ...document, frame: { ...document.frame, source: { ...ref, mediaType },
        original: { ...document.frame.original, mediaType } } };
      const uploads: { asset: GalleryAsset; bytes: Blob | Uint8Array }[] = [];
      const sourceAsset = { kind: 'source', id: ref.asset, mediaType, size: document.frame.original.size, byteLength: source.size };
      // Parse the source MIME at the same boundary as the rest of the draft below.
      const seen = new Set([ref.asset]);
      for (const object of document.objects) {
        const ref = object.produced.mask;
        if (seen.has(ref.asset)) continue;
        const plane = input.products.masks.get(ref.asset);
        if (plane === undefined) throw new Error('A subject mask is unavailable.');
        const bytes = plane.data.slice(); seen.add(ref.asset);
        uploads.push({ asset: { kind: 'mask', id: ref.asset, format: 'u8', size: plane.size, byteLength: bytes.byteLength }, bytes });
      }
      const depth = document.analysis.depth, plate = document.analysis.plate;
      if (depth === null) throw new Error('Depth is still preparing.');
      const depthPlane = input.products.depths.get(depth.map.asset);
      if (depthPlane === undefined) throw new Error('Depth is still preparing.');
      const depthBytes = new Uint8Array(depthPlane.data.length * 4), view = new DataView(depthBytes.buffer);
      depthPlane.data.forEach((value, index) => view.setFloat32(index * 4, value, true));
      uploads.push({ asset: { kind: 'depth', id: depth.map.asset, format: 'f32', size: depthPlane.size, byteLength: depthBytes.byteLength }, bytes: depthBytes });
      if (plate !== null) {
        const plane = input.products.plates.get(plate.image.asset);
        if (plane === undefined) throw new Error('The background plate is still preparing.');
        const bytes = plane.data.slice();
        uploads.push({ asset: { kind: 'plate', id: plate.image.asset, format: 'rgb8', size: plane.size, byteLength: bytes.byteLength }, bytes });
      }
      const still = renderStill(normalized);
      // Observe both promises immediately, including if an injected encoder fails early.
      void still.catch(() => undefined);
      const posterPromise = encodePoster(still);
      progress('snapshot', 0, uploads.length + 2, 'Preparing the published still.');
      const poster = await untilAborted(posterPromise, signal);
      signal?.throwIfAborted();
      const posterId = await productAsset(new Uint8Array(await poster.blob.arrayBuffer()));
      const parsed = galleryDraftSchema.safeParse({ document: normalized, assets: [sourceAsset, ...uploads.map(({ asset }) => asset)],
        poster: { kind: 'poster', id: posterId, mediaType: poster.blob.type, size: poster.size, byteLength: poster.blob.size } });
      if (!parsed.success) throw new Error('This photo cannot fit the gallery snapshot requirements.');
      const draft = parsed.data, declaredSource = draft.assets.find((asset) => asset.kind === 'source');
      if (declaredSource === undefined) throw new Error('The original photo is unavailable.');
      uploads.unshift({ asset: declaredSource, bytes: source });
      const total = uploads.length + 1;
      signal?.throwIfAborted(); progress('creating', 0, total, 'Creating a private gallery draft.'); signal?.throwIfAborted();
      created = unwrap(await client.createDraft({ draft, ...(signal === undefined ? {} : { signal }) }));
      const persistent = tokens.remember(created);
      const options = { ...created, ...(signal === undefined ? {} : { signal }) };
      let completed = 0;
      for (const { asset, bytes } of uploads) {
        signal?.throwIfAborted(); unwrap(await client.uploadAsset({ ...options, asset, bytes }));
        progress('uploading', ++completed, total, `Uploading ${completed} of ${total} assets.`);
      }
      signal?.throwIfAborted(); unwrap(await client.uploadPoster({ ...options, poster: draft.poster, bytes: poster.blob }));
      progress('uploading', ++completed, total, `Uploading ${completed} of ${total} assets.`);
      signal?.throwIfAborted(); progress('publishing', completed, total, 'Publishing your piece.'); signal?.throwIfAborted();
      unwrap(await client.publishDraft(options)); signal?.throwIfAborted();
      published = true;
      const sentence = persistent ? 'Published. Anyone with the link can see this piece.'
        : 'Published. This device could not save its unpublish key. You can unpublish now, but cannot unpublish from this device after leaving this page.';
      progress('published', completed, total, sentence);
      return { kind: 'published', id: created.id, url: `/gallery/${created.id}`, device: persistent ? 'persistent' : 'session', sentence };
    } catch (error) {
      let sentence = signal?.aborted ? 'Publishing was cancelled.' : error instanceof Error ? error.message : 'The piece could not be published. Please try again.';
      if (created !== null && !published) {
        // Cancellation must not cancel cleanup; ambiguous publish responses may already be public.
        const cleanup = await client.unpublish(created);
        if (cleanup.ok) tokens.forget(created.id);
        else sentence += ' Cleanup could not be confirmed. Use Unpublish on this device to remove the piece.';
      }
      return { kind: 'failed', sentence };
    } finally { publishing = false; }
  }
  return {
    canPublish: (): PublishReadiness => readiness(read()), publish, publishedHere: tokens.publishedHere,
    async unpublish(id: string): Promise<UnpublishResult> {
      if (!isGalleryId(id)) return { kind: 'failed', sentence: 'This gallery link is invalid.' };
      const token = tokens.tokenFor(id);
      if (token === null) return { kind: 'failed', sentence: 'This device does not have the key to unpublish this piece.' };
      const result = await client.unpublish({ id, token });
      if (!result.ok) return { kind: 'failed', sentence: result.error.message };
      tokens.forget(id); return { kind: 'unpublished', id };
    },
  };
}
