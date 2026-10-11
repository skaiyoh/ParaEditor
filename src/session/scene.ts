import { newDocument, newObject } from '../core/defaults.ts';
import { isAssetId, isSceneId, isObjectId, type AssetId, type ObjectId, type SceneId } from '../core/ids.ts';
import { SCENE_VERSION } from '../core/migrate.ts';
import { sceneDocumentSchema } from '../core/schema.ts';
import type { ObjectProduced, SceneDocument } from '../core/types.ts';
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
import { applyEdit, applyEdits } from '../core/reduce.ts';
import { EMPTY_HISTORY, coalesceKey, push, undo, redo, referencedAssets, type History, type HistoryEntry } from '../core/history.ts';
import type { Edit, StylePatch } from '../core/edits.ts';
import { createRenderer } from '../render/renderer.ts';
import { renderPng } from '../export/png.ts';
import { labelAt, plateNeeded } from '../core/derive.ts';
import { bundledLock } from '../analysis/bundled-lock.ts';
import { maskedDepth, objectProduced } from './objects.ts';
import { createLoopStepper, loopTapPoint, loopCanvas, encodeLoopGif } from './loop.ts';
import { frameCount, effectiveOrbit, loopZoom, parallaxMargin, type Vec2 } from '../core/motion.ts';
import { LOOP_FPS } from '../render/loop.ts';
import { movieFormat, recordMovie, exportWait } from '../export/movie.ts';
import { GIF_FPS, GIF_LONG_EDGE } from '../export/gif.ts';
import { createWindowSource } from './window.ts';
import { createTiltSource, type Orientation } from './tilt.ts';
import { liveCoverage } from '../core/live-coverage.ts';
import { apertureFromRect, containedImageRect, createPerspectiveGeometry, constrainEye, lateralEnvelope } from '../core/perspective.ts';
import type { PerspectiveRenderResult } from '../render/types.ts';
import { createViewDriver, type ViewHost, type ViewSubmission } from './view-driver.ts';
import { createProjectSession } from './projects.ts';
import { anchoredSize, candidateSize, draggedSize, maskArea, rankCandidates, refinementChoice, thresholdMask } from './refine.ts';

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
  readonly exportProgress: string | null;
  readonly status: string; readonly scene: DemoScene | null;
  readonly analysisStatus: string; readonly analysisTiming: { readonly stage: string; readonly ms: number } | null;
  readonly parallaxEnabled: boolean;
  readonly refiningObject: ObjectId | null;
  readonly refinementSize: number | null;
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
  let state: DemoState = { exportProgress: null, status: 'Drop a photo', scene: null, analysisStatus: 'Fetching models 0%', analysisTiming: null, parallaxEnabled: false, refiningObject: null, refinementSize: null };
  const products = createProducts();
  let history: History = EMPTY_HISTORY;
  let generation = 0;
  let readyScene: { readonly generation: number; readonly id: SceneDocument['id'] } | null = null;
  let importController: AbortController | null = null;
  let baseline: SceneDocument | null = null;
  let objectEpoch = 0;
  const tapControllers = new Set<AbortController>();
  type Refinement = {
    readonly id: ObjectId; readonly original: ObjectProduced;
    readonly generation: number; readonly epoch: number; readonly controller: AbortController;
    readonly startSize: number; readonly done: Promise<void>; readonly resolve: () => void;
    phase: 'decoding' | 'dragging' | 'committing';
    candidates: ReturnType<typeof rankCandidates> | null;
    anchor: number; size: number; revision: number; applied: number;
    preview: ObjectProduced | null; frame: number | null; work: Promise<void> | null;
    ready: Promise<void>;
  };
  let refinement: Refinement | null = null;
  const invalidateTaps = (): void => {
    cancelRefinement();
    objectEpoch++;
    for (const controller of tapControllers) controller.abort();
    tapControllers.clear(); pendingMask = Promise.resolve();
  };
  let pendingMask = Promise.resolve();
  let renderer: ReturnType<typeof createRenderer> | null = null;
  let exportJob: AbortController | null = null;
  let recordingJob: AbortController | null = null;
  function cancelExport(): void {
    exportJob?.abort(); exportJob = null; recordingJob = null;
    state = { ...state, exportProgress: null };
  }
  function exportProgress(controller: AbortController, text: string | null): void {
    if (exportJob !== controller) return;
    state = { ...state, exportProgress: text };
    for (const listener of listeners) listener(state);
  }
  const projects = createProjectSession(() => {
    if (renderer === null) throw new Error('The photo renderer is unavailable.');
    return renderPng(renderer);
  });
  let renderError: unknown = null;
  let stageCanvas: HTMLCanvasElement | null = null;
  const loop = createLoopStepper((frame) => { if (recordingJob === null) renderer?.renderFrame(frame); }, (error) => {
    renderError = error;
    state = { ...state, status: error instanceof Error ? error.message : String(error) };
    for (const listener of listeners) listener(state);
  });
  const listeners = new Set<(state: DemoState) => void>();
  const publish = (next: Pick<DemoState, 'status' | 'scene'>, refuseOnRenderError = false): void => {
    if (next.scene?.doc !== state.scene?.doc) cancelExport();
    const scene = next.scene === null ? null : { ...next.scene, ...products.forScene(next.scene.doc) };
    let status = next.status;
    if (status === 'Still analyzing…' && analysis.snapshot().decoderReady) status = 'Ready';
    if (status === 'Ready' && viewEnabled()) status = view.status();
    try { if (scene !== null) draw(scene); }
    catch (error) {
      loop.stop(); stopView();
      // Failed imports retain the previous master; other edits still publish their document.
      if (refuseOnRenderError) throw error;
      status = error instanceof Error ? error.message : String(error);
    }
    if (viewEnabled() && liveResult.kind === 'limited') status = `${view.status()} - ${liveResult.reason}`;
    state = { exportProgress: state.exportProgress, status, scene, analysisStatus: analysis.snapshot().status, analysisTiming: analysis.lastTiming(), parallaxEnabled: view.enabled(), refiningObject: refinement?.id ?? null, refinementSize: refinement?.size ?? null };
    if (scene !== null && readyScene?.generation === generation) projects.observe(scene.doc, products.masks);
    for (const listener of listeners) listener(state);
  };
  const setDocument = (doc: SceneDocument): void => {
    const scene = state.scene;
    if (scene === null || scene.doc.id !== doc.id) throw new Error('The document belongs to another photo.');
    if (NOISY_DEV) sceneDocumentSchema(SCENE_VERSION).parse(doc);
    const before = sortedMasks(scene.doc), after = sortedMasks(doc);
    const masksChanged = before.length !== after.length || before.some((asset, i) => asset !== after[i]);
    const selected = doc.objects.some((object) => object.id === scene.selected) ? scene.selected : null;
    publish({ status: state.status, scene: { ...scene, doc, selected } });
    if ((masksChanged && (doc.motion.enabled || viewEnabled())) || doc.objects.some((object) => object.hidden)) {
      const current = generation;
      void requestPlateIfNeeded().catch((error: unknown) => {
        if (current === generation) publish({ ...state, status: error instanceof Error ? error.message : String(error) });
      });
    }
  };
  const analysis = createAnalysisDriver({
    // A restored plate reference is persisted metadata, not a resident raster.
    // Reconciliation must request the missing transient product without changing the saved look.
    read: () => {
      const scene = state.scene;
      if (scene === null || scene.doc.analysis.plate === null || products.plates.has(scene.doc.analysis.plate.image.asset)) return scene;
      return { ...scene, doc: { ...scene.doc, analysis: { ...scene.doc.analysis, plate: null } } };
    }, products, changed: () => publish(state),
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
  let liveKey: string | null = null, liveViewId = 0;
  let liveResult: PerspectiveRenderResult = { kind: 'limited', reason: 'Parallax is off' };
  function liveGeometry(doc: SceneDocument) {
    const rect = stageCanvas?.getBoundingClientRect();
    if (rect === undefined || rect.width <= 0 || rect.height <= 0) return null;
    return createPerspectiveGeometry({
      aperture: apertureFromRect(containedImageRect(rect, doc.frame.master.size), { width: window.innerWidth, height: window.innerHeight }),
      crop: parallaxMargin(doc.motion.parallax), neutralDistance: 1, nearFactor: 1.1, farFactor: 2,
    });
  }
  function renderLive(scene: DemoScene, frame: number): ViewSubmission | void {
    if (renderer === null) return;
    const geometry = liveGeometry(scene.doc);
    if (geometry === null) return;
    const key = JSON.stringify([scene.doc.frame.master.asset, scene.doc.analysis.depth?.map.asset,
      sortedMasks(scene.doc), geometry]);
    if (key !== liveKey) {
      liveKey = key;
      const current = generation;
      // Publishing installs the new document after drawing; request against that installed state.
      queueMicrotask(() => {
        if (current !== generation || !viewEnabled() || liveKey !== key) return;
        void analysis.requestLivePlate(geometry).catch((error: unknown) => {
          if (current === generation && viewEnabled()) publish({ ...state, status: error instanceof Error ? error.message : String(error) });
        });
      });
    }
    const envelope = lateralEnvelope(geometry), center = view.diagnostics().center;
    const eye = constrainEye({ x: (center.x - .5) * 2 * envelope.max.x,
      y: -2 * (center.y - .5) * envelope.max.y }, geometry);
    liveResult = renderer.renderPerspective({ geometry, eye, sceneGeneration: generation, viewId: ++liveViewId, frame });
    return { eye: liveResult.kind === 'limited' ? { x: 0, y: 0, z: geometry.neutralDistance } : liveResult.eye,
      viewId: liveViewId, limitation: liveResult.reason };
  }
  const viewHost = {
    read: () => state.scene?.doc ?? null,
    generation: () => generation,
    draw: (_camera, frame) => { if (recordingJob === null && state.scene !== null) return renderLive(state.scene, frame); },
    changed: () => {
      if (!view.enabled()) { stopView(); publish({ ...state, status: view.status() }); return; }
      // Source status does not change scene products. The live clock owns drawing;
      // publishing the full scene here would prepare and draw a second frame.
      loop.stop();
      const status = liveKey !== null && liveResult.kind === 'limited' ? `${view.status()} - ${liveResult.reason}` : view.status();
      state = { ...state, status, parallaxEnabled: true };
      for (const listener of listeners) listener(state);
    },
    failed: (status) => { stopView(); publish({ ...state, status }); },
  } satisfies ViewHost;
  const cameraSource = createWindowSource({ openTracker: () => analysis.openFaceTracker() });
  const tiltSource = createTiltSource();
  const view = createViewDriver(viewHost, { camera: cameraSource.source, tilt: tiltSource.source });
  function viewEnabled(): boolean { return view.enabled(); }
  function stopView(): void {
    view.stop(); renderer?.endPerspective(); liveKey = null; liveResult = { kind: 'limited', reason: 'Parallax is off' };
    void analysis.requestLivePlate(null);
  }
  async function setParallax(enabled: boolean): Promise<void> {
    if (!enabled) { stopView(); publish({ ...state, status: 'Ready' }); return; }
    if (state.scene === null || readyScene?.generation !== generation || !analysis.snapshot().modelsReady) return;
    const starting = view.start();
    await starting;
  }
  function draw(scene: DemoScene): void {
    if (renderer === null) {
      if (renderError !== null) throw renderError;
      return;
    }
    const preview = refinement?.preview;
    const doc = preview === null || preview === undefined ? scene.doc : {
      ...scene.doc, objects: scene.doc.objects.map((object) => object.id === refinement?.id ? { ...object, produced: preview } : object),
    };
    const masks = preview === null || preview === undefined ? scene.masks : products.forScene(doc).masks;
    const selected = doc.objects.some((object) => object.id === scene.selected && !object.hidden) ? scene.selected : null;
    const live = analysis.livePlate(), geometry = liveGeometry(doc);
    const matchingLive = live.kind === 'ready' && geometry !== null && live.product.key === liveCoverage(doc, geometry)?.key ? live.product : null;
    renderer.setScene({ doc, master: scene.master, masks, depth: scene.depth, plate: scene.plate, selected,
      livePlate: matchingLive });
    if (viewEnabled()) {
      loop.stop(); renderLive(scene, view.frame());
    } else if (scene.doc.motion.enabled && readyScene?.generation === generation && readyScene.id === scene.doc.id && !plateNeeded(scene.doc) &&
      (scene.doc.analysis.plate === null || scene.plate !== null)) {
      if (loop.running()) renderer.renderFrame(loop.frame());
      loop.start(frameCount(scene.doc.motion, LOOP_FPS), scene.doc.id);
    } else {
      loop.stop(); renderer.renderStill();
    }
  }
  function retainMasks(doc: SceneDocument): void {
    products.retainMasks(new Set([...referencedAssets(history), ...doc.objects.map((object) => object.produced.mask.asset)]));
  }
  function record(edit: Edit, inverse: HistoryEntry['inverse'], doc: SceneDocument): void {
    const masks = new Map<AssetId, Plane<'u8'>>();
    for (const action of [edit, ...inverse]) {
      const asset = action.kind === 'object.add' ? action.object.produced.mask.asset
        : action.kind === 'object.refine' ? action.produced.mask.asset : null;
      const mask = asset === null ? undefined : products.masks.get(asset);
      if (asset !== null && mask !== undefined) masks.set(asset, mask);
    }
    history = push(history, { key: coalesceKey(edit), at: performance.now(), forward: [edit], inverse, masks }, doc);
    retainMasks(doc);
  }
  function edit(edit: Edit): void {
    cancelRefinement();
    if (state.scene === null) return;
    const result = applyEdit(state.scene.doc, edit, new Date().toISOString());
    if (result.kind === 'refused') {
      publish({ ...state, status: `The edit was refused: ${result.detail}` }); return;
    }
    if (result.kind === 'unchanged') return;
    record(edit, result.inverse, result.doc);
    setDocument(result.doc);
    if (edit.kind !== 'motion') publish({ ...state, status: viewEnabled() ? view.status() : 'Ready' });
  }
  function stepHistory(direction: 'undo' | 'redo'): void {
    invalidateTaps();
    if (state.scene === null) return;
    const entry = history[direction].at(-1);
    const step = direction === 'undo' ? undo(history) : redo(history);
    if (step === null || entry === undefined) return;
    const result = applyEdits(state.scene.doc, step.edits, new Date().toISOString());
    if (result.kind === 'refused') { publish({ ...state, status: `The edit was refused: ${result.detail}` }); return; }
    for (const [asset, mask] of entry.masks ?? []) products.putMask(asset, mask);
    history = step.history;
    retainMasks(result.doc);
    setDocument(result.doc);
  }
  async function requestPlateIfNeeded(): Promise<void> {
    const current = generation;
    await pendingMask;
    while (refinement !== null && current === generation) await refinement.done;
    if (current !== generation || readyScene?.generation !== current) return;
    return analysis.requestPlateIfNeeded();
  }
  function select(id: ObjectId | null): void {
    cancelRefinement();
    const scene = state.scene;
    if (scene === null) return;
    if (id !== null && !scene.doc.objects.some((object) => object.id === id)) throw new Error('The object is not in this photo.');
    publish({ status: 'Ready', scene: { ...scene, selected: id } });
  }
  function tap(at: ImagePoint): Promise<void> {
    cancelRefinement();
    if (![at.x, at.y].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) return Promise.resolve();
    const decoder = analysis.decoder();
    if (state.scene === null || readyScene?.generation !== generation) return Promise.resolve();
    if (decoder === null) { publish({ ...state, status: 'Still analyzing…' }); return Promise.resolve(); }
    const liveHit = viewEnabled() ? renderer?.hitTest(at) : null;
    if (viewEnabled() && (liveHit === null || liveHit === undefined || liveHit.kind === 'miss'
      || liveHit.sceneGeneration !== generation || liveHit.viewId !== liveViewId)) return Promise.resolve();
    if (liveHit?.kind === 'generated') {
      publish({ ...state, status: 'This revealed background cannot be selected. Recenter to select the original photo.' });
      return Promise.resolve();
    }
    if (liveHit?.kind === 'original' && liveHit.objectId !== null) { select(liveHit.objectId); return Promise.resolve(); }
    const zoomed = loop.running() && effectiveOrbit(state.scene.doc.motion) > 0;
    const point = liveHit?.kind === 'original' ? liveHit.sourceUV
      : zoomed ? loopTapPoint(at, loopZoom(state.scene.doc.motion.parallax)) : at;
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
        master: latest.doc.frame.master.size, depth: latest.depth, thumbnail: makeThumbnail(latest.master), seed: latest.doc.seed,
        selection: { kind: 'taps', points: [{ at: point, label: 'include' }], candidate: 0,
          size: candidateSize(rankCandidates(decoded.value.candidates), 0) } });
      if (produced === null) { publish({ ...state, status: 'Nothing there' }); return; }
      const id = crypto.randomUUID();
      if (!isObjectId(id)) throw new Error('The object id is invalid.');
      const object = { ...newObject({ id, produced, existing: latest.doc.objects }), subject: true };
      const result = applyEdit(latest.doc, { kind: 'object.add', object }, new Date().toISOString());
      if (result.kind === 'refused') throw new Error(result.detail);
      products.putMask(asset, mask);
      if (result.kind === 'applied') record({ kind: 'object.add', object }, result.inverse, result.doc);
      setDocument(result.doc); select(id);
    };
    pendingMask = pendingMask.then(run).catch((error: unknown) => {
      if (valid()) publish({ ...state, status: error instanceof Error ? error.message : String(error) });
    }).finally(() => { tapControllers.delete(controller); });
    return pendingMask;
  }
  function objectAt(at: ImagePoint): ObjectId | null {
    const scene = state.scene;
    if (scene === null || readyScene?.generation !== generation) return null;
    if (viewEnabled()) {
      const hit = renderer?.hitTest(at);
      return hit?.kind === 'original' && hit.sceneGeneration === generation && hit.viewId === liveViewId ? hit.objectId : null;
    }
    const zoomed = loop.running() && effectiveOrbit(scene.doc.motion) > 0;
    return labelAt(scene.doc, scene.masks, zoomed ? loopTapPoint(at, loopZoom(scene.doc.motion.parallax)) : at);
  }
  function refineValid(current: Refinement): boolean {
    return refinement === current && current.generation === generation && current.epoch === objectEpoch && !current.controller.signal.aborted;
  }
  function dropPreview(current: Refinement): void {
    const asset = current.preview?.mask.asset;
    if (asset !== undefined && asset !== current.original.mask.asset && !referencedAssets(history).has(asset) &&
      !state.scene?.doc.objects.some((object) => object.produced.mask.asset === asset)) dropMask(asset);
  }
  function dropMask(asset: AssetId): void {
    products.dropMask(asset);
  }
  function cancelRefinement(): boolean {
    const current = refinement;
    if (current === null) return false;
    refinement = null;
    current.controller.abort();
    if (current.frame !== null) cancelAnimationFrame(current.frame);
    dropPreview(current); current.resolve();
    publish(state);
    return true;
  }
  async function produceRefinement(current: Refinement): Promise<void> {
    const scene = state.scene, candidates = current.candidates;
    if (!refineValid(current) || scene === null || candidates === null || current.revision === current.applied) return;
    const revision = current.revision;
    if (current.size === current.startSize) {
      dropPreview(current); current.preview = null; current.applied = revision; draw(scene); return;
    }
    const size = anchoredSize(current.size, current.startSize, current.anchor);
    const choice = refinementChoice(size);
    const candidate = candidates[choice.rank];
    const mask = thresholdMask(candidate.mask, choice.threshold);
    const asset = await productAsset(mask.data);
    if (!refineValid(current) || current.revision !== revision || state.scene === null) return;
    const original = current.original.selection;
    const points = original.kind === 'taps' ? original.points : [original.seed];
    const point = points[0];
    if (point === undefined) return;
    const produced = objectProduced({ model: current.original.model, at: point.at, asset, mask,
      master: scene.doc.frame.master.size, depth: state.scene.depth, thumbnail: makeThumbnail(scene.master), seed: scene.doc.seed,
      selection: { ...original, candidate: candidate.candidate, size } });
    if (produced === null) { cancelRefinement(); return; }
    dropPreview(current);
    products.putMask(asset, mask); current.preview = produced; current.applied = revision;
    draw(state.scene);
  }
  function scheduleRefinement(current: Refinement): void {
    if (!refineValid(current) || current.phase !== 'dragging' || current.frame !== null || current.work !== null || current.revision === current.applied) return;
    current.frame = requestAnimationFrame(() => {
      current.frame = null;
      current.work = produceRefinement(current).catch(() => { if (refineValid(current)) cancelRefinement(); }).finally(() => {
        current.work = null; scheduleRefinement(current);
      });
    });
  }
  function beginRefinement(id: ObjectId): boolean {
    cancelExport();
    cancelRefinement();
    const scene = state.scene, decoder = analysis.decoder();
    const object = scene?.doc.objects.find((entry) => entry.id === id);
    if (scene === null || object === undefined || decoder === null || readyScene?.generation !== generation || tapControllers.size > 0) return false;
    const original = object.produced;
    const selection = original.selection;
    const points = selection.kind === 'taps' ? selection.points : [selection.seed] satisfies readonly [typeof selection.seed];
    let resolve = (): void => {};
    const done = new Promise<void>((finish) => { resolve = finish; });
    const current: Refinement = { id, original, generation, epoch: objectEpoch, controller: new AbortController(),
      startSize: selection.size ?? 0.5, size: selection.size ?? 0.5, anchor: selection.size ?? 0.5, phase: 'decoding', candidates: null,
      revision: 0, applied: 0, preview: null, frame: null, work: null, ready: Promise.resolve(), done, resolve };
    refinement = current;
    publish({ ...state, scene: { ...scene, selected: id } });
    current.ready = decoder.decode(points, current.controller.signal).then((result) => {
      if (!refineValid(current)) return;
      if (!result.ok) { cancelRefinement(); return; }
      current.candidates = rankCandidates(result.value.candidates);
      // Older documents default to .5 even when their decoder choice was not the middle.
      if (current.startSize === 0.5 && selection.candidate === 0) current.anchor = candidateSize(current.candidates, 0);
      if (current.phase === 'decoding') current.phase = 'dragging';
      scheduleRefinement(current);
    }).catch(() => { if (refineValid(current)) cancelRefinement(); });
    return true;
  }
  function moveRefinement(travel: number): void {
    const current = refinement;
    if (current === null || current.phase === 'committing') return;
    if (travel === 0 && current.revision > 0) { cancelRefinement(); return; }
    const size = draggedSize(current.startSize, travel);
    if (current.size === size) return;
    current.size = size; current.revision++;
    // Page-only feedback follows the pointer without publishing a document or saving.
    state = { ...state, refinementSize: size };
    for (const listener of listeners) listener(state);
    scheduleRefinement(current);
  }
  async function commitRefinement(): Promise<void> {
    const current = refinement;
    if (current === null) return;
    current.phase = 'committing';
    if (current.frame !== null) { cancelAnimationFrame(current.frame); current.frame = null; }
    try {
      await current.ready; await current.work;
      if (!refineValid(current)) return;
      await produceRefinement(current);
      if (!refineValid(current) || state.scene === null) return;
      const produced = current.preview;
      if (produced === null || current.size === current.startSize) { cancelRefinement(); return; }
      const result = applyEdit(state.scene.doc, { kind: 'object.refine', id: current.id, produced }, new Date().toISOString());
      if (result.kind === 'refused') throw new Error(result.detail);
      refinement = null; current.resolve();
      if (result.kind === 'applied') record({ kind: 'object.refine', id: current.id, produced }, result.inverse, result.doc);
      // Publish the committed change for autosave; the plate retains its old forMasks.
      setDocument(result.doc);
    } catch { if (refineValid(current)) cancelRefinement(); }
  }
  type LoadedProject = Awaited<ReturnType<typeof projects.load>>;
  function installImported(imported: DemoScene, file: File, project: LoadedProject | null, current: number, refuseOnRenderError: boolean): void {
    const scene = project === null ? imported : { ...imported, doc: { ...imported.doc, id: project.document.id } };
    const previous = state.scene;
    history = EMPTY_HISTORY;
    readyScene = { generation: current, id: scene.doc.id };
    try { publish({ status: 'Ready', scene }, refuseOnRenderError); }
    catch (error) { readyScene = null; scene.master.close(); throw error; }
    baseline = scene.doc;
    previous?.master.close();
    if (project !== null) {
      for (const [asset, mask] of project.masks) products.putMask(asset, mask);
      setDocument(project.document);
    }
    projects.begin(file, state.scene?.doc ?? scene.doc, products.masks, project?.revision ?? null);
  }
  async function importSource(source: (signal: AbortSignal) => Promise<{
    readonly file: File; readonly project: LoadedProject | null;
  }>): Promise<boolean> {
    cancelExport();
    projects.suspend();
    loop.stop(); stopView(); readyScene = null;
    importController?.abort();
    const controller = new AbortController();
    importController = controller;
    invalidateTaps();
    // Abort warming and release the resident decoder before loading the next source.
    const current = analysis.beginImport(); generation = current; pendingMask = Promise.resolve();
    history = EMPTY_HISTORY;
    const retained = state.scene;
    // Keep the first look on refusal, with no references to products we just dropped.
    const firstLook = retained === null ? null : { ...retained, doc: { ...retained.doc, analysis: { ...retained.doc.analysis, depth: null, plate: null }, objects: [] }, selected: null };
    publish({ status: 'Importing…', scene: firstLook });
    try {
      const { file, project } = await source(controller.signal);
      if (current !== generation || controller.signal.aborted || importController !== controller) return false;
      const imported = await importScene(file);
      if (current !== generation || controller.signal.aborted || importController !== controller) { imported.master.close(); return false; }
      installImported(imported, file, project, current, true);
      await analysis.sceneReady(current, imported.masterPixels);
      return current === generation;
    } catch (error) {
      if (current === generation && !controller.signal.aborted && importController === controller) {
        analysis.importFailed(current);
        projects.openFailed();
        publish({ status: error instanceof Error ? error.message : String(error), scene: state.scene });
      }
      return false;
    }
  }
  async function exportStereo(size: Size = STEREO_3DS_SIZE) {
    const scene = state.scene;
    if (scene === null) throw new Error('Open a photo before downloading.');
    if (renderer === null) throw new Error('The photo renderer is unavailable.');
    return renderStereo(renderer, scene.doc, size);
  }
  function exportLoopFrame(frame: number, edge = GIF_LONG_EDGE): ImageData {
    if (renderer === null || state.scene === null) throw new Error('Open a photo before exporting a loop.');
    const canvas = loopCanvas(state.scene.master, edge, true);
    renderer.exportStill({ frame, canvas });
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('The loop export canvas is unavailable.');
    return context.getImageData(0, 0, canvas.width, canvas.height);
  }
  async function saveLoop(kind: 'gif' | 'movie'): Promise<void> {
    cancelExport();
    const controller = new AbortController(); exportJob = controller;
    const { signal } = controller;
    const scene = state.scene, activeRenderer = renderer;
    try {
      if (scene === null || activeRenderer === null) throw new Error('Open a photo before exporting a loop.');
      if (!scene.doc.motion.enabled) throw new Error('Turn Motion on before exporting a loop.');
      if (refinement !== null) throw new Error('Finish the selection adjustment before exporting a loop.');
      if (plateNeeded(scene.doc) || (scene.doc.analysis.plate !== null && scene.plate === null)) throw new Error('The loop background is still preparing; try Export again when it is ready.');
      const loopFrames = frameCount(scene.doc.motion, LOOP_FPS);
      const frames = frameCount(scene.doc.motion, kind === 'gif' ? GIF_FPS : LOOP_FPS);
      const canvas = loopCanvas(scene.master, kind === 'gif' ? GIF_LONG_EDGE : 1080, kind === 'gif');
      const progress = (completed: number) => exportProgress(controller, `Exporting: ${completed} of ${frames} frames`);
      const render = (frame: number) => {
        signal.throwIfAborted();
        activeRenderer.exportStill({ frame: Math.floor(frame * loopFrames / frames), canvas });
      };
      progress(0);
      let blob: Blob, extension: string;
      if (kind === 'gif') {
        extension = 'gif';
        blob = await encodeLoopGif({ canvas, frames, fps: frames * LOOP_FPS / loopFrames, signal, render, progress });
      } else {
        const format = movieFormat();
        if (format === null) throw new Error('This browser does not support movie recording.');
        extension = format.extension;
        const prepared: Blob[] = [];
        let bytes = 0;
        for (let frame = 0; frame < frames; frame++) {
          render(frame);
          const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => {
            if (value === null) reject(new Error('A movie frame could not be prepared.')); else resolve(value);
          }, 'image/png'));
          signal.throwIfAborted(); bytes += png.size;
          if (bytes > 128 * 1024 * 1024) throw new Error('This movie needs too much memory; shorten the loop and try again.');
          prepared.push(png); progress(frame + 1);
          await exportWait(0, signal);
        }
        recordingJob = controller;
        blob = await recordMovie({ canvas, frames: prepared, fps: LOOP_FPS, format, signal, progress });
      }
      signal.throwIfAborted();
      if (exportJob !== controller || state.scene?.doc !== scene.doc) return;
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `${scene.doc.title}-loop.${extension}`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      if (!signal.aborted && exportJob === controller) {
        const detail = error instanceof Error ? error.message : 'The browser could not encode this loop.';
        publish({ ...state, status: `${kind === 'gif' ? 'GIF' : 'Movie'} export failed: ${detail}` });
      }
    } finally {
      if (recordingJob === controller) {
        recordingJob = null;
        if (state.scene !== null) {
          try { draw(state.scene); } catch (error) { publish({ ...state, status: error instanceof Error ? error.message : String(error) }); }
        }
      }
      if (exportJob === controller) { exportProgress(controller, null); exportJob = null; }
    }
  }
  return {
    products, projects, saveLoop, movieFormat, exportLoopFrame,
    tap, select, objectAt, beginRefinement, moveRefinement, commitRefinement, cancelRefinement,
    historyState: () => ({ canUndo: history.undo.length > 0, canRedo: history.redo.length > 0 }),
    undo: (): void => stepHistory('undo'),
    redo: (): void => stepHistory('redo'),
    renameObject: (id: ObjectId, name: string): void => edit({ kind: 'object.rename', id, name }),
    setObjectHidden: (id: ObjectId, hidden: boolean): void => edit({ kind: hidden ? 'object.hide' : 'object.show', id }),
    deleteObject(id: ObjectId): void { invalidateTaps(); edit({ kind: 'object.remove', id }); },
    refinementProbe() {
      const current = refinement;
      return current === null ? null : { id: current.id, phase: current.phase, size: current.size,
        candidateAreas: current.candidates?.map(({ candidate, area }) => ({ candidate, area })) ?? [],
        originalRank: current.candidates?.findIndex((candidate) => candidate.candidate === current.original.selection.candidate) ?? null,
        previewAsset: current.preview?.mask.asset ?? null,
        previewArea: current.preview === null ? null : (() => {
          const mask = products.masks.get(current.preview.mask.asset);
          return mask === undefined ? null : maskArea(mask);
        })() };
    },
    setRecolor(color: Oklch | null): void {
      const id = state.scene?.selected;
      if (id === null || id === undefined) return;
      edit({ kind: 'object.set', id, patch: { recolor: color === null ? { kind: 'none' } : { kind: 'target', color } } });
    },
    reset(): void {
      cancelExport();
      const scene = state.scene;
      if (scene === null || baseline === null || baseline.id !== scene.doc.id) return;
      stopView();
      invalidateTaps();
      const product = scene.doc.analysis.depth;
      const depth = product === null ? null : products.depths.get(product.map.asset) ?? null;
      products.clear();
      history = EMPTY_HISTORY;
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
    async importFile(file: File): Promise<void> { await importSource(async () => ({ file, project: null })); },
    async importUrl(url: string, name: string): Promise<void> {
      await importSource(async (signal) => {
        const target = new URL(url, location.href);
        if (target.origin !== location.origin) throw new Error('The sample must load from this site.');
        const response = await fetch(target, { signal });
        if (!response.ok) throw new Error(`The sample could not load (HTTP ${response.status}).`);
        return { file: new File([await response.blob()], name, { type: response.headers.get('content-type') ?? '' }), project: null };
      });
    },
    async openProject(id: SceneId): Promise<boolean> {
      cancelExport();
      importController?.abort();
      const controller = new AbortController(); importController = controller;
      const expected = generation;
      const valid = (): boolean => expected === generation && importController === controller && !controller.signal.aborted;
      let prepared: { readonly project: LoadedProject; readonly scene: DemoScene } | null = null;
      publish({ ...state, status: 'Importing…' });
      try {
        const project = await projects.load(id, controller.signal);
        if (!valid()) return false;
        const imported = await importScene(project.photo);
        prepared = { project, scene: imported };
        if (!valid()) { imported.master.close(); return false; }
        const masks = new Map(project.document.objects.map((object) => {
          const mask = project.masks.get(object.produced.mask.asset);
          if (mask === undefined) throw new Error('A project mask is missing.');
          return [object.id, mask] satisfies [ObjectId, Plane<'u8'>];
        }));
        // Validate the candidate while the current products, analysis and saves are intact.
        // Restore the current renderer before suspend captures its pending thumbnail.
        try {
          if (renderer !== null) {
            renderer.setScene({ doc: project.document, master: imported.master, masks, depth: null, plate: null, selected: null });
            renderer.renderStill();
          } else if (renderError !== null) throw renderError;
        } finally { if (state.scene !== null) draw(state.scene); }
      } catch (error) {
        prepared?.scene.master.close();
        if (valid()) {
          publish({ ...state, status: error instanceof Error ? error.message : String(error) });
          projects.openFailed();
        }
        return false;
      }
      if (prepared === null || !valid()) { prepared?.scene.master.close(); return false; }
      projects.suspend();
      loop.stop(); stopView(); readyScene = null;
      invalidateTaps();
      const current = analysis.beginImport(); generation = current;
      installImported(prepared.scene, prepared.project.photo, prepared.project, current, false);
      try { await analysis.sceneReady(current, prepared.scene.masterPixels); }
      catch (error) {
        if (current === generation) {
          analysis.importFailed(current);
          publish({ ...state, status: error instanceof Error ? error.message : String(error) });
        }
      }
      return current === generation;
    },
    requestPlateIfNeeded,
    setParallax,
    recenterParallax: (): void => view.recenter(),
    setParallaxSource: view.setSourceMode,
    parallaxTrace: () => ({ ...view.trace(), stage: (() => {
      const rect = stageCanvas?.getBoundingClientRect();
      return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, dpr: window.devicePixelRatio };
    })() }),
    downloadParallaxTrace(): void {
      const rect = stageCanvas?.getBoundingClientRect();
      const data = { ...view.trace(), build: readBuildId(), userAgent: navigator.userAgent, tilt: tiltSource.readings(),
        stage: rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        viewport: { width: window.innerWidth, height: window.innerHeight, dpr: devicePixelRatio }, coverage: liveResult };
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'parallax-trace.json'; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    injectOrientation: (orientation: Orientation): void => tiltSource.injectOrientation(orientation),
    injectFace: (center: Vec2 | null): void => cameraSource.injectFace(center),
    injectCameraFrame: cameraSource.injectCameraFrame,
    parallaxDebug: () => ({ ...tiltSource.readings(), ...view.targets(), ...cameraSource.preview(), ...view.diagnostics(), coverage: liveResult, preparation: analysis.livePlate().kind, viewId: liveViewId,
      offset: view.camera(), cameraRunning: view.ready('camera'), tiltRunning: view.ready('tilt') }),
    windowReady: (): boolean => view.ready('camera'),
    windowFrames: (): number => cameraSource.trackedFrames(),
    windowTracks: (): readonly MediaStreamTrack[] => cameraSource.tracks(),
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
    frame: (): number => viewEnabled() ? view.frame() : loop.frame(),
    renderFrameAt(frame: number): void {
      if (renderer === null) throw new Error('Open a photo before rendering.');
      renderer.renderFrame(frame);
    },
    renderer: (): ReturnType<typeof createRenderer> | null => renderer,
    attachCanvas(canvas: HTMLCanvasElement): () => void {
      cancelExport();
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
        cancelExport();
        loop.stop(); stopView(); renderer?.dispose(); renderer = null; renderError = null; stageCanvas = null;
      };
    },
    reportError(error: unknown): void {
      publish({ status: error instanceof Error ? error.message : String(error), scene: state.scene });
    },
  };
}
