import { newDocument, newObject } from '../core/defaults.ts';
import { isAssetId, isSceneId, isObjectId, type AssetId, type ObjectId } from '../core/ids.ts';
import { SCENE_VERSION } from '../core/migrate.ts';
import { sceneDocumentSchema } from '../core/schema.ts';
import type { SceneDocument } from '../core/types.ts';
import type { ImagePoint, Oklch, Plane, Rgb8 } from '../core/raster.ts';
import { applyProduce, sortedMasks } from '../core/produce.ts';
import { createAnalysisDriver } from './driver.ts';
import { createProducts, productAsset } from './products.ts';
import { decodePhoto, type DecodedPhoto } from '../photo/decode.ts';
import { photoStats } from '../photo/stats.ts';
import { makeThumbnail } from '../photo/thumbnail.ts';
import { encodePng, savePng } from '../export/png.ts';
import { renderStereo, STEREO_3DS_SIZE } from '../export/stereo.ts';
import type { Size } from '../core/raster.ts';
import { readBuildId } from '../platform/build-id.ts';
import { applyEdit } from '../core/reduce.ts';
import type { Edit, StylePatch } from '../core/edits.ts';
import { createRenderer } from '../render/renderer.ts';
import type { Renderer } from '../render/types.ts';
import { renderPng } from '../export/png.ts';
import { labelAt, plateNeeded } from '../core/derive.ts';
import { bundledLock } from '../analysis/bundled-lock.ts';
import { maskedDepth, objectProduced } from './objects.ts';
import { createLoopStepper, loopTapPoint } from './loop.ts';
import { frameCount, effectiveOrbit, loopZoom, type Vec2 } from '../core/motion.ts';
import { LOOP_FPS } from '../render/loop.ts';
import { createWindowDriver } from './window.ts';
import { createTiltDriver, type Orientation } from './tilt.ts';
import type { ViewHost } from './view-driver.ts';

/** D2a consumes doc and master; D3 makes fresh worker bitmaps from masterPixels. */
export type DemoScene = {
  readonly doc: SceneDocument;
  readonly master: ImageBitmap;
  readonly masterPixels: ImageData;
  readonly masterPng: Blob;
  readonly path: DecodedPhoto['path'];
  readonly masks: ReadonlyMap<ObjectId, Plane<'u8'>>;
  readonly depth: Plane<'f32'> | null;
  readonly plate: Rgb8 | null;
  readonly selected: ObjectId | null;
};
export type DemoState = {
  readonly status: string; readonly scene: DemoScene | null;
  readonly analysisStatus: string; readonly analysisTiming: { readonly stage: string; readonly ms: number } | null;
  readonly windowEnabled: boolean;
  readonly tiltEnabled: boolean;
};
export type DemoSession = ReturnType<typeof createDemoSession>;

async function assetId(bytes: ArrayBuffer): Promise<AssetId> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = [...hash].map((value) => value.toString(16).padStart(2, '0')).join('');
  if (!isAssetId(hex)) throw new Error('The photo hash is invalid.');
  return hex;
}

async function importScene(file: File): Promise<DemoScene> {
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  const decoded = await decodePhoto(file);
  try {
    const stats = photoStats(makeThumbnail(decoded.bitmap), seed);
    const [masterPng, sourceAsset] = await Promise.all([encodePng(decoded.pixels), file.arrayBuffer().then(assetId)]);
    const masterAsset = await assetId(await masterPng.arrayBuffer());
    const id = crypto.randomUUID();
    if (!isSceneId(id)) throw new Error('The scene id is invalid.');
    const doc = newDocument({
      id, title: [...(file.name.replace(/\.[^.]+$/, '') || 'Photo')].slice(0, 80).join(''),
      now: new Date().toISOString(), seed, writer: readBuildId(), importedOn: navigator.userAgent,
      frame: {
        source: { asset: sourceAsset, mediaType: file.type, byteLength: file.size },
        master: { asset: masterAsset, size: { width: decoded.pixels.width, height: decoded.pixels.height } },
        original: { name: [...(file.name || 'Photo')].slice(0, 255).join(''), mediaType: file.type, size: decoded.original },
      },
      analysis: { ...stats, depth: null, plate: null, autoSubject: 'pending' },
    });
    if (NOISY_DEV) sceneDocumentSchema(SCENE_VERSION).parse(doc);
    return { doc, master: decoded.bitmap, masterPixels: decoded.pixels, masterPng, path: decoded.path, masks: new Map(), depth: null, plate: null, selected: null };
  } catch (error) {
    decoded.bitmap.close();
    throw error;
  }
}

export function createDemoSession() {
  let state: DemoState = { status: 'Drop a photo', scene: null, analysisStatus: 'Fetching models 0%', analysisTiming: null, windowEnabled: false, tiltEnabled: false };
  const products = createProducts();
  let generation = 0;
  let readyScene: { readonly generation: number; readonly id: SceneDocument['id'] } | null = null;
  let importController: AbortController | null = null;
  let baseline: SceneDocument | null = null;
  let objectEpoch = 0;
  const tapControllers = new Set<AbortController>();
  const invalidateTaps = (): void => {
    objectEpoch++;
    for (const controller of tapControllers) controller.abort();
    tapControllers.clear(); pendingMask = Promise.resolve();
  };
  let pendingMask = Promise.resolve();
  let renderer: Renderer | null = null;
  let renderError: unknown = null;
  let stageCanvas: HTMLCanvasElement | null = null;
  const loop = createLoopStepper((frame) => { renderer?.renderFrame(frame); }, (error) => {
    renderError = error;
    state = { ...state, status: error instanceof Error ? error.message : String(error) };
    for (const listener of listeners) listener(state);
  });
  const listeners = new Set<(state: DemoState) => void>();
  const publish = (next: Pick<DemoState, 'status' | 'scene'>, refuseOnRenderError = false): void => {
    const scene = next.scene === null ? null : { ...next.scene, ...products.forScene(next.scene.doc) };
    let status = next.status;
    if (status === 'Still analyzing…' && analysis.snapshot().decoderReady) status = 'Ready';
    try { if (scene !== null) draw(scene); }
    catch (error) {
      loop.stop(); stopView();
      // Failed imports retain the previous master; other edits still publish their document.
      if (refuseOnRenderError) throw error;
      status = error instanceof Error ? error.message : String(error);
    }
    state = { status, scene, analysisStatus: analysis.snapshot().status, analysisTiming: analysis.lastTiming(), windowEnabled: windowView.enabled(), tiltEnabled: tiltView.enabled() };
    for (const listener of listeners) listener(state);
  };
  const setDocument = (doc: SceneDocument): void => {
    const scene = state.scene;
    if (scene === null || scene.doc.id !== doc.id) throw new Error('The document belongs to another photo.');
    if (NOISY_DEV) sceneDocumentSchema(SCENE_VERSION).parse(doc);
    const before = sortedMasks(scene.doc), after = sortedMasks(doc);
    const masksChanged = before.length !== after.length || before.some((asset, i) => asset !== after[i]);
    publish({ status: state.status, scene: { ...scene, doc } });
    if (masksChanged && (doc.motion.enabled || viewEnabled())) {
      const current = generation;
      void requestPlateIfNeeded().catch((error: unknown) => {
        if (current === generation) publish({ ...state, status: error instanceof Error ? error.message : String(error) });
      });
    }
  };
  const analysis = createAnalysisDriver({
    read: () => state.scene, products, changed: () => publish(state), windowEnabled: () => viewEnabled(),
    produce(product) {
      if (state.scene === null) return;
      if (product.kind === 'plate' && state.scene.doc.objects.length === 0) return;
      const now = new Date().toISOString();
      const result = applyProduce(state.scene.doc, product, now);
      if (result.kind === 'refused') throw new Error(result.detail);
      let doc = result.doc;
      if (product.kind === 'depth') {
        const depth = products.depths.get(product.depth.map.asset);
        if (depth !== undefined) for (const object of doc.objects) {
          if (object.produced.depth !== null) continue;
          const mask = products.masks.get(object.produced.mask.asset);
          const stats = mask === undefined ? null : maskedDepth(mask, depth);
          if (stats === null) continue;
          const update = applyProduce(doc, { kind: 'object.depth', id: object.id, depth: stats }, now);
          if (update.kind === 'refused') throw new Error(update.detail);
          doc = update.doc;
        }
      }
      setDocument(doc);
    },
  });
  const viewHost = {
    read: () => state.scene?.doc ?? null,
    generation: () => generation,
    draw: (camera, frame) => renderer?.renderView(camera, frame),
    changed: () => publish(state),
    failed: (status) => publish({ ...state, status }),
  } satisfies ViewHost;
  const windowView = createWindowDriver({ ...viewHost, openTracker: () => analysis.openFaceTracker() });
  const tiltView = createTiltDriver(viewHost);
  function viewEnabled(): boolean { return windowView.enabled() || tiltView.enabled(); }
  function activeView() { return tiltView.enabled() ? tiltView : windowView; }
  function stopView(): void { windowView.stop(); tiltView.stop(); }
  async function setView(mode: 'window' | 'tilt', enabled: boolean): Promise<void> {
    const view = mode === 'window' ? windowView : tiltView;
    if (!enabled) { view.stop(); publish({ ...state, status: 'Ready' }); return; }
    if (state.scene === null || readyScene?.generation !== generation || !analysis.snapshot().modelsReady) return;
    (mode === 'window' ? tiltView : windowView).stop();
    const current = generation;
    publish({ ...state, status: 'Ready' });
    await view.start();
    if (current === generation && view.enabled()) void requestPlateIfNeeded().catch((error: unknown) => {
      if (current === generation && view.enabled()) publish({ ...state, status: error instanceof Error ? error.message : String(error) });
    });
  }
  function draw(scene: DemoScene): void {
    if (renderer === null) {
      if (renderError !== null) throw renderError;
      return;
    }
    renderer.setScene({ doc: scene.doc, master: scene.master, masks: scene.masks, depth: scene.depth, plate: scene.plate, selected: scene.selected });
    if (viewEnabled()) {
      const view = activeView();
      loop.stop(); renderer.renderView(view.camera(), view.frame());
    } else if (scene.doc.motion.enabled && readyScene?.generation === generation && readyScene.id === scene.doc.id && !plateNeeded(scene.doc)) {
      if (loop.running()) renderer.renderFrame(loop.frame());
      loop.start(frameCount(scene.doc.motion, LOOP_FPS), scene.doc.id);
    } else {
      loop.stop(); renderer.renderStill();
    }
  }
  function edit(edit: Edit): void {
    if (state.scene === null) return;
    const result = applyEdit(state.scene.doc, edit, new Date().toISOString());
    if (result.kind === 'refused') {
      publish({ ...state, status: `The edit was refused: ${result.detail}` }); return;
    }
    if (result.kind === 'unchanged') return;
    const scene = { ...state.scene, doc: result.doc };
    publish({ status: edit.kind === 'motion' ? state.status : 'Ready', scene });
  }
  async function requestPlateIfNeeded(): Promise<void> {
    const current = generation;
    await pendingMask;
    if (current !== generation || readyScene?.generation !== current) return;
    return analysis.requestPlateIfNeeded();
  }
  function select(id: ObjectId | null): void {
    const scene = state.scene;
    if (scene === null) return;
    if (id !== null && !scene.doc.objects.some((object) => object.id === id)) throw new Error('The object is not in this photo.');
    publish({ status: 'Ready', scene: { ...scene, selected: id } });
  }
  function tap(at: ImagePoint): Promise<void> {
    if (![at.x, at.y].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) return Promise.resolve();
    const decoder = analysis.decoder();
    if (state.scene === null || readyScene?.generation !== generation) return Promise.resolve();
    if (decoder === null) { publish({ ...state, status: 'Still analyzing…' }); return Promise.resolve(); }
    // Undo the preview zoom only. Parallax displacement is not undone;
    // the remaining error is at most 2% of each frame axis.
    const zoomed = (viewEnabled() && state.scene.depth !== null) || (loop.running() && effectiveOrbit(state.scene.doc.motion) > 0);
    const point = zoomed ? loopTapPoint(at, loopZoom(state.scene.doc.motion.parallax)) : at;
    const current = generation, epoch = objectEpoch;
    const controller = new AbortController(); tapControllers.add(controller);
    const valid = (): boolean => current === generation && epoch === objectEpoch && !controller.signal.aborted;
    const run = async (): Promise<void> => {
      const scene = state.scene;
      if (!valid() || scene === null) return;
      const hit = labelAt(scene.doc, scene.masks, point);
      if (hit !== null) { select(hit); return; }
      if (scene.doc.objects.length >= 8) { publish({ ...state, status: 'That is enough objects for one photo' }); return; }
      const decoded = await decoder.decode([{ at: point, label: 'include' }], controller.signal);
      if (!valid() || state.scene === null) return;
      if (!decoded.ok) throw new Error(`Tapping failed: ${JSON.stringify(decoded.error)}`);
      const mask = decoded.value.candidates[0].mask;
      const asset = await productAsset(mask.data);
      if (!valid() || state.scene === null) return;
      const lock = bundledLock();
      if (!lock.ok) throw new Error(lock.error);
      const latest = state.scene;
      const produced = objectProduced({ model: lock.value.ops.decode.model, at: point, asset, mask,
        master: latest.doc.frame.master.size, depth: latest.depth, thumbnail: makeThumbnail(latest.master), seed: latest.doc.seed });
      if (produced === null) { publish({ ...state, status: 'Nothing there' }); return; }
      const id = crypto.randomUUID();
      if (!isObjectId(id)) throw new Error('The object id is invalid.');
      const object = { ...newObject({ id, produced, existing: latest.doc.objects }), subject: true };
      const result = applyEdit(latest.doc, { kind: 'object.add', object }, new Date().toISOString());
      if (result.kind === 'refused') throw new Error(result.detail);
      products.putMask(asset, mask);
      setDocument(result.doc); select(id);
    };
    pendingMask = pendingMask.then(run).catch((error: unknown) => {
      if (valid()) publish({ ...state, status: error instanceof Error ? error.message : String(error) });
    }).finally(() => { tapControllers.delete(controller); });
    return pendingMask;
  }
  async function importSource(source: (signal: AbortSignal) => Promise<File>): Promise<void> {
    loop.stop(); stopView(); readyScene = null;
    importController?.abort();
    const controller = new AbortController();
    importController = controller;
    invalidateTaps();
    const current = analysis.beginImport(); generation = current; pendingMask = Promise.resolve();
    const retained = state.scene;
    // Keep the first look on refusal, with no references to products we just dropped.
    const firstLook = retained === null ? null : { ...retained, doc: { ...retained.doc, analysis: { ...retained.doc.analysis, depth: null, plate: null }, objects: [] }, selected: null };
    publish({ status: 'Importing…', scene: firstLook });
    try {
      const file = await source(controller.signal);
      if (current !== generation) return;
      const scene = await importScene(file);
      if (current !== generation) { scene.master.close(); return; }
      const previous = state.scene;
      readyScene = { generation: current, id: scene.doc.id };
      try { publish({ status: 'Ready', scene }, true); }
      catch (error) { readyScene = null; scene.master.close(); throw error; }
      baseline = scene.doc;
      previous?.master.close();
      await analysis.sceneReady(current, scene.masterPixels);
    } catch (error) {
      if (current === generation) {
        analysis.importFailed(current);
        publish({ status: error instanceof Error ? error.message : String(error), scene: state.scene });
      }
    }
  }
  async function exportStereo(size: Size = STEREO_3DS_SIZE) {
    const scene = state.scene;
    if (scene === null) throw new Error('Open a photo before downloading.');
    if (renderer === null) throw new Error('The photo renderer is unavailable.');
    return renderStereo(renderer, scene.doc, size);
  }
  return {
    products,
    tap, select,
    setRecolor(color: Oklch | null): void {
      const id = state.scene?.selected;
      if (id === null || id === undefined) return;
      edit({ kind: 'object.set', id, patch: { recolor: color === null ? { kind: 'none' } : { kind: 'target', color } } });
    },
    reset(): void {
      const scene = state.scene;
      if (scene === null || baseline === null || baseline.id !== scene.doc.id) return;
      stopView();
      invalidateTaps();
      const product = scene.doc.analysis.depth;
      const depth = product === null ? null : products.depths.get(product.map.asset) ?? null;
      products.clear();
      let doc = baseline;
      if (product !== null && depth !== null) {
        products.putDepth(product.map.asset, depth);
        const result = applyProduce(doc, { kind: 'depth', depth: product }, new Date().toISOString());
        if (result.kind === 'refused') throw new Error(result.detail);
        doc = result.doc;
      }
      setDocument(doc);
      publish({ status: 'Reset', scene: { ...(state.scene ?? scene), selected: null } });
    },
    analysis,
    setDocument,
    snapshot: (): DemoState => state,
    subscribe(listener: (state: DemoState) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    importFile(file: File): Promise<void> { return importSource(async () => file); },
    importUrl(url: string, name: string): Promise<void> {
      return importSource(async (signal) => {
        const target = new URL(url, location.href);
        if (target.origin !== location.origin) throw new Error('The sample must load from this site.');
        const response = await fetch(target, { signal });
        if (!response.ok) throw new Error(`The sample could not load (HTTP ${response.status}).`);
        return new File([await response.blob()], name, { type: response.headers.get('content-type') ?? '' });
      });
    },
    requestPlateIfNeeded,
    setWindow: (enabled: boolean): Promise<void> => setView('window', enabled),
    setTilt: (enabled: boolean): Promise<void> => setView('tilt', enabled),
    injectOrientation: (orientation: Orientation): void => tiltView.injectOrientation(orientation),
    injectFace: (center: Vec2 | null): void => windowView.injectFace(center),
    windowReady: (): boolean => windowView.ready(),
    windowFrames: (): number => windowView.trackedFrames(),
    windowTracks: (): readonly MediaStreamTrack[] => windowView.tracks(),
    setMotion(patch: Partial<SceneDocument['motion']>): void {
      const scene = state.scene;
      if (scene === null) throw new Error('Open a photo before enabling Motion.');
      edit({ kind: 'motion', patch });
      const current = generation;
      if (patch.enabled === true && state.scene?.doc.motion.enabled) void requestPlateIfNeeded().catch((error: unknown) => {
        if (current !== generation) return;
        publish({ ...state, status: error instanceof Error ? error.message : String(error) });
      });
    },
    injectMask(plane: { width: number; height: number; data: Uint8Array }): void {
      if (!NOISY_DEV) throw new Error('Mask injection is available only in dev builds.');
      const scene = state.scene;
      if (scene === null) throw new Error('Open a photo before injecting a mask.');
      const { width, height, data } = plane;
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || data.length !== width * height) throw new Error('Invalid injected mask plane.');
      const current = generation, epoch = objectEpoch;
      const mask: Plane<'u8'> = { format: 'u8', size: { width, height }, data: data.slice() };
      // This fixture object exists only to exercise plate freshness before D4.
      pendingMask = pendingMask.then(async () => {
        const asset = await productAsset(mask.data);
        if (current !== generation || epoch !== objectEpoch || state.scene === null) return;
        const doc = state.scene.doc;
        const color = doc.analysis.colors[0].lab;
        const model = doc.analysis.depth?.model;
        if (model === undefined) throw new Error('Wait for depth before injecting a mask.');
        const next = sceneDocumentSchema(SCENE_VERSION).parse({ ...doc, objects: [...doc.objects, {
          id: crypto.randomUUID(), name: 'Injected plate fixture', subject: true, recolor: { kind: 'none' }, symbols: 'slider', motion: { kind: 'none' }, thickness: 1,
          produced: { model, selection: { kind: 'taps', points: [{ at: { x: 0.5, y: 0.5 }, label: 'include' }], candidate: 0 }, mask: { asset, format: 'u8', size: mask.size }, bounds: { x: 0, y: 0, ...doc.frame.master.size }, depth: null, color: { mean: color, clusters: [{ lab: color, weight: 0.5 }, { lab: color, weight: 0.5 }] } },
        }] });
        products.putMask(asset, mask); setDocument(next);
      });
      // requestPlateIfNeeded awaits the original promise and reports injection failures.
      void pendingMask.catch(() => undefined);
    },
    async downloadPng(): Promise<Blob> {
      const scene = state.scene;
      if (scene === null) throw new Error('Open a photo before downloading.');
      if (renderer === null) throw new Error('The photo renderer is unavailable.');
      return renderPng(renderer);
    },
    async savePng(): Promise<void> {
      const scene = state.scene;
      if (scene === null) throw new Error('Open a photo before downloading.');
      if (renderer === null) throw new Error('The photo renderer is unavailable.');
      savePng(await renderPng(renderer), scene.doc.title);
    },
    exportStereo,
    async saveStereo(): Promise<void> {
      const { left, mpo } = await exportStereo();
      for (const [blob, name] of [[mpo, 'HNI_0001.MPO'], [left, 'HNI_0001.JPG']] satisfies readonly (readonly [Blob, string])[]) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url; link.download = name; link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    },
    setStyle(patch: StylePatch): void { edit({ kind: 'style', patch }); },
    setSurface(patch: Partial<SceneDocument['surface']>): void { edit({ kind: 'surface', patch }); },
    setFry(fry: number): void { edit({ kind: 'fry', fry }); },
    frame: (): number => viewEnabled() ? activeView().frame() : loop.frame(),
    renderFrameAt(frame: number): void {
      if (renderer === null) throw new Error('Open a photo before rendering.');
      renderer.renderFrame(frame);
    },
    renderer: (): Renderer | null => renderer,
    attachCanvas(canvas: HTMLCanvasElement): () => void {
      loop.stop(); stopView(); renderer?.dispose(); renderer = null; renderError = null; stageCanvas = canvas;
      try {
        renderer = createRenderer(canvas);
        if (state.scene !== null) draw(state.scene);
      } catch (error) {
        loop.stop(); stopView(); renderer?.dispose(); renderer = null; renderError = error;
        publish({ ...state, status: error instanceof Error ? error.message : String(error) });
      }
      return () => {
        if (stageCanvas !== canvas) return;
        loop.stop(); stopView(); renderer?.dispose(); renderer = null; renderError = null; stageCanvas = null;
      };
    },
    reportError(error: unknown): void {
      publish({ status: error instanceof Error ? error.message : String(error), scene: state.scene });
    },
  };
}
