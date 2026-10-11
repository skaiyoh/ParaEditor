// What scenario code running inside a page may read from the page's globals.
// The dev test surface is declared here with the members the driver and the
// scenarios call, typed from src/app/events.ts; the test project cannot import
// src/app/test-surface.ts itself, because the module behind its Root type
// reads a constant only a build defines. A production build has no surface.
// The memory harness page's own surface is declared beside it.

import type { DiagnosticEvent, EnvironmentSnapshot } from '../../src/app/events.ts';
import type { SceneDocument } from '../../src/core/types.ts';
import type { StylePatch } from '../../src/core/edits.ts';
import type { Renderer, RendererDebug, CompareMode, SampleColorResult } from '../../src/render/types.ts';
import type { Oklch, Plane } from '../../src/core/raster.ts';
import type { SymbolsDebug, LoopDebug, SelectionDebug } from '../../src/render/debug.ts';
import type { FaceDetection } from '../../src/analysis/protocol.ts';
import type { Vec2 } from '../../src/core/motion.ts';
import type { AnalysisDriver } from '../../src/session/driver.ts';
import type { createViewDriver, SourceMode } from '../../src/session/view-driver.ts';
import type { createTiltSource } from '../../src/session/tilt.ts';
import type { createWindowSource } from '../../src/session/window.ts';
import type { PerspectiveRenderResult } from '../../src/render/types.ts';
import type { AuthoringState, SampleMode, OperationTarget, Tool, CommandResult, GestureStart, GestureToken, GestureUpdate } from '../../src/session/authoring.ts';
type ViewDriver = ReturnType<typeof createViewDriver>;
type LiveDebug = ReturnType<ReturnType<typeof createTiltSource>['readings']>
  & ReturnType<ReturnType<typeof createWindowSource>['preview']>
  & ReturnType<ViewDriver['targets']> & ReturnType<ViewDriver['diagnostics']>
  & { coverage: PerspectiveRenderResult; preparation: ReturnType<AnalysisDriver['livePlate']>['kind']; viewId: number;
      offset: Vec2; cameraRunning: boolean; tiltRunning: boolean };


declare global {
  const NOISY_MODEL_LOCK: string;
  const NOISY_ORT_DIR: string;
  const NOISY_WORKER_URLS: { readonly sequence: string; readonly decode: string; readonly face: string };
  interface Window {
    ImageDecoder?: new (input: { data: Uint8Array; type: string }) => {
      tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } | null };
      decode(input: { frameIndex: number }): Promise<{ image: VideoFrame }>;
      close(): void;
    };
    __paintProof?: import('./scenarios/math-remix-proof.scenario.ts').PaintProofHarness;
    readonly __noisyTest?: {
      readonly session?: { renderer(): (Renderer & { exportStill(capture: { frame: number; canvas: HTMLCanvasElement }): void }) | null };
      readonly demo: {
        readonly remix: import('../../src/session/math-remix.ts').MathRemixSession;
        readonly paint: {
          planes(): readonly import('../../src/render/types.ts').PaintPlane[];
          renderPerspective(geometry: import('../../src/core/perspective.ts').PerspectiveGeometry, eye: import('../../src/core/perspective.ts').PerspectiveEye): PerspectiveRenderResult;
          setBrush(brush: import('../../src/core/paint.ts').PaintBrush): Promise<CommandResult>;
          attachBrushPreview(canvas: HTMLCanvasElement | null): void;
          replayBrushPreview(): Promise<CommandResult>; resetBrushPreview(): void;
          drawingAvailability(input?: import('../../src/session/paint.ts').StrokeStart): import('../../src/session/paint.ts').DrawingAvailability;
          setFingerDraw(on: boolean): void; interrupt(reason: import('../../src/session/paint.ts').PaintInterruption): void;
          selectPaintLayer(id: string | null): CommandResult;
          beginStroke(input: import('../../src/session/paint.ts').StrokeStart): { kind: 'began'; token: string } | { kind: 'refused'; reason: string };
          extendStroke(token: string, samples: readonly import('../../src/session/paint.ts').PointerSample[]): CommandResult;
          endStroke(token: string): Promise<CommandResult>; cancelStroke(token: string): void;
          state(): { brush: import('../../src/core/paint.ts').PaintBrush; fingerDraw: boolean; tool: Tool; activeLayer: string | null };
          flush(): Promise<{ kind: 'saved' | 'preparing' }>;
        };
        readonly mathGrain: {
          createRenderer(canvas: HTMLCanvasElement): Renderer;
          compilePhotoRack: typeof import('../../src/render/math-program.ts').compilePhotoRack;
          createMathPresets: typeof import('../../src/core/math-graph.ts').createMathPresets;
          replaceMathNode: typeof import('../../src/core/math-graph.ts').replaceMathNode;
          createMathBlock: typeof import('../../src/core/math-graph.ts').createMathBlock;
          createMathLibrary: typeof import('../../src/core/math-definition.ts').createMathLibrary;
          parseScene(input: unknown): SceneDocument;
        };
        readonly paintProof: import('./scenarios/math-remix-proof.scenario.ts').PaintProofTools;
        // C2 manual-region surface, additive beside C1's authoring hooks.
        beginSelection(input: import('../../src/session/selection.ts').SelectionGestureStart): { kind: 'began'; token: string } | { kind: 'refused'; reason: string };
        extendSelection(input: ({kind:'shape';at:{x:number;y:number}}|{kind:'feather';radius:number}) & { token:string;pointerId:number }): import('../../src/session/authoring.ts').CommandResult;
        endSelection(input: {token:string;pointerId:number}): Promise<import('../../src/session/authoring.ts').CommandResult>;
        cancelSelection(token?:string): import('../../src/session/authoring.ts').CommandResult;
        invertSelection(): Promise<import('../../src/session/authoring.ts').CommandResult>;
        featherSelection(radius:number): Promise<import('../../src/session/authoring.ts').CommandResult>;
        clearSelection(): Promise<import('../../src/session/authoring.ts').CommandResult>;
        deselect(): Promise<import('../../src/session/authoring.ts').CommandResult>;
        initializeSelection(space: import('../../src/core/types.ts').SelectionSpace): Promise<import('../../src/session/authoring.ts').CommandResult>;
        selectionState(): { selection: import('../../src/core/types.ts').ActiveSelection; preview: {space:import('../../src/core/types.ts').SelectionSpace;size:{width:number;height:number};bytes:readonly number[]}|null;
          view:import('../../src/core/authoring-view.ts').AuthoringView;neutral:boolean;pending:boolean;target:import('../../src/core/types.ts').OperationTarget;tool:import('../../src/session/authoring.ts').Tool };
        setOperationTarget(target:import('../../src/core/types.ts').OperationTarget): import('../../src/session/authoring.ts').CommandResult;
        setSelectionTool(tool:import('../../src/session/authoring.ts').Tool): import('../../src/session/authoring.ts').CommandResult;
        localOperation(input:{target:OperationTarget;operation:{kind:'recolor'|'fill';color:Oklch|null}|{kind:'clipping';amount:number}}):CommandResult;
        c2SetSurface(patch:Partial<SceneDocument['surface']>):void;
        c2SetParallax(enabled:boolean):Promise<void>;
        overlapPolicy(): import('../../src/core/types.ts').CompositingPolicy|null;
        projectSwitchState(): {readonly kind:'idle'}|{readonly kind:'finishing';readonly project:import('../../src/core/ids.ts').SceneId};
        cancelProjectSwitch(): boolean;
        panAuthoring(delta:{x:number;y:number}):import('../../src/session/authoring.ts').CommandResult;
        zoomAuthoring(input:{zoom:number;anchor:import('../../src/core/authoring-view.ts').ViewPoint}):import('../../src/session/authoring.ts').CommandResult;
        pinchAuthoring(input:{from:import('../../src/core/authoring-view.ts').ViewPoint;to:import('../../src/core/authoring-view.ts').ViewPoint;factor:number}):import('../../src/session/authoring.ts').CommandResult;
        fitAuthoring():import('../../src/session/authoring.ts').CommandResult;
        setAuthoringLayout(layout:import('../../src/core/authoring-view.ts').AuthoringLayout):void;
        selectionToSource(point:import('../../src/core/authoring-view.ts').ViewPoint):{x:number;y:number};
        selectionToView(point:{x:number;y:number},kind?:'css'|'device'):import('../../src/core/authoring-view.ts').ViewPoint;
        c2Undo():void;
        c2Redo():void;
        c2DeleteObject(id:string):void;
        assetRetention():{activeBytes:number;historyBytes:number;assets:number;dirtyBytes:number;saves:readonly {id:string;revision:number;kind:'active'|'pending';assets:readonly string[];bytes:number;complete:boolean}[]}|null;
        projectAssets():readonly {asset:string;bytes:readonly number[];path:string;mediaType:string;original:boolean}[];
        authoringState(): AuthoringState;
        historyState(): { canUndo: boolean; canRedo: boolean; undoDepth: number; redoDepth: number };
        previewDocument(): SceneDocument | null;
        setColor(input: { target: OperationTarget; color: Oklch | null }): CommandResult;
        setTarget(target: OperationTarget): CommandResult;
        setTool(tool: Tool): CommandResult;
        beginGesture(start: GestureStart): GestureToken | null;
        updateGesture(update: GestureUpdate): CommandResult;
        commitGesture(token: GestureToken): CommandResult;
        cancelGesture(token: GestureToken): void;
        setCompare(mode: CompareMode): void;
        setSampleMode(mode: SampleMode): void;
        sampleColor(at: { x: number; y: number }): SampleColorResult;
        setSurface(patch: Partial<SceneDocument['surface']>): void;
        readonly gallery: ReturnType<typeof import('../../src/session/publish.ts').createPublishSession>
          & Pick<ReturnType<typeof import('../../src/session/authoring.ts').createAuthoring>, 'beginGesture' | 'updateGesture' | 'cancelGesture'>;
        importFile(file: File): Promise<void>;
        scene(): { status: string; master: { width: number; height: number } | null; clusters: number; path: 'resize' | 'fallback' | null };
        downloadPng(): Promise<Blob>;
        saveStereo(): Promise<void>;
        tap(x: number, y: number): Promise<void>;
        select(id: string | null): void;
        setRecolor(color: Oklch | null): void;
        reset(): void;
        objects(): readonly { readonly id: string; readonly name: string; readonly hidden: boolean; readonly subject: boolean; readonly recolor: SceneDocument['objects'][number]['recolor']; readonly bounds: SceneDocument['objects'][number]['produced']['bounds']; readonly depth: SceneDocument['objects'][number]['produced']['depth']; readonly selected: boolean }[];
        analysis(): { backend: { kind: 'device' } | { kind: 'gpu'; name: string }; status: string; modelsReady: boolean; depth: boolean; embeddings: boolean; decoderReady: boolean; plate: boolean; alive: { heavy: boolean; decoder: boolean }; timings: Record<string, number> };
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
        refinement(): {
          readonly id: string; readonly phase: 'decoding' | 'dragging' | 'committing'; readonly size: number;
          readonly candidateAreas: readonly { readonly candidate: number; readonly area: number }[];
          readonly originalRank: number | null; readonly previewAsset: string | null; readonly previewArea: number | null;
        } | null;
        refinementMask(): { readonly width: number; readonly height: number; readonly bytes: readonly number[] } | null;
        projectMasks(): readonly { readonly asset: string; readonly width: number; readonly height: number; readonly bytes: readonly number[] }[];
        projects(): { readonly current: string | null; readonly state: 'saving' | 'saved' | 'failed' | 'absent'; readonly states: ReadonlyMap<string, 'saving' | 'saved' | 'failed'>; readonly retainedJobs: number; readonly pendingSaves: number };
        openProject(id: string): Promise<boolean>;
        deleteProject(id: string): Promise<boolean>;
        products(): { generation: number; depth: number; masks: number; plates: number; plateSize: { width: number; height: number } | null; guideSize: { width: number; height: number } | null; plateNeeded: boolean };
        setStyle(patch: StylePatch): void;
        setSymbols(patch: Partial<SceneDocument['symbols']>): void;
        setFry(f: number): void;
        injectDepth(plane: Plane<'f32'> | null): void;
        injectFace(center: Vec2 | null): void;
        injectCameraFrame(frame: ImageData, face: FaceDetection | null): void;
        parallaxDebug(): LiveDebug;
        recenterParallax(): void;
        setParallaxSource(mode: SourceMode): void;
        parallaxTrace(): ReturnType<ViewDriver['trace']> & { stage: { x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number; dpr: number } | null };
        injectOrientation(orientation: import('../../src/session/tilt.ts').Orientation): void;
        injectScreenAngle(angle: number | null): void;
        windowReady(): boolean;
        windowFrames(): number;
        windowTracks(): readonly MediaStreamTrack[];
        readonly render: (RendererDebug & SymbolsDebug & LoopDebug & SelectionDebug & { profileCamera(): Readonly<Record<string, number>>; hashCells(): readonly number[]; motionCamera(): Vec2; setMotionFeather(enabled: boolean): void }) | null;
      };
      diagnostics(): readonly DiagnosticEvent[];
      environment(): Promise<EnvironmentSnapshot>;
    };
    /** Recipes installed by render scenarios, never part of the app bundle. */
    __renderFixtures?: {
      gradientFile(different: boolean): Promise<File>;
      flatFile(bytes: readonly number[]): Promise<File>;
      splitFile(left: readonly number[], right: readonly number[]): Promise<File>;
      readPng(blob: Blob): Promise<Uint8ClampedArray>;
    };
    /** Temporary download capture installed and restored by export.stereo. */
    __stereoDownloads?: {
      readonly entries: { readonly name: string; readonly blob: Blob }[];
      restore(): void;
    };
    __loopExport?: {
      readonly entries: { name: string; blob: Blob }[];
      readonly progress: string[];
      decode(bytes: Uint8Array): { signature: string; width: number; height: number; loop: number | null; frames: { width: number; height: number; delay: number; rgba: Uint8ClampedArray }[] };
      restore(): void;
    };
    /** The memory harness page's surface (src/dev/harness/memory.ts). */
    readonly __noisyHarness?: {
      holeDigest(shape: string, width: number, height: number): Promise<string>;
    };
  }
}

export {};
