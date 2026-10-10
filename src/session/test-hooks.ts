import type { DemoSession } from './scene.ts';
import type { AnalysisDriver, AnalysisSnapshot } from './driver.ts';
import type { SceneDocument } from '../core/types.ts';
import { plateNeeded } from '../core/derive.ts';
import type { StylePatch } from '../core/edits.ts';
import type { RendererDebug } from '../render/types.ts';
import type { SelectionDebug } from '../render/debug.ts';
import { isObjectId, isSceneId } from '../core/ids.ts';
import type { Oklch, Plane } from '../core/raster.ts';
import { applyEdit } from '../core/reduce.ts';
import type { Vec2 } from '../core/motion.ts';
import { windowPlateNeeded } from './window.ts';
import { injectScreenAngle, type Orientation } from './tilt.ts';

export type DemoTestSurface = {
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
  injectOrientation(orientation: Orientation): void;
  injectScreenAngle(angle: number | null): void;
  windowReady(): boolean;
  windowFrames(): number;
  windowTracks(): readonly MediaStreamTrack[];
  readonly render: (RendererDebug & Partial<SelectionDebug>) | null;
};

export function demoTestHooks(session: DemoSession): DemoTestSurface {
  let injectedRenderer: ReturnType<DemoSession['renderer']> = null;
  let injectedDepth: Plane<'f32'> | null = null;
  return {
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
    async renderFrameAt(frame) { session.renderFrameAt(frame); },
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
      return { generation: session.analysis.generation(), depth: session.products.depths.size, masks: session.products.masks.size, plates: session.products.plates.size, plateSize: scene?.plate?.size ?? null, guideSize: session.analysis.guide()?.size ?? null, plateNeeded: scene !== null && (state.parallaxEnabled ? windowPlateNeeded(scene.doc) : plateNeeded(scene.doc)) };
    },
    setStyle: (patch) => session.setStyle(patch),
    setSymbols: (patch) => {
      const scene = session.snapshot().scene;
      if (scene === null) return;
      const result = applyEdit(scene.doc, { kind: 'symbols', patch }, new Date().toISOString());
      if (result.kind === 'applied') session.setDocument(result.doc);
    },
    setFry: (f) => session.setFry(f),
    injectFace: (center) => session.injectFace(center),
    injectCameraFrame: (frame, face) => session.injectCameraFrame(frame, face),
    parallaxDebug: () => session.parallaxDebug(),
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
      injectedDepth = plane;
      if (injectedRenderer !== renderer) {
        const setScene = renderer.setScene.bind(renderer);
        renderer.setScene = (scene) => setScene({ ...scene, depth: injectedDepth });
        injectedRenderer = renderer;
      }
      session.setStyle({});
    },
    get render() { return session.renderer()?.debug ?? null; },
  };
}
