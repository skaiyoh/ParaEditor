// The app owns service composition and reads the deployed configuration once.
import { z } from '../core/zod.ts';
import { createAnalysisService } from '../analysis/service.ts';
import { openModelLoader, webLocks } from '../analysis/models.ts';
import { createComposedAnalysisService } from '../analysis/composed.ts';
import { decodePlate, encodeMaster } from '../analysis/remote.ts';
import { injectAnalysisService } from '../session/driver.ts';

export function composeAnalysis(win: Window): void {
  const gpu = win.fetch('/build.json', { cache: 'no-store', signal: AbortSignal.timeout(5_000) })
    .then(async (response) => {
      if (!response.ok) return '';
      const config = z.object({ gpu: z.string().default('') }).parse(await response.json());
      if (config.gpu === '') return '';
      const url = new URL(config.gpu, win.location.origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.hostname.includes('*')) return '';
      return url.href.replace(/\/$/, '');
    }).catch(() => '');
  injectAnalysisService(({ clock, diag, threads, lock, changed, waiting }) => {
    const local = createAnalysisService({
      clock, diag, threads, lock, ortBase: NOISY_ORT_DIR,
      spawn: () => new Worker(NOISY_WORKER_URLS.sequence, { type: 'module', name: 'sequence' }),
      spawnDecoder: () => new Worker(NOISY_WORKER_URLS.decode, { type: 'module', name: 'decode' }),
      spawnFaceTracker: () => new Worker(NOISY_WORKER_URLS.face, { type: 'module', name: 'face' }),
      loader: openModelLoader({ lock, origin: win.location.origin, caches, fetch: (url, init) => win.fetch(url, init), subtle: crypto.subtle, locks: webLocks(navigator.locks), clock }),
    });
    return createComposedAnalysisService({ local, gpu, encoderModel: lock.ops.encode.model, fetch: win.fetch.bind(win), encode: encodeMaster, decode: decodePlate, changed, waiting });
  });
}
