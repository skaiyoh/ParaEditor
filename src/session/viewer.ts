import type { AssetId, ObjectId } from '../core/ids.ts';
import type { Plane, Rgb8, Size } from '../core/raster.ts';
import type { LegacySceneDocument, SceneDocument } from '../core/types.ts';
import { collectCompositionAssets } from '../core/asset-refs.ts';
import { decodeRaster, inspectPng } from '../core/asset-codec.ts';
import { plateKeyMatches, repairHole, sourceRemovalUnion } from '../core/derive.ts';
import { sortedMasks } from '../core/produce.ts';
import { liveCoverage, liveHoleMask } from '../core/live-coverage.ts';
import { frameCount, parallaxMargin, type Vec2 } from '../core/motion.ts';
import { apertureFromRect, containedImageRect, createPerspectiveGeometry, constrainEye, lateralEnvelope } from '../core/perspective.ts';
import { decodePhoto } from '../photo/decode.ts';
import { createRenderer } from '../render/renderer.ts';
import { LOOP_FPS, frameAtElapsed } from '../render/loop.ts';
import type { Renderer, RenderScene, PaintPlane } from '../render/types.ts';
import { resolveLocalEffects } from '../render/local-effects.ts';
import { createTiltSource } from './tilt.ts';

export type LegacyViewerPiece = {
  /** Manifest v1 keeps its frozen v4 document and payload-only raster assets. */
  readonly document: LegacySceneDocument;
  readonly source: Blob;
  readonly planes: ReadonlyMap<AssetId, Plane<'u8'> | Plane<'f32'> | Rgb8>;
};
export type CompositionViewerPiece = {
  /** Manifest v2 owns the same encoded asset closure as the editor checkpoint. */
  readonly document: SceneDocument;
  readonly assets: ReadonlyMap<AssetId, Uint8Array>;
};
export type ViewerPiece = LegacyViewerPiece | CompositionViewerPiece;
export type ViewerFailure =
  | { readonly kind: 'missing-asset' | 'invalid-asset'; readonly asset: AssetId | null; readonly message: string }
  | { readonly kind: 'no-webgl2' | 'decode-failure' | 'render-failure' | 'context-lost'; readonly message: string };
export type ViewerStatus =
  | { readonly kind: 'idle' | 'loading' | 'stopped' | 'disposed' }
  | { readonly kind: 'running'; readonly limitation: string | null }
  | { readonly kind: 'failed'; readonly failure: ViewerFailure };
export type ViewerInput = 'none' | 'pointer' | 'tilt';
export type TiltPermission = 'granted' | 'denied' | 'unsupported';

class AssetFailure extends Error {
  readonly failure: Extract<ViewerFailure, { asset: AssetId | null }>;
  constructor(failure: Extract<ViewerFailure, { asset: AssetId | null }>) { super(failure.message); this.failure = failure; }
}
const sameSize = (a: Size, b: Size): boolean => a.width === b.width && a.height === b.height;
type ResolvedViewerAssets = Pick<RenderScene, 'masks' | 'depth' | 'plate'> & (
  | { readonly kind: 'legacy' }
  | { readonly kind: 'composition'; readonly masterPng: Blob; readonly repairPng: Blob | null;
    readonly masksByAsset: ReadonlyMap<AssetId, Plane<'u8'>>;
    readonly backgroundDepth: Plane<'f32'> | null;
    readonly localEffects: NonNullable<RenderScene['localEffects']>; readonly compositing: SceneDocument['compositing']; readonly paint: readonly PaintPlane[] }
);

type DecodedPaintTile = { readonly size: Size; readonly rgba: Uint8Array<ArrayBuffer> };
const paintTileCache = new WeakMap<Uint8Array, DecodedPaintTile>();
const paintContentCache = new Map<AssetId, WeakRef<DecodedPaintTile>>();
/** Shared editor/viewer hydration keeps immutable tile identities stable across
 * metadata-only document changes, so MRX3 can reuse its admitted textures. */
export function resolvePaintPlanes(doc: SceneDocument, assets: ReadonlyMap<AssetId, Uint8Array>): readonly PaintPlane[] {
  if (doc.version !== 6) return [];
  for (const [asset, cached] of paintContentCache) if (cached.deref() === undefined) paintContentCache.delete(asset);
  let order = 0;
  return doc.paint.layers.flatMap(layer => [...layer.patches].sort((a, b) => a.order - b.order).map(patch => ({
    id: patch.id, disparity: patch.disparity, order: order++, opacity: layer.opacity, visible: !layer.hidden,
    bounds: { x: 0, y: 0, ...patch.size }, tiles: patch.tiles.map(tile => {
      const bytes = assets.get(tile.rgba.asset);
      if (bytes === undefined) throw new Error('A saved paint tile is unavailable.');
      let cached = paintTileCache.get(bytes) ?? paintContentCache.get(tile.rgba.asset)?.deref();
      if (cached === undefined) {
        const raster = decodeRaster(bytes, { format: tile.rgba.encoding, size: tile.rgba.size });
        if (raster.format !== 'rgba8-srgb-straight') throw new Error('A saved paint tile has the wrong format.');
        cached = { size: raster.size, rgba: new Uint8Array(raster.data) };
        paintContentCache.set(tile.rgba.asset, new WeakRef(cached));
      }
      if (!sameSize(cached.size, tile.rgba.size)) throw new Error('A saved paint tile has conflicting dimensions.');
      paintTileCache.set(bytes, cached);
      return { x: tile.x, y: tile.y, ...tile.rgba.size, rgba: cached.rgba };
    }),
  })));
}

function resolveCompositionAssets(piece: CompositionViewerPiece): ResolvedViewerAssets {
  const doc = piece.document;
  const invalid = (asset: AssetId | null, message: string): never => { throw new AssetFailure({ kind: 'invalid-asset', asset, message }); };
  if (doc.compositing === 'scene-depth') return invalid(null, 'Scene-depth composition requires C3.');
  const inventory = collectCompositionAssets([{ kind: 'document', document: doc }]);
  if (!inventory.ok) return invalid(null, `The published asset closure is invalid: ${inventory.error.detail}`);
  const masksByAsset = new Map<AssetId, Plane<'u8'>>(), depths = new Map<AssetId, Plane<'f32'>>();
  const pngs = new Map<AssetId, Blob>();
  for (const [asset, refs] of inventory.value) {
    const bytes = piece.assets.get(asset);
    if (bytes === undefined) throw new AssetFailure({ kind: 'missing-asset', asset, message: `The published piece is missing asset ${asset}.` });
    for (const ref of refs) {
      if (ref.byteLength !== null && ref.byteLength !== bytes.byteLength) return invalid(asset, 'A published asset has the wrong encoded byte length.');
      try {
        switch (ref.kind) {
          case 'original': break; // Rendering uses the immutable master PNG, never another decode of the original.
          case 'png': {
            if (!sameSize(inspectPng(bytes).size, ref.size)) return invalid(asset, 'A published PNG has the wrong dimensions.');
            pngs.set(asset, new Blob([new Uint8Array(bytes)], { type: 'image/png' })); break;
          }
          case 'raster': {
            const plane = decodeRaster(bytes, ref);
            if (plane.format === 'u8') masksByAsset.set(asset, { ...plane, format: 'u8' });
            else if (plane.format === 'f32') depths.set(asset, { ...plane, format: 'f32' });
            break;
          }
          default: { const exhaustive: never = ref; return exhaustive; }
        }
      } catch (error) {
        if (error instanceof AssetFailure) throw error;
        return invalid(asset, `A published asset is invalid: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (piece.assets.size !== inventory.value.size) return invalid(null, 'The published piece contains an unreferenced asset.');
  const masterPng = pngs.get(doc.frame.master.asset);
  if (masterPng === undefined) return invalid(doc.frame.master.asset, 'The published master PNG is unavailable.');
  const masks = new Map<ObjectId, Plane<'u8'>>();
  for (const object of doc.objects) {
    const mask = masksByAsset.get(object.produced.mask.asset);
    if (mask === undefined) return invalid(object.produced.mask.asset, 'A published layer mask is unavailable.');
    masks.set(object.id, mask);
  }
  const depth = doc.analysis.depth === null ? null : depths.get(doc.analysis.depth.map.asset) ?? null;
  const repair = doc.analysis.plate;
  let repairPng: Blob | null = null, backgroundDepth: Plane<'f32'> | null = null;
  if (repair !== null) {
    if (!plateKeyMatches(doc, repair.key)) return invalid(repair.image.asset, 'The published repair belongs to a different source, depth or reveal envelope.');
    const union = sourceRemovalUnion(doc, masksByAsset), hole = repairHole(doc, union);
    const samePlane = (actual: Plane<'u8'> | undefined, expected: Plane<'u8'>): boolean => actual !== undefined
      && sameSize(actual.size, expected.size) && actual.data.length === expected.data.length
      && actual.data.every((value, index) => value === expected.data[index]);
    if (!samePlane(masksByAsset.get(repair.key.removalUnion), union) || !samePlane(masksByAsset.get(repair.key.hole), hole)) {
      return invalid(repair.image.asset, 'The published repair belongs to different source removals or a different hole.');
    }
    repairPng = pngs.get(repair.image.asset) ?? null;
    backgroundDepth = depths.get(repair.backgroundDepth.asset) ?? null;
    if (repairPng === null || backgroundDepth === null) return invalid(repair.image.asset, 'The published repair output is unavailable.');
  } else if (doc.objects.length > 0) {
    throw new AssetFailure({ kind: 'missing-asset', asset: null, message: 'The published layers need a background plate.' });
  }
  return { kind: 'composition', masks, depth, plate: null, masterPng, repairPng, masksByAsset, backgroundDepth,
    localEffects: resolveLocalEffects(doc.localEffects, masksByAsset), compositing: doc.compositing, paint: resolvePaintPlanes(doc, piece.assets) };
}

/** Resolve every declared raster before GL or image decoding. The loader owns schema parsing and byte hashes. */
export function resolveViewerAssets(piece: ViewerPiece): ResolvedViewerAssets {
  if ('assets' in piece) return resolveCompositionAssets(piece);
  const doc = piece.document;
  const invalid = (asset: AssetId | null, message: string): never => { throw new AssetFailure({ kind: 'invalid-asset', asset, message }); };
  const read = (asset: AssetId, size: Size) => {
    const value = piece.planes.get(asset);
    if (value === undefined) throw new AssetFailure({ kind: 'missing-asset', asset, message: `The published piece is missing asset ${asset}.` });
    if (!sameSize(value.size, size)) invalid(asset, 'A published asset has the wrong dimensions.');
    return value;
  };
  const masks = new Map<ObjectId, Plane<'u8'>>();
  for (const object of doc.objects) {
    const ref = object.produced.mask, value = read(ref.asset, ref.size);
    if (!('format' in value) || value.format !== 'u8' || !(value.data instanceof Uint8Array) || value.data.length !== ref.size.width * ref.size.height) {
      return invalid(ref.asset, 'A published mask is not a complete u8 plane.');
    }
    masks.set(object.id, value);
  }
  let depth: Plane<'f32'> | null = null;
  if (doc.analysis.depth !== null) {
    const ref = doc.analysis.depth.map, value = read(ref.asset, ref.size);
    if (!('format' in value) || value.format !== 'f32' || !(value.data instanceof Float32Array) || value.data.length !== ref.size.width * ref.size.height
      || !value.data.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) return invalid(ref.asset, 'Published depth must be a complete, finite f32 plane in [0, 1].');
    depth = value;
  }
  let plate: Rgb8 | null = null;
  if (doc.analysis.plate !== null) {
    const ref = doc.analysis.plate.image, value = read(ref.asset, ref.size);
    if ('format' in value || !(value.data instanceof Uint8Array) || !sameSize(ref.size, doc.frame.master.size)
      || value.data.length !== ref.size.width * ref.size.height * 3) return invalid(ref.asset, 'The published plate is not a complete master-size RGB image.');
    if (JSON.stringify(sortedMasks(doc)) !== JSON.stringify(doc.analysis.plate.forMasks)) return invalid(ref.asset, 'The published plate belongs to different masks.');
    plate = value;
  }
  if (doc.objects.length > 0 && plate === null) {
    throw new AssetFailure({ kind: 'missing-asset', asset: null, message: 'The published layers need a background plate.' });
  }
  return { kind: 'legacy', masks, depth, plate };
}

export function tiltNeedsPermission(): boolean {
  return typeof DeviceOrientationEvent !== 'undefined' && 'requestPermission' in DeviceOrientationEvent
    && typeof DeviceOrientationEvent.requestPermission === 'function';
}

/** Only animation-frame timestamps advance Motion; a pause retains the last submitted time. */
export function createViewerMotionClock(motion: LegacySceneDocument['motion']) {
  const count = frameCount(motion, LOOP_FPS);
  let origin: number | null = null, elapsed = 0, retained = 0;
  return {
    frame(timestamp: number): number {
      if (!Number.isFinite(timestamp)) throw new RangeError('The Motion timestamp must be finite.');
      origin ??= timestamp;
      elapsed = Math.max(elapsed, Math.max(0, timestamp - origin));
      return frameAtElapsed(retained + elapsed, count);
    },
    stop(): void { retained += elapsed; origin = null; elapsed = 0; },
  };
}

/** A view owns decoded pixels, GL and inputs only. It never opens the editor or its services. */
export function createViewer({ canvas, piece }: { readonly canvas: HTMLCanvasElement; readonly piece: ViewerPiece }) {
  let status: ViewerStatus = { kind: 'idle' }, input: ViewerInput = 'none';
  let renderer: Renderer | null = null, master: ImageBitmap | null = null;
  let scene: RenderScene | null = null, geometryKey = '';
  let paintPlanes: readonly PaintPlane[] = [];
  let removalMasks: ReadonlyMap<AssetId, Plane<'u8'>> | undefined;
  let disposed = false, running = false, epoch = 0;
  let pending: Promise<void> | null = null, request = 0, viewId = 0;
  const motionClock = createViewerMotionClock(piece.document.motion);
  let previous: number | null = null;
  let pointer: Vec2 = { x: .5, y: .5 }, center: Vec2 = pointer;
  let tiltTarget: Vec2 = pointer, tiltAt = -Infinity;
  let tiltAttempt: { cleanup: (() => void)[]; result: Promise<TiltPermission>; resolve(value: TiltPermission): void } | null = null;
  let tiltGranted = false;
  const tilt = createTiltSource();
  const listeners = new Set<() => void>();
  const notify = (): void => { for (const listener of listeners) listener(); };
  function setStatus(next: ViewerStatus): void {
    if (JSON.stringify(next) !== JSON.stringify(status)) { status = next; notify(); }
  }
  function setInput(next: ViewerInput): void { if (input !== next) { input = next; notify(); } }
  function endTilt(): void {
    const old = tiltAttempt; tiltAttempt = null; tiltAt = -Infinity;
    if (old !== null) { for (const dispose of old.cleanup.splice(0).reverse()) dispose(); old.resolve('unsupported'); }
  }
  function stop(): void {
    running = false; epoch++;
    cancelAnimationFrame(request); request = 0;
    motionClock.stop(); previous = null;
    endTilt();
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerleave', leave);
    setInput('none');
    if (!disposed && status.kind !== 'failed') setStatus({ kind: 'stopped' });
  }
  function release(): void {
    renderer?.dispose(); renderer = null;
    master?.close(); master = null; scene = null; geometryKey = ''; removalMasks = undefined; paintPlanes = [];
  }
  function fail(failure: ViewerFailure): void {
    setStatus({ kind: 'failed', failure }); stop(); release();
  }
  const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
  function move(event: PointerEvent): void {
    if (event.pointerType === 'touch') return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    pointer = { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  }
  function leave(): void { pointer = { x: .5, y: .5 }; }
  function requestTilt(): Promise<TiltPermission> {
    if (disposed || !running || typeof DeviceOrientationEvent === 'undefined') return Promise.resolve('unsupported');
    if (tiltAttempt !== null) return tiltAttempt.result;
    const deferred = Promise.withResolvers<TiltPermission>();
    const cleanup: (() => void)[] = [];
    const attempt = { cleanup, result: deferred.promise, resolve: deferred.resolve };
    tiltAttempt = attempt;
    // Calling source here (before any await) preserves the initiating iOS gesture.
    void tilt.source({
      valid: () => running && !disposed && tiltAttempt === attempt,
      dispose(action) {
        if (tiltAttempt !== attempt) { action(); return; }
        attempt.cleanup.push(action); tiltGranted = true;
        deferred.resolve('granted');
      },
      target(target, observation) {
        if (tiltAttempt !== attempt || observation?.state !== 'tracking') return;
        tiltTarget = target; tiltAt = observation.capturedAt;
      },
      failed() {
        if (tiltAttempt !== attempt) return;
        deferred.resolve(tiltNeedsPermission() ? 'denied' : 'unsupported');
        endTilt();
      },
    });
    return attempt.result;
  }
  function draw(now: number): void {
    if (renderer === null || scene === null) return;
    const doc = piece.document, rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const geometry = createPerspectiveGeometry({
      aperture: apertureFromRect(containedImageRect(rect, doc.frame.master.size), { width: window.innerWidth, height: window.innerHeight }),
      crop: parallaxMargin(doc.motion.parallax), neutralDistance: 1, nearFactor: 1.1, farFactor: 2,
    });
    const key = JSON.stringify(geometry);
    if (key !== geometryKey) {
      const coverage = liveCoverage(doc, geometry);
      // Published RGB is already prepared. Only the viewport-dependent hole and key are transient.
      const livePlate = coverage === null || scene.plate === null || scene.depth === null ? null
        : { key: coverage.key, image: scene.plate, hole: liveHoleMask(doc, scene.masks, coverage, removalMasks), depth: scene.depth };
      renderer.setScene({ ...scene, livePlate }); geometryKey = key;
      if (paintPlanes.length > 0) {
        const paint = renderer.setPaintPlanes(paintPlanes);
        if (paint.kind === 'refused') throw new Error(paint.reason);
      }
    }
    const usesTilt = now - tiltAt <= 250;
    const target = usesTilt ? tiltTarget : pointer;
    setInput(usesTilt ? 'tilt' : 'pointer');
    const alpha = 1 - Math.exp(-Math.max(0, now - (previous ?? now)) / 70); previous = now;
    center = { x: center.x + (target.x - center.x) * alpha, y: center.y + (target.y - center.y) * alpha };
    const envelope = lateralEnvelope(geometry);
    const eye = constrainEye({ x: (center.x - .5) * 2 * envelope.max.x, y: -(center.y - .5) * 2 * envelope.max.y }, geometry);
    const frame = doc.motion.enabled ? motionClock.frame(now) : 0;
    const result = renderer.renderPerspective({ geometry, eye, frame, sceneGeneration: 1, viewId: ++viewId, showSelection: false });
    setStatus({ kind: 'running', limitation: result.reason });
  }
  function tick(now: number): void {
    if (!running || disposed) return;
    try { draw(now); }
    catch (error) { fail({ kind: 'render-failure', message: message(error) }); return; }
    if (running) request = requestAnimationFrame(tick);
  }
  async function prepare(): Promise<void> {
    setStatus({ kind: 'loading' });
    let assets: ReturnType<typeof resolveViewerAssets>;
    try { assets = resolveViewerAssets(piece); }
    catch (error) {
      fail(error instanceof AssetFailure ? error.failure : { kind: 'render-failure', message: message(error) }); return;
    }
    paintPlanes = assets.kind === 'composition' ? assets.paint : [];
    let plate = assets.plate;
    try {
      if ('assets' in piece && assets.kind === 'composition') {
        const bitmap = await createImageBitmap(assets.masterPng);
        if (disposed) { bitmap.close(); return; }
        master = bitmap;
        if (!sameSize(bitmap, piece.document.frame.master.size)) throw new Error('The decoded PNG does not match the published master dimensions.');
        if (assets.repairPng !== null) {
          const repair = await createImageBitmap(assets.repairPng);
          try {
            if (disposed) return;
            if (!sameSize(repair, piece.document.frame.master.size)) throw new Error('The decoded repair does not match the published master dimensions.');
            const canvas = new OffscreenCanvas(repair.width, repair.height), context = canvas.getContext('2d', { willReadFrequently: true });
            if (context === null) throw new Error('The published repair image could not be read.');
            context.drawImage(repair, 0, 0);
            const rgba = context.getImageData(0, 0, repair.width, repair.height).data, data = new Uint8Array(repair.width * repair.height * 3);
            for (let pixel = 0; pixel < data.length / 3; pixel++) data.set(rgba.subarray(pixel * 4, pixel * 4 + 3), pixel * 3);
            plate = { size: { width: repair.width, height: repair.height }, data };
          } finally { repair.close(); }
        }
      } else if ('source' in piece) {
        const photo = await decodePhoto(new File([piece.source], piece.document.frame.original.name, { type: piece.source.type || piece.document.frame.original.mediaType }));
        if (disposed) { photo.bitmap.close(); return; }
        master = photo.bitmap;
        if (!sameSize(photo.pixels, piece.document.frame.master.size)) throw new Error('The decoded source does not match the published master dimensions.');
      }
    } catch (error) { if (!disposed) fail({ kind: 'decode-failure', message: message(error) }); return; }
    if (disposed) return;
    try {
      const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true });
      if (gl === null || gl.getExtension('EXT_color_buffer_float') === null) {
        fail({ kind: 'no-webgl2', message: 'This device cannot show the live piece. Showing its poster.' }); return;
      }
      renderer = createRenderer(canvas);
      if (master !== null) {
        const common = { doc: piece.document, master, masks: assets.masks, depth: assets.depth, plate, selected: null };
        if (assets.kind === 'composition') {
          scene = { ...common, localEffects: assets.localEffects, compositing: assets.compositing, backgroundDepth: assets.backgroundDepth };
          removalMasks = assets.masksByAsset;
        } else scene = common;
      }
    } catch (error) { fail({ kind: 'render-failure', message: message(error) }); }
  }
  async function start(): Promise<void> {
    if (disposed || running || status.kind === 'failed') return;
    const current = ++epoch;
    if (scene === null) {
      pending ??= prepare().finally(() => { pending = null; });
      await pending;
    }
    if (disposed || current !== epoch || scene === null) return;
    running = true;
    canvas.addEventListener('pointermove', move); canvas.addEventListener('pointerleave', leave);
    if (tiltGranted || (!tiltNeedsPermission() && window.matchMedia('(pointer: coarse)').matches)) void requestTilt();
    request = requestAnimationFrame(tick);
  }
  function lost(event: Event): void {
    event.preventDefault();
    if (!disposed) fail({ kind: 'context-lost', message: 'The live picture was interrupted. Showing its poster.' });
  }
  canvas.addEventListener('webglcontextlost', lost);
  return {
    start, stop, requestTilt,
    status: (): ViewerStatus => status,
    input: (): ViewerInput => input,
    /** Real renderer readback for dev scenarios; no authoring state or production pixels are exposed. */
    debug: (): Renderer['debug'] => NOISY_DEV ? renderer?.debug ?? null : null,
    tiltNeedsPermission,
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); },
    dispose(): void {
      if (disposed) return;
      disposed = true; stop(); release(); canvas.removeEventListener('webglcontextlost', lost);
      setStatus({ kind: 'disposed' }); listeners.clear();
    },
  };
}
export type Viewer = ReturnType<typeof createViewer>;
