import { isGalleryId } from '../core/gallery.ts';
import * as client from './gallery.ts';
import type { GalleryTokenStore } from './gallery-tokens.ts';

export type GalleryDevicePiece = {
  readonly id: string;
  readonly publishedAt: string;
  readonly posterUrl: string;
  readonly width: number;
  readonly height: number;
};
export type GalleryDeviceList = { readonly kind: 'listed'; readonly pieces: readonly GalleryDevicePiece[] }
  | { readonly kind: 'failed'; readonly sentence: string };
export type GalleryDeviceUnpublish = { readonly kind: 'unpublished' } | { readonly kind: 'failed'; readonly sentence: string };

/** Gallery composition supplies the same store used by the editor publisher. */
export function createGalleryDevice(tokens: GalleryTokenStore) {
  return {
    async list(signal: AbortSignal): Promise<GalleryDeviceList> {
      const result = await client.list({ signal });
      if (!result.ok) return { kind: 'failed', sentence: result.error.message };
      return { kind: 'listed', pieces: result.value.map((piece) => ({ id: piece.id, publishedAt: piece.publishedAt,
        posterUrl: piece.poster, width: piece.size.width, height: piece.size.height })) };
    },
    publishedHere: (): readonly string[] => tokens.publishedHere(),
    async unpublish(id: string): Promise<GalleryDeviceUnpublish> {
      if (!isGalleryId(id)) return { kind: 'failed', sentence: 'This gallery link is invalid.' };
      const token = tokens.tokenFor(id);
      if (token === null) return { kind: 'failed', sentence: 'This device does not have the key to unpublish this piece.' };
      const result = await client.unpublish({ id, token });
      if (!result.ok) return { kind: 'failed', sentence: result.error.message };
      tokens.forget(id); return { kind: 'unpublished' };
    },
  };
}

export type GalleryDevice = ReturnType<typeof createGalleryDevice>;
