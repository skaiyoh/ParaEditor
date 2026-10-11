import type { Viewer, ViewerPiece, ViewerFailure } from '../session/viewer.ts';
import type { GalleryMountContext } from './gallery-bootstrap.ts';
import { GalleryLoadError } from './gallery-bootstrap.ts';
import type { GalleryDevice } from '../projects/gallery-device.ts';

export type GalleryContent = {
  readonly title: string;
  readonly posterUrl: string;
  /** Separate from metadata so the poster remains available when a scene asset fails. */
  loadPiece(signal: AbortSignal): Promise<ViewerPiece>;
};
export type GalleryLoader = (path: string, signal: AbortSignal) => Promise<GalleryContent | null>;

declare global {
  interface Window {
    __noisyGalleryFixture?: GalleryLoader;
    __noisyGallery?: ReturnType<typeof mountGalleryPage> & GalleryDevice & { remount(): void };
  }
}

/** Replace the loader at integration; the designed UI can instead consume createViewer directly. */
export function mountGalleryPage({ root, load, list, route, createViewer, status: sharedStatus }: GalleryMountContext) {
  const controller = new AbortController();
  let disposed = false, viewer: Viewer | null = null, unsubscribe = (): void => {};
  const canvas = document.createElement('canvas'), poster = document.createElement('img');
  const tilt = document.createElement('button'), status = document.createElement('p');
  root.dataset['testid'] = 'gallery';
  root.style.cssText = 'position:fixed;inset:0;background:#1c1c1c;color:#eee9df;font:14px system-ui,sans-serif;';
  for (const media of [canvas, poster]) media.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;';
  canvas.dataset['testid'] = 'gallery-canvas'; canvas.style.visibility = 'hidden';
  canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', 'Live published piece');
  poster.dataset['testid'] = 'gallery-poster'; poster.hidden = true;
  tilt.dataset['testid'] = 'gallery-tilt'; tilt.type = 'button'; tilt.textContent = 'Tilt to look'; tilt.hidden = true;
  tilt.style.cssText = 'position:absolute;bottom:max(24px,env(safe-area-inset-bottom));left:24px;min-height:44px;padding:10px 18px;border:1px solid #eee9df;border-radius:4px;background:#1c1c1c;color:#eee9df;font:inherit;cursor:pointer;';
  status.dataset['testid'] = 'gallery-status'; status.setAttribute('role', 'status');
  status.style.cssText = 'position:absolute;left:24px;right:24px;top:max(12px,env(safe-area-inset-top));width:fit-content;max-width:calc(100% - 48px);padding:8px 12px;background:#1c1c1c;';
  status.textContent = 'Opening piece…';
  sharedStatus.set({ kind: 'loading' });
  root.append(poster, canvas, tilt, status);
  function fallback(text: string): void {
    canvas.hidden = true; poster.hidden = !poster.hasAttribute('src'); tilt.hidden = true;
    root.dataset['state'] = 'poster'; status.hidden = false; status.textContent = text;
  }
  function update(): void {
    if (disposed || viewer === null) return;
    const state = viewer.status(); root.dataset['state'] = state.kind; root.dataset['input'] = viewer.input();
    sharedStatus.set(state);
    if (state.kind === 'failed') {
      root.dataset['failure'] = state.failure.kind;
      fallback('The live piece is unavailable. Showing its poster.');
    } else if (state.kind === 'running') {
      canvas.hidden = false; canvas.style.visibility = 'visible'; poster.hidden = true; status.hidden = true;
    }
  }
  const requestTilt = async (): Promise<void> => {
    if (viewer === null) return;
    tilt.disabled = true;
    const permission = await viewer.requestTilt();
    if (disposed) return;
    tilt.disabled = false;
    if (permission === 'granted') tilt.hidden = true;
    else { status.hidden = false; status.textContent = permission === 'denied' ? 'Tilt permission was not granted. Motion is still playing.' : 'Tilt is unavailable on this device. Motion is still playing.'; }
  };
  tilt.addEventListener('click', requestTilt);
  const visible = (): void => { if (document.visibilityState === 'hidden') viewer?.stop(); else void viewer?.start(); };
  const hide = (event: PageTransitionEvent): void => { if (event.persisted) viewer?.stop(); else dispose(); };
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('pagehide', hide); window.addEventListener('pageshow', visible);
  const ready = (async () => {
    try {
      if (route?.kind === 'list') {
        const result = await list({ signal: controller.signal });
        if (disposed) return;
        if (!result.ok) throw new GalleryLoadError(result.error);
        sharedStatus.set({ kind: 'listed', pieces: result.value });
        root.dataset['state'] = 'listed'; status.textContent = result.value.length === 0 ? 'No published pieces yet.' : `${result.value.length} published pieces.`;
        return;
      }
      if (route === null) {
        const message = 'This piece is not available.';
        sharedStatus.set({ kind: 'unavailable', message }); fallback(message); return;
      }
      const content = await load(`/gallery/${route.id}`, controller.signal);
      if (disposed) return;
      if (content === null) { sharedStatus.set({ kind: 'unavailable', message: 'This piece is not available.' }); fallback('This piece is not available.'); return; }
      document.title = `${content.title} · ParaEditor`;
      poster.alt = content.title; canvas.setAttribute('aria-label', content.title);
      poster.src = content.posterUrl; poster.hidden = false;
      const piece = await content.loadPiece(controller.signal);
      if (disposed) return;
      viewer = createViewer({ canvas, piece }); unsubscribe = viewer.subscribe(update);
      tilt.hidden = !viewer.tiltNeedsPermission();
      if (document.visibilityState !== 'hidden') await viewer.start();
      update();
    } catch (error) {
      if (!disposed) {
        const failure = error instanceof GalleryLoadError ? error.failure
          : { kind: 'render-failure', message: error instanceof Error ? error.message : String(error) } satisfies ViewerFailure;
        sharedStatus.set({ kind: 'load-failed', failure }); root.dataset['failure'] = failure.kind;
        fallback(poster.hasAttribute('src') ? 'The live piece could not be opened. Showing its poster.' : failure.message);
      }
    }
  })();
  function dispose(): void {
    if (disposed) return;
    disposed = true; controller.abort(); unsubscribe(); viewer?.dispose();
    document.removeEventListener('visibilitychange', visible);
    window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', visible);
    tilt.removeEventListener('click', requestTilt);
    root.replaceChildren();
  }
  return { ready, viewer: (): Viewer | null => viewer, dispose };
}
