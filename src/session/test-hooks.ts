import { createRenderer } from '../render/renderer.ts';
import { encodeLoopGif } from './loop.ts';
import { movieFormat, recordMovie } from '../export/movie.ts';
import type { DemoSession } from './scene.ts';
import { resolvePaintPlanes } from './viewer.ts';
import type { AnalysisDriver, AnalysisSnapshot } from './driver.ts';
import type { SceneDocument } from '../core/types.ts';
import { plateNeeded } from '../core/derive.ts';
import type { StylePatch } from '../core/edits.ts';
import type { PerspectivePlate, RendererDebug } from '../render/types.ts';
import type { SelectionDebug } from '../render/debug.ts';
import { isObjectId, isSceneId } from '../core/ids.ts';
import type { Oklch, Plane } from '../core/raster.ts';
import type { Vec2 } from '../core/motion.ts';
import { injectScreenAngle, type Orientation } from './tilt.ts';
import { collectCompositionAssets } from '../core/asset-refs.ts';
import type { SelectionGestureStart, SelectionGestureUpdate } from './selection.ts';
import type { CommandResult } from './authoring.ts';
import { compilePhotoRack } from '../render/math-program.ts';
import { createMathPresets, replaceMathNode, createMathBlock } from '../core/math-graph.ts';
import { createMathLibrary } from '../core/math-definition.ts';
import { currentDocumentSchema } from '../core/schema.ts';

// MRX3m's explicit proof lease: real isolated renderers, with no session state writes.
const mathGrain = { createRenderer, compilePhotoRack, createMathPresets, replaceMathNode, createMathBlock,
  createMathLibrary, parseScene: (input: unknown) => currentDocumentSchema.parse(input) };

export type PaintProofTools = { readonly createRenderer: typeof createRenderer; readonly encodeLoopGif: typeof encodeLoopGif;
  readonly movieFormat: typeof movieFormat; readonly recordMovie: typeof recordMovie };
export type DemoTestSurface = {
  readonly remix: DemoSession['remix'];
  readonly paint: {
    planes(): readonly import('../render/types.ts').PaintPlane[];
    renderPerspective: DemoSession['renderPaintPerspective'];
    setBrush: DemoSession['setBrush']; attachBrushPreview: DemoSession['attachBrushPreview'];
    replayBrushPreview: DemoSession['replayBrushPreview']; resetBrushPreview: DemoSession['resetBrushPreview'];
    drawingAvailability: DemoSession['drawingAvailability']; setFingerDraw: DemoSession['setFingerDraw'];
    interrupt: DemoSession['interrupt']; selectPaintLayer(id: string | null): CommandResult;
    beginStroke(input: Parameters<DemoSession['beginStroke']>[0]): { readonly kind: 'began'; readonly token: string } | { readonly kind: 'refused'; readonly reason: string };
    extendStroke(token: string, samples: Parameters<DemoSession['extendStroke']>[1]): CommandResult;
    endStroke(token: string): Promise<CommandResult>; cancelStroke(token: string): void;
    state(): Pick<ReturnType<DemoSession['snapshot']>, 'brush' | 'fingerDraw'> & { readonly tool: ReturnType<DemoSession['authoringState']>['tool']; readonly activeLayer: string | null };
    flush(): ReturnType<DemoSession['projects']['flushCurrent']>;
  };
  readonly mathGrain: typeof mathGrain;
  /** Dev-only real renderer/encoder entry points, with no second rendering implementation. */
  readonly paintProof: PaintProofTools;
  // C2 hook block, kept separate from the concurrently landing C1 surface.
  beginSelection(input: SelectionGestureStart): { readonly kind: 'began'; readonly token: string } | { readonly kind: 'refused'; readonly reason: string };
  extendSelection(input: (Omit<Extract<SelectionGestureUpdate, { kind: 'shape' }>, 'token'> | Omit<Extract<SelectionGestureUpdate, { kind: 'feather' }>, 'token'>) & { readonly token: string }): CommandResult;
  endSelection(input: { readonly token: string; readonly pointerId: number }): Promise<CommandResult>;
  cancelSelection(token?: string): CommandResult;
  invertSelection(): Promise<CommandResult>;
  featherSelection(radius: number): Promise<CommandResult>;
  clearSelection(): Promise<CommandResult>;
  deselect(): Promise<CommandResult>;
  initializeSelection: DemoSession['initializeSelection'];
  selectionState(): Omit<ReturnType<DemoSession['selectionState']>, 'preview'> & { readonly preview: { readonly space: import('../core/types.ts').SelectionSpace; readonly size: import('../core/raster.ts').Size; readonly bytes: readonly number[] } | null };
  setOperationTarget: DemoSession['setTarget'];
  setSelectionTool: DemoSession['setTool'];
  localOperation: DemoSession['setLocalOperation'];
  c2SetSurface: DemoSession['setSurface'];
  c2SetParallax: DemoSession['setParallax'];
  overlapPolicy: DemoSession['overlapPolicy'];
  projectSwitchState: DemoSession['projectSwitchState'];
  cancelProjectSwitch: DemoSession['cancelProjectSwitch'];
  panAuthoring: DemoSession['panAuthoring'];
  zoomAuthoring: DemoSession['zoomAuthoring'];
  pinchAuthoring: DemoSession['pinchAuthoring'];
  fitAuthoring: DemoSession['fitAuthoring'];
  setAuthoringLayout: DemoSession['setAuthoringLayout'];
  selectionToSource: DemoSession['selectionToSource'];
  selectionToView: DemoSession['selectionToView'];
  c2Undo(): void;
  c2Redo(): void;
  c2DeleteObject(id: string): void;
  assetRetention(): { readonly activeBytes: number; readonly historyBytes: number; readonly assets: number; readonly dirtyBytes: number; readonly saves: ReturnType<DemoSession['projects']['retention']> } | null;
  projectAssets(): readonly { readonly asset: string; readonly bytes: readonly number[]; readonly path: string; readonly mediaType: string; readonly original: boolean }[];
  authoringState: DemoSession['authoringState'];
  historyState: DemoSession['historyState'];
  previewDocument: DemoSession['previewDocument'];
  setColor: DemoSession['setColor'];
  setTarget: DemoSession['setTarget'];
  setTool: DemoSession['setTool'];
  beginGesture: DemoSession['beginGesture'];
  updateGesture: DemoSession['updateGesture'];
  commitGesture: DemoSession['commitGesture'];
  cancelGesture: DemoSession['cancelGesture'];
  setCompare: DemoSession['setCompare'];
  setSampleMode: DemoSession['setSampleMode'];
  sampleColor: DemoSession['sampleColor'];
  setSurface: DemoSession['setSurface'];
  readonly gallery: DemoSession['gallery'] & Pick<DemoSession, 'beginGesture' | 'updateGesture' | 'cancelGesture'>;
  importFile(file: File): Promise<void>;
  scene(): { status: string; master: { width: number; height: number } | null; clusters: number; path: 'resize' | 'fallback' | null };
  downloadPng(): Promise<Blob>;
  /** The stereo pair as the two 3DS downloads, through the session; the page has no button for it. */
  saveStereo(): Promise<void>;
  tap(x: number, y: number): Promise<void>;
  select(id: string | null): void;
  setRecolor(color: Oklch | null): void;
  reset(): void;
  objects(): readonly { readonly id: string; readonly name: string; readonly hidden: boolean; readonly subject: boolean; readonly recolor: SceneDocument['objects'][number]['recolor']; readonly bounds: SceneDocument['objects'][number]['produced']['bounds']; readonly depth: SceneDocument['objects'][number]['produced']['depth']; readonly selected: boolean }[];
  analysis(): AnalysisSnapshot;
  analysisDiagnostics(): ReturnType<AnalysisDriver['diagnostics']>;
  requestPlate(): Promise<void>;
  injectMask(plane: { width: number; height: number; data: Uint8Array }): void;
  platePixel(x: number, y: number): readonly number[];
  frame(): number;
  renderFrameAt(frame: number): Promise<void>;
  exportFrame(frame: number): Promise<Blob>;
  exportLoopFrame(frame: number, edge?: number): ImageData;
  saveLoop(kind: 'gif' | 'movie'): Promise<void>;
  exportProgress(): string | null;
  setMotion(patch: Partial<SceneDocument['motion']>): void;
  document(): SceneDocument | null;
  refinement(): ReturnType<DemoSession['refinementProbe']>;
  refinementMask(): { readonly width: number; readonly height: number; readonly bytes: readonly number[] } | null;
  projectMasks(): readonly { readonly asset: string; readonly width: number; readonly height: number; readonly bytes: readonly number[] }[];
  projects(): ReturnType<DemoSession['projects']['snapshot']> & ReturnType<DemoSession['projects']['diagnostics']>;
  openProject(id: string): Promise<boolean>;
  deleteProject(id: string): Promise<boolean>;
  products(): { generation: number; depth: number; masks: number; plates: number; plateSize: { width: number; height: number } | null; guideSize: { width: number; height: number } | null; plateNeeded: boolean };
  setStyle(patch: StylePatch): void;
  setSymbols(patch: Partial<SceneDocument['symbols']>): void;
  setFry(f: number): void;
  injectDepth(plane: Plane<'f32'> | null): void;
  injectFace(center: Vec2 | null): void;
  injectCameraFrame(frame: ImageData, face: Parameters<DemoSession['injectCameraFrame']>[1]): void;
  parallaxDebug(): ReturnType<DemoSession['parallaxDebug']>;
  recenterParallax(): void;
  setParallaxSource: DemoSession['setParallaxSource'];
  parallaxTrace: DemoSession['parallaxTrace'];
  injectOrientation(orientation: Orientation): void;
  injectScreenAngle(angle: number | null): void;
  windowReady(): boolean;
  windowFrames(): number;
  windowTracks(): readonly MediaStreamTrack[];
  readonly render: (RendererDebug & Partial<SelectionDebug>) | null;
};

export function demoTestHooks(session: DemoSession): DemoTestSurface {
  const selectionTokens = new Map<string, symbol>();
  const endingSelections = new Map<string, Promise<CommandResult>>();
  let selectionSerial = 0;
  let injectedRenderer: ReturnType<DemoSession['renderer']> = null;
  let injectedDepth: Plane<'f32'> | null = null;
  let injectedPlates = new WeakMap<PerspectivePlate, PerspectivePlate>();
  const strokeTokens = new Map<string, import('./paint.ts').StrokeToken>();
  let strokeSerial = 0;
  return {
    remix: session.remix,
    paint: {
      planes: () => { const doc = session.snapshot().scene?.doc; return doc === undefined ? [] : resolvePaintPlanes(doc, session.products.assets); },
      renderPerspective: session.renderPaintPerspective,
      setBrush: session.setBrush, attachBrushPreview: session.attachBrushPreview,
      replayBrushPreview: session.replayBrushPreview, resetBrushPreview: session.resetBrushPreview,
      drawingAvailability: session.drawingAvailability, setFingerDraw: session.setFingerDraw, interrupt: session.interrupt,
      selectPaintLayer(id) {
        if (id !== null && !isObjectId(id)) return { kind: 'refused', reason: 'The paint layer id is invalid.' };
        return session.selectPaintLayer(id);
      },
      beginStroke(input) {
        const result = session.beginStroke(input);
        if (!result.ok) return { kind: 'refused', reason: result.error };
        const token = `paint-${++strokeSerial}`; strokeTokens.set(token, result.value); return { kind: 'began', token };
      },
      extendStroke(handle, samples) {
        const token = strokeTokens.get(handle); return token === undefined ? { kind: 'cancelled' } : session.extendStroke(token, samples);
      },
      async endStroke(handle) {
        const token = strokeTokens.get(handle);
        if (token === undefined) return { kind: 'cancelled' };
        try { return await session.endStroke(token); } finally { strokeTokens.delete(handle); }
      },
      cancelStroke(handle) { const token = strokeTokens.get(handle); if (token !== undefined) session.cancelStroke(token); strokeTokens.delete(handle); },
      state: () => ({ brush: session.snapshot().brush, fingerDraw: session.snapshot().fingerDraw,
        tool: session.authoringState().tool, activeLayer: session.activePaintLayer() }),
      flush: session.projects.flushCurrent,
    },
    mathGrain,
    paintProof: { createRenderer, encodeLoopGif, movieFormat, recordMovie },
    // C2 hook entries use opaque string handles, never serialized Symbols.
    beginSelection(input) {
      const result = session.beginSelection(input);
      if (!result.ok) return { kind: 'refused', reason: result.error };
      selectionTokens.clear();
      const token = `selection-${++selectionSerial}`;
      selectionTokens.set(token, result.value); return { kind: 'began', token };
    },
    extendSelection(input) {
      const token = selectionTokens.get(input.token);
      return token === undefined ? { kind: 'cancelled' } : session.extendSelection({ ...input, token } as SelectionGestureUpdate);
    },
    endSelection(input) {
      const pending = endingSelections.get(input.token);
      if (pending !== undefined) return pending;
      const token = selectionTokens.get(input.token);
      if (token === undefined) return Promise.resolve({ kind: 'cancelled' });
      const completion = session.endSelection({ ...input, token }).finally(() => {
        if (endingSelections.get(input.token) === completion) endingSelections.delete(input.token);
        if (selectionTokens.get(input.token) === token) selectionTokens.delete(input.token);
      });
      endingSelections.set(input.token, completion); return completion;
    },
    cancelSelection(handle) {
      if (handle === undefined) { selectionTokens.clear(); return session.cancelSelection(); }
      const token = selectionTokens.get(handle); selectionTokens.delete(handle);
      return token === undefined ? { kind: 'cancelled' } : session.cancelSelection(token);
    },
    invertSelection: session.invertSelection, featherSelection: session.featherSelection, clearSelection: session.clearSelection,
    deselect: session.deselect, initializeSelection: session.initializeSelection,
    selectionState() {
      const value = session.selectionState(), preview = value.preview;
      return { ...value, preview: preview === null ? null : { space: preview.space, size: preview.plane.size, bytes: Array.from(preview.plane.data) } };
    },
    setOperationTarget: session.setTarget, setSelectionTool: session.setTool, localOperation: session.setLocalOperation, c2SetSurface: session.setSurface,
    c2SetParallax: session.setParallax,
    overlapPolicy: session.overlapPolicy, projectSwitchState: session.projectSwitchState, cancelProjectSwitch: session.cancelProjectSwitch,
    panAuthoring: session.panAuthoring, zoomAuthoring: session.zoomAuthoring,
    pinchAuthoring: session.pinchAuthoring, fitAuthoring: session.fitAuthoring, setAuthoringLayout: session.setAuthoringLayout,
    selectionToSource: session.selectionToSource, selectionToView: session.selectionToView,
    c2Undo: session.undo, c2Redo: session.redo,
    c2DeleteObject(id) { if (!isObjectId(id)) throw new Error('Invalid object id.'); session.deleteObject(id); },
    assetRetention() {
      const value = session.retention();
      return value === null ? null : { activeBytes: value.activeBytes, historyBytes: value.historyBytes,
        assets: value.retained.size, dirtyBytes: value.dirtyBytes, saves: value.saves };
    },
    projectAssets() {
      const document = session.snapshot().scene?.doc;
      if (document === undefined) return [];
      const inventory = collectCompositionAssets([{ kind: 'document', document }]);
      if (!inventory.ok) throw new Error(inventory.error.detail);
      return [...inventory.value].map(([asset, refs]) => {
        const bytes = session.products.assets.get(asset);
        if (bytes === undefined) throw new Error('The project asset is missing.');
        const original = refs.find(ref => ref.kind === 'original');
        return { asset, bytes: Array.from(bytes), path: `assets/${asset}`, original: original !== undefined,
          mediaType: original?.mediaType ?? 'application/octet-stream' };
      });
    },
    authoringState: session.authoringState,
    historyState: session.historyState,
    previewDocument: session.previewDocument,
    setColor: session.setColor,
    setTarget: session.setTarget,
    setTool: session.setTool,
    beginGesture: session.beginGesture,
    updateGesture: session.updateGesture,
    commitGesture: session.commitGesture,
    cancelGesture: session.cancelGesture,
    setCompare: session.setCompare,
    setSampleMode: session.setSampleMode,
    sampleColor: session.sampleColor,
    setSurface: session.setSurface,
    gallery: { ...session.gallery, beginGesture: session.beginGesture, updateGesture: session.updateGesture, cancelGesture: session.cancelGesture },
    importFile: (file) => session.importFile(file),
    scene() {
      const { status, scene } = session.snapshot();
      return {
        status, master: scene === null ? null : { width: scene.master.width, height: scene.master.height },
        clusters: scene?.doc.analysis.colors.length ?? 0, path: scene?.path ?? null,
      };
    },
    downloadPng: () => session.downloadPng(),
    saveStereo: () => session.saveStereo(),
    tap: (x, y) => session.tap({ x, y }),
    select(id) {
      if (id !== null && !isObjectId(id)) throw new Error('Invalid object id.');
      session.select(id);
    },
    setRecolor: (color) => session.setRecolor(color),
    reset: () => session.reset(),
    objects() {
      const scene = session.snapshot().scene;
      return scene?.doc.objects.map((object) => ({ id: object.id, name: object.name, hidden: object.hidden, subject: object.subject, recolor: object.recolor,
        bounds: object.produced.bounds, depth: object.produced.depth, selected: scene.selected === object.id })) ?? [];
    },
    analysis: () => session.analysis.snapshot(),
    analysisDiagnostics: () => session.analysis.diagnostics(),
    requestPlate: () => session.requestPlateIfNeeded(),
    injectMask: (plane) => session.injectMask(plane),
    platePixel(x, y) {
      const plate = session.snapshot().scene?.plate;
      if (plate === null || plate === undefined || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= plate.size.width || y >= plate.size.height) {
        throw new Error('The plate pixel is unavailable.');
      }
      const i = (y * plate.size.width + x) * 3;
      return Array.from(plate.data.subarray(i, i + 3));
    },
    frame: () => session.frame(),
    exportLoopFrame: (frame, edge) => session.exportLoopFrame(frame, edge),
    saveLoop: (kind) => session.saveLoop(kind),
    exportProgress: () => session.snapshot().exportProgress,
    async renderFrameAt(frame) { await session.requestPlateIfNeeded(); session.renderFrameAt(frame); },
    async exportFrame(frame) {
      const debug = session.renderer()?.debug;
      if (debug === null || debug === undefined || !('exportFrame' in debug) || typeof debug.exportFrame !== 'function') {
        throw new Error('Loop export requires the dev render probe.');
      }
      const blob: unknown = await debug.exportFrame(frame);
      if (!(blob instanceof Blob)) throw new Error('The loop export did not return a PNG.');
      return blob;
    },
    setMotion: (patch) => session.setMotion(patch),
    document: () => session.snapshot().scene?.doc ?? null,
    refinement: () => session.refinementProbe(),
    refinementMask() {
      const asset = session.refinementProbe()?.previewAsset;
      const mask = [...session.products.masks].find(([id]) => id === asset)?.[1];
      return mask === undefined ? null : { ...mask.size, bytes: Array.from(mask.data) };
    },
    projectMasks() {
      const assets = new Set(session.snapshot().scene?.doc.objects.map((object) => object.produced.mask.asset));
      return [...session.products.masks].filter(([asset]) => assets.has(asset)).map(([asset, mask]) => ({ asset, ...mask.size, bytes: Array.from(mask.data) }));
    },
    projects: () => ({ ...session.projects.snapshot(), ...session.projects.diagnostics() }),
    openProject(id) {
      if (!isSceneId(id)) throw new Error('Invalid project id.');
      return session.openProject(id);
    },
    deleteProject(id) {
      if (!isSceneId(id)) throw new Error('Invalid project id.');
      return session.projects.remove(id);
    },
    products() {
      const scene = session.snapshot().scene;
      const state = session.snapshot();
      return { generation: session.analysis.generation(), depth: scene?.depth == null ? 0 : 1, masks: session.objectMaskCount(), plates: scene?.plate == null ? 0 : 1, plateSize: scene?.plate?.size ?? null, guideSize: session.analysis.guide()?.size ?? null, plateNeeded: scene !== null && (state.parallaxEnabled ? session.analysis.livePlate().kind === 'preparing' : plateNeeded(scene.doc)) };
    },
    setStyle: (patch) => session.setStyle(patch),
    setSymbols: (patch) => { session.setSymbols(patch); },
    setFry: (f) => session.setFry(f),
    injectFace: (center) => session.injectFace(center),
    injectCameraFrame: (frame, face) => session.injectCameraFrame(frame, face),
    parallaxDebug: () => session.parallaxDebug(),
    recenterParallax: () => session.recenterParallax(),
    setParallaxSource: session.setParallaxSource,
    parallaxTrace: session.parallaxTrace,
    injectOrientation: (orientation) => session.injectOrientation(orientation),
    injectScreenAngle,
    windowReady: () => session.windowReady(),
    windowFrames: () => session.windowFrames(),
    windowTracks: () => session.windowTracks(),
    injectDepth(plane) {
      const renderer = session.renderer();
      if (renderer === null) throw new Error('Open a photo before injecting depth.');
      // Install only on explicit injection. The driver still owns real scene
      // construction; this dev-only override follows its subsequent edits.
      if (injectedDepth !== plane) injectedPlates = new WeakMap();
      injectedDepth = plane;
      if (injectedRenderer !== renderer) {
        const setScene = renderer.setScene.bind(renderer);
        renderer.setScene = (scene) => {
          const original = scene.livePlate;
          let livePlate: PerspectivePlate | null = null;
          if (original != null && injectedDepth !== null) {
            livePlate = injectedPlates.get(original) ?? null;
            if (livePlate === null) {
              livePlate = { ...original, depth: injectedDepth };
              injectedPlates.set(original, livePlate);
            }
          }
          // Preserve the production cache identity across unchanged scene updates.
          // Replacing either the prepared product or injected depth invalidates it.
          setScene({ ...scene, depth: injectedDepth, livePlate });
        };
        injectedRenderer = renderer;
      }
      session.setStyle({});
    },
    get render() { return session.renderer()?.debug ?? null; },
  };
}
