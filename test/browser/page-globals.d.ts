// What scenario code running inside a page may read from the page's globals.
// The dev test surface is declared here with the members the driver and the
// scenarios call, typed from src/app/events.ts; the test project cannot import
// src/app/test-surface.ts itself, because the module behind its Root type
// reads a constant only a build defines. A production build has no surface.
// The memory harness page's own surface is declared beside it.

import type { DiagnosticEvent, EnvironmentSnapshot } from '../../src/app/events.ts';
import type { SceneDocument } from '../../src/core/types.ts';
import type { StylePatch } from '../../src/core/edits.ts';
import type { Renderer, RendererDebug } from '../../src/render/types.ts';
import type { Oklch, Plane } from '../../src/core/raster.ts';
import type { SymbolsDebug, LoopDebug, SelectionDebug } from '../../src/render/debug.ts';
import type { FaceDetection } from '../../src/analysis/protocol.ts';
import type { Vec2 } from '../../src/core/motion.ts';
import type { AnalysisDriver } from '../../src/session/driver.ts';

declare global {
  const NOISY_MODEL_LOCK: string;
  const NOISY_ORT_DIR: string;
  const NOISY_WORKER_URLS: { readonly sequence: string; readonly decode: string; readonly face: string };
  interface Window {
    readonly __noisyTest?: {
      readonly session?: { renderer(): Renderer | null };
      readonly demo: {
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
        parallaxDebug(): { beta: number | null; gamma: number | null; type: OrientationType | null; effectiveType: OrientationType; angle: number | null; legacy: number | null; effectiveAngle: number; faceTarget: Vec2; tilt: Vec2; frame: HTMLCanvasElement | null; face: FaceDetection | null; offset: Vec2; cameraRunning: boolean; tiltRunning: boolean };
        injectOrientation(orientation: Pick<DeviceOrientationEvent, 'beta' | 'gamma'>): void;
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
