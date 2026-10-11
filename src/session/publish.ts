import { GALLERY_LIMITS, galleryCompositionAssetSchema, galleryCompositionDraftSchema, galleryRemixDraftSchema, isGalleryId, type GalleryCompositionAsset, type GalleryCreated, type GalleryId } from '../core/gallery.ts';
import { serializeDocument } from '../projects/serialize.ts';
import { collectCompositionAssets } from '../core/asset-refs.ts';
import { publicationPlateNeeded } from '../core/derive.ts';
import { sameValue } from '../core/equal.ts';
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
  readonly phase: 'preparing' | 'snapshot' | 'creating' | 'uploading' | 'publishing' | 'published';
  readonly completed: number;
  readonly total: number;
  readonly sentence: string;
};
export type PublishResult = { readonly kind: 'published'; readonly id: GalleryId; readonly url: string;
  readonly device: 'persistent' | 'session'; readonly sentence: string } | { readonly kind: 'failed'; readonly sentence: string };
export type UnpublishResult = { readonly kind: 'unpublished'; readonly id: GalleryId } | { readonly kind: 'failed'; readonly sentence: string };
export type PublishInput = {
  readonly document: SceneDocument | null;
  readonly products: Pick<Products, 'assets' | 'masks' | 'depths' | 'plates'>;
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

export function createPublishSession({ read, prepareBackground, renderStill, encodePoster = encodeGalleryPoster, tokens = galleryTokens, onReadinessChanged }: {
  readonly read: () => PublishInput;
  readonly prepareBackground: (signal: AbortSignal) => Promise<void>;
  /** Must capture pixels synchronously using this document, never the displayed preview. */
  readonly renderStill: (document: SceneDocument) => Promise<Blob>;
  readonly encodePoster?: (still: Promise<Blob>) => Promise<Poster>;
  readonly tokens?: GalleryTokenStore;
  readonly onReadinessChanged?: () => void;
}) {
  let publishing = false, capturePending = false;
  const needsBackground = ({ document, products }: PublishInput): boolean => document !== null && document.objects.length > 0 &&
    (publicationPlateNeeded(document, products.assets) || document.analysis.plate === null || !products.plates.has(document.analysis.plate.image.asset));
  function readiness(input: PublishInput, ownPublication = false): PublishReadiness {
    const unavailable = (reason: Extract<PublishReadiness, { kind: 'unavailable' }>['reason'], sentence: string): PublishReadiness => ({ kind: 'unavailable', reason, sentence });
    const doc = input.document;
    if (doc === null || doc.frame.source === null || !input.products.assets.has(doc.frame.source.asset)) return unavailable('no-photo', 'Open a photo before publishing.');
    if (input.gesture) return unavailable('gesture', 'Finish the current adjustment before publishing.');
    if (input.exporting) return unavailable('export', 'Wait for the export to finish before publishing.');
    if ((!ownPublication && publishing) || capturePending) return unavailable('publishing', 'Wait for the current publication to finish.');
    if (doc.analysis.depth === null || !input.products.depths.has(doc.analysis.depth.map.asset)) return unavailable('depth', 'Depth is still preparing. Publish will be available when it is ready.');
    const plate = doc.analysis.plate;
    if (doc.objects.length === 0 && plate !== null) {
      return unavailable('plate', 'This photo retains a background plate from an earlier subject. Its saved plate cannot be omitted from a published piece.');
    }
    if (doc.objects.some((object) => !input.products.masks.has(object.produced.mask.asset))) return unavailable('masks', 'The subject masks are not ready to publish.');
    // An obsolete repair is replaced by preparation; its old assets need not be resident.
    const inventory = collectCompositionAssets([{ kind: 'document', document: needsBackground(input)
      ? { ...doc, analysis: { ...doc.analysis, plate: null } } : doc }]);
    if (!inventory.ok || [...inventory.value.keys()].some((asset) => !input.products.assets.has(asset))) {
      return unavailable('masks', 'The saved composition assets are not ready to publish.');
    }
    return { kind: 'ready' };
  }
  function unwrap<T>(result: client.GalleryResult<T>): T {
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }
  async function publish({ onProgress, signal }: { readonly onProgress?: (progress: PublishProgress) => void; readonly signal?: AbortSignal } = {}): Promise<PublishResult> {
    let input = read();
    const state = readiness(input);
    if (state.kind === 'unavailable') return { kind: 'failed', sentence: state.sentence };
    publishing = true;
    let created: GalleryCreated | null = null, published = false;
    const progress = (phase: PublishProgress['phase'], completed: number, total: number, sentence: string): void => {
      try { onProgress?.({ phase, completed, total, sentence }); } catch { /* Observers cannot change publication. */ }
    };
    try {
      signal?.throwIfAborted();
      if (input.document === null || input.document.frame.source === null) throw new Error('Open a photo before publishing.');
      if (needsBackground(input)) {
        const before = structuredClone(input.document);
        const preparationSignal = signal ?? new AbortController().signal;
        progress('preparing', 0, 1, 'Preparing the background.');
        preparationSignal.throwIfAborted();
        try { await untilAborted(prepareBackground(preparationSignal), preparationSignal); }
        catch { throw new Error('The background could not be prepared. Please try publishing again.'); }
        signal?.throwIfAborted();
        input = read();
        const ready = readiness(input, true), current = input.document;
        if (ready.kind === 'unavailable') throw new Error(ready.sentence);
        if (current === null || current.frame.source === null || !sameValue(before,
          { ...current, updatedAt: before.updatedAt, analysis: { ...current.analysis, plate: before.analysis.plate } })) {
          throw new Error('The photo changed while preparing the background. Please publish again.');
        }
        if (needsBackground(input)) throw new Error('The background could not be prepared. Please try publishing again.');
      }
      if (input.document === null || input.document.frame.source === null) throw new Error('Open a photo before publishing.');
      // Freeze the complete encoded closure before any await or observer can edit/import.
      const document = structuredClone(input.document), ref = input.document.frame.source;
      const mediaType = ref.mediaType || 'application/octet-stream';
      const normalized = { ...document, frame: { ...document.frame, source: { ...ref, mediaType },
        original: { ...document.frame.original, mediaType } } };
      const inventory = collectCompositionAssets([{ kind: 'document', document: normalized }]);
      if (!inventory.ok) throw new Error(inventory.error.detail);
      let byteLength = 0;
      for (const asset of inventory.value.keys()) {
        const bytes = input.products.assets.get(asset);
        if (bytes === undefined) throw new Error('A saved composition asset is unavailable.');
        byteLength += bytes.byteLength;
      }
      const serialized = serializeDocument(normalized);
      const documentBytes = new TextEncoder().encode(JSON.stringify(serialized)).byteLength;
      if (inventory.value.size > (normalized.version === 6 ? GALLERY_LIMITS.remixAssets : GALLERY_LIMITS.assets) || documentBytes > GALLERY_LIMITS.document || byteLength + documentBytes + GALLERY_LIMITS.poster > GALLERY_LIMITS.piece) {
        throw new Error('This photo cannot fit the gallery snapshot requirements.');
      }
      const uploads: { asset: GalleryCompositionAsset; bytes: Blob }[] = [];
      for (const [id, refs] of inventory.value) {
        const bytes = input.products.assets.get(id);
        if (bytes === undefined) throw new Error('A saved composition asset is unavailable.');
        const original = refs.find((value) => value.kind === 'original'), image = refs.find((value) => value.kind === 'png'), raster = refs.find((value) => value.kind === 'raster');
        const asset = galleryCompositionAssetSchema.parse(original !== undefined ? { kind: 'source', id, mediaType, size: normalized.frame.original.size, byteLength: bytes.byteLength }
          : image !== undefined ? { kind: 'png', id, mediaType: 'image/png', size: image.size, byteLength: bytes.byteLength }
          : raster !== undefined ? { kind: 'raster', id, format: raster.format, size: raster.size, byteLength: bytes.byteLength } : null);
        const upload = { asset, bytes: new Blob([bytes]) };
        if (asset.kind === 'source') uploads.unshift(upload); else uploads.push(upload);
      }
      const still = renderStill(normalized);
      let posterPromise: Promise<Poster>;
      try { posterPromise = encodePoster(still); }
      catch (error) { posterPromise = Promise.reject(error); }
      // Native capture/encoding cannot abort. Retain one slot until both settle,
      // even when cancellation returns before their pixels are released.
      capturePending = true;
      void Promise.allSettled([still, posterPromise]).then(() => {
        capturePending = false;
        try { onReadinessChanged?.(); } catch { /* Observers cannot retain or restart a capture. */ }
      });
      progress('snapshot', 0, uploads.length + 1, 'Preparing the published still.');
      const poster = await untilAborted(posterPromise, signal);
      signal?.throwIfAborted();
      const posterId = await productAsset(new Uint8Array(await poster.blob.arrayBuffer()));
      const parsed = (normalized.version === 6 ? galleryRemixDraftSchema : galleryCompositionDraftSchema).safeParse({ version: normalized.version === 6 ? 3 : 2, document: serialized, assets: uploads.map(({ asset }) => asset),
        poster: { kind: 'poster', id: posterId, mediaType: poster.blob.type, size: poster.size, byteLength: poster.blob.size } });
      if (!parsed.success) throw new Error('This project could not be prepared for the gallery. Save it and try again.');
      const draft = parsed.data;
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
    } finally {
      publishing = false;
      // A cancelled native capture still owns the slot; its drain notifies readiness.
      if (!capturePending) {
        try { onReadinessChanged?.(); } catch { /* Observers cannot change publication. */ }
      }
    }
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
