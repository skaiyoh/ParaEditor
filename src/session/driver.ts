import { bundledLock } from '../analysis/bundled-lock.ts';
import type { AnalysisError, AnalysisEvent, AnalysisService, AnalysisServiceDeps, Decoder, FaceTracker, HeavyStage } from '../analysis/service.ts';
import type { AnalysisBackend, ComposedAnalysisService } from '../analysis/composed.ts';
import type { SamEmbeddings } from '../analysis/protocol.ts';
import { holeRadius, plateKeyMatches, plateNeeded, publicationPlateNeeded, reconcile, repairHole, sourceRemovalUnion } from '../core/derive.ts';
import { liveCoverage, liveHoleMask, type LiveCoverage } from '../core/live-coverage.ts';
import type { PerspectiveGeometry } from '../core/perspective.ts';
import type { Produce } from '../core/edits.ts';
import type { AssetId, ModelId, NonEmpty } from '../core/ids.ts';
import { effectiveOrbit } from '../core/motion.ts';
import type { Plane, Rgb8 } from '../core/raster.ts';
import type { RepairProduct, RepairRequestKey, SceneDocument } from '../core/types.ts';
import { createBrowserClock } from '../platform/clock.ts';
import { createDiagnostics } from '../platform/diagnostics.ts';
import { initialPolicy, nextWake, transition, type PolicyEvent, type Stage } from './policy.ts';
import { createProducts, repairBasis, type Products, type LivePlateProduct } from './products.ts';
import { fillBackgroundDepth } from '../render/shaders/pushpull.ts';
import { createEmbeddingCache, readCachedEmbeddings, type EmbeddingCache } from './embedding-cache.ts';

export type LivePlateState =
  | { readonly kind: 'off' }
  | { readonly kind: 'not-needed' }
  | { readonly kind: 'limited'; readonly reason: string }
  | { readonly kind: 'preparing'; readonly identity: string }
  | { readonly kind: 'ready'; readonly product: LivePlateProduct };

type ServiceFactory = (deps: Pick<AnalysisServiceDeps, 'diag' | 'threads' | 'lock'> & { readonly clock: ReturnType<typeof createBrowserClock> } & { readonly changed: () => void; readonly waiting: (stage: Stage) => void }) => ComposedAnalysisService;
let serviceFactory: ServiceFactory | null = null;
/** Installed by the app before it creates the session; the driver owns policy only. */
export function injectAnalysisService(factory: ServiceFactory): void { serviceFactory = factory; }

export type AnalysisSnapshot = {
  readonly backend: AnalysisBackend;
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
};
const reason = (error: unknown): string => error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error);

type DriverEvent = AnalysisEvent | { readonly event: 'fetch.failed'; readonly error: unknown }
  | { readonly event: 'analysis.failed'; readonly op: Stage; readonly error: unknown };
const modelsUnavailable = 'Models unavailable: reload to try loading the models again.';

/** Product copy never includes model identifiers or diagnostic messages. */
function modelFailure(error: AnalysisError): string {
  switch (error.kind) {
    case 'download':
      return error.status === 'offline'
        ? 'Models unavailable: check your connection and reload to download them.'
        : 'Models unavailable: the download stopped; reload to try again.';
    case 'integrity': return 'Models unavailable: a model failed its check; reload to fetch it again.';
    case 'timeout': return 'Models unavailable: loading took too long; reload to try again.';
    case 'worker': return 'Models unavailable: loading failed; reload to try again.';
    case 'quota': return 'Models unavailable: free some device storage, then reload.';
    case 'cancelled': return 'Models unavailable: loading was cancelled; reload to try again.';
    default: { const unhandled: never = error; return modelsUnavailable; }
  }
}

/** Recovery copy never serializes a worker error or a thrown value. */
function analysisRecovery(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'kind' in error) {
    switch (error.kind) {
      case 'download': return 'status' in error && error.status === 'offline'
        ? 'Check your connection and reopen this photo.' : 'Reload this page to load the models and try again.';
      case 'integrity': return 'Reload this page to load a fresh copy of the models.';
      case 'quota': return 'Free some device storage and reload this page.';
      case 'timeout':
      case 'cancelled': return 'Reopen this photo to try again.';
      case 'worker': return 'Reload this page to try again.';
    }
  }
  return 'Reload this page to try again.';
}

function retryDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const finish = (): void => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** Optional storage never gates readiness or retains the driver's scene. */
function persistEmbeddings(cache: EmbeddingCache, master: AssetId, value: SamEmbeddings): void {
  try { void cache.put(master, value).catch(() => undefined); }
  catch { /* Unavailable storage leaves the active embeddings usable. */ }
}

/** Warming owns its worker until ready; abort also ends a pending retry. */
export async function warmDecoder({ open, releaseHeavy, signal, now, report, onReady }: {
  readonly open: () => Decoder; readonly releaseHeavy: () => void; readonly signal: AbortSignal;
  readonly now: () => number; readonly report: (error: unknown) => void;
  readonly onReady: (decoder: Decoder, ms: number) => void;
}): Promise<{ readonly kind: 'ready' } | { readonly kind: 'failed'; readonly reload: boolean } | { readonly kind: 'cancelled' }> {
  let resident: Decoder | null = null;
  const abort = (): void => { resident?.release(); resident = null; };
  signal.addEventListener('abort', abort, { once: true });
  const began = now();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal.aborted) return { kind: 'cancelled' };
      try {
        resident = open();
        const result = await resident.decode([{ at: { x: 0.5, y: 0.5 }, label: 'include' }], signal);
        if (signal.aborted) return { kind: 'cancelled' };
        if (!result.ok) throw result.error;
      } catch (error) {
        abort();
        if (signal.aborted || (typeof error === 'object' && error !== null
          && (('kind' in error && error.kind === 'cancelled') || ('name' in error && error.name === 'AbortError')))) return { kind: 'cancelled' };
        report(error);
        const deadlineFailure = typeof error === 'object' && error !== null
          && 'kind' in error && error.kind === 'timeout' && 'op' in error && error.op === 'decode';
        const startupFailure = deadlineFailure || /out of memory|no available backend|decoder (?:did not start|session could not be created)/i.test(reason(error));
        if (attempt !== 0 || !startupFailure) return { kind: 'failed', reload: attempt !== 0 };
        releaseHeavy();
        await retryDelay(1500, signal);
        continue;
      }
      // Hand ownership over synchronously, before removing the abort listener.
      const ready = resident; resident = null;
      onReady(ready, now() - began);
      return { kind: 'ready' };
    }
    return { kind: 'failed', reload: true };
  } finally { signal.removeEventListener('abort', abort); }
}

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

/** Match the renderer's deterministic depth fill at the source depth resolution. */
function repairedDepth(depth: Plane<'f32'> | null, hole: Plane<'u8'>): Plane<'f32'> {
  if (depth === null) return { format: 'f32', size: { ...hole.size }, data: new Float32Array(hole.data.length).fill(.5) };
  const { width, height } = depth.size;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const hx = Math.min(hole.size.width - 1, Math.floor((x + .5) * hole.size.width / width));
    const hy = Math.min(hole.size.height - 1, Math.floor((y + .5) * hole.size.height / height));
    data[y * width + x] = hole.data[hy * hole.size.width + hx] ?? 0;
  }
  return fillBackgroundDepth(depth, { format: 'u8', size: { ...depth.size }, data });
}

export function createAnalysisDriver(host: Host) {
  const clock = createBrowserClock(window);
  const diag = createDiagnostics<DriverEvent>(clock);
  const threads = Math.max(2, Math.min(8, Math.floor(navigator.hardwareConcurrency || 2)));
  const lock = bundledLock();
  let driver: ReturnType<typeof createDriver> | null = null;
  const service = lock.ok && serviceFactory !== null ? serviceFactory({
    clock, diag, threads, lock: lock.value, changed: host.changed,
    waiting: (stage) => driver?.reportWaiting(stage),
  }) : null;
  driver = createDriver(host, {
    clock, diag, service, threads, prepareGuide: makeGuide,
    models: lock.ok ? { kind: 'ready', ids: [...new Set(Object.values(lock.value.ops).map((op) => op.model))],
      depth: lock.value.ops.depth.model, encode: lock.value.ops.encode.model, inpaint: lock.value.ops.inpaint.model, count: Object.keys(lock.value.lock.models).length }
      : { kind: 'unavailable', message: lock.error },
  });
  return driver;
}

/** Policy execution takes its service and guide boundary explicitly for lifecycle tests. */
export function createDriver(host: Host, { clock, diag, service, threads, prepareGuide, models, embeddingCache = createEmbeddingCache() }: {
  readonly clock: Pick<ReturnType<typeof createBrowserClock>, 'now'>;
  readonly diag: Pick<ReturnType<typeof createDiagnostics<DriverEvent>>, 'log' | 'events'>;
  readonly service: (AnalysisService & { readonly backend?: AnalysisBackend; readonly routing?: ComposedAnalysisService['routing']; readonly remoteTimings?: ComposedAnalysisService['remoteTimings']; readonly releaseImport?: () => void }) | null;
  readonly threads: number;
  readonly prepareGuide: typeof makeGuide;
  readonly models: { readonly kind: 'ready'; readonly ids: readonly ModelId[]; readonly depth: ModelId; readonly encode: ModelId; readonly inpaint: ModelId; readonly count: number }
    | { readonly kind: 'unavailable'; readonly message: string };
  readonly embeddingCache?: EmbeddingCache;
}) {
  let policy = initialPolicy();
  let status = 'Fetching models 0%';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let heavy: AbortController | null = null;
  let liveHeavy: AbortController | null = null;
  let savedHeavy: { readonly controller: AbortController; readonly basis: string; readonly products: Promise<void>[] } | null = null;
  let publication: { readonly generation: number } | null = null;
  let warming: AbortController | null = null;
  let decoder: Decoder | null = null;
  let pendingWarmup: (() => void) | null = null;
  let guide: Rgb8 | null = null;
  let embeddings = false;
  let cachedEmbeddings: SamEmbeddings | null = null;
  let decoderReady = false;
  let tapFailure: string | null = null;
  let sequenceFailure: string | null = null;
  let timings: Record<string, number> = {};
  let lastTiming: { stage: string; ms: number } | null = null;
  let liveGeometry: PerspectiveGeometry | null = null;
  let restored = false;
  let disposed = false;
  let decoderDemand = false;
  let decoderRequest: { readonly generation: number; readonly promise: Promise<void> } | null = null;
  let decoderWaiters: { resolve: () => void; reject: (error: Error) => void }[] = [];
  let importWaiters: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const started = new Map<Stage, number>();
  let waiters: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const fetchController = new AbortController();
  const valid = (generation: number): boolean => !disposed && generation === policy.generation;
  const setStatus = (text: string): void => { status = text; host.changed(); };
  const settle = (error: string | null): void => {
    const pending = waiters; waiters = [];
    for (const waiter of pending) { if (error === null) waiter.resolve(); else waiter.reject(new Error(error)); }
  };
  const settleDecoder = (error: string | null): void => {
    const pending = decoderWaiters; decoderWaiters = [];
    for (const waiter of pending) { if (error === null) waiter.resolve(); else waiter.reject(new Error(error)); }
  };
  const settleImport = (error: string | null): void => {
    const pending = importWaiters; importWaiters = [];
    for (const waiter of pending) { if (error === null) waiter.resolve(); else waiter.reject(new Error(error)); }
  };
  const note = (stage: string, ms: number, generation: number): void => {
    timings[stage] = ms; lastTiming = { stage, ms };
    if (NOISY_DEV) void fetch('/api/log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'analysis', stage, ms, generation }), signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    host.changed();
  };
  const wantsSavedPlate = (): boolean => {
    const scene = host.read();
    return scene !== null && (plateNeeded(scene.doc) || (publication?.generation === policy.generation &&
      (publicationPlateNeeded(scene.doc, host.products.assets) || (scene.doc.objects.length > 0 && scene.doc.analysis.plate !== null && !host.products.plates.has(scene.doc.analysis.plate.image.asset)))));
  };
  const currentCoverage = (): LiveCoverage | null => {
    const scene = host.read();
    return scene === null || liveGeometry === null ? null : liveCoverage(scene.doc, liveGeometry);
  };
  const wantsLivePlate = (): boolean => {
    const scene = host.read(), coverage = currentCoverage();
    return scene !== null && scene.doc.removals.length > 0 && coverage !== null && host.products.forScene(scene.doc).depth !== null
      && scene.doc.removals.every((removal) => host.products.masks.has(removal.mask.plane.asset)) && host.products.livePlate?.key !== coverage.key;
  };
  const wantsPlate = (): boolean => wantsSavedPlate() || wantsLivePlate();
  const restingStatus = (): string => tapFailure ?? sequenceFailure ?? (decoderReady ? 'Ready to tap' : embeddings ? 'Warming decoder' : 'Ready');
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
    if (disposed) return;
    const next = transition(policy, event, clock.now());
    policy = next.state;
    // State changes first: cancelHeavy can synchronously deliver a terminal callback.
    for (const effect of next.effects) {
      switch (effect.kind) {
        case 'cancel-heavy':
          heavy?.abort(); heavy = null; liveHeavy = null; savedHeavy = null;
          service?.cancelHeavy(next.effects.some((item) => item.kind === 'status' && item.text.startsWith('Analysis timed out')) ? 'timeout' : undefined);
          break;
        case 'release-decoder': warming?.abort(); warming = null; decoder?.release(); decoder = null; decoderReady = false; break;
        case 'drop-products':
          settle('The photo was replaced.'); settleDecoder('The photo was replaced.'); settleImport('The photo was replaced.'); host.products.clear(); guide = null; embeddings = false; cachedEmbeddings = null;
          restored = false; decoderDemand = false; decoderRequest = null;
          liveGeometry = null;
          pendingWarmup = null;
          tapFailure = null; sequenceFailure = null; timings = {}; lastTiming = null; started.clear();
          if (policy.modelsReady) status = 'Waiting to analyze';
          host.changed(); break;
        case 'start-import': run(false); break;
        case 'start-plate': run(true); break;
        case 'status':
          if (effect.text.startsWith('Analysis timed out') || effect.text.startsWith('Analysis failed')) {
            sequenceFailure = effect.text;
            settle(effect.text);
            settleDecoder(effect.text);
            settleImport(effect.text);
          }
          setStatus(effect.text); break;
        default: { const unhandled: never = effect; throw new Error(String(unhandled)); }
      }
    }
    schedule();
    // Failure and timeout also terminate a queued plate before resuming warming.
    if (policy.sequence === 'idle' && heavy === null && warming === null && !decoderReady && tapFailure === null) pendingWarmup?.();
  }
  function queueDecoder(value: SamEmbeddings, generation: number, sourceSignal?: AbortSignal): void {
    const scene = host.read();
    if (scene === null || service === null || models.kind !== 'ready') return;
    // Dispatch invokes this only when import and queued background workers have ended.
    pendingWarmup = () => { void (async () => {
      if (!valid(generation) || !policy.modelsReady) return;
      // A cache-only restore has no inference owner. Cancelled sequence-owned
      // warmups must release their closure so a later decoder demand can retry.
      if (sourceSignal?.aborted) { pendingWarmup = null; return; }
      const preparedGuide = guide;
      if (preparedGuide === null) { tapFailure = 'Tapping unavailable - try another photo'; settleDecoder(tapFailure); setStatus(restingStatus()); return; }
      const warm = new AbortController(); warming = warm;
      setStatus('Warming decoder');
      const result = await warmDecoder({
        open: () => service.openDecoder({ scene: scene.doc.id, embeddings: value, guide: preparedGuide }),
        releaseHeavy: () => { heavy?.abort(); heavy = null; service.cancelHeavy(); },
        signal: warm.signal, now: () => clock.now(),
        report: (error) => { if (NOISY_DEV) diag.log({ event: 'stage.failed', op: 'decode', error: { kind: 'worker', op: 'decode', message: reason(error) } }); },
        onReady: (resident, ms) => {
          if (!valid(generation) || warm.signal.aborted || warming !== warm) { resident.release(); return; }
          warming = null; pendingWarmup = null; decoder = resident; decoderReady = true;
          settleDecoder(null);
          note('warmup', ms, generation);
          if (valid(generation) && !warm.signal.aborted) {
            if (policy.sequence !== 'plate' && !policy.plateQueued) setStatus(restingStatus());
            else host.changed();
          }
        },
      });
      if (result.kind === 'ready' || !valid(generation) || warm.signal.aborted || warming !== warm) return;
      warming = null; pendingWarmup = null;
      if (result.kind === 'failed') {
        decoderReady = false;
        tapFailure = result.reload ? 'Tapping needs a reload on this device' : 'Tapping unavailable - try another photo';
        settleDecoder(tapFailure);
      }
      setStatus(restingStatus());
    })(); };
  }
  function run(plate: boolean): void {
    const scene = host.read();
    if (scene === null || service === null || models.kind !== 'ready') return;
    const generation = policy.generation;
    if (plate && !wantsPlate()) {
      dispatch({ kind: 'done', generation, plateNeeded: false }); settle(null); setStatus(restingStatus()); return;
    }
    if (!plate && restored && !decoderDemand) {
      dispatch({ kind: 'done', generation, plateNeeded: false }); settle(null); settleImport(null); setStatus(restingStatus()); return;
    }
    // A plate queued while warming must finish before another decoder starts.
    warming?.abort(); warming = null;
    const needs = reconcile(scene.doc, { embeddings }, new Set(), { objectsActive: true, tapPending: false });
    const coverage = plate && !wantsSavedPlate() ? currentCoverage() : null;
    const sourceProducts = host.products.forScene(scene.doc);
    const liveDepth = coverage === null ? null : sourceProducts.depth;
    let union: Plane<'u8'> | null = null, hole: Plane<'u8'> | null = null;
    try {
      union = plate && coverage === null ? sourceRemovalUnion(scene.doc, host.products.masks, scene.doc.frame.master.size) : null;
      hole = plate ? coverage === null && union !== null ? repairHole(scene.doc, union)
        : coverage === null ? null : liveHoleMask(scene.doc, sourceProducts.masks, coverage, host.products.masks) : null;
    } catch (error) {
      dispatch({ kind: 'failed', generation, stage: 'inpaint', reason: reason(error) }); return;
    }
    if (coverage !== null && liveDepth === null) {
      dispatch({ kind: 'done', generation, plateNeeded: false }); settle(null); setStatus(restingStatus()); return;
    }
    const encode = needs.some((need) => need.kind === 'encode');
    const stages: NonEmpty<HeavyStage> | null = hole !== null ? [{ kind: 'inpaint', hole }]
      : !restored && needs.some((need) => need.kind === 'depth') ? [{ kind: 'depth' }, ...(encode ? [{ kind: 'encode' } satisfies HeavyStage] : [])]
      : encode ? [{ kind: 'encode' }] : null;
    if (stages === null) {
      if (!plate && cachedEmbeddings !== null) queueDecoder(cachedEmbeddings, generation);
      dispatch({ kind: 'done', generation, plateNeeded: wantsPlate() });
      if (decoderReady) settleDecoder(null);
      if (!plate) settleImport(null);
      if (policy.sequence === 'idle') { settle(null); setStatus(restingStatus()); }
      return;
    }
    const basis = repairBasis(scene.doc);
    const controller = new AbortController(); heavy = controller;
    if (!plate && cachedEmbeddings !== null) queueDecoder(cachedEmbeddings, generation, controller.signal);
    liveHeavy = coverage === null ? null : controller;
    const active = (): boolean => valid(generation) && !controller.signal.aborted && heavy === controller;
    const sameBasis = (): boolean => {
      const current = host.read();
      return active() && current !== null && current.doc.id === scene.doc.id && repairBasis(current.doc) === basis;
    };
    // Hash immutable request snapshots beside inference; stale work never enters the active store.
    const prepared = createProducts();
    const required: Promise<RepairRequestKey | null> = union === null || hole === null ? Promise.resolve(null)
      : Promise.all([prepared.admitPlane(union), prepared.admitPlane(hole)]).then(([removalUnion, holeAsset]) => ({
        algorithm: 'photo-repair-v2', source: scene.doc.frame.master.asset, size: { ...scene.doc.frame.master.size },
        removalUnion, hole: holeAsset, depth: scene.doc.analysis.depth?.map.asset ?? null,
        radius: holeRadius(scene.doc, scene.doc.frame.master.size), model: models.inpaint,
        purpose: scene.doc.motion.enabled
          ? { kind: 'loop', parallax: scene.doc.motion.parallax, reach: effectiveOrbit(scene.doc.motion) }
          : { kind: 'still' },
      }));
    const products: Promise<void>[] = [];
    savedHeavy = plate && coverage === null ? { controller, basis, products } : null;
    const failed = (stage: Stage, error: unknown): void => {
      if (!active()) return;
      diag.log({ event: 'analysis.failed', op: stage, error });
      finishProduct(stage, generation);
      dispatch({ kind: 'failed', generation, stage, reason: analysisRecovery(error) });
    };
    products.push(required.then(() => undefined).catch((error: unknown) => failed('inpaint', error)));
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
          if (!active()) return;
          const pending = (async () => {
            const began = clock.now(); const asset = await prepared.admitPlane(map);
            if (!active()) return;
            note('depth-hash', clock.now() - began, generation);
            if (!active()) return;
            const bytes = prepared.assets.get(asset);
            if (bytes === undefined) throw new Error('The encoded depth asset is unavailable.');
            host.products.installEncoded(asset, bytes);
            host.produce({ kind: 'depth', depth: { model: models.depth, map: { asset, size: map.size, format: 'f32' }, stats } });
          })().catch((error: unknown) => failed('depth', error));
          products.push(pending);
        },
        onEmbeddings(value) {
          if (!active()) return;
          finishProduct('encode', generation);
          if (!active()) return;
          embeddings = true; cachedEmbeddings = value;
          persistEmbeddings(embeddingCache, scene.doc.frame.master.asset, value);
          queueDecoder(value, generation, controller.signal);
        },
        onPlate(image) {
          if (!active()) return;
          finishProduct('inpaint', generation);
          if (!active()) return;
          if (coverage !== null) {
            if (currentCoverage()?.key === coverage.key && hole !== null && liveDepth !== null) {
              host.products.putLivePlate({ key: coverage.key, image, hole, depth: liveDepth });
              host.changed();
            }
            return;
          }
          products.push((async () => {
            const key = await required;
            if (key === null || hole === null || !sameBasis()) return;
            if (scene.doc.analysis.depth !== null && sourceProducts.depth === null) throw new Error('The source depth asset is unavailable.');
            const background = repairedDepth(sourceProducts.depth, hole);
            const [asset, backgroundAsset] = await Promise.all([prepared.admitRgb(image), prepared.admitPlane(background)]);
            if (!sameBasis()) return;
            const current = host.read();
            if (current === null || !plateKeyMatches(current.doc, key)) return;
            const savedImage = prepared.plates.get(asset);
            if (savedImage === undefined) throw new Error('The encoded repair image is unavailable.');
            const repair: RepairProduct = { key, image: { asset, size: { ...image.size } },
              backgroundDepth: { asset: backgroundAsset, format: 'f32', size: { ...background.size } } };
            for (const [id, bytes] of prepared.assets) host.products.installEncoded(id, bytes);
            host.products.installRgb(asset, savedImage);
            host.products.rememberRepair(current.doc, repair);
            host.produce({ kind: 'plate', plate: repair, required: key });
          })().catch((error: unknown) => failed('inpaint', error)));
        },
        onFailed: failed,
        onDone() {
          if (!active()) return;
          void Promise.all(products).then(() => {
            if (!active()) return;
            const needed = wantsPlate();
            const current = host.read();
            const sameRequest = coverage === null ? wantsSavedPlate() && current !== null && repairBasis(current.doc) === basis
              : wantsLivePlate() && currentCoverage()?.key === coverage.key;
            if (plate && needed && sameRequest) {
              failed('inpaint', 'The sequence completed without a fresh plate.'); return;
            }
            heavy = null; liveHeavy = null; savedHeavy = null;
            if (!plate) settleImport(null);
            dispatch({ kind: 'done', generation, plateNeeded: needed });
            if (!valid(generation) || controller.signal.aborted) return;
            if (policy.sequence === 'idle') { settle(null); setStatus(restingStatus()); }
            else host.changed();
          });
        },
      }, controller.signal);
    } catch (error) { failed(plate ? 'inpaint' : 'depth', error); }
  }
  let loadingModels = false;
  const failModels = (error: unknown, sentence = modelsUnavailable): void => {
    if (disposed) return;
    loadingModels = false;
    diag.log({ event: 'fetch.failed', error });
    setStatus(sentence);
    settle(status);
    settleDecoder(status); settleImport(status);
  };
  function loadModels(): void {
    if (disposed || loadingModels || policy.modelsReady) return;
    if (service === null || models.kind !== 'ready') { failModels(models.kind === 'ready' ? 'service unavailable' : models.message); return; }
    loadingModels = true;
    setStatus('Fetching models 0%');
    const progress = new Map<string, number>();
    void Promise.resolve().then(() => service.fetchModels(['depth', 'encode', 'decode', 'inpaint', 'face'], fetchController.signal, (model, fraction) => {
      if (disposed) return;
      progress.set(model, fraction);
      const percent = Math.floor([...progress.values()].reduce((sum, value) => sum + value, 0) * 100 / models.ids.length);
      setStatus(`Fetching models ${percent}%`);
    })).then((result) => {
      if (disposed) return;
      loadingModels = false;
      if (!result.ok) { failModels(result.error, modelFailure(result.error)); return; }
      setStatus(host.read() === null ? 'Models ready - drop a photo' : restored ? restingStatus() : 'Waiting to analyze');
      dispatch({ kind: 'models-ready' });
    }).catch((error: unknown) => { failModels(error); });
  }
  function requestDecoder(): Promise<void> {
    if (disposed) return Promise.reject(new Error('The analysis session was closed.'));
    if (decoderReady) return Promise.resolve();
    if (service === null || !policy.modelsReady) return Promise.reject(new Error('Models are unavailable.'));
    const scene = host.read(), generation = policy.generation;
    if (scene === null) return Promise.reject(new Error('Import a photo before selecting an object.'));
    if (decoderRequest?.generation === generation) return decoderRequest.promise;
    const promise = (async () => {
      if (guide === null) {
        const made = await prepareGuide(scene.masterPixels);
        if (!valid(generation)) throw new Error('The photo was replaced.');
        guide = made;
      }
      if (!valid(generation)) throw new Error('The photo was replaced.');
      if (decoderReady) return;
      decoderDemand = true; tapFailure = null; sequenceFailure = null;
      const ready = new Promise<void>((resolve, reject) => decoderWaiters.push({ resolve, reject }));
      if (pendingWarmup !== null) {
        if (policy.sequence === 'idle' && heavy === null && warming === null) pendingWarmup();
      }
      else if (policy.sequence !== 'import' && !policy.pendingImport) {
        // Retain the scene/products; policy still serializes encoder work behind any active plate.
        embeddings = false; policy = { ...policy, pendingImport: true };
        dispatch({ kind: 'tick' });
      }
      return ready;
    })();
    decoderRequest = { generation, promise };
    void promise.then(() => { if (decoderRequest?.promise === promise) decoderRequest = null; },
      () => { if (decoderRequest?.promise === promise) decoderRequest = null; });
    return promise;
  }
  queueMicrotask(loadModels);
  return {
    reportWaiting(stage: Stage): void { if (!disposed) setStatus(stage === 'inpaint' ? 'preparing' : `Analyzing: ${stage === 'encode' ? 'encoder' : stage}`); },
    snapshot(): AnalysisSnapshot {
      const scene = host.read(); const products = scene === null ? null : host.products.forScene(scene.doc);
      return { backend: service?.backend ?? { kind: 'device' }, status, modelsReady: policy.modelsReady, depth: products?.depth !== null && products?.depth !== undefined, embeddings, decoderReady, plate: products?.plate !== null && products?.plate !== undefined, alive: service?.alive ?? { heavy: false, decoder: false }, timings: { ...timings } };
    },
    generation: (): number => policy.generation,
    guide: (): Rgb8 | null => guide,
    decoder: (): Decoder | null => decoderReady ? decoder : null,
    modelCount: (): number => models.kind === 'ready' ? models.count : 0,
    openFaceTracker(): FaceTracker {
      if (disposed) throw new Error('The analysis session was closed.');
      if (service === null || !policy.modelsReady) throw new Error('Models are unavailable.');
      return service.openFaceTracker();
    },
    lastTiming: (): { stage: string; ms: number } | null => lastTiming,
    diagnostics: () => ({ threads, generation: policy.generation, routing: service?.routing ?? { depth: 'device', encoder: 'device', taps: 'device', plate: 'device' }, remoteTimings: service?.remoteTimings ?? {}, timings: { ...timings }, events: [...diag.events] }),
    beginImport(): number {
      if (disposed) throw new Error('The analysis session was closed.');
      dispatch({ kind: 'import' }); service?.releaseImport?.(); if (!policy.modelsReady) loadModels(); return policy.generation;
    },
    importFailed(generation: number): void {
      if (!valid(generation)) return;
      dispatch({ kind: 'import-failed', generation }); settle('The photo could not be imported.'); settleImport('The photo could not be imported.');
    },
    async sceneReady(generation: number, master: ImageData, options: { readonly restore?: boolean } = {}): Promise<void> {
      if (!valid(generation)) return;
      restored = options.restore ?? false;
      const scene = host.read();
      try {
        if (restored && scene !== null && models.kind === 'ready') {
          const cached = await readCachedEmbeddings(embeddingCache, scene.doc.frame.master.asset, models.encode);
          if (!valid(generation)) return;
          cachedEmbeddings = cached; embeddings = cached !== null;
        }
        if (!restored || cachedEmbeddings !== null) {
          const made = await prepareGuide(master);
          if (!valid(generation)) return;
          guide = made;
          if (!restored && scene !== null && models.kind === 'ready') {
            const cached = await readCachedEmbeddings(embeddingCache, scene.doc.frame.master.asset, models.encode);
            if (!valid(generation)) return;
            cachedEmbeddings = cached; embeddings = cached !== null;
          }
        }
      } catch (error) {
        if (!valid(generation)) return;
        if (NOISY_DEV) diag.log({ event: 'stage.failed', op: 'decode', error: { kind: 'worker', op: 'decode', message: reason(error) } });
        tapFailure = 'Tapping unavailable - try another photo';
      }
      if (restored) {
        // Saved products remain authoritative. A cache hit only warms tapping;
        // a miss leaves guide preparation and encoding to an explicit decoder request.
        // Keep a decoder request made while that optional cache read was pending.
        policy = { ...policy, pendingImport: decoderDemand && cachedEmbeddings === null };
        if (cachedEmbeddings !== null) queueDecoder(cachedEmbeddings, generation);
        dispatch({ kind: 'scene-ready', generation }); settleImport(null);
        if (valid(generation) && policy.modelsReady && warming === null) setStatus(restingStatus());
        return;
      }
      dispatch({ kind: 'scene-ready', generation });
    },
    requestDecoder,
    waitForImport(): Promise<void> {
      if (disposed) return Promise.reject(new Error('The analysis session was closed.'));
      if (status.startsWith('Models unavailable')) return Promise.reject(new Error(status));
      if (sequenceFailure !== null) return Promise.reject(new Error(sequenceFailure));
      if (!policy.pendingImport && policy.sequence !== 'import') return Promise.resolve();
      return new Promise<void>((resolve, reject) => importWaiters.push({ resolve, reject }));
    },
    dispose(): void {
      if (disposed) return;
      disposed = true; fetchController.abort();
      if (timer !== null) clearTimeout(timer);
      timer = null; heavy?.abort(); heavy = null; liveHeavy = null; savedHeavy = null;
      warming?.abort(); warming = null; decoder?.release(); decoder = null; decoderReady = false;
      pendingWarmup = null; decoderRequest = null;
      service?.cancelHeavy(); service?.releaseImport?.();
      settle('The analysis session was closed.'); settleDecoder('The analysis session was closed.'); settleImport('The analysis session was closed.');
    },
    async preparePublicationPlate(signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      if (publication !== null) throw new Error('A publication is already preparing its background.');
      const generation = policy.generation;
      const request = { generation }; publication = request;
      let rejectAbort = (_error: Error): void => {};
      const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
      const abort = (): void => {
        if (publication === request) publication = null;
        rejectAbort(new Error('Publishing was cancelled.'));
        if (!valid(generation)) return;
        const previous = savedHeavy;
        if (previous !== null && heavy === previous.controller) {
          previous.controller.abort(); heavy = null; savedHeavy = null;
          started.delete('inpaint'); policy = { ...policy, deadline: null };
          service?.cancelHeavy();
          // Cancellation returns promptly, but another repair still waits for native work.
          void Promise.all(previous.products).then(() => {
            if (!valid(generation) || heavy !== null || policy.sequence !== 'plate') return;
            const needed = wantsPlate();
            dispatch({ kind: 'done', generation, plateNeeded: needed });
            if (!needed) { settle(null); setStatus(restingStatus()); }
          });
        } else if (!wantsPlate()) policy = { ...policy, plateQueued: false };
      };
      signal.addEventListener('abort', abort, { once: true });
      try { await Promise.race([this.requestPlateIfNeeded(), cancelled]); }
      finally {
        if (publication === request) publication = null;
        signal.removeEventListener('abort', abort);
      }
    },
    requestPlateIfNeeded(): Promise<void> {
      if (disposed) return Promise.reject(new Error('The analysis session was closed.'));
      if (!wantsSavedPlate()) return Promise.resolve();
      if (!policy.sceneReady && !policy.pendingImport) return Promise.reject(new Error('Import a photo before requesting a plate.'));
      if (status.startsWith('Models unavailable')) return Promise.reject(new Error(status));
      // An explicit new request can retry inpaint after failure; failures never retry themselves.
      sequenceFailure = null;
      const promise = new Promise<void>((resolve, reject) => { waiters.push({ resolve, reject }); });
      const generation = policy.generation, previous = savedHeavy, current = host.read();
      if (previous !== null && heavy === previous.controller && policy.sequence === 'plate' &&
        current !== null && previous.basis !== repairBasis(current.doc)) {
        // A v5 purpose/envelope change cannot use this result. Release obsolete
        // inference now, but drain its native hashes/encoding before allocating
        // another request. Requests during that drain coalesce onto the latest doc.
        previous.controller.abort(); heavy = null; savedHeavy = null;
        // The cancelled inference cannot time out while its native snapshots drain.
        // Keep the plate sequence reserved so retries cannot allocate beside them.
        started.delete('inpaint'); policy = { ...policy, deadline: null };
        service?.cancelHeavy();
        void Promise.all(previous.products).then(() => {
          if (!valid(generation) || heavy !== null || policy.sequence !== 'plate') return;
          const needed = wantsPlate();
          dispatch({ kind: 'done', generation, plateNeeded: needed });
          if (!needed) { settle(null); setStatus(restingStatus()); }
        });
      }
      dispatch({ kind: 'plate-request', generation: policy.generation });
      return promise;
    },
    livePlate(): LivePlateState {
      if (liveGeometry === null) return { kind: 'off' };
      const coverage = currentCoverage(), scene = host.read();
      if (coverage === null || scene === null || host.products.forScene(scene.doc).depth === null) return { kind: 'limited', reason: 'Depth is not ready' };
      if (scene.doc.removals.length === 0) return { kind: 'not-needed' };
      if (scene.doc.removals.some((removal) => !host.products.masks.has(removal.mask.plane.asset))) return { kind: 'limited', reason: 'Source removal masks are not ready' };
      const product = host.products.livePlate;
      if (product?.key === coverage.key) return { kind: 'ready', product };
      return sequenceFailure === null ? { kind: 'preparing', identity: coverage.key } : { kind: 'limited', reason: sequenceFailure };
    },
    requestLivePlate(geometry: PerspectiveGeometry | null): Promise<void> {
      if (disposed) return Promise.reject(new Error('The analysis session was closed.'));
      liveGeometry = geometry === null ? null : { ...geometry, aperture: { ...geometry.aperture, center: { ...geometry.aperture.center } } };
      if (geometry === null) {
        host.products.clearLivePlate();
        if (liveHeavy !== null && heavy === liveHeavy) {
          liveHeavy.abort(); heavy = null; liveHeavy = null; service?.cancelHeavy();
          dispatch({ kind: 'done', generation: policy.generation, plateNeeded: wantsSavedPlate() });
          if (policy.sequence === 'idle') { settle(null); setStatus(restingStatus()); }
        }
        return Promise.resolve();
      }
      if (!wantsLivePlate()) return Promise.resolve();
      if (!policy.sceneReady && !policy.pendingImport) return Promise.reject(new Error('Import a photo before requesting a live plate.'));
      if (status.startsWith('Models unavailable')) return Promise.reject(new Error(status));
      sequenceFailure = null;
      const promise = new Promise<void>((resolve, reject) => { waiters.push({ resolve, reject }); });
      dispatch({ kind: 'plate-request', generation: policy.generation });
      return promise;
    },
  };
}
export type AnalysisDriver = ReturnType<typeof createAnalysisDriver>;
