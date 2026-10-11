import type { AssetId, ObjectId } from '../core/ids.ts';
import type { Plane, Rgb8, Size } from '../core/raster.ts';
import type { SceneDocument } from '../core/types.ts';
import { sortedMasks } from '../core/produce.ts';
import { liveCoverage, liveHoleMask } from '../core/live-coverage.ts';
import { frameCount, parallaxMargin, type Vec2 } from '../core/motion.ts';
import { apertureFromRect, containedImageRect, createPerspectiveGeometry, constrainEye, lateralEnvelope } from '../core/perspective.ts';
import { decodePhoto } from '../photo/decode.ts';
import { createRenderer } from '../render/renderer.ts';
import { LOOP_FPS, frameAtElapsed } from '../render/loop.ts';
import type { Renderer, RenderScene } from '../render/types.ts';
import { createTiltSource } from './tilt.ts';

export type ViewerPiece = {
  readonly document: SceneDocument;
  readonly source: Blob;
  readonly planes: ReadonlyMap<AssetId, Plane<'u8'> | Plane<'f32'> | Rgb8>;
};
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

/** Resolve every declared raster before allocating GL resources. The loader owns schema parsing. */
export function resolveViewerAssets(piece: ViewerPiece): Pick<RenderScene, 'masks' | 'depth' | 'plate'> {
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
  return { masks, depth, plate };
}

export function tiltNeedsPermission(): boolean {
  return typeof DeviceOrientationEvent !== 'undefined' && 'requestPermission' in DeviceOrientationEvent
    && typeof DeviceOrientationEvent.requestPermission === 'function';
}

/** Only animation-frame timestamps advance Motion; a pause retains the last submitted time. */
export function createViewerMotionClock(motion: SceneDocument['motion']) {
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
    master?.close(); master = null; scene = null; geometryKey = '';
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
        : { key: coverage.key, image: scene.plate, hole: liveHoleMask(doc, scene.masks, coverage), depth: scene.depth };
      renderer.setScene({ ...scene, livePlate }); geometryKey = key;
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
    try {
      const photo = await decodePhoto(new File([piece.source], piece.document.frame.original.name, { type: piece.source.type || piece.document.frame.original.mediaType }));
      if (disposed) { photo.bitmap.close(); return; }
      master = photo.bitmap;
      if (!sameSize(photo.pixels, piece.document.frame.master.size)) throw new Error('The decoded source does not match the published master dimensions.');
    } catch (error) { if (!disposed) fail({ kind: 'decode-failure', message: message(error) }); return; }
    try {
      const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true });
      if (gl === null || gl.getExtension('EXT_color_buffer_float') === null) {
        fail({ kind: 'no-webgl2', message: 'This device cannot show the live piece. Showing its poster.' }); return;
      }
      renderer = createRenderer(canvas);
      if (master !== null) scene = { doc: piece.document, master, ...assets, selected: null };
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
