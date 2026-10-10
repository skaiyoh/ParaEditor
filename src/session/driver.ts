import { bundledLock } from '../analysis/bundled-lock.ts';
import { openModelLoader, webLocks } from '../analysis/models.ts';
import { createAnalysisService, type AnalysisEvent, type Decoder, type FaceTracker, type HeavyStage } from '../analysis/service.ts';
import { holeMask, plateNeeded, reconcile } from '../core/derive.ts';
import type { Produce } from '../core/edits.ts';
import type { NonEmpty } from '../core/ids.ts';
import { sortedMasks } from '../core/produce.ts';
import type { Rgb8 } from '../core/raster.ts';
import type { SceneDocument } from '../core/types.ts';
import { createBrowserClock } from '../platform/clock.ts';
import { createDiagnostics } from '../platform/diagnostics.ts';
import { initialPolicy, nextWake, transition, type PolicyEvent, type Stage } from './policy.ts';
import { productAsset, type Products } from './products.ts';
import { windowPlateNeeded } from './window.ts';

export type AnalysisSnapshot = {
  readonly status: string;
  readonly modelsReady: boolean;
  readonly depth: boolean;
  readonly embeddings: boolean;
  readonly decoderReady: boolean;
  readonly plate: boolean;
  readonly alive: { readonly heavy: boolean; readonly decoder: boolean };
  readonly timings: Record<string, number>;
};
type Host = {
  readonly read: () => { readonly doc: SceneDocument; readonly masterPixels: ImageData } | null;
  readonly produce: (product: Produce) => void;
  readonly changed: () => void;
  readonly products: Products;
  readonly windowEnabled: () => boolean;
};
const reason = (error: unknown): string => error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error);

/** Same guide as the decoder dev page; the retained master itself is never transferred. */
async function makeGuide(master: ImageData): Promise<Rgb8> {
  const scale = 1024 / Math.max(master.width, master.height);
  const size = { width: Math.max(1, Math.round(master.width * scale)), height: Math.max(1, Math.round(master.height * scale)) };
  const bitmap = await createImageBitmap(master);
  try {
    const canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) throw new Error('The decoder guide could not be created.');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const rgba = context.getImageData(0, 0, size.width, size.height).data;
    const data = new Uint8Array(size.width * size.height * 3);
    for (let i = 0, j = 0; j < rgba.length; i += 3, j += 4) {
      data[i] = rgba[j] ?? 0; data[i + 1] = rgba[j + 1] ?? 0; data[i + 2] = rgba[j + 2] ?? 0;
    }
    return { size, data };
  } finally { bitmap.close(); }
}

export function createAnalysisDriver(host: Host) {
  const clock = createBrowserClock(window);
  const diag = createDiagnostics<AnalysisEvent>(clock);
  const threads = Math.max(2, Math.min(8, Math.floor(navigator.hardwareConcurrency || 2)));
  const lock = bundledLock();
  const service = lock.ok ? createAnalysisService({
    clock, diag, threads, lock: lock.value, ortBase: NOISY_ORT_DIR,
    spawn: () => new Worker(NOISY_WORKER_URLS.sequence, { type: 'module', name: 'sequence' }),
    spawnDecoder: () => new Worker(NOISY_WORKER_URLS.decode, { type: 'module', name: 'decode' }),
    spawnFaceTracker: () => new Worker(NOISY_WORKER_URLS.face, { type: 'module', name: 'face' }),
    loader: openModelLoader({ lock: lock.value, origin: window.location.origin, caches, fetch: (url, init) => window.fetch(url, init), subtle: crypto.subtle, locks: webLocks(navigator.locks), clock }),
  }) : null;
  let policy = initialPolicy();
  let status = 'Fetching models 0%';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let heavy: AbortController | null = null;
  let warming: AbortController | null = null;
  let decoder: Decoder | null = null;
  let guide: Rgb8 | null = null;
  let embeddings = false;
  let decoderReady = false;
  let tapFailure: string | null = null;
  let sequenceFailure: string | null = null;
  let timings: Record<string, number> = {};
  let lastTiming: { stage: string; ms: number } | null = null;
  const started = new Map<Stage, number>();
  let waiters: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const fetchController = new AbortController();
  const valid = (generation: number): boolean => generation === policy.generation;
  const setStatus = (text: string): void => { status = text; host.changed(); };
  const settle = (error: string | null): void => {
    const pending = waiters; waiters = [];
    for (const waiter of pending) { if (error === null) waiter.resolve(); else waiter.reject(new Error(error)); }
  };
  const note = (stage: string, ms: number, generation: number): void => {
    timings[stage] = ms; lastTiming = { stage, ms };
    if (NOISY_DEV) void fetch('/api/log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'analysis', stage, ms, generation }), signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    host.changed();
  };
  const wantsPlate = (): boolean => {
    const scene = host.read();
    return scene !== null && (host.windowEnabled() ? windowPlateNeeded(scene.doc) : plateNeeded(scene.doc));
  };
  const restingStatus = (): string => sequenceFailure ?? tapFailure ?? (decoderReady ? 'Ready to tap' : embeddings ? 'Warming decoder' : 'Ready');
  const finishProduct = (stage: Stage, generation: number): void => {
    const began = started.get(stage);
    if (began !== undefined) { note(stage, clock.now() - began, generation); started.delete(stage); }
    dispatch({ kind: 'product', stage, generation });
  };
  function schedule(): void {
    if (timer !== null) clearTimeout(timer);
    const at = nextWake(policy);
    timer = at === null ? null : setTimeout(() => {
      timer = null;
      dispatch({ kind: 'tick' });
    }, Math.max(0, at - clock.now()));
  }
  function dispatch(event: PolicyEvent): void {
    const next = transition(policy, event, clock.now());
    policy = next.state;
    // State changes first: cancelHeavy can synchronously deliver a terminal callback.
    for (const effect of next.effects) {
      switch (effect.kind) {
        case 'cancel-heavy': heavy?.abort(); heavy = null; service?.cancelHeavy(); break;
        case 'release-decoder': warming?.abort(); warming = null; decoder?.release(); decoder = null; decoderReady = false; break;
        case 'drop-products':
          settle('The photo was replaced.'); host.products.clear(); guide = null; embeddings = false;
          tapFailure = null; sequenceFailure = null; timings = {}; lastTiming = null; started.clear();
          if (policy.modelsReady) status = 'Waiting to analyze';
          host.changed(); break;
        case 'start-import': run(false); break;
        case 'start-plate': run(true); break;
        case 'status':
          if (effect.text.startsWith('Analysis timed out') || effect.text.startsWith('Analysis failed')) {
            sequenceFailure = effect.text;
            settle(effect.text);
          }
          setStatus(effect.text); break;
        default: { const unhandled: never = effect; throw new Error(String(unhandled)); }
      }
    }
    schedule();
  }
  function run(plate: boolean): void {
    const scene = host.read();
    if (scene === null || service === null || !lock.ok) return;
    const generation = policy.generation;
    if (plate && !wantsPlate()) {
      dispatch({ kind: 'done', generation, plateNeeded: false }); settle(null); setStatus(restingStatus()); return;
    }
    const needs = reconcile(scene.doc, { embeddings }, new Set(), { objectsActive: true, tapPending: false });
    const stages: NonEmpty<HeavyStage> = plate
      ? [{ kind: 'inpaint', hole: holeMask(scene.doc, host.products.forScene(scene.doc).masks, scene.doc.frame.master.size) }]
      : [{ kind: 'depth' }, ...needs.flatMap((need): HeavyStage[] => need.kind === 'encode' ? [{ kind: 'encode' }] : [])];
    const forMasks = sortedMasks(scene.doc);
    const controller = new AbortController(); heavy = controller;
    const active = (): boolean => valid(generation) && !controller.signal.aborted && heavy === controller;
    const products: Promise<void>[] = [];
    let startWarmup: (() => void) | null = null;
    const failed = (stage: Stage, error: unknown): void => {
      if (!active()) return;
      finishProduct(stage, generation);
      dispatch({ kind: 'failed', generation, stage, reason: reason(error) });
    };
    try {
      service.runSequence(scene.doc.id, stages, { master: () => createImageBitmap(scene.masterPixels) }, {
        onPhase(stage, phase) {
          if (!active()) return;
          if (phase === 'session' && !started.has(stage)) started.set(stage, clock.now());
          dispatch({ kind: 'phase', generation, stage, phase });
        },
        onDepth(map, stats) {
          if (!active()) return;
          finishProduct('depth', generation);
          const pending = (async () => {
            const began = clock.now(); const asset = await productAsset(map.data);
            if (!active()) return;
            note('depth-hash', clock.now() - began, generation);
            host.products.putDepth(asset, map);
            host.produce({ kind: 'depth', depth: { model: lock.value.ops.depth.model, map: { asset, size: map.size, format: 'f32' }, stats } });
          })().catch((error: unknown) => failed('depth', error));
          products.push(pending);
        },
        onEmbeddings(value) {
          if (!active()) return;
          finishProduct('encode', generation); embeddings = true;
          // Only onDone invokes this, after the service has terminated the encoder worker.
          startWarmup = () => { void (async () => {
            if (!valid(generation) || controller.signal.aborted) return;
            if (guide === null) throw new Error(tapFailure?.slice('Tapping unavailable: '.length) ?? 'The decoder guide is unavailable.');
            decoder = service.openDecoder({ scene: scene.doc.id, embeddings: value, guide });
            const resident = decoder;
            const warm = new AbortController(); warming = warm;
            const began = clock.now();
            const result = await resident.decode([{ at: { x: 0.5, y: 0.5 }, label: 'include' }], warm.signal);
            if (!valid(generation) || warm.signal.aborted || decoder !== resident) return;
            warming = null; note('warmup', clock.now() - began, generation);
            if (!result.ok) throw new Error(reason(result.error));
            decoderReady = true;
            if (policy.sequence !== 'plate' && !policy.plateQueued) setStatus(restingStatus());
            else host.changed();
          })().catch((error: unknown) => {
            if (!valid(generation) || controller.signal.aborted) return;
            warming = null; decoder?.release(); decoder = null; decoderReady = false;
            tapFailure = `Tapping unavailable: ${reason(error)}`;
            if (policy.sequence !== 'plate' && !policy.plateQueued) setStatus(restingStatus());
            else host.changed();
          }); };
        },
        onPlate(image) {
          if (!active()) return;
          finishProduct('inpaint', generation);
          products.push((async () => {
            const asset = await productAsset(image.data);
            if (!active()) return;
            const current = host.read();
            if (current === null || JSON.stringify(sortedMasks(current.doc)) !== JSON.stringify(forMasks)) return;
            host.products.putPlate(asset, image);
            host.produce({ kind: 'plate', plate: { model: lock.value.ops.inpaint.model, image: { asset, size: image.size }, forMasks } });
          })().catch((error: unknown) => failed('inpaint', error)));
        },
        onFailed: failed,
        onDone() {
          if (!active()) return;
          void Promise.all(products).then(() => {
            if (!active()) return;
            const needed = wantsPlate();
            const current = host.read();
            if (plate && needed && current !== null && JSON.stringify(sortedMasks(current.doc)) === JSON.stringify(forMasks)) {
              failed('inpaint', 'The sequence completed without a fresh plate.'); return;
            }
            startWarmup?.();
            heavy = null;
            dispatch({ kind: 'done', generation, plateNeeded: needed });
            if (policy.sequence === 'idle') { settle(null); setStatus(restingStatus()); }
            else host.changed();
          });
        },
      }, controller.signal);
    } catch (error) { failed(plate ? 'inpaint' : 'depth', error); }
  }
  queueMicrotask(() => {
    if (service === null || !lock.ok) { setStatus(`Models unavailable: ${lock.ok ? 'service unavailable' : lock.error}`); return; }
    const progress = new Map<string, number>();
    const models = new Set(Object.values(lock.value.ops).map((op) => op.model));
    void service.fetchModels(['depth', 'encode', 'decode', 'inpaint', 'face'], fetchController.signal, (model, fraction) => {
      progress.set(model, fraction);
      const percent = Math.floor([...progress.values()].reduce((sum, value) => sum + value, 0) * 100 / models.size);
      setStatus(`Fetching models ${percent}%`);
    }).then((result) => {
      if (!result.ok) { setStatus(`Models unavailable: ${reason(result.error)}`); settle(status); return; }
      setStatus(host.read() === null ? 'Models ready - drop a photo' : 'Waiting to analyze');
      dispatch({ kind: 'models-ready' });
    }).catch((error: unknown) => { setStatus(`Models unavailable: ${reason(error)}`); settle(status); });
  });
  return {
    snapshot(): AnalysisSnapshot {
      const scene = host.read(); const products = scene === null ? null : host.products.forScene(scene.doc);
      return { status, modelsReady: policy.modelsReady, depth: products?.depth !== null && products?.depth !== undefined, embeddings, decoderReady, plate: products?.plate !== null && products?.plate !== undefined, alive: service?.alive ?? { heavy: false, decoder: false }, timings: { ...timings } };
    },
    generation: (): number => policy.generation,
    guide: (): Rgb8 | null => guide,
    decoder: (): Decoder | null => decoderReady ? decoder : null,
    modelCount: (): number => lock.ok ? Object.keys(lock.value.lock.models).length : 0,
    openFaceTracker(): FaceTracker {
      if (service === null || !policy.modelsReady) throw new Error('Models are unavailable.');
      return service.openFaceTracker();
    },
    lastTiming: (): { stage: string; ms: number } | null => lastTiming,
    diagnostics: () => ({ threads, generation: policy.generation, timings: { ...timings }, events: [...diag.events] }),
    beginImport(): number { dispatch({ kind: 'import' }); return policy.generation; },
    importFailed(generation: number): void {
      if (!valid(generation)) return;
      dispatch({ kind: 'import-failed', generation }); settle('The photo could not be imported.');
    },
    async sceneReady(generation: number, master: ImageData): Promise<void> {
      try {
        const made = await makeGuide(master);
        if (!valid(generation)) return;
        guide = made;
      } catch (error) { if (!valid(generation)) return; tapFailure = `Tapping unavailable: ${reason(error)}`; }
      dispatch({ kind: 'scene-ready', generation });
    },
    requestPlateIfNeeded(): Promise<void> {
      if (!wantsPlate()) return Promise.resolve();
      if (!policy.sceneReady && !policy.pendingImport) return Promise.reject(new Error('Import a photo before requesting a plate.'));
      if (status.startsWith('Models unavailable')) return Promise.reject(new Error(status));
      // An explicit new request can retry inpaint after failure; failures never retry themselves.
      sequenceFailure = null;
      const promise = new Promise<void>((resolve, reject) => { waiters.push({ resolve, reject }); });
      dispatch({ kind: 'plate-request', generation: policy.generation });
      return promise;
    },
  };
}
export type AnalysisDriver = ReturnType<typeof createAnalysisDriver>;
