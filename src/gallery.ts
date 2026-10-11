import type { GalleryLoader } from './app/gallery-page.ts';
import { mountGalleryUi } from './ui/gallery.tsx';
import { bootstrapGallery, loadGallery } from './app/gallery-bootstrap.ts';
import { galleryTokens } from './projects/gallery-tokens.ts';
import { createGalleryDevice } from './projects/gallery-device.ts';
export { bootstrapGallery, parseGalleryRoute, loadGallery, listGallery } from './app/gallery-bootstrap.ts';
export type { GalleryMountContext, GalleryRoute, GalleryStatus } from './app/gallery-bootstrap.ts';
export const { list, publishedHere, unpublish } = createGalleryDevice(galleryTokens);

// Fixture loading is explicit and dev-only; ordinary piece URLs always read the API.
const load: GalleryLoader = NOISY_DEV && new URLSearchParams(location.search).get('fixture') === 'yes' && window.__noisyGalleryFixture !== undefined
  ? window.__noisyGalleryFixture : loadGallery;
function boot(): void {
  const root = document.getElementById('gallery-root');
  if (root === null) return;
  const app = bootstrapGallery({ root, load, mount: (ctx) => mountGalleryUi({ ...ctx, list, publishedHere, unpublish, editorUrl: '/' }) });
  if (NOISY_DEV) window.__noisyGallery = { ...app.page, list, publishedHere, unpublish, remount() { app.dispose(); boot(); } };
}
boot();
