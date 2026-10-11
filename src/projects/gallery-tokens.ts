import { isGalleryId, type GalleryCreated, type GalleryId } from '../core/gallery.ts';

const PREFIX = 'noisy.gallery.token.';
const validToken = (value: string | null): value is string => value !== null && /^[A-Za-z0-9_-]{43}$/.test(value);

/** Storage is lazy and optional; this page retains authority when storage is denied. */
export function createGalleryTokenStore(storage: () => Storage = () => globalThis.localStorage) {
  const tokens = new Map<GalleryId, string>();
  // A blocked removal must not expose a stale key again on this page.
  const removed = new Set<GalleryId>();
  return {
    tokenFor(id: GalleryId): string | null {
      if (removed.has(id)) return null;
      try { const value = storage().getItem(PREFIX + id); if (validToken(value)) return value; }
      catch { /* The in-memory key is still available. */ }
      return tokens.get(id) ?? null;
    },
    remember({ id, token }: GalleryCreated): boolean {
      removed.delete(id); tokens.set(id, token);
      try { const local = storage(); local.setItem(PREFIX + id, token); return local.getItem(PREFIX + id) === token; }
      catch { return false; }
    },
    forget(id: GalleryId): void {
      tokens.delete(id); removed.add(id);
      try { storage().removeItem(PREFIX + id); }
      catch { /* A deleted key confers no server authority. */ }
    },
    publishedHere(): readonly GalleryId[] {
      const ids = new Set(tokens.keys());
      try {
        const local = storage();
        for (let index = 0; index < local.length; index++) {
          const key = local.key(index);
          if (key === null || !key.startsWith(PREFIX)) continue;
          const id = key.slice(PREFIX.length);
          if (isGalleryId(id) && validToken(local.getItem(key))) ids.add(id);
        }
      } catch { /* Navigation loses only keys that could not be persisted. */ }
      return [...ids].filter((id) => !removed.has(id)).sort();
    },
  };
}

export type GalleryTokenStore = ReturnType<typeof createGalleryTokenStore>;
export const galleryTokens = createGalleryTokenStore();
