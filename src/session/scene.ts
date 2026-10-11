import { newDocument, newObject } from '../core/defaults.ts';
import { isAssetId, isSceneId, isObjectId, isEffectId, type AssetId, type ObjectId, type SceneId } from '../core/ids.ts';
import { currentDocumentSchema } from '../core/schema.ts';
import type { ObjectProduced, SceneDocument, ActiveSelection, SelectionSpace, LocalEffect, MaskProvenance } from '../core/types.ts';
import type { ImagePoint, Oklch, Plane, Rgb8 } from '../core/raster.ts';
import { applyProduce, sortedMasks } from '../core/produce.ts';
import { createAnalysisDriver } from './driver.ts';
import { createProducts, repairBasis, type Products } from './products.ts';
import { collectCompositionAssets, type CompositionAssetRoot } from '../core/asset-refs.ts';
import { COMPOSITION_LIMITS } from '../core/composition-ranges.ts';
import { MAX_ORIGINAL_BYTES } from '../core/asset-codec.ts';
import { migrateV4ToV5 } from '../core/composition.ts';
import { selectionOwnerSize, resolveOperationTarget } from '../core/selection.ts';
import { resolveLocalEffects } from '../render/local-effects.ts';
import { sameValue } from '../core/equal.ts';
import { createSelection, type SelectionChange, type SelectionGestureStart, type SelectionGestureUpdate, type SelectionGestureToken, type SelectionPixels } from './selection.ts';
import type { AuthoringLayout, ViewPoint } from '../core/authoring-view.ts';
import type { SourcePoint } from '../core/mask-edit.ts';
import { decodePhoto, type DecodedPhoto } from '../photo/decode.ts';
import { photoStats } from '../photo/stats.ts';
import { makeThumbnail } from '../photo/thumbnail.ts';
import { encodePng, savePng } from '../export/png.ts';
import { renderStereo, STEREO_3DS_SIZE } from '../export/stereo.ts';
import type { Size } from '../core/raster.ts';
import { readBuildId } from '../platform/build-id.ts';
import { applyEdit, applyEdits } from '../core/reduce.ts';
import { coalesceKey, type DocumentHistoryEntry } from '../core/history.ts';
import type { Edit, StylePatch } from '../core/edits.ts';
import { createRenderer } from '../render/renderer.ts';
import { renderPng } from '../export/png.ts';
import { labelAt, plateNeeded, sourceRemovalUnion, repairHole, renderingPrerequisites } from '../core/derive.ts';
import { bundledLock } from '../analysis/bundled-lock.ts';
import { maskedDepth, objectProduced } from './objects.ts';
import { createLoopStepper, loopTapPoint, loopCanvas, encodeLoopGif } from './loop.ts';
import { frameCount, effectiveOrbit, loopZoom, parallaxMargin, type Vec2 } from '../core/motion.ts';
import { LOOP_FPS } from '../render/loop.ts';
import { movieFormat, recordLoopMovie } from '../export/movie.ts';
import { GIF_FPS, GIF_LONG_EDGE } from '../export/gif.ts';
import { createWindowSource } from './window.ts';
import { createTiltSource, type Orientation } from './tilt.ts';
import { liveCoverage } from '../core/live-coverage.ts';
import { apertureFromRect, containedImageRect, createPerspectiveGeometry, constrainEye, lateralEnvelope } from '../core/perspective.ts';
import type { PerspectiveRenderResult, SampleColorResult } from '../render/types.ts';
import { createViewDriver, type ViewHost, type ViewSubmission } from './view-driver.ts';
import { createProjectSession } from './projects.ts';
import { createPublishSession } from './publish.ts';
import { anchoredSize, candidateSize, draggedSize, maskArea, rankCandidates, refinementChoice, thresholdMask } from './refine.ts';
import { captureCommitted, createAuthoring, EMPTY_AUTHORING_HISTORY as EMPTY_HISTORY,
  pushAuthoringHistory as push, recordAuthoringEdit as recordEdit, recordAuthoringSelection as recordSelection,
  authoringReferencedAssets as referencedAssets, stepAuthoringHistory, isRecipeEntry, restoreRecipe,
  recipeState as recipeForHistory,
  type AuthoringHistory as History, type AuthoringState, type CommandResult, type GestureStart, type OperationTarget, type Tool, type GestureValue } from './authoring.ts';
import { createMathRemixSession } from './math-remix.ts';
import { withDerivedGrainStyle } from '../core/remix-schema.ts';
import { createPaintSession, BRUSH_PREVIEW, type BrushPreviewFrame, type PaintInterruption, type StrokeStart, type StrokeToken,
  type PaintCommitGuard, type PaintGenerations, type PaintStrokePlane } from './paint.ts';
import { snapshotPaintPatch, snapshotPaintRaster, type PaintBrush, type PaintPatch, type PaintCapture,
  type PaintStrokeResult, type PaintPoint, PAINT_LIMITS } from '../core/paint.ts';
import { migrateV5ToV6, remixPaintBrushSchema, type PaintLayer, type StrokePatch } from '../core/remix-schema.ts';
import { createMathLibrary, mathRefKey, mathRefSchema, type MathRef } from '../core/math-definition.ts';
import { createMathBlock } from '../core/math-graph.ts';
import { compileBrushCoverage, evaluateBrushCoverage } from '../render/math-program.ts';
import { decodeRaster, encodeRaster } from '../core/asset-codec.ts';
import { productAsset } from './products.ts';
import { resolvePaintPlanes } from './viewer.ts';
import { linearToSrgb, srgbToLinear } from '../core/color.ts';
import { inverseSource, projectSource, type PerspectiveGeometry, type PerspectiveEye } from '../core/perspective.ts';
import { anchorDisparity, cameraRadius } from '../core/derive.ts';
import { cameraOffset, loopPhase, parallaxDisplacement } from '../core/motion.ts';
import type { HistoryEntry } from '../core/history.ts';

const DEFAULT_BRUSH = remixPaintBrushSchema.parse({ operation: 'draw', diameter: 24, opacity: 1, pressure: 'off', color: { l: .2, c: 0, h: 0 } });

/** Compose the canonical raster first, then filter premultiplied linear samples
 * into the canvas backing size. Transparent pixels never contribute ink. */
export function brushPreviewPixels(frame: BrushPreviewFrame, size: Size): Uint8ClampedArray<ArrayBuffer> {
  const { width, height } = frame.size, linear = new Float32Array(width * height * 4);
  for (const patch of frame.patches) for (const tile of patch.tiles) {
    for (let y = 0; y < tile.raster.size.height; y++) for (let x = 0; x < tile.raster.size.width; x++) {
      const from = (y * tile.raster.size.width + x) * 4;
      const px = tile.x * 256 + x, py = tile.y * 256 + y;
      if (px >= width || py >= height) continue;
      const to = (py * width + px) * 4, alpha = tile.raster.byteAt(from + 3) / 255;
      for (let c = 0; c < 3; c++) linear[to + c] = srgbToLinear(tile.raster.byteAt(from + c) / 255) * alpha + (linear[to + c] ?? 0) * (1 - alpha);
      linear[to + 3] = alpha + (linear[to + 3] ?? 0) * (1 - alpha);
    }
  }
  const bytes = new Uint8ClampedArray(size.width * size.height * 4);
  for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
    const sx = Math.max(0, Math.min(width - 1, (x + .5) * width / size.width - .5));
    const sy = Math.max(0, Math.min(height - 1, (y + .5) * height / size.height - .5));
    const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
    const offsets = [(y0 * width + x0) * 4, (y0 * width + Math.min(width - 1, x0 + 1)) * 4,
      (Math.min(height - 1, y0 + 1) * width + x0) * 4, (Math.min(height - 1, y0 + 1) * width + Math.min(width - 1, x0 + 1)) * 4];
    const weights = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
    const sample = (c: number): number => offsets.reduce((sum, offset, i) => sum + (linear[offset + c] ?? 0) * (weights[i] ?? 0), 0);
    const alpha = sample(3), at = (y * size.width + x) * 4;
    for (let c = 0; c < 3; c++) bytes[at + c] = alpha > 0 ? Math.round(linearToSrgb(sample(c) / alpha) * 255) : 0;
    bytes[at + 3] = Math.round(alpha * 255);
  }
  return bytes;
}

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
  readonly brush: PaintBrush;
  readonly fingerDraw: boolean;
  readonly authoring: AuthoringState;
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

async function importScene(file: File, sink: Products): Promise<DemoScene> {
  if (file.size === 0 || file.size > MAX_ORIGINAL_BYTES) throw new Error('Photo files must be nonempty and at most 24 MiB.');
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  const decoded = await decodePhoto(file);
  try {
    const stats = photoStats(makeThumbnail(decoded.bitmap), seed);
    const [masterPng, original] = await Promise.all([encodePng(decoded.pixels), file.arrayBuffer()]);
    const masterBytes = new Uint8Array(await masterPng.arrayBuffer());
    const [sourceAsset, masterAsset] = await Promise.all([sink.admitBytes(new Uint8Array(original)), sink.admitBytes(masterBytes)]);
    const id = crypto.randomUUID();
    if (!isSceneId(id)) throw new Error('The scene id is invalid.');
    const doc = currentDocumentSchema.parse(newDocument({
      id, title: [...(file.name.replace(/\.[^.]+$/, '') || 'Photo')].slice(0, 80).join(''),
      now: new Date().toISOString(), seed, writer: readBuildId(), importedOn: navigator.userAgent,
      frame: {
        source: { asset: sourceAsset, mediaType: file.type, byteLength: file.size },
        master: { asset: masterAsset, size: { width: decoded.pixels.width, height: decoded.pixels.height } },
        original: { name: [...(file.name || 'Photo')].slice(0, 255).join(''), mediaType: file.type, size: decoded.original },
      },
      analysis: { ...stats, depth: null, plate: null, autoSubject: 'pending' },
    }));
    return { doc, master: decoded.bitmap, masterPixels: decoded.pixels, masterPng, path: decoded.path, masks: new Map(), depth: null, plate: null, selected: null };
  } catch (error) {
    decoded.bitmap.close();
    throw error;
  }
}

export function createDemoSession() {
  let activeSelection: ActiveSelection = null;
  const authoring = createAuthoring({ read: () => state.scene?.doc ?? null, record: (change) => edit(change, null), changed: authoringChanged,
    selection: () => activeSelection, localEdit, interrupt: reason => interruptPaint(reason), remix: {
      begin: () => remix.beginGesture('photo'),
      update: (token, value) => remix.updateGestureNow(token, { kind: 'parameter', instance: value.instance, name: value.name, value: value.value }),
      commit: token => remix.commitGestureNow(token), cancel: token => remix.cancelGesture(token),
    } });
  let state: DemoState = { brush: DEFAULT_BRUSH, fingerDraw: false, authoring: authoring.snapshot(), exportProgress: null, status: 'Drop a photo', scene: null, analysisStatus: 'Fetching models 0%', analysisTiming: null, parallaxEnabled: false, refiningObject: null, refinementSize: null };
  const products = createProducts();
  let history: History = EMPTY_HISTORY;
  let generation = 0;
  let readyScene: { readonly generation: number; readonly id: SceneDocument['id'] } | null = null;
  let importController: AbortController | null = null;
  let finishingSwitch: { readonly controller: AbortController; readonly project: SceneId } | null = null;
  function visibleState(): DemoState {
    return finishingSwitch !== null && !finishingSwitch.controller.signal.aborted
      ? { ...state, status: 'Finishing your work before switching' } : state;
  }
  let baseline: SceneDocument | null = null;
  let objectEpoch = 0;
  let selectionEpoch = 0, selectionCommit = 0;
  let pendingSelection = false, selectionChange: SelectionChange | null = null;
  let pendingSelectionToken: SelectionGestureToken | null = null;
  // Native hashing cannot be aborted. Cancellation invalidates its commit, while
  // this single slot keeps its detached bytes bounded until the hash settles.
  let selectionHashing: { readonly ticket: number; readonly bytes: number } | null = null;
  let authoringNeutral = false;
  const ownerVersions = new Map<ObjectId, number>();
  const selection = createSelection({ readOwner(space) {
    const doc = state.scene?.doc;
    if (doc === undefined) return null;
    const size = selectionOwnerSize(doc, space);
    return !size.ok ? null : { size: size.value, sceneGeneration: generation, editEpoch: selectionEpoch,
      ownerGeneration: space.kind === 'photo' ? generation : ownerVersions.get(space.id) ?? 0 };
  }, record(change) { selectionChange = change; return { kind: 'applied' }; }, changed: () => authoringChanged(true) },
  { source: { width: 1, height: 1 }, viewport: { x: 0, y: 0, width: 1, height: 1 }, dpr: 1 });
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
    interruptPaint('generation-change');
    authoring.cancel();
    cancelSelectionWork();
    cancelRefinement();
    objectEpoch++;
    for (const controller of tapControllers) controller.abort();
    tapControllers.clear(); pendingMask = Promise.resolve();
  };
  let pendingMask = Promise.resolve();
  let renderer: ReturnType<typeof createRenderer> | null = null;
  let rendererCompare: AuthoringState['compare'] = 'edited';
  function syncCompare(): void {
    const compare = authoring.snapshot().compare;
    if (renderer !== null && rendererCompare !== compare) {
      renderer.setCompare(compare); rendererCompare = compare;
    }
  }
  let exportJob: AbortController | null = null;
  let recordingJob: AbortController | null = null;
  function cancelExport(): void {
    exportJob?.abort(); exportJob = null; recordingJob = null;
    state = { ...state, exportProgress: null };
  }
  function exportProgress(controller: AbortController, text: string | null): void {
    if (exportJob !== controller) return;
    state = { ...state, exportProgress: text };
    for (const listener of listeners) listener(visibleState());
  }
  const projects = createProjectSession((document) => {
    if (renderer === null) throw new Error('The photo renderer is unavailable.');
    const activeRenderer = renderer;
    return committedRender(() => renderPng(activeRenderer), document);
  });
  const remix = createMathRemixSession({ read: () => state.scene?.doc ?? null, generation: () => generation, renderer: () => renderer,
    interrupt() { cancelExport(); invalidateTaps(); },
    preflight(doc, before) {
      try {
        const candidate = before === null ? history : push(history, { kind: 'remix', key: null, at: performance.now(), before,
          after: doc.version === 6 ? recipeForHistory(doc) : before }, doc);
        admitHistory(doc, activeSelection, candidate);
        const save = projects.preflightObserve(doc, products.assets);
        return save.kind === 'refused' ? { kind: 'refused', reason: save.reason } : { kind: 'unchanged' };
      } catch (error) { return { kind: 'refused', reason: error instanceof Error ? error.message : 'The recipe could not be retained.' }; }
    },
    install: doc => setDocument(doc),
    record(before, after) {
      if (state.scene === null) return;
      history = admitHistory(state.scene.doc, activeSelection, push(history, { kind: 'remix', key: null, at: performance.now(), before, after }, state.scene.doc));
      retainAssets(state.scene.doc);
    },
    changed() { for (const listener of listeners) listener(visibleState()); },
    saving: () => projects.checkpointState(state.scene?.doc ?? null),
    async retrySave() {
      try { return { kind: (await projects.flushCurrent()).kind === 'saved' ? 'applied' : 'unchanged' }; }
      catch (error) { return { kind: 'refused', reason: error instanceof Error ? error.message : 'Saving failed.' }; }
    },
  });
  const readDocuments = new WeakMap<SceneDocument, SceneDocument>();
  function readDocument(doc: SceneDocument): SceneDocument {
    if (doc.version === 5) return doc;
    let view = readDocuments.get(doc);
    if (!view) { view = withDerivedGrainStyle(doc); readDocuments.set(doc, view); readDocuments.set(view, view); }
    return view;
  }
  const gallery = createPublishSession({
    read: () => ({ document: readyScene?.generation === generation ? state.scene?.doc ?? null : null,
      products, gesture: authoring.snapshot().gesture !== null || remix.snapshot().editing !== null || refinement !== null || selection.dirtyBytes() > 0 || pendingSelection || selectionHashing !== null || paintWork.size > 0, exporting: exportJob !== null }),
    onReadinessChanged() { for (const listener of listeners) listener(visibleState()); },
    prepareBackground: (signal) => requestPlateIfNeeded(signal),
    renderStill(document) {
      if (renderer === null) throw new Error('The photo renderer is unavailable.');
      const activeRenderer = renderer;
      return committedRender(() => renderPng(activeRenderer), document);
    },
  });
  let renderError: unknown = null;
  let stageCanvas: HTMLCanvasElement | null = null;
  const loop = createLoopStepper((frame) => { if (recordingJob === null && paintWork.size === 0) { renderer?.renderFrame(frame); updatePaintMotion(frame); } }, (error) => {
    renderError = error;
    state = { ...state, status: error instanceof Error ? error.message : String(error) };
    for (const listener of listeners) listener(visibleState());
  });
  const listeners = new Set<(state: DemoState) => void>();
  projects.subscribe(() => { for (const listener of listeners) listener(visibleState()); });
  // C2u navigation changes the neutral authoring view without an edit gesture.
  // Snapshots are copies, so compare their values with the view last drawn.
  let drawnAuthoringView: ReturnType<typeof selection.navigation.snapshot> | null = null;

  // Core's chronological stack remains the owner of limits, redo clearing and
  // coalescing. These key:null carriers are intercepted before selection replay;
  // their identity survives core undo/redo. Only paint layers belong to this delta.
  const paintHistory = new WeakMap<History['undo'][number], { readonly before: readonly PaintLayer[]; readonly after: readonly PaintLayer[] }>();
  let paintOwner: ObjectId | null = null, paintOwnerEpoch = 0, paintViewEpoch = 0;
  let drawBrush = DEFAULT_BRUSH;
  let paintTail: Promise<unknown> = Promise.resolve(), paintQueuedBytes = 0;
  const paintWork = new Set<StrokeToken>();
  let activePaintStroke: StrokeToken | null = null;
  const paintPointers = new Map<StrokeToken, StrokeStart['pointer']>();
  const storedPatches = new WeakMap<PaintPatch, StrokePatch>();
  const hydratedTiles = new WeakMap<Uint8Array, ReturnType<typeof snapshotPaintRaster>>();
  type PaintView = { readonly kind: 'still' } | { readonly kind: 'motion'; readonly frame: number; readonly camera: Vec2; readonly zoom: number; readonly anchor: number }
    | { readonly kind: 'perspective'; readonly frame: number; readonly geometry: PerspectiveGeometry; readonly eye: PerspectiveEye; readonly requestEye: PerspectiveEye };
  let paintView: PaintView = { kind: 'still' };
  let paintMaster: ImageBitmap | null = null, paintDepth: DemoScene['depth'] = null;
  let paintAdmitted = false;
  function clearPaintPlanes(): void {
    if (paintAdmitted) renderer?.setPaintPlanes([]);
    paintAdmitted = false;
  }
  function syncPaintPlanes(doc: SceneDocument, assets: ReadonlyMap<AssetId, Uint8Array> = products.assets): void {
    const planes = resolvePaintPlanes(doc, assets);
    if (planes.length === 0 && !paintAdmitted) return;
    const admission = renderer?.setPaintPlanes(planes);
    if (admission?.kind !== 'accepted') throw new Error(admission?.reason ?? 'The paint renderer is unavailable.');
    paintAdmitted = planes.length > 0;
  }
  function updatePaintView(next: PaintView): void {
    if (sameValue(paintView, next)) return;
    paintView = next; paintViewEpoch++;
    if (paintWork.size > 0) interruptPaint('generation-change'); else paint.reconcile();
  }
  function updatePaintMotion(frame: number, doc = state.scene?.doc): void {
    if (doc === undefined) return;
    const moving = doc.motion.enabled && effectiveOrbit(doc.motion) > 0 && !plateNeeded(doc), anchor = anchorDisparity(doc);
    updatePaintView(!moving || anchor === null ? { kind: 'still' } : { kind: 'motion', frame, anchor, zoom: loopZoom(doc.motion.parallax),
      camera: cameraOffset(cameraRadius(doc), loopPhase(frame, frameCount(doc.motion, LOOP_FPS)), doc.motion.drift.direction) });
  }
  let previewCanvas: HTMLCanvasElement | null = null, previewObserver: MutationObserver | null = null;
  let previewFrame: BrushPreviewFrame = { size: BRUSH_PREVIEW.size, patches: [] };
  function redrawBrushPreview(): void {
    const canvas = previewCanvas;
    if (canvas === null || canvas.width < 1 || canvas.height < 1) return;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('The brush preview canvas is unavailable.');
    context.putImageData(new ImageData(brushPreviewPixels(previewFrame, canvas), canvas.width, canvas.height), 0, 0);
  }
  function paintDocument(doc: SceneDocument): Extract<SceneDocument, { version: 6 }> {
    if (doc.version === 6) return doc;
    const migrated = migrateV5ToV6(doc);
    if (!migrated.ok) throw new Error(migrated.error.message);
    const checked = currentDocumentSchema.parse(migrated.value);
    if (checked.version !== 6) throw new Error('The brush document is unavailable.');
    return checked;
  }
  function advancePaintDocument(doc: SceneDocument, layers: readonly PaintLayer[], brush?: PaintBrush): SceneDocument {
    const base = paintDocument(doc), checkpoint = base.remix.checkpoint;
    return currentDocumentSchema.parse({ ...base, updatedAt: new Date().toISOString(),
      paint: { layers, brush: brush ?? base.paint.brush }, remix: { ...base.remix,
        checkpoint: { ...checkpoint, appliedRevision: checkpoint.appliedRevision + 1, checkpointRevision: checkpoint.checkpointRevision + 1 } } });
  }
  function currentPaintOwner(): ObjectId {
    if (paintOwner !== null) return paintOwner;
    const doc = state.scene?.doc;
    paintOwner = doc?.version === 6 ? doc.paint.layers.find(layer => !layer.hidden)?.id ?? null : null;
    if (paintOwner === null) {
      const id = crypto.randomUUID();
      if (!isObjectId(id)) throw new Error('The paint layer id is invalid.');
      paintOwner = id;
    }
    return paintOwner;
  }
  function resumePaintRendering(): void {
    const current = generation;
    queueMicrotask(() => {
      if (current !== generation || paintWork.size !== 0 || state.scene === null) return;
      try { draw(state.scene); }
      catch (error) {
        state = { ...state, status: error instanceof Error ? error.message : String(error) };
        for (const listener of listeners) listener(visibleState());
      }
    });
  }
  function releasePaintWork(token: StrokeToken): void {
    const hadSceneWork = paintWork.delete(token); paintPointers.delete(token);
    if (activePaintStroke === token) activePaintStroke = null;
    if (hadSceneWork && paintWork.size === 0) resumePaintRendering();
  }
  function interruptPaint(reason: PaintInterruption): void {
    const hadSceneWork = paintWork.size > 0;
    paintOwnerEpoch++; paint.interrupt(reason); paintWork.clear(); paintPointers.clear(); activePaintStroke = null;
    if (hadSceneWork) resumePaintRendering();
  }
  function projectionAt(disparity: number, projection = paintView) {
    const size = state.scene?.doc.frame.master.size;
    if (size === undefined) throw new Error('Open a photo before drawing.');
    const toPlane = (at: PaintPoint): PaintPoint => {
      const uv = { x: at.x / size.width, y: at.y / size.height };
      if (projection.kind === 'perspective') {
        const { aperture } = projection.geometry;
        const source = inverseSource({ x: aperture.center.x + (uv.x - .5) * aperture.width,
          y: aperture.center.y + (.5 - uv.y) * aperture.height }, disparity, projection.geometry, projection.eye);
        return { x: source.x * size.width, y: source.y * size.height };
      }
      if (projection.kind === 'motion') {
        const offset = parallaxDisplacement(projection.camera, disparity, projection.anchor);
        return { x: ((uv.x - .5) / projection.zoom + .5 - offset.x) * size.width,
          y: ((uv.y - .5) / projection.zoom + .5 - offset.y) * size.height };
      }
      return { ...at };
    };
    const toDisplay = (at: PaintPoint): PaintPoint => {
      const uv = { x: at.x / size.width, y: at.y / size.height };
      if (projection.kind === 'perspective') {
        const screen = projectSource(uv, disparity, projection.geometry, projection.eye), { aperture } = projection.geometry;
        return { x: (.5 + (screen.x - aperture.center.x) / aperture.width) * size.width,
          y: (.5 - (screen.y - aperture.center.y) / aperture.height) * size.height };
      }
      if (projection.kind === 'motion') {
        const offset = parallaxDisplacement(projection.camera, disparity, projection.anchor);
        return { x: ((uv.x + offset.x - .5) * projection.zoom + .5) * size.width,
          y: ((uv.y + offset.y - .5) * projection.zoom + .5) * size.height };
      }
      return { ...at };
    };
    return { size: { ...size }, texture: { origin: { x: .5, y: .5 }, pixelScale: 1 }, toPlane, toDisplay };
  }
  function hydratePatch(patch: StrokePatch): PaintPatch {
    const tiles = patch.tiles.map(tile => {
      const bytes = products.assets.get(tile.rgba.asset);
      if (bytes === undefined) throw new Error('A saved paint tile is unavailable.');
      let raster = hydratedTiles.get(bytes);
      if (raster === undefined) {
        const decoded = decodeRaster(bytes, { format: tile.rgba.encoding, size: tile.rgba.size });
        if (decoded.format !== 'rgba8-srgb-straight') throw new Error('A saved paint tile has the wrong format.');
        raster = snapshotPaintRaster(decoded); hydratedTiles.set(bytes, raster);
      }
      return { x: tile.x, y: tile.y, raster };
    });
    const restored = snapshotPaintPatch({ id: patch.id, size: patch.size, tiles,
      // Erase hydrates deposited pixels, never rerasterizes the original brush.
      brush: { operation: 'draw', diameter: 1, opacity: 1, pressure: 'off', color: { l: 0, c: 0, h: 0 } },
      capture: { owner: patch.owner, sceneGeneration: generation, viewGeneration: paintViewEpoch,
        brushRevision: mathRefKey(patch.brush), functionRevision: 'saved', seed: patch.seed, start: { x: 0, y: 0 },
        attachment: { depthSample: { x: 0, y: 0 }, disparity: patch.disparity }, plane: { origin: { x: .5, y: .5 }, pixelScale: 1 } } });
    if (!restored.ok) throw new Error(restored.error);
    storedPatches.set(restored.value, patch); return restored.value;
  }
  function paintBrushRevision(): MathRef {
    const doc = state.scene?.doc;
    return doc?.version === 6 ? doc.remix.instances.find(instance => instance.target === 'brush' && instance.enabled)?.block ?? { id: 'grain-texture', revision: 1 }
      : { id: 'grain-texture', revision: 1 };
  }
  function writePaintBrush(brush: PaintBrush): CommandResult {
    const parsed = remixPaintBrushSchema.safeParse(brush);
    if (!parsed.success) return { kind: 'refused', reason: 'The brush settings are invalid.' };
    if (sameValue(parsed.data, state.brush)) return { kind: 'unchanged' };
    const scene = state.scene;
    try {
      if (scene !== null) {
        const doc = paintDocument(scene.doc), next = advancePaintDocument(doc, doc.paint.layers, parsed.data);
        admitHistory(next, activeSelection, history); setDocument(next);
      } else state = { ...state, brush: parsed.data };
      if (parsed.data.operation === 'draw') drawBrush = parsed.data;
      state = { ...state, brush: parsed.data };
      for (const listener of listeners) listener(visibleState());
      return { kind: 'applied' };
    } catch (error) { return { kind: 'refused', reason: error instanceof Error ? error.message : 'The brush settings could not be saved.' }; }
  }
  const paint = createPaintSession({
    sceneSurface: () => state.scene === null ? null : { owner: currentPaintOwner(), depthAvailable: state.scene.depth !== null && renderer !== null && (!viewEnabled() || liveResult.kind !== 'limited') },
    generations: (): PaintGenerations => ({ scene: generation, view: paintViewEpoch, owner: paintOwnerEpoch }),
    depthAt(at) {
      const size = state.scene?.doc.frame.master.size;
      if (renderer === null || size === undefined) return null;
      const depth = renderer.capturePaintDepth({ x: at.x / size.width, y: at.y / size.height });
      if (depth.kind === 'refused') throw new Error(depth.reason);
      return { depthSample: { ...at }, disparity: depth.disparity };
    },
    capturePlane: ({ attachment }): PaintStrokePlane => projectionAt(attachment.disparity),
    readBrush: () => ({ brush: state.brush, brushRevision: mathRefKey(paintBrushRevision()),
      functionRevision: JSON.stringify(state.scene?.doc.version === 6 ? state.scene.doc.remix.checkpoint : { appliedRevision: 0 }) }),
    writeBrush: writePaintBrush,
    brushCoverage() {
      const doc = state.scene?.doc;
      // Capture definitions/parameters in this closure. Future rack edits may
      // replay the pad but never replace a live stroke's executable coverage.
      if (doc?.version !== 6) return () => 1;
      const instances = doc.remix.instances.filter(instance => instance.target === 'brush' && instance.enabled);
      if (instances.length === 0) return () => 1;
      const library = createMathLibrary(doc.remix.functions);
      if (!library.ok) throw new Error(library.error.message);
      const programs = instances.map(instance => {
        const source = doc.remix.blocks.find(block => mathRefKey(block) === mathRefKey(instance.block));
        if (source === undefined) throw new Error('The captured brush block is unavailable.');
        const block = createMathBlock(source, library.value);
        if (!block.ok) throw new Error(block.error.message);
        const program = compileBrushCoverage(block.value, instance.parameters);
        if (!program.ok) throw new Error(program.error.message);
        return program.value;
      });
      return (x, y, seed) => programs.reduce((coverage, program) => {
        const result = evaluateBrushCoverage(program, { position: [x, y], seed, hold: 0, time: 0, pressure: 1,
          roundTip: 1, opacity: 1, ink: [0, 0, 0] });
        if (!result.ok) throw new Error(result.error.message);
        return coverage * result.value.texture;
      }, 1);
    },
    nextStroke: () => ({ id: crypto.randomUUID(), seed: crypto.getRandomValues(new Uint32Array(1))[0] ?? 0 }),
    projectPatchCount: () => state.scene?.doc.version === 6 ? state.scene.doc.paint.layers.reduce((count, layer) => count + layer.patches.length, 0) : 0,
    activePatches(capture) {
      const doc = state.scene?.doc;
      if (doc?.version !== 6) return [];
      const projection = paintView, eraser = projectionAt(capture.attachment.disparity, projection);
      return (doc.paint.layers.find(layer => layer.id === capture.owner)?.patches ?? []).map(stored => {
        const target = projectionAt(stored.disparity, projection), offset = target.toPlane(eraser.toDisplay({ x: 0, y: 0 }));
        const basis = target.toPlane(eraser.toDisplay({ x: 1, y: 0 }));
        return { patch: hydratePatch(stored), toPatch: { offset, scale: basis.x - offset.x } };
      });
    },
    commit: commitPaint,
  });

  function commitPaint(result: PaintStrokeResult, guard: PaintCommitGuard): Promise<CommandResult> {
    const bytes = result.memory.afterTileBytes;
    if (paintQueuedBytes + bytes > COMPOSITION_LIMITS.dirtyStrokeBytes) return Promise.resolve({ kind: 'refused', reason: 'Wait for the previous paint stroke to finish saving.' });
    paintQueuedBytes += bytes;
    const work = paintTail.then(async (): Promise<CommandResult> => {
      if (!guard.isCurrent()) return { kind: 'cancelled' };
      const staged = new Map<AssetId, Uint8Array<ArrayBuffer>>(), replacements = new Map<string, StrokePatch | null>();
      for (const change of result.changes) {
        const patch = change.after;
        if (patch === null) { replacements.set(change.patchId, null); continue; }
        const original = change.before === null ? null : storedPatches.get(change.before);
        const tiles: StrokePatch['tiles'][number][] = [];
        for (const tile of patch.tiles) {
          if (!guard.isCurrent()) return { kind: 'cancelled' };
          const changed = change.tiles.some(value => value.x === tile.x && value.y === tile.y);
          const previous = original?.tiles.find(value => value.x === tile.x && value.y === tile.y);
          if (!changed && previous !== undefined) { tiles.push(previous); continue; }
          const encoded = encodeRaster({ format: 'rgba8-srgb-straight', size: tile.raster.size, data: tile.raster.copyBytes() });
          const asset = await productAsset(encoded);
          if (!guard.isCurrent()) return { kind: 'cancelled' };
          staged.set(asset, encoded); tiles.push({ x: tile.x, y: tile.y, rgba: { asset, encoding: 'rgba8-srgb-straight', size: tile.raster.size } });
        }
        const separator = patch.capture.brushRevision.lastIndexOf('@');
        const capturedBrush = mathRefSchema.parse({ id: patch.capture.brushRevision.slice(0, separator), revision: Number(patch.capture.brushRevision.slice(separator + 1)) });
        replacements.set(change.patchId, { id: patch.id, owner: currentPaintOwner(), order: original?.order ?? 0,
          disparity: original?.disparity ?? patch.capture.attachment.disparity, brush: original?.brush ?? capturedBrush,
          seed: patch.capture.seed, size: patch.size, tiles });
      }
      if (!guard.isCurrent() || state.scene === null) return { kind: 'cancelled' };
      const before = paintDocument(state.scene.doc), owner = currentPaintOwner(), active = before.paint.layers.find(layer => layer.id === owner);
      if (result.kind === 'draw' && before.paint.layers.reduce((count, layer) => count + layer.patches.length, 0) >= PAINT_LIMITS.patches) {
        return { kind: 'refused', reason: 'The project already has 64 paint patches.' };
      }
      if (active === undefined && before.objects.length + before.paint.layers.length >= COMPOSITION_LIMITS.createdLayers) return { kind: 'refused', reason: 'Create at most eight top-level layers in this editor.' };
      for (const change of result.changes) if (change.before !== null) {
        const captured = storedPatches.get(change.before), current = active?.patches.find(patch => patch.id === change.patchId);
        if (captured === undefined || !sameValue(captured, current)) return { kind: 'cancelled' };
      }
      const patches = new Map((active?.patches ?? []).map(patch => [patch.id, patch]));
      let order = Math.max(-1, ...[...patches.values()].map(patch => patch.order)) + 1;
      for (const [id, patch] of replacements) {
        if (patch === null) patches.delete(id);
        else patches.set(id, result.kind === 'draw' ? { ...patch, order: order++ } : patch);
      }
      const layer: PaintLayer = { id: owner, name: active?.name ?? 'Paint', hidden: active?.hidden ?? false,
        opacity: active?.opacity ?? 1, patches: [...patches.values()] };
      const layers = active === undefined ? [...before.paint.layers, layer] : before.paint.layers.map(value => value.id === owner ? layer : value);
      const next = advancePaintDocument(before, layers), candidateAssets = new Map([...products.assets, ...staged]);
      const store = { ...products, assets: candidateAssets };
      const marker = { kind: 'selection', key: null, at: performance.now(), selection: { before: activeSelection, after: activeSelection } } satisfies HistoryEntry;
      paintHistory.set(marker, { before: before.paint.layers, after: layers });
      let nextHistory: History;
      try { nextHistory = admitHistory(next, activeSelection, push(history, marker, next), store); }
      catch (error) { return { kind: 'refused', reason: error instanceof Error ? error.message : 'This stroke exceeds the asset budget.' }; }
      if (!guard.isCurrent()) return { kind: 'cancelled' };
      // Renderer admission is transactional; a refusal changes no document,
      // products, history or checkpoint. No await is allowed after this guard.
      const admission = renderer?.setPaintPlanes(resolvePaintPlanes(next, candidateAssets));
      if (admission?.kind !== 'accepted') return { kind: 'refused', reason: admission?.reason ?? 'The paint renderer is unavailable.' };
      paintAdmitted = true;
      for (const [asset, encoded] of staged) if (!products.assets.has(asset)) products.installEncoded(asset, encoded);
      history = nextHistory;
      setDocument(next); retainAssets(next);
      return { kind: 'applied' };
    });
    paintTail = work.catch(() => undefined);
    return work.finally(() => { paintQueuedBytes -= bytes; });
  }
  function authoringChanged(selectionChanged = false): void {
    const previous = state.authoring;
    state = { ...state, authoring: authoring.snapshot() };
    try {
      syncCompare();
      // Selection previews have their own gesture state, separate from color gestures.
      // Redraw their decoration even when the authoring view has not moved.
      // Other transient tool/target/sample changes preserve the displayed frame and hit identity.
      const viewChanged = authoringNeutral && !sameValue(selection.navigation.snapshot(), drawnAuthoringView);
      if (state.scene !== null && (previous.gesture !== null || state.authoring.gesture !== null || viewChanged ||
        (authoringNeutral && selectionChanged))) draw(state.scene);
    }
    catch (error) { state = { ...state, status: error instanceof Error ? error.message : String(error) }; }
    for (const listener of listeners) listener(visibleState());
  }

  // C2 authoring boundary: immutable selection assets, local operations and retention.
  function selectionPixels(value = activeSelection): SelectionPixels | null {
    if (value === null) return null;
    const plane = products.masks.get(value.mask.plane.asset);
    return plane === undefined ? null : { space: value.space, plane };
  }
  function cancelSelectionWork(): void {
    selectionEpoch++; selectionCommit++; pendingSelection = false; selectionChange = null; pendingSelectionToken = null;
    selection.cancelActive(); selection.restore(selectionPixels());
  }
  function localEdit(value: Extract<GestureValue, { kind: 'color' | 'fill' | 'clipping' }>, target: OperationTarget,
    previous: Extract<Edit, { kind: 'effect.set' }> | null = null): Edit | null {
    const doc = state.scene?.doc;
    if (doc === undefined || pendingSelection || selectionHashing !== null) return null;
    const resolved = resolveOperationTarget({ document: doc, target, selection: activeSelection });
    if (!resolved.ok || resolved.value.kind !== 'local') return null;
    const { owner, scope } = resolved.value;
    const kind = value.kind === 'color' ? 'recolor' : value.kind;
    const matches = (effect: LocalEffect): boolean => effect.operation.kind === kind &&
      sameValue(effect.owner, owner) && sameValue(effect.scope, scope);
    const existing = doc.localEffects.findLast(matches);
    const preview = previous?.value != null && matches(previous.value) ? previous.value : undefined;
    const id = existing?.id ?? preview?.id ?? crypto.randomUUID();
    if (!isEffectId(id)) throw new Error('The local operation id is invalid.');
    const index = existing === undefined ? doc.localEffects.length : doc.localEffects.indexOf(existing);
    const remove: Edit = { kind: 'effect.set', id, value: null, index };
    let operation: LocalEffect['operation'];
    switch (value.kind) {
      case 'color':
        if (value.color === null) return remove;
        operation = { kind: 'recolor', color: value.color }; break;
      case 'fill':
        if (value.color === null) return remove;
        operation = { kind: 'fill', color: value.color }; break;
      case 'clipping':
        if (value.amount === 0) return remove;
        operation = value; break;
      default: { const unhandled: never = value; return unhandled; }
    }
    return { kind: 'effect.set', id, index,
      value: { id, enabled: true, owner, scope: structuredClone(existing?.scope ?? preview?.scope ?? scope), operation } };
  }
  function assetPlan(doc: SceneDocument, selected: ActiveSelection, stack: History, store = products) {
    const activeDocument = { ...doc, analysis: { ...doc.analysis, plate: store.cachedRepair(doc) } };
    const active = collectCompositionAssets([{ kind: 'document', document: activeDocument }, { kind: 'selection', selection: selected }]);
    if (!active.ok) throw new Error(active.error.detail);
    const roots: CompositionAssetRoot[] = [{ kind: 'document', document: activeDocument }, { kind: 'selection', selection: selected }];
    const repairKeys = new Set<string>();
    function addDocument(document: SceneDocument): void {
      const cached = store.cachedRepair(document);
      repairKeys.add(repairBasis(document));
      roots.push({ kind: 'document', document: { ...document, analysis: { ...document.analysis, plate: cached } } });
    }
    addDocument(doc);
    for (const direction of ['undo', 'redo'] as const) {
      let prior = doc;
      for (const entry of [...stack[direction]].reverse()) {
        if (isRecipeEntry(entry)) {
          const restored = restoreRecipe(prior, direction === 'undo' ? entry.before : entry.after);
          if (!restored.ok) throw new Error(`A retained recipe action is invalid: ${restored.error.message}`);
          prior = restored.value; addDocument(prior); continue;
        }
        for (const stencil of [entry.selection?.before, entry.selection?.after]) if (stencil !== undefined) roots.push({ kind: 'selection', selection: stencil });
        const paint = paintHistory.get(entry);
        if (paint !== undefined) { prior = advancePaintDocument(prior, paint[direction === 'undo' ? 'before' : 'after']); addDocument(prior); continue; }
        if (!('forward' in entry)) continue;
        const result = applyEdits(prior, direction === 'undo' ? entry.inverse : entry.forward, prior.updatedAt);
        if (result.kind === 'refused') throw new Error(`A retained history action is invalid: ${result.detail}`);
        prior = result.doc; addDocument(prior);
      }
    }
    const inventory = collectCompositionAssets(roots);
    if (!inventory.ok) throw new Error(inventory.error.detail);
    const activeIds = new Set(active.value.keys()), retained = new Set(inventory.value.keys());
    for (const asset of referencedAssets(stack)) retained.add(asset);
    const bytes = (ids: ReadonlySet<AssetId>, excludeOriginal: boolean) => [...ids].reduce((total, id) => {
      const refs = inventory.value.get(id) ?? active.value.get(id) ?? [];
      if (excludeOriginal && refs.length > 0 && refs.every(ref => ref.kind === 'original')) return total;
      const value = store.assets.get(id);
      if (value === undefined) throw new Error(`The composition asset ${id} is unavailable.`);
      return total + value.byteLength;
    }, 0);
    return { activeIds, retained, repairKeys, activeBytes: bytes(activeIds, true), historyBytes: bytes(new Set([...retained].filter(id => !activeIds.has(id))), false) };
  }
  function admitHistory(doc: SceneDocument, selected: ActiveSelection, stack: History, store = products, evictUndo = true): History {
    const cached = store.cachedRepair(doc);
    if (doc.analysis.plate !== cached) doc = { ...doc, analysis: { ...doc.analysis, plate: cached } };
    let candidate = stack, plan = assetPlan(doc, selected, candidate, store);
    if (plan.activeBytes > COMPOSITION_LIMITS.activeAssetBytes) throw new Error('This edit exceeds the 64 MiB active asset limit.');
    while (evictUndo && plan.historyBytes > COMPOSITION_LIMITS.historyAssetBytes && candidate.undo.length > 1) {
      candidate = { ...candidate, undo: candidate.undo.slice(1) }; plan = assetPlan(doc, selected, candidate, store);
    }
    if (plan.historyBytes > COMPOSITION_LIMITS.historyAssetBytes) throw new Error('This edit exceeds the 64 MiB history asset limit.');
    const admission = projects.preflightObserve(doc, store.assets);
    if (admission.kind === 'refused') throw new Error(admission.reason);
    return candidate;
  }
  function retainAssets(doc: SceneDocument): void {
    const plan = assetPlan(doc, activeSelection, history);
    const preview = refinement?.preview?.mask.asset;
    if (preview !== undefined) plan.retained.add(preview);
    // Projects owns detached bounded byte snapshots, independently of this resident store.
    products.retain(plan.retained, plan.repairKeys);
  }
  async function commitSelectionAction(action: () => CommandResult, token: SelectionGestureToken | null = null): Promise<CommandResult> {
    remix.finishEditing();
    if (pendingSelection || selectionHashing !== null) return { kind: 'refused', reason: 'Wait for the selection to finish.' };
    const doc = state.scene?.doc;
    if (doc === undefined) return { kind: 'refused', reason: 'Open a photo first.' };
    authoring.cancel();
    selectionChange = null;
    const result = action(), change = selectionChange as SelectionChange | null;
    if (result.kind !== 'applied' || change === null) return result;
    const ticket = ++selectionCommit, epoch = selectionEpoch, sceneGeneration = generation;
    const before = activeSelection;
    pendingSelection = true; pendingSelectionToken = token; authoringChanged();
    try {
      let after: ActiveSelection = null;
      if (change.after !== null) {
        const hashBytes = (change.before?.plane.data.byteLength ?? 0) + change.after.plane.data.byteLength * 2 + 16;
        if (hashBytes > COMPOSITION_LIMITS.dirtyStrokeBytes) throw new Error('This selection exceeds the 16 MiB gesture limit.');
        selectionHashing = { ticket, bytes: hashBytes };
        const staged = createProducts(), asset = await staged.admitPlane(change.after.plane);
        if (ticket !== selectionCommit || epoch !== selectionEpoch || sceneGeneration !== generation) return { kind: 'cancelled' };
        const provenance: MaskProvenance = change.operation === 'initialize' ? { kind: 'full' }
          : { kind: 'manual', operation: change.operation === 'clear' ? 'rectangle' : change.operation };
        after = { space: change.after.space, mask: { plane: { asset, format: 'u8', size: { ...change.after.plane.size } }, provenance } };
        const bytes = staged.assets.get(asset);
        if (bytes === undefined) throw new Error('The selection asset was not encoded.');
        products.installEncoded(asset, bytes);
      }
      if (ticket !== selectionCommit || epoch !== selectionEpoch || sceneGeneration !== generation || state.scene === null) return { kind: 'cancelled' };
      const next = recordSelection({ doc: state.scene.doc, history, before, after, at: performance.now(), masks: products.masks });
      history = admitHistory(state.scene.doc, after, next); activeSelection = after;
      pendingSelection = false; selectionChange = null;
      authoring.reconcile(state.scene.doc, state.scene.selected);
      retainAssets(state.scene.doc); return { kind: 'applied' };
    } catch (error) {
      if (ticket === selectionCommit && epoch === selectionEpoch && sceneGeneration === generation) selection.restore(selectionPixels(before));
      return { kind: 'refused', reason: error instanceof Error ? error.message : 'The selection could not be retained.' };
    } finally {
      if (selectionHashing?.ticket === ticket) selectionHashing = null;
      if (ticket === selectionCommit) {
        pendingSelection = false; selectionChange = null; pendingSelectionToken = null;
        if (state.scene !== null) retainAssets(state.scene.doc);
      }
      authoringChanged();
    }
  }
  function enterAuthoring(): void {
    authoring.cancel(); cancelRefinement(); cancelExport(); selectionEpoch++;
    loop.stop(); stopView(); authoringNeutral = true;
  }
  function setAuthoringTool(tool: Tool): CommandResult {
    if (tool === 'brush' || tool === 'eraser') {
      const { diameter, opacity, pressure, operation } = state.brush;
      const next: PaintBrush = tool === 'eraser' ? { operation: 'erase', diameter, opacity, pressure }
        : drawBrush.operation === 'draw' ? { ...drawBrush, diameter, opacity, pressure } : DEFAULT_BRUSH;
      const applied = writePaintBrush(next);
      if (applied.kind === 'refused' || applied.kind === 'cancelled') return applied;
      if (operation !== state.brush.operation) interruptPaint('tool-change');
      void paint.replayBrushPreview();
    }
    cancelSelectionWork();
    if (tool === 'rectangle' || tool === 'freehand' || tool === 'navigate') enterAuthoring();
    else { authoringNeutral = false; if (tool === 'select' && readyScene !== null && analysis.snapshot().modelsReady) {
      const current = generation;
      void analysis.requestDecoder().catch(error => { if (current === generation) publish({ ...state, status: error instanceof Error ? error.message : String(error) }); });
    } }
    const result = authoring.setTool(tool);
    authoringChanged(); return result;
  }
  function setOperationTarget(target: OperationTarget): CommandResult {
    cancelSelectionWork(); return authoring.setTarget(target);
  }
  function refreshAuthoringLayout(layout?: AuthoringLayout): void {
    if (layout !== undefined) { selection.navigation.layout(layout); return; }
    const transform = stageCanvas?.style.transform;
    if (stageCanvas !== null) stageCanvas.style.transform = '';
    const source = state.scene?.doc.frame.master.size, rect = stageCanvas?.getBoundingClientRect();
    if (stageCanvas !== null) stageCanvas.style.transform = transform ?? '';
    if (source === undefined || rect === undefined || rect.width <= 0 || rect.height <= 0) return;
    selection.navigation.layout({ source, viewport: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, dpr: window.devicePixelRatio });
  }
  const publish = (next: Pick<DemoState, 'status' | 'scene'>, refuseOnRenderError = false): void => {
    const beforeRemix = state.scene?.doc.version === 6 ? state.scene.doc.remix : null;
    const afterRemix = next.scene?.doc.version === 6 ? next.scene.doc.remix : null;
    const brushRackChanged = !sameValue(beforeRemix === null ? null :
      [beforeRemix.functions, beforeRemix.blocks, beforeRemix.instances.filter(instance => instance.target === 'brush')],
      afterRemix === null ? null : [afterRemix.functions, afterRemix.blocks, afterRemix.instances.filter(instance => instance.target === 'brush')]);
    if (next.scene !== null && readyScene?.generation === generation) {
      const admission = projects.preflightObserve(next.scene.doc, products.assets);
      if (admission.kind === 'refused') throw new Error(admission.reason);
    }
    if (next.scene?.doc !== state.scene?.doc) cancelExport();
    const scene = next.scene === null ? null : { ...next.scene, doc: readDocument(next.scene.doc), ...products.forScene(next.scene.doc) };
    if (scene !== null) authoring.reconcile(scene.doc, scene.selected);
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
    if (scene !== null && readyScene?.generation === generation) {
      const admission = projects.observe(scene.doc, products.assets);
      if (admission.kind === 'refused') throw new Error(admission.reason);
    }
    state = { brush: scene?.doc.version === 6 ? scene.doc.paint.brush : state.brush, fingerDraw: state.fingerDraw,
      authoring: authoring.snapshot(), exportProgress: state.exportProgress, status, scene, analysisStatus: analysis.snapshot().status, analysisTiming: analysis.lastTiming(), parallaxEnabled: view.enabled(), refiningObject: refinement?.id ?? null, refinementSize: refinement?.size ?? null };
    if (brushRackChanged) void paint.replayBrushPreview();
    for (const listener of listeners) listener(visibleState());
  };
  // Analysis/import setter; UI mutations use the recorded session actions.
  const setDocument = (doc: SceneDocument): void => {
    const scene = state.scene;
    if (scene === null || scene.doc.id !== doc.id) throw new Error('The document belongs to another photo.');
    if (doc.compositing === 'scene-depth') { publish({ ...state, status: 'Scene-depth composition requires C3.' }); return; }
    const cached = products.cachedRepair(doc);
    if (doc.analysis.plate !== cached) doc = { ...doc, analysis: { ...doc.analysis, plate: cached } };
    doc = currentDocumentSchema.parse(doc);
    const admission = projects.preflightObserve(doc, products.assets);
    if (admission.kind === 'refused') throw new Error(admission.reason);
    const before = sortedMasks(scene.doc), after = sortedMasks(doc);
    const masksChanged = before.length !== after.length || before.some((asset, i) => asset !== after[i]);
    const selected = doc.objects.some((object) => object.id === scene.selected) ? scene.selected : null;
    let selectionOwnerChanged = false;
    for (const object of [...scene.doc.objects, ...doc.objects]) {
      const before = scene.doc.objects.find(item => item.id === object.id), after = doc.objects.find(item => item.id === object.id);
      if (before?.produced.mask.asset !== after?.produced.mask.asset) {
        ownerVersions.set(object.id, (ownerVersions.get(object.id) ?? 0) + 1);
        if (activeSelection?.space.kind === 'layer' && activeSelection.space.id === object.id) selectionOwnerChanged = true;
      }
    }
    if (activeSelection !== null && !selectionOwnerSize(doc, activeSelection.space).ok) activeSelection = null;
    publish({ status: state.status, scene: { ...scene, doc, selected } });
    if (selectionOwnerChanged) selection.restore(selectionPixels());
    if (readyScene?.generation === generation) retainAssets(doc);
    // Every committed change can invalidate v5's repair key (including Motion
    // parameters and history), even when the extraction masks did not change.
    if (plateNeeded(doc) || (doc.analysis.plate !== null && state.scene?.plate === null) || (masksChanged && viewEnabled())) {
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
      const previous = state.scene.doc;
      try {
        const now = new Date().toISOString();
        const result = applyProduce(state.scene.doc, product, now);
        if (result.kind === 'refused') throw new Error(result.detail);
        let doc = result.doc;
        if (product.kind === 'plate' && result.kind === 'applied') products.rememberRepair(doc, product.plate);
        if (product.kind === 'depth') doc = backfillDepthSummaries(doc, products, now);
        history = admitHistory(doc, activeSelection, history, products, false);
        setDocument(doc);
      } catch (error) {
        if (product.kind === 'plate') {
          products.forgetRepair(previous);
          if (previous.analysis.plate !== null) products.rememberRepair(previous, previous.analysis.plate);
        }
        retainAssets(previous);
        throw error;
      }
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
    if (liveResult.kind !== 'limited') updatePaintView({ kind: 'perspective', frame, geometry, eye: { ...liveResult.eye }, requestEye: { ...eye } });
    return { eye: liveResult.kind === 'limited' ? { x: 0, y: 0, z: geometry.neutralDistance } : liveResult.eye,
      viewId: liveViewId, limitation: liveResult.reason };
  }
  const viewHost = {
    read: () => state.scene?.doc ?? null,
    generation: () => generation,
    draw: (_camera, frame) => { if (recordingJob === null && paintWork.size === 0 && state.scene !== null) return renderLive(state.scene, frame); },
    changed: () => {
      if (!view.enabled()) { stopView(); publish({ ...state, status: view.status() }); return; }
      // Source status does not change scene products. The live clock owns drawing;
      // publishing the full scene here would prepare and draw a second frame.
      loop.stop();
      const status = liveKey !== null && liveResult.kind === 'limited' ? `${view.status()} - ${liveResult.reason}` : view.status();
      state = { ...state, status, parallaxEnabled: true };
      for (const listener of listeners) listener(visibleState());
    },
    failed: (status) => { stopView(); publish({ ...state, status }); },
  } satisfies ViewHost;
  const cameraSource = createWindowSource({ openTracker: () => analysis.openFaceTracker() });
  const tiltSource = createTiltSource();
  const view = createViewDriver(viewHost, { camera: cameraSource.source, tilt: tiltSource.source });
  function viewEnabled(): boolean { return view.enabled(); }
  function stopView(): void {
    view.stop(); renderer?.endPerspective(); liveKey = null; liveResult = { kind: 'limited', reason: 'Parallax is off' };
    // Detachment can stop the view after its analysis owner has closed. This
    // cancellation request has no result to publish, but still owns rejection.
    void analysis.requestLivePlate(null).catch(() => undefined);
  }
  async function setParallax(enabled: boolean): Promise<void> {
    interruptPaint('generation-change');
    if (!enabled) { stopView(); publish({ ...state, status: 'Ready' }); return; }
    if (state.scene === null || readyScene?.generation !== generation || !analysis.snapshot().modelsReady) return;
    cancelSelectionWork(); authoringNeutral = false;
    const starting = view.start();
    await starting;
  }
  let committedRendering = false;
  // Export methods capture their pixels synchronously before returning a promise.
  // Queued autosave thumbnails must never capture a transient authoring preview.
  function committedRender<T>(capture: () => T, document = state.scene?.doc): T {
    const scene = state.scene;
    if (scene === null || document === undefined || document.id !== scene.doc.id) throw new Error('The output document is not in this photo.');
    if (document === scene.doc && authoring.snapshot().gesture === null && refinement?.preview == null && !authoringNeutral) return capture();
    return captureCommitted({ document, capture,
      render(doc) { committedRendering = true; draw({ ...scene, doc, ...products.forScene(doc) }); },
      restore() { committedRendering = false; if (state.scene !== null) draw(state.scene); },
    });
  }
  function draw(scene: DemoScene): void {
    if (renderer === null) {
      if (renderError !== null) throw renderError;
      return;
    }
    const authoringView = selection.navigation.snapshot();
    if (stageCanvas !== null) {
      stageCanvas.style.transform = !committedRendering && authoringNeutral ? `translate(${authoringView.pan.x}px, ${authoringView.pan.y}px) scale(${authoringView.zoom})` : '';
    }
    const base = readDocument(committedRendering ? scene.doc : authoring.previewDocument(scene.doc));
    const preview = committedRendering ? null : refinement?.preview;
    const doc = preview === null || preview === undefined ? base : {
      ...base, objects: base.objects.map((object) => object.id === refinement?.id ? { ...object, produced: preview } : object),
    };
    const masks = preview === null || preview === undefined ? scene.masks : products.forScene(doc).masks;
    const selected = doc.objects.some((object) => object.id === scene.selected && !object.hidden) ? scene.selected : null;
    const live = analysis.livePlate(), geometry = liveGeometry(doc);
    const matchingLive = live.kind === 'ready' && geometry !== null && live.product.key === liveCoverage(doc, geometry)?.key ? live.product : null;
    const backgroundDepth = doc.analysis.plate === null ? null : products.depths.get(doc.analysis.plate.backgroundDepth.asset) ?? null;
    if (paintMaster !== scene.master || paintDepth !== scene.depth) {
      if (paintMaster !== null) interruptPaint('generation-change');
      clearPaintPlanes();
    }
    renderer.setScene({ doc, master: scene.master, masks, depth: scene.depth, plate: scene.plate, selected,
      localEffects: resolveLocalEffects(doc.localEffects, products.masks), compositing: doc.compositing, backgroundDepth,
      manualSelection: committedRendering || !authoringNeutral ? null : selection.preview()?.plane ?? null, livePlate: matchingLive });
    const rack = remix.synchronize(doc, renderer);
    if (!rack.ok) throw new Error(rack.error.message);
    paintMaster = scene.master; paintDepth = scene.depth;
    syncPaintPlanes(doc);
    syncCompare();
    if (!committedRendering && paintWork.size > 0) {
      loop.stop();
      if (paintView.kind === 'perspective') {
        const accepted = renderer.renderPerspective({ geometry: paintView.geometry, eye: paintView.requestEye,
          frame: paintView.frame, sceneGeneration: generation, viewId: ++liveViewId });
        if (accepted.kind === 'limited' || !sameValue(accepted.eye, paintView.eye)) interruptPaint('generation-change');
      }
      else if (paintView.kind === 'motion') renderer.renderFrame(paintView.frame);
      else renderer.renderStill();
    }
    else if (!committedRendering && authoringNeutral) { loop.stop(); renderer.renderStill(); updatePaintView({ kind: 'still' }); }
    else if (viewEnabled() && !committedRendering) {
      loop.stop(); renderLive(scene, view.frame());
    } else if (scene.doc.motion.enabled && readyScene?.generation === generation && readyScene.id === scene.doc.id && !plateNeeded(scene.doc) &&
      (scene.doc.analysis.plate === null || scene.plate !== null)) {
      if (loop.running()) renderer.renderFrame(loop.frame());
      loop.start(frameCount(scene.doc.motion, LOOP_FPS), scene.doc.id);
      updatePaintMotion(loop.frame(), doc);
    } else {
      loop.stop(); renderer.renderStill(); updatePaintView({ kind: 'still' });
    }
    drawnAuthoringView = authoringView;
  }
  function retainMasks(doc: SceneDocument): void {
    retainAssets(doc);
  }
  function record(edit: Edit, inverse: DocumentHistoryEntry['inverse'], doc: SceneDocument): void {
    const masks = new Map<AssetId, Plane<'u8'>>();
    for (const action of [edit, ...inverse]) {
      const asset = action.kind === 'object.add' ? action.object.produced.mask.asset
        : action.kind === 'object.refine' ? action.produced.mask.asset : null;
      const mask = asset === null ? undefined : products.masks.get(asset);
      if (asset !== null && mask !== undefined) masks.set(asset, mask);
    }
    history = admitHistory(doc, activeSelection, push(history, { key: coalesceKey(edit), at: performance.now(), forward: [edit], inverse, masks }, doc));
    retainMasks(doc);
  }
  // Direct setters keep the legacy 600 ms coalescing until C1u moves the UI onto
  // gestures; an authoring gesture or color pick commits as its own step (key null).
  function edit(edit: Edit, key: string | null = coalesceKey(edit)): CommandResult {
    remix.finishEditing();
    if (edit.kind === 'motion') interruptPaint('generation-change');
    authoring.cancel();
    cancelSelectionWork();
    cancelRefinement();
    if (state.scene === null) return { kind: 'refused', reason: 'Open a photo first.' };
    const result = recordEdit({ doc: state.scene.doc, history, edit, key, now: new Date().toISOString(), at: performance.now(), masks: products.masks });
    if (result.kind === 'refused') {
      state = { ...state, status: `The edit was refused: ${result.detail}` };
      for (const listener of listeners) listener(visibleState());
      return { kind: 'refused', reason: result.detail };
    }
    if (result.kind === 'unchanged') return { kind: 'unchanged' };
    const selected = activeSelection !== null && !selectionOwnerSize(result.doc, activeSelection.space).ok ? null : activeSelection;
    let nextHistory = result.history;
    if (selected !== activeSelection) {
      nextHistory = { ...nextHistory, undo: [...nextHistory.undo.slice(0, -1), { ...nextHistory.undo.at(-1)!, selection: { before: activeSelection, after: selected } }] };
    }
    try { nextHistory = admitHistory(result.doc, selected, nextHistory); }
    catch (error) { return { kind: 'refused', reason: error instanceof Error ? error.message : 'The asset limit was exceeded.' }; }
    const save = projects.preflightObserve(result.doc, products.assets);
    if (save.kind === 'refused') return { kind: 'refused', reason: save.reason };
    const compiled = remix.synchronize(readDocument(result.doc));
    if (!compiled.ok) return { kind: 'refused', reason: compiled.error.message };
    history = nextHistory; activeSelection = selected;
    retainMasks(result.doc);
    setDocument(result.doc);
    if (edit.kind !== 'motion') publish({ ...state, status: viewEnabled() ? view.status() : 'Ready' });
    return { kind: 'applied' };
  }
  function stepHistory(direction: 'undo' | 'redo'): void {
    remix.finishEditing(); remix.invalidate();
    invalidateTaps();
    if (state.scene === null) return;
    const entry = history[direction].at(-1);
    const step = stepAuthoringHistory(history, direction);
    if (step === null || entry === undefined) return;
    if (step.kind === 'remix') {
      const restored = restoreRecipe(state.scene.doc, step.recipe, new Date().toISOString());
      if (!restored.ok) { publish({ ...state, status: restored.error.message }); return; }
      try {
        const next = admitHistory(restored.value, activeSelection, step.history, products, false);
        const save = projects.preflightObserve(restored.value, products.assets);
        if (save.kind === 'refused') throw new Error(save.reason);
        const compiled = remix.synchronize(restored.value);
        if (!compiled.ok) throw new Error(compiled.error.message);
        history = next; setDocument(restored.value); retainAssets(restored.value);
      } catch (error) { publish({ ...state, status: error instanceof Error ? error.message : String(error) }); }
      return;
    }
    const paint = paintHistory.get(entry);
    if (paint !== undefined) {
      const doc = advancePaintDocument(state.scene.doc, paint[direction === 'undo' ? 'before' : 'after']);
      try {
        const nextHistory = admitHistory(doc, activeSelection, step.history, products, false);
        const admission = renderer?.setPaintPlanes(resolvePaintPlanes(doc, products.assets));
        if (admission?.kind !== 'accepted') throw new Error(admission?.reason ?? 'The paint renderer is unavailable.');
        paintAdmitted = doc.version === 6 && doc.paint.layers.some(layer => layer.patches.length > 0);
        history = nextHistory; setDocument(doc); retainAssets(doc);
      }
      catch (error) { publish({ ...state, status: error instanceof Error ? error.message : String(error) }); }
      return;
    }
    if (step.kind === 'selection') {
      try { history = admitHistory(state.scene.doc, step.selection, step.history, products, false); }
      catch (error) { publish({ ...state, status: error instanceof Error ? error.message : String(error) }); return; }
      activeSelection = step.selection;
      selection.restore(selectionPixels()); retainAssets(state.scene.doc); authoringChanged(); return;
    }
    const result = applyEdits(state.scene.doc, step.edits, new Date().toISOString());
    if (result.kind === 'refused') { publish({ ...state, status: `The edit was refused: ${result.detail}` }); return; }
    const nextSelection = step.selection === undefined ? activeSelection : step.selection;
    let nextHistory: History;
    try { nextHistory = admitHistory(result.doc, nextSelection, step.history, products, false); }
    catch (error) { publish({ ...state, status: error instanceof Error ? error.message : String(error) }); return; }
    const save = projects.preflightObserve(result.doc, products.assets);
    if (save.kind === 'refused') { publish({ ...state, status: save.reason }); return; }
    const compiled = remix.synchronize(readDocument(result.doc));
    if (!compiled.ok) { publish({ ...state, status: compiled.error.message }); return; }
    for (const [asset, mask] of ('masks' in entry ? entry.masks : undefined) ?? []) products.putMask(asset, mask);
    history = nextHistory; activeSelection = nextSelection;
    retainMasks(result.doc);
    setDocument(result.doc);
    selection.restore(selectionPixels());
  }
  async function requestPlateIfNeeded(publicationSignal?: AbortSignal): Promise<void> {
    const current = generation;
    await pendingMask;
    while (refinement !== null && current === generation) await refinement.done;
    if (current !== generation || readyScene?.generation !== current) return;
    if (publicationSignal !== undefined) return analysis.preparePublicationPlate(publicationSignal);
    return analysis.requestPlateIfNeeded();
  }
  function select(id: ObjectId | null): void {
    if (id !== state.scene?.selected) authoring.cancel();
    if (id !== state.scene?.selected) cancelSelectionWork();
    cancelRefinement();
    const scene = state.scene;
    if (scene === null) return;
    if (id !== null && !scene.doc.objects.some((object) => object.id === id)) throw new Error('The object is not in this photo.');
    publish({ status: 'Ready', scene: { ...scene, selected: id } });
  }
  function tap(at: ImagePoint): Promise<void> {
    remix.finishEditing();
    authoring.cancel();
    cancelSelectionWork();
    cancelRefinement();
    if (![at.x, at.y].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) return Promise.resolve();
    if (state.scene === null || readyScene?.generation !== generation) return Promise.resolve();
    const decoder = analysis.decoder();
    if (decoder === null) {
      if (analysis.snapshot().modelsReady && !analysis.snapshot().embeddings) return analysis.requestDecoder().then(() => analysis.decoder() === null ? undefined : tap(at));
      publish({ ...state, status: 'Still analyzing…' }); return Promise.resolve();
    }
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
      const staged = createProducts(), asset = await staged.admitPlane(mask);
      if (!valid() || state.scene === null) return;
      const lock = bundledLock();
      if (!lock.ok) throw new Error(lock.error);
      remix.finishEditing();
      const latest = state.scene;
      if (!valid() || latest === null) return;
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
      products.installEncoded(asset, staged.assets.get(asset)!);
      if (result.kind === 'applied') record({ kind: 'object.add', object }, result.inverse, result.doc);
      setDocument(result.doc); select(id);
    };
    pendingMask = pendingMask.then(run).catch((error: unknown) => {
      if (valid()) {
        if (state.scene !== null) retainAssets(state.scene.doc);
        publish({ ...state, status: error instanceof Error ? error.message : String(error) });
      }
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
    current.preview = null;
    if (state.scene !== null && readyScene?.generation === generation) retainAssets(state.scene.doc);
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
    const staged = createProducts(), asset = await staged.admitPlane(mask);
    if (!refineValid(current) || current.revision !== revision || state.scene === null) return;
    const provenance = current.original.provenance;
    if (provenance.kind !== 'ai') return;
    const original = provenance.selection;
    const points = original.kind === 'taps' ? original.points : [original.seed];
    const point = points[0];
    if (point === undefined) return;
    const produced = objectProduced({ model: provenance.model, at: point.at, asset, mask,
      master: scene.doc.frame.master.size, depth: state.scene.depth, thumbnail: makeThumbnail(scene.master), seed: scene.doc.seed,
      selection: { ...original, candidate: candidate.candidate, size } });
    if (produced === null) { cancelRefinement(); return; }
    dropPreview(current);
    products.installEncoded(asset, staged.assets.get(asset)!); current.preview = produced; current.applied = revision;
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
    remix.finishEditing();
    authoring.cancel();
    cancelSelectionWork();
    cancelExport();
    cancelRefinement();
    const scene = state.scene, decoder = analysis.decoder();
    const object = scene?.doc.objects.find((entry) => entry.id === id);
    if (scene === null || object === undefined || decoder === null || readyScene?.generation !== generation || tapControllers.size > 0) return false;
    const original = object.produced;
    if (original.provenance.kind !== 'ai') return false;
    const selection = original.provenance.selection;
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
    for (const listener of listeners) listener(visibleState());
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
      remix.finishEditing();
      if (!refineValid(current) || state.scene === null) return;
      const result = applyEdit(state.scene.doc, { kind: 'object.refine', id: current.id, produced }, new Date().toISOString());
      if (result.kind === 'refused') throw new Error(result.detail);
      if (result.kind === 'applied') record({ kind: 'object.refine', id: current.id, produced }, result.inverse, result.doc);
      refinement = null; current.resolve();
      // Publish the committed change; an exact cached repair is restored by its request basis.
      setDocument(result.doc);
    } catch (error) {
      if (refineValid(current)) {
        cancelRefinement();
        publish({ ...state, status: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  type LoadedProject = Awaited<ReturnType<typeof projects.load>>;
  function backfillDepthSummaries(doc: SceneDocument, store: Products, now: string): SceneDocument {
    const depth = doc.analysis.depth === null ? undefined : store.depths.get(doc.analysis.depth.map.asset);
    if (depth === undefined) return doc;
    for (const object of doc.objects) {
      if (object.produced.depth !== null) continue;
      const mask = store.masks.get(object.produced.mask.asset);
      const stats = mask === undefined ? null : maskedDepth(mask, depth);
      if (stats === null) continue;
      const update = applyProduce(doc, { kind: 'object.depth', id: object.id, depth: stats }, now);
      if (update.kind === 'refused') throw new Error(update.detail);
      doc = update.doc;
    }
    return doc;
  }
  async function preparedComposition(project: Extract<LoadedProject, { kind: 'composition' }>, staged: Products): Promise<DemoScene> {
    const doc = project.document;
    if (doc.compositing === 'scene-depth') throw new Error('Scene-depth composition requires C3.');
    const readiness = renderingPrerequisites(doc, project.assets);
    if (readiness.kind !== 'ready') throw new Error(`This saved composition is incomplete: ${readiness.reason}`);
    for (const [asset, bytes] of project.assets) staged.installEncoded(asset, bytes);
    const bytes = staged.assets.get(doc.frame.master.asset);
    if (bytes === undefined) throw new Error('The saved master is unavailable.');
    const masterPng = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
    const master = await createImageBitmap(masterPng);
    try {
      const canvas = new OffscreenCanvas(master.width, master.height), context = canvas.getContext('2d', { willReadFrequently: true });
      if (context === null) throw new Error('The saved master could not be read.');
      context.drawImage(master, 0, 0);
      const masterPixels = context.getImageData(0, 0, master.width, master.height);
      if (doc.analysis.plate !== null) {
        const plate = doc.analysis.plate, validation = createProducts();
        const union = sourceRemovalUnion(doc, staged.masks), hole = repairHole(doc, union);
        const [removalUnion, holeAsset] = await Promise.all([validation.admitPlane(union), validation.admitPlane(hole)]);
        const expected = { ...plate.key, source: doc.frame.master.asset, size: doc.frame.master.size,
          removalUnion, hole: holeAsset, depth: doc.analysis.depth?.map.asset ?? null,
          radius: Math.ceil(Math.ceil(Math.max(doc.frame.master.size.width, doc.frame.master.size.height) / 100) * doc.motion.parallax),
          purpose: doc.motion.enabled ? { kind: 'loop' as const, parallax: doc.motion.parallax, reach: effectiveOrbit(doc.motion) } : { kind: 'still' as const } };
        if (!sameValue(expected, plate.key)) throw new Error('The saved repair does not match its exact source removal and hole.');
        const encoded = staged.assets.get(plate.image.asset);
        if (encoded === undefined) throw new Error('The saved repair image is unavailable.');
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(encoded)], { type: 'image/png' }));
        try {
          context.clearRect(0, 0, master.width, master.height); context.drawImage(bitmap, 0, 0);
          const rgba = context.getImageData(0, 0, master.width, master.height).data, data = new Uint8Array(master.width * master.height * 3);
          for (let i = 0, j = 0; i < data.length; i += 3, j += 4) data.set(rgba.subarray(j, j + 3), i);
          staged.installRgb(plate.image.asset, { size: { width: master.width, height: master.height }, data });
        } finally { bitmap.close(); }
        staged.rememberRepair(doc, plate);
      }
      const resident = staged.forScene(doc);
      return { doc, master, masterPixels, masterPng, path: 'resize', ...resident, selected: null };
    } catch (error) { master.close(); throw error; }
  }
  async function hydratedLegacy(project: Extract<LoadedProject, { kind: 'legacy' }>, staged: Products, signal: AbortSignal): Promise<DemoScene> {
    const imported = await importScene(project.photo, staged);
    let temporary: ReturnType<typeof createAnalysisDriver> | null = null;
    try {
      signal.throwIfAborted();
      const migrated = migrateV4ToV5(project.document);
      if (!migrated.ok) throw new Error(JSON.stringify(migrated.error));
      if (!sameValue(imported.doc.frame.master.size, migrated.value.frame.master.size)) throw new Error('The saved photo no longer matches its master extent.');
      const replacements = new Map<AssetId, AssetId>();
      for (const [oldAsset, plane] of project.masks) { signal.throwIfAborted(); replacements.set(oldAsset, await staged.admitPlane(plane)); }
      const objects = migrated.value.objects.map(layer => {
        const asset = replacements.get(layer.produced.mask.asset);
        if (asset === undefined) throw new Error('A legacy layer mask is unavailable.');
        return { ...layer, produced: { ...layer.produced, mask: { ...layer.produced.mask, asset } },
          depthAttachment: { kind: 'plane' as const, disparity: layer.produced.depth?.median ?? .5 } };
      });
      let doc: SceneDocument = currentDocumentSchema.parse({ ...migrated.value,
        frame: { ...migrated.value.frame, master: imported.doc.frame.master,
          source: migrated.value.frame.source === null ? null : imported.doc.frame.source },
        analysis: { ...migrated.value.analysis, depth: null, plate: null }, objects,
        removals: migrated.value.removals.map(removal => ({ ...removal, mask: { ...removal.mask,
          plane: { ...removal.mask.plane, asset: replacements.get(removal.mask.plane.asset) } } })) });
      let candidate: DemoScene = { ...imported, doc, ...staged.forScene(doc) };
      const hydration = createProducts();
      signal.throwIfAborted();
      temporary = createAnalysisDriver({ read: () => candidate, products: hydration, changed: () => {},
        produce(product) {
          signal.throwIfAborted();
          const now = new Date().toISOString();
          const result = applyProduce(doc, product, now);
          if (result.kind === 'refused') throw new Error(result.detail);
          doc = result.doc;
          if (product.kind === 'depth' && project.document.analysis.depth !== null) doc = { ...doc,
            objects: doc.objects.map(layer => ({ ...layer, depthAttachment: { kind: 'source', map: product.depth.map, model: product.depth.model, offset: 0 } })) };
          if (product.kind === 'depth') doc = backfillDepthSummaries(doc, hydration, now);
          if (product.kind === 'plate') hydration.rememberRepair(doc, product.plate);
          candidate = { ...candidate, doc, ...hydration.forScene(doc) };
        } });
      const active = temporary, cancel = (): void => active.dispose();
      signal.addEventListener('abort', cancel, { once: true });
      try {
        const current = active.beginImport();
        for (const [asset, bytes] of staged.assets) hydration.installEncoded(asset, bytes);
        await active.sceneReady(current, imported.masterPixels);
        await active.waitForImport(); signal.throwIfAborted();
        if (plateNeeded(doc)) await active.requestPlateIfNeeded();
        signal.throwIfAborted();
        for (const [asset, bytes] of hydration.assets) staged.installEncoded(asset, bytes);
        for (const [asset, image] of hydration.plates) staged.installRgb(asset, image);
        if (doc.analysis.plate !== null) staged.rememberRepair(doc, doc.analysis.plate);
        return { ...candidate, ...staged.forScene(doc) };
      } finally { signal.removeEventListener('abort', cancel); }
    } catch (error) { imported.master.close(); throw error; }
    finally { temporary?.dispose(); }
  }
  // A saved composition is the working scene; Reset starts from its photo.
  function photoBaseline(scene: DemoScene): SceneDocument {
    return currentDocumentSchema.parse(newDocument({
      id: scene.doc.id, title: scene.doc.title, now: scene.doc.createdAt, seed: scene.doc.seed,
      frame: scene.doc.frame, writer: scene.doc.provenance.writer, importedOn: scene.doc.provenance.importedOn,
      analysis: { ...photoStats(makeThumbnail(scene.master), scene.doc.seed), depth: scene.doc.analysis.depth, plate: null, autoSubject: 'pending' },
    }));
  }
  function validateImportedRender(scene: DemoScene, staged: Products): void {
    try {
      if (renderer !== null) {
        clearPaintPlanes();
        renderer.setScene({ ...scene, localEffects: resolveLocalEffects(scene.doc.localEffects, staged.masks),
          backgroundDepth: scene.doc.analysis.plate === null ? null : staged.depths.get(scene.doc.analysis.plate.backgroundDepth.asset) ?? null });
        const rack = remix.synchronize(readDocument(scene.doc), renderer);
        if (!rack.ok) throw new Error(rack.error.message);
        paintMaster = scene.master; paintDepth = scene.depth;
        syncPaintPlanes(scene.doc, staged.assets);
        renderer.renderStill();
      } else if (renderError !== null) throw renderError;
    } finally { if (state.scene !== null) draw(state.scene); }
  }
  function installImported(scene: DemoScene, staged: Products, checkpoint: Parameters<typeof projects.begin>[0]['checkpoint'], current: number, refuseOnRenderError: boolean, resetBaseline = scene.doc): void {
    try {
      admitHistory(scene.doc, null, EMPTY_HISTORY, staged);
      const admission = projects.preflight({ document: scene.doc, assets: staged.assets, checkpoint });
      if (admission.kind === 'refused') throw new Error(admission.reason);
    }
    catch (error) { scene.master.close(); throw error; }
    remix.reset(); authoring.reset();
    paintOwner = null; paintOwnerEpoch++; paintWork.clear(); paintPointers.clear(); activePaintStroke = null;
    state = { ...state, brush: scene.doc.version === 6 ? scene.doc.paint.brush : DEFAULT_BRUSH };
    if (state.brush.operation === 'draw') drawBrush = state.brush;
    activeSelection = null; selection.restore(null); authoringNeutral = false; ownerVersions.clear();
    for (const [asset, bytes] of staged.assets) products.installEncoded(asset, bytes);
    for (const [asset, image] of staged.plates) products.installRgb(asset, image);
    if (scene.doc.analysis.plate !== null) products.rememberRepair(scene.doc, scene.doc.analysis.plate);
    const previous = state.scene;
    history = EMPTY_HISTORY;
    readyScene = null;
    try { publish({ status: 'Ready', scene }, refuseOnRenderError); }
    catch (error) { readyScene = null; scene.master.close(); throw error; }
    baseline = resetBaseline;
    void paint.replayBrushPreview();
    previous?.master.close();
    readyScene = { generation: current, id: scene.doc.id };
    refreshAuthoringLayout();
    const admission = projects.begin({ document: scene.doc, assets: products.assets, checkpoint });
    if (admission.kind === 'refused') throw new Error(admission.reason);
    retainAssets(scene.doc);
  }
  async function importSource(source: (signal: AbortSignal) => Promise<{
    readonly file: File; readonly project: LoadedProject | null;
  }>): Promise<boolean> {
    authoring.cancel(); cancelSelectionWork(); cancelRefinement(); cancelExport();
    importController?.abort();
    const controller = new AbortController();
    importController = controller;
    const expected = generation;
    const valid = (): boolean => (started ?? expected) === generation && !controller.signal.aborted && importController === controller;
    let started: number | null = null;
    try {
      while (projects.waitingForPreparation()) {
        if (!await finishCurrentProjectBeforeSwitch(controller) || !valid()) return false;
      }
      if (!valid()) return false;
      publish({ ...state, status: 'Importing…' });
      const { file, project } = await source(controller.signal);
      if (!valid()) return false;
      if (project !== null) throw new Error('Saved projects use the separate project open path.');
      const staged = createProducts(), imported = await importScene(file, staged);
      if (!valid()) { imported.master.close(); return false; }
      try {
        while (projects.waitingForPreparation()) {
          if (!await finishCurrentProjectBeforeSwitch(controller) || !valid()) { imported.master.close(); return false; }
        }
        if (!valid()) { imported.master.close(); return false; }
        validateImportedRender(imported, staged);
        admitHistory(imported.doc, null, EMPTY_HISTORY, staged);
        const admission = projects.preflight({ document: imported.doc, assets: staged.assets, checkpoint: { kind: 'new' } });
        if (admission.kind === 'refused') throw new Error(admission.reason);
      } catch (error) { imported.master.close(); throw error; }
      // The final synchronous admission precedes every change to the current
      // document, its history, resident products and unsaved project roots.
      cancelExport(); projects.suspend(); loop.stop(); stopView(); readyScene = null; invalidateTaps();
      const current = analysis.beginImport(); started = current; generation = current; pendingMask = Promise.resolve();
      installImported(imported, staged, { kind: 'new' }, current, true);
      await analysis.sceneReady(current, imported.masterPixels);
      return current === generation;
    } catch (error) {
      if (valid()) {
        if (started !== null) analysis.importFailed(started);
        projects.openFailed();
        publish({ status: error instanceof Error ? error.message : String(error), scene: state.scene });
      }
      return false;
    }
  }
  function cancelProjectSwitch(): boolean {
    const waiting = finishingSwitch;
    if (waiting === null || waiting.controller.signal.aborted) return false;
    waiting.controller.abort();
    publish({ ...state, status: 'Switch cancelled.' });
    return true;
  }
  async function finishCurrentProjectBeforeSwitch(controller: AbortController): Promise<boolean> {
    const scene = state.scene;
    if (scene === null || !projects.waitingForPreparation()) return !controller.signal.aborted;
    const waiting = { controller, project: scene.doc.id };
    finishingSwitch = waiting;
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && finishingSwitch === waiting) { event.preventDefault(); cancelProjectSwitch(); }
    };
    let abort = (): void => {};
    const cancelled = new Promise<false>((resolve) => { abort = () => resolve(false); controller.signal.addEventListener('abort', abort, { once: true }); });
    window.addEventListener('keydown', escape, true);
    try {
      publish(state);
      const finish = async (): Promise<boolean> => {
        for (;;) {
          controller.signal.throwIfAborted();
          let checkpointBecameReady = false;
          if (projects.waitingForPreparation()) {
            // Undo or a changed Motion setting may make this checkpoint ready
            // without the obsolete repair. Stop waiting as soon as that happens.
            let ready = (): void => {};
            const checkpointReady = new Promise<void>((resolve) => { ready = () => {
              if (!projects.waitingForPreparation()) { checkpointBecameReady = true; resolve(); }
            }; });
            listeners.add(ready);
            try { await Promise.race([requestPlateIfNeeded(), checkpointReady, cancelled]); }
            catch { if (projects.waitingForPreparation()) throw new Error('The background repair could not finish, so this project is still open.'); }
            finally { listeners.delete(ready); }
          }
          controller.signal.throwIfAborted();
          const current = state.scene;
          if (current === null || current.doc.id !== waiting.project) throw new Error('The current project changed before its work could be saved.');
          // A later listener/microtask may invalidate a checkpoint that just
          // became ready. Finish that new work instead of reporting a failure.
          if (checkpointBecameReady && projects.waitingForPreparation()) continue;
          if (renderingPrerequisites(current.doc, products.assets).kind !== 'ready') throw new Error('The background repair could not finish, so this project is still open.');
          const saved = await projects.flushCurrent();
          controller.signal.throwIfAborted();
          if (saved.kind === 'saved') return true;
        }
      };
      return await Promise.race([finish(), cancelled]);
    } catch (error) {
      if (!controller.signal.aborted && importController === controller) {
        if (finishingSwitch === waiting) finishingSwitch = null;
        publish({ ...state, status: error instanceof Error ? error.message : String(error) });
      }
      return false;
    } finally {
      controller.signal.removeEventListener('abort', abort);
      window.removeEventListener('keydown', escape, true);
      if (finishingSwitch === waiting) finishingSwitch = null;
    }
  }
  async function exportStereo(size: Size = STEREO_3DS_SIZE) {
    const scene = state.scene;
    if (scene === null) throw new Error('Open a photo before downloading.');
    if (renderer === null) throw new Error('The photo renderer is unavailable.');
    const activeRenderer = renderer;
    return committedRender(() => renderStereo(activeRenderer, scene.doc, size));
  }
  function exportLoopFrame(frame: number, edge = GIF_LONG_EDGE): ImageData {
    if (renderer === null || state.scene === null) throw new Error('Open a photo before exporting a loop.');
    const canvas = loopCanvas(state.scene.master, edge, true);
    const activeRenderer = renderer;
    committedRender(() => activeRenderer.exportStill({ frame, canvas }));
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
        committedRender(() => activeRenderer.exportStill({ frame: Math.floor(frame * loopFrames / frames), canvas }));
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
        recordingJob = controller;
        blob = await recordLoopMovie({ canvas, frames, render, fps: LOOP_FPS, format, signal, progress });
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
    remix,
    setBrush(brush: PaintBrush): Promise<CommandResult> {
      const previous = state.brush.operation, applied = paint.setBrush(brush);
      if (previous !== state.brush.operation) interruptPaint('tool-change');
      return applied;
    },
    attachBrushPreview(canvas: HTMLCanvasElement | null): void {
      previewObserver?.disconnect(); previewObserver = null; previewCanvas = canvas;
      paint.attachBrushPreview(canvas === null ? null : frame => { previewFrame = frame; redrawBrushPreview(); });
      if (canvas !== null) {
        previewObserver = new MutationObserver(redrawBrushPreview);
        previewObserver.observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });
      }
    },
    replayBrushPreview: paint.replayBrushPreview,
    resetBrushPreview: paint.resetBrushPreview,
    brushPreviewStatus: paint.brushPreviewStatus,
    drawingAvailability: paint.drawingAvailability,
    beginStroke(input: StrokeStart) {
      if (input.surface === 'scene') authoring.cancel();
      cancelExport();
      const begun = paint.beginStroke(input);
      if (activePaintStroke !== null) releasePaintWork(activePaintStroke);
      activePaintStroke = begun.ok ? begun.value : null;
      if (begun.ok) {
        paintPointers.set(begun.value, input.pointer);
        if (input.surface === 'scene') { paintWork.add(begun.value); loop.stop(); }
      }
      return begun;
    },
    extendStroke(token: StrokeToken, samples: Parameters<typeof paint.extendStroke>[1]): CommandResult {
      const result = paint.extendStroke(token, samples);
      if (result.kind === 'refused' || result.kind === 'cancelled') releasePaintWork(token);
      return result;
    },
    async endStroke(token: StrokeToken): Promise<CommandResult> {
      if (activePaintStroke === token) activePaintStroke = null;
      try { return await paint.endStroke(token); }
      finally { releasePaintWork(token); }
    },
    cancelStroke(token: StrokeToken): void {
      paint.cancelStroke(token); releasePaintWork(token);
    },
    interrupt: interruptPaint,
    setFingerDraw(on: boolean): void {
      paint.setFingerDraw(on); state = { ...state, fingerDraw: on };
      if (!on) for (const [token, pointer] of paintPointers) if (pointer === 'finger') releasePaintWork(token);
      for (const listener of listeners) listener(visibleState());
    },
    selectPaintLayer(id: ObjectId | null): CommandResult {
      const doc = state.scene?.doc;
      if (id !== null && (doc?.version !== 6 || !doc.paint.layers.some(layer => layer.id === id && !layer.hidden))) return { kind: 'refused', reason: 'That paint layer is unavailable.' };
      interruptPaint('generation-change'); paintOwner = id;
      if (id === null && doc !== undefined) {
        const fresh = crypto.randomUUID();
        if (!isObjectId(fresh)) return { kind: 'refused', reason: 'The paint layer id is invalid.' };
        paintOwner = fresh;
      }
      return { kind: 'applied' };
    },
    activePaintLayer: (): ObjectId | null => paintOwner,
    /** Browser proof drives the same accepted-eye capture as live parallax. */
    renderPaintPerspective(geometry: PerspectiveGeometry, eye: PerspectiveEye): PerspectiveRenderResult {
      if (!NOISY_DEV) throw new Error('Paint perspective injection is available only in dev builds.');
      if (renderer === null || state.scene === null) return { kind: 'limited', reason: 'Open a photo before drawing.' };
      if (paintWork.size > 0) return { kind: 'limited', reason: 'Finish the current stroke before moving the view.' };
      const result = renderer.renderPerspective({ geometry, eye, frame: 0, sceneGeneration: generation, viewId: ++liveViewId });
      if (result.kind !== 'limited') updatePaintView({ kind: 'perspective', frame: 0, geometry, eye: { ...result.eye }, requestEye: { ...eye } });
      return result;
    },
    authoringState: authoring.snapshot,
    capability: authoring.capability,
    setTarget: setOperationTarget,
    setTool: setAuthoringTool,
    setCompare: authoring.setCompare,
    setSampleMode: authoring.setSampleMode,
    sampleColor(at: ImagePoint): SampleColorResult {
      let result: SampleColorResult;
      try {
        result = renderer === null ? { kind: 'refused', reason: 'Open a photo before sampling a color.' }
          : renderer.sampleColor({ at, source: authoring.snapshot().sampleMode });
      } catch (error) {
        result = { kind: 'refused', reason: error instanceof Error ? error.message : String(error) };
      }
      authoring.setTool('select');
      state = { ...state, status: result.kind === 'refused' ? result.reason : 'Color sampled. Apply it to recolor the selected object.' };
      for (const listener of listeners) listener(visibleState());
      return result;
    },
    setColor: authoring.setColor,
    beginGesture(input: GestureStart) {
      remix.finishEditing();
      if (input.operation === 'motion') interruptPaint('generation-change');
      cancelExport(); cancelRefinement(); cancelSelectionWork();
      return authoring.beginGesture(input);
    },
    updateGesture: authoring.updateGesture,
    commitGesture: authoring.commitGesture,
    cancelGesture: authoring.cancelGesture,
    previewDocument: (): SceneDocument | null => state.scene === null ? null : readDocument(authoring.previewDocument(state.scene.doc)),
    // C2u consumes this grouped pointer-agnostic session API.
    beginSelection(input: SelectionGestureStart) {
      if (pendingSelection || selectionHashing !== null) return { ok: false as const, error: 'Wait for the selection to finish.' };
      enterAuthoring(); refreshAuthoringLayout(); return selection.begin(input);
    },
    extendSelection: (input: SelectionGestureUpdate): CommandResult => selection.extend(input),
    endSelection: (input: { readonly token: SelectionGestureToken; readonly pointerId: number }): Promise<CommandResult> => commitSelectionAction(() => selection.end(input), input.token),
    cancelSelection: (token?: SelectionGestureToken): CommandResult => {
      if (token !== undefined && (!pendingSelection || token !== pendingSelectionToken)) return selection.cancel(token);
      cancelSelectionWork(); return { kind: 'cancelled' };
    },
    invertSelection: (): Promise<CommandResult> => commitSelectionAction(selection.invert),
    clearSelection: (): Promise<CommandResult> => commitSelectionAction(selection.clear),
    deselect: (): Promise<CommandResult> => commitSelectionAction(selection.clear),
    featherSelection(radius: number): Promise<CommandResult> {
      if (pendingSelection || selectionHashing !== null) return Promise.resolve({ kind: 'refused', reason: 'Wait for the selection to finish.' });
      const space = activeSelection?.space;
      if (space === undefined) return Promise.resolve({ kind: 'refused', reason: 'Create a selection first.' });
      enterAuthoring();
      const began = selection.begin({ space, pointerId: -1, kind: 'feather' });
      if (!began.ok) return Promise.resolve({ kind: 'refused', reason: began.error });
      const extended = selection.extend({ token: began.value, pointerId: -1, kind: 'feather', radius });
      if (extended.kind === 'refused') { selection.cancel(began.value); return Promise.resolve(extended); }
      return commitSelectionAction(() => selection.end({ token: began.value, pointerId: -1 }));
    },
    initializeSelection(space: SelectionSpace): Promise<CommandResult> {
      if (pendingSelection || selectionHashing !== null) return Promise.resolve({ kind: 'refused', reason: 'Wait for the selection to finish.' });
      enterAuthoring();
      const doc = state.scene?.doc, object = space.kind === 'layer' ? doc?.objects.find(layer => layer.id === space.id) : undefined;
      const plane = object === undefined ? undefined : products.masks.get(object.produced.mask.asset);
      if (doc === undefined) return Promise.resolve({ kind: 'refused', reason: 'Open a photo first.' });
      return commitSelectionAction(() => selection.initialize({ space, plane: plane ?? { format: 'u8', size: doc.frame.master.size,
        data: new Uint8Array(doc.frame.master.size.width * doc.frame.master.size.height).fill(255) }, sampling: object?.produced.sampling ?? 'coverage' }));
    },
    selectionState: () => ({ selection: activeSelection, preview: selection.preview(), view: selection.navigation.snapshot(),
      neutral: authoringNeutral, pending: pendingSelection || selectionHashing !== null, target: authoring.snapshot().target, tool: authoring.snapshot().tool }),
    selectionToSource: (point: ViewPoint): SourcePoint => selection.navigation.toSource(point),
    selectionToView: (point: SourcePoint, kind: ViewPoint['kind'] = 'css'): ViewPoint => selection.navigation.toView(point, kind),
    setAuthoringLayout(layout: AuthoringLayout): void { cancelSelectionWork(); refreshAuthoringLayout(layout); },
    panAuthoring: (delta: SourcePoint): CommandResult => { cancelSelectionWork(); enterAuthoring(); return selection.navigation.pan(delta); },
    zoomAuthoring: (input: { zoom: number; anchor: ViewPoint }): CommandResult => { cancelSelectionWork(); enterAuthoring(); return selection.navigation.zoom(input); },
    pinchAuthoring: (input: { from: ViewPoint; to: ViewPoint; factor: number }): CommandResult => { cancelSelectionWork(); enterAuthoring(); return selection.navigation.pinch(input); },
    fitAuthoring: (): CommandResult => { cancelSelectionWork(); enterAuthoring(); return selection.navigation.fit(); },
    setLocalOperation(input: { readonly target: OperationTarget; readonly operation:
      { readonly kind: 'recolor'; readonly color: Oklch | null } | { readonly kind: 'fill'; readonly color: Oklch | null }
      | Extract<LocalEffect['operation'], { kind: 'clipping' }> }): CommandResult {
      if (pendingSelection || selectionHashing !== null) return { kind: 'refused', reason: 'Wait for the selection to finish.' };
      const value: Extract<GestureValue, { kind: 'color' | 'fill' | 'clipping' }> = input.operation.kind === 'recolor'
        ? { kind: 'color', color: input.operation.color } : input.operation;
      const available = authoring.capability({ target: input.target, operation: value.kind });
      if (available.kind === 'unavailable') return { kind: 'refused', reason: available.reason };
      const change = localEdit(value, input.target);
      return change === null ? { kind: 'unchanged' } : edit(change, null);
    },
    overlapPolicy: () => state.scene?.doc.compositing ?? null,
    retention: () => state.scene === null ? null : { ...assetPlan(state.scene.doc, activeSelection, history), saves: projects.retention(),
      dirtyBytes: selection.dirtyBytes() + (selectionHashing?.bytes ?? 0) },
    products, projects, gallery, saveLoop, movieFormat, exportLoopFrame,
    objectMaskCount(): number {
      const assets = new Set(state.scene?.doc.objects.map(object => object.produced.mask.asset));
      for (const entry of [...history.undo, ...history.redo]) if ('forward' in entry) for (const change of [...entry.forward, ...entry.inverse]) {
        if (change.kind === 'object.add') assets.add(change.object.produced.mask.asset);
        if (change.kind === 'object.refine') assets.add(change.produced.mask.asset);
        if (change.kind === 'layer.add') assets.add(change.layer.produced.mask.asset);
        if (change.kind === 'layer.coverage') assets.add(change.value.mask.asset);
      }
      if (refinement?.preview !== null && refinement?.preview !== undefined) assets.add(refinement.preview.mask.asset);
      return [...assets].filter(asset => products.masks.has(asset)).length;
    },
    tap, select, objectAt, beginRefinement, moveRefinement, commitRefinement, cancelRefinement,
    historyState: () => ({ canUndo: history.undo.length > 0, canRedo: history.redo.length > 0,
      undoDepth: history.undo.length, redoDepth: history.redo.length }),
    undo: (): void => stepHistory('undo'),
    redo: (): void => stepHistory('redo'),
    renameObject: (id: ObjectId, name: string): void => { edit({ kind: 'object.rename', id, name }); },
    setObjectHidden: (id: ObjectId, hidden: boolean): void => { edit({ kind: hidden ? 'object.hide' : 'object.show', id }); },
    deleteObject(id: ObjectId): void { invalidateTaps(); edit({ kind: 'object.remove', id }); },
    refinementProbe() {
      const current = refinement;
      return current === null ? null : { id: current.id, phase: current.phase, size: current.size,
        candidateAreas: current.candidates?.map(({ candidate, area }) => ({ candidate, area })) ?? [],
        originalRank: current.original.provenance.kind === 'ai' ? current.candidates?.findIndex((candidate) => candidate.candidate === (current.original.provenance.kind === 'ai' ? current.original.provenance.selection.candidate : -1)) ?? null : null,
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
      const scene = state.scene;
      if (scene === null || baseline === null || baseline.id !== scene.doc.id) return;
      const product = scene.doc.analysis.depth;
      const depth = product === null ? null : products.depths.get(product.map.asset) ?? null;
      let doc = baseline;
      if (product !== null && depth !== null) {
        products.putDepth(product.map.asset, depth);
        const result = applyProduce(doc, { kind: 'depth', depth: product }, new Date().toISOString());
        if (result.kind === 'refused') throw new Error(result.detail);
        doc = result.doc;
      }
      try { admitHistory(doc, null, EMPTY_HISTORY); }
      catch (error) { publish({ ...state, status: error instanceof Error ? error.message : String(error) }); return; }
      remix.reset(); cancelExport(); stopView(); invalidateTaps(); authoring.reset();
      activeSelection = null; selection.restore(null); authoringNeutral = false;
      history = EMPTY_HISTORY;
      setDocument(doc);
      publish({ status: 'Reset', scene: { ...(state.scene ?? scene), selected: null } });
    },
    analysis,
    snapshot: (): DemoState => visibleState(),
    projectSwitchState: (): { readonly kind: 'idle' } | { readonly kind: 'finishing'; readonly project: SceneId } =>
      finishingSwitch === null || finishingSwitch.controller.signal.aborted ? { kind: 'idle' } : { kind: 'finishing', project: finishingSwitch.project },
    cancelProjectSwitch,
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
      authoring.cancel(); cancelSelectionWork(); cancelRefinement(); cancelExport();
      importController?.abort();
      const controller = new AbortController(); importController = controller;
      const expected = generation;
      const valid = (): boolean => expected === generation && importController === controller && !controller.signal.aborted;
      let prepared: { readonly project: LoadedProject; readonly scene: DemoScene; readonly staged: Products; resetBaseline: SceneDocument } | null = null;
      try {
        while (projects.waitingForPreparation()) {
          if (!await finishCurrentProjectBeforeSwitch(controller) || !valid()) return false;
        }
        if (!valid()) return false;
        publish({ ...state, status: 'Importing…' });
        const project = await projects.load(id, controller.signal);
        if (!valid()) return false;
        const staged = createProducts();
        const scene = project.kind === 'composition' ? await preparedComposition(project, staged)
          : await hydratedLegacy(project, staged, controller.signal);
        prepared = { project, scene, staged, resetBaseline: scene.doc };
        if (!valid()) { scene.master.close(); return false; }
        prepared.resetBaseline = photoBaseline(scene);
        while (projects.waitingForPreparation()) {
          if (!await finishCurrentProjectBeforeSwitch(controller) || !valid()) { scene.master.close(); return false; }
        }
        if (!valid()) { scene.master.close(); return false; }
        admitHistory(scene.doc, null, EMPTY_HISTORY, staged);
        // Candidate validation leaves the old analysis, asset roots and save queue intact.
        validateImportedRender(scene, staged);
        const admission = projects.preflight({ document: scene.doc, assets: staged.assets,
          checkpoint: { kind: project.kind === 'composition' ? 'restored' : 'upgrade', revision: project.revision } });
        if (admission.kind === 'refused') throw new Error(admission.reason);
      } catch (error) {
        prepared?.scene.master.close();
        if (valid()) {
          publish({ ...state, status: error instanceof Error ? error.message : String(error) }); projects.openFailed();
        }
        return false;
      }
      if (prepared === null || !valid()) { prepared?.scene.master.close(); return false; }
      projects.suspend(); loop.stop(); stopView(); readyScene = null; invalidateTaps();
      const current = analysis.beginImport(); generation = current;
      installImported(prepared.scene, prepared.staged, { kind: prepared.project.kind === 'composition' ? 'restored' : 'upgrade',
        revision: prepared.project.revision }, current, false, prepared.resetBaseline);
      await analysis.sceneReady(current, prepared.scene.masterPixels, { restore: true });
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
    },
    injectMask(plane: { width: number; height: number; data: Uint8Array }): void {
      if (!NOISY_DEV) throw new Error('Mask injection is available only in dev builds.');
      const scene = state.scene;
      if (scene === null) throw new Error('Open a photo before injecting a mask.');
      const { width, height, data } = plane;
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || data.length !== width * height) throw new Error('Invalid injected mask plane.');
      const current = generation, epoch = objectEpoch;
      const mask: Plane<'u8'> = { format: 'u8', size: { width, height }, data: data.slice() };
      // The fixture uses the same encoded admission and linked-removal reducer as SAM.
      pendingMask = pendingMask.then(async () => {
        const staged = createProducts(), asset = await staged.admitPlane(mask);
        if (current !== generation || epoch !== objectEpoch || state.scene === null) return;
        const doc = state.scene.doc, lock = bundledLock();
        if (!lock.ok) throw new Error(lock.error);
        const color = doc.analysis.colors[0].lab, id = crypto.randomUUID();
        if (!isObjectId(id)) throw new Error('The object id is invalid.');
        const object = newObject({ id, existing: doc.objects, produced: {
          sampling: 'legacy-threshold', provenance: { kind: 'ai', model: lock.value.ops.decode.model,
            selection: { kind: 'taps', points: [{ at: { x: .5, y: .5 }, label: 'include' }], candidate: 0, size: .5 } },
          mask: { asset, format: 'u8', size: mask.size }, bounds: { x: 0, y: 0, ...doc.frame.master.size },
          depth: null, color: { mean: color, clusters: [{ lab: color, weight: .5 }, { lab: color, weight: .5 }] },
        } });
        const next = applyEdit(doc, { kind: 'object.add', object }, new Date().toISOString());
        if (next.kind === 'refused') throw new Error(next.detail);
        products.installEncoded(asset, staged.assets.get(asset)!); setDocument(next.doc);
      });
      // requestPlateIfNeeded awaits the original promise and reports injection failures.
      void pendingMask.catch(() => undefined);
    },
    async downloadPng(): Promise<Blob> {
      const scene = state.scene;
      if (scene === null) throw new Error('Open a photo before downloading.');
      if (renderer === null) throw new Error('The photo renderer is unavailable.');
      const activeRenderer = renderer;
      return committedRender(() => renderPng(activeRenderer));
    },
    async savePng(): Promise<void> {
      const scene = state.scene;
      if (scene === null) throw new Error('Open a photo before downloading.');
      if (renderer === null) throw new Error('The photo renderer is unavailable.');
      const activeRenderer = renderer;
      savePng(await committedRender(() => renderPng(activeRenderer)), scene.doc.title);
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
    setSymbols(patch: Partial<SceneDocument['symbols']>): void { edit({ kind: 'symbols', patch }); },
    setSurface(patch: Partial<SceneDocument['surface']>): void { edit({ kind: 'surface', patch }); },
    setFry(fry: number): void { edit({ kind: 'fry', fry }); },
    frame: (): number => viewEnabled() ? view.frame() : loop.frame(),
    renderFrameAt(frame: number): void {
      if (renderer === null) throw new Error('Open a photo before rendering.');
      renderer.renderFrame(frame);
      updatePaintMotion(frame);
    },
    renderer: (): ReturnType<typeof createRenderer> | null => renderer,
    attachCanvas(canvas: HTMLCanvasElement): () => void {
      authoring.cancel(); cancelSelectionWork();
      const cancelAuthoring = (): void => { authoring.cancel(); cancelSelectionWork(); interruptPaint('context-loss'); };
      canvas.addEventListener('webglcontextlost', cancelAuthoring);
      cancelExport();
      loop.stop(); stopView(); renderer?.dispose(); renderer = null; renderError = null; stageCanvas = canvas;
      try {
        renderer = createRenderer(canvas);
        paintMaster = null; paintDepth = null; paintAdmitted = false;
        rendererCompare = 'edited';
        if (state.scene !== null) draw(state.scene);
      } catch (error) {
        loop.stop(); stopView(); renderer?.dispose(); renderer = null; renderError = error;
        publish({ ...state, status: error instanceof Error ? error.message : String(error) });
      }
      return () => {
        canvas.removeEventListener('webglcontextlost', cancelAuthoring);
        if (stageCanvas !== canvas) return;
        authoring.cancel(); cancelSelectionWork();
        interruptPaint('context-loss');
        cancelExport();
        loop.stop(); stopView(); renderer?.dispose(); renderer = null; renderError = null; stageCanvas = null;
      };
    },
    reportError(error: unknown): void {
      publish({ status: error instanceof Error ? error.message : String(error), scene: state.scene });
    },
  };
}
