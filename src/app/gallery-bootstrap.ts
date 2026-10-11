import { createViewer, type ViewerStatus, type ViewerFailure, type ViewerPiece } from '../session/viewer.ts';
import { isGalleryId, type GalleryId, type GalleryListItem, type GalleryManifest, type GalleryAsset } from '../core/gallery.ts';
import * as client from '../projects/gallery.ts';
import type { AssetId } from '../core/ids.ts';
import type { Plane, Rgb8 } from '../core/raster.ts';
import { mountGalleryPage, type GalleryLoader } from './gallery-page.ts';

export type GalleryRoute = { readonly kind: 'list' } | { readonly kind: 'piece'; readonly id: GalleryId };
export type GalleryStatus = ViewerStatus | { readonly kind: 'unavailable'; readonly message: string }
  | { readonly kind: 'listed'; readonly pieces: readonly GalleryListItem[] }
  | { readonly kind: 'load-failed'; readonly failure: ViewerFailure | client.GalleryError };
export type GalleryStatusStore = {
  read(): GalleryStatus;
  set(value: GalleryStatus): void;
  subscribe(listener: (value: GalleryStatus) => void): () => void;
};
export type GalleryMountContext = {
  readonly root: HTMLElement;
  readonly route: GalleryRoute | null;
  readonly load: GalleryLoader;
  readonly list: typeof client.list;
  readonly createViewer: typeof createViewer;
  readonly status: GalleryStatusStore;
};

export function parseGalleryRoute(path: string): GalleryRoute | null {
  if (path === '/gallery' || path === '/gallery/') return { kind: 'list' };
  const id = /^\/gallery\/([^/]+)$/.exec(path)?.[1]?.toLowerCase();
  return id === undefined || !isGalleryId(id) ? null : { kind: 'piece', id };
}

export class GalleryLoadError extends Error {
  readonly failure: ViewerFailure | client.GalleryError;
  constructor(failure: ViewerFailure | client.GalleryError) { super(failure.message); this.failure = failure; }
}
function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new GalleryLoadError({ kind: 'aborted', status: null, message: 'Opening the piece was cancelled.' });
}

async function readAsset(id: GalleryId, asset: GalleryAsset, signal: AbortSignal): Promise<ArrayBuffer> {
  const url = client.assetUrl({ id, asset: asset.id });
  if (!url.ok) throw new GalleryLoadError(url.error);
  const timeout = AbortSignal.timeout(15_000);
  try {
    const response = await fetch(url.value, { signal: AbortSignal.any([signal, timeout]) });
    if (!response.ok) throw new GalleryLoadError({ kind: 'missing-asset', asset: asset.id, message: 'A published asset is unavailable.' });
    const bytes = await response.arrayBuffer();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const hash = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    if (bytes.byteLength !== asset.byteLength || hash !== asset.id) {
      throw new GalleryLoadError({ kind: 'invalid-asset', asset: asset.id, message: 'A published asset does not match its saved bytes.' });
    }
    return bytes;
  } catch (error) {
    if (error instanceof GalleryLoadError) throw error;
    throw new GalleryLoadError({ kind: signal.aborted ? 'aborted' : 'network', status: null,
      message: signal.aborted ? 'Opening the piece was cancelled.' : timeout.aborted ? 'The published asset request timed out.' : 'A published asset could not be reached.' });
  }
}

/** Bytes stay outside the document. Only saved planes are decoded; inference is never loaded. */
async function loadPiece(manifest: GalleryManifest, signal: AbortSignal): Promise<ViewerPiece> {
  const planes = new Map<AssetId, Plane<'u8'> | Plane<'f32'> | Rgb8>();
  let source: Blob | null = null;
  for (const asset of manifest.assets) {
    checkSignal(signal);
    const bytes = await readAsset(manifest.id, asset, signal);
    switch (asset.kind) {
      case 'source': source = new Blob([bytes], { type: asset.mediaType }); break;
      case 'mask': planes.set(asset.id, { format: 'u8', size: asset.size, data: new Uint8Array(bytes) }); break;
      case 'plate': planes.set(asset.id, { size: asset.size, data: new Uint8Array(bytes) }); break;
      case 'depth': {
        const data = new Float32Array(bytes.byteLength / 4), view = new DataView(bytes);
        for (let i = 0; i < data.length; i++) data[i] = view.getFloat32(i * 4, true);
        planes.set(asset.id, { format: 'f32', size: asset.size, data }); break;
      }
      default: { const exhaustive: never = asset; throw new Error(`Unknown gallery asset ${exhaustive}.`); }
    }
  }
  checkSignal(signal);
  if (source === null) throw new GalleryLoadError({ kind: 'missing-asset', asset: null, message: 'The published photo is unavailable.' });
  return { document: manifest.document, source, planes };
}

export const loadGallery: GalleryLoader = async (path, signal) => {
  const route = parseGalleryRoute(path);
  if (route?.kind !== 'piece') return null;
  const result = await client.manifest({ id: route.id, signal });
  if (!result.ok) {
    if (result.error.status === 404 || result.error.status === 410) return null;
    throw new GalleryLoadError(result.error);
  }
  const manifest = result.value;
  return { title: manifest.document.title, posterUrl: `/api/gallery/${manifest.id}/poster`, loadPiece: (signal) => loadPiece(manifest, signal) };
};
export const listGallery = client.list;

/** The UI supplies mount at integration; routing, viewer creation and status have one composition owner. */
export function bootstrapGallery<T extends { dispose(): void } = ReturnType<typeof mountGalleryPage>>({ root, load = loadGallery, mount, path = window.location.pathname }: {
  readonly root: HTMLElement;
  readonly load?: GalleryLoader;
  readonly mount: (context: GalleryMountContext) => T;
  readonly path?: string;
}) {
  const route = parseGalleryRoute(path);
  let current: GalleryStatus = { kind: 'idle' };
  const listeners = new Set<(value: GalleryStatus) => void>();
  const status: GalleryStatusStore = {
    read: () => current,
    set(value) { current = value; for (const listener of listeners) listener(value); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const page = mount({ root, route, load, list: listGallery, createViewer, status });
  return { route, status, page, dispose(): void { page.dispose(); listeners.clear(); } };
}
