import type { PaintPlane, PaintAdmission, PaintResources, PaintDepthCapture } from './paint.ts';
export type { PaintPlane, PaintTile, PaintAdmission, PaintResources, PaintDepthCapture } from './paint.ts';
import type { CompositingPolicy, SceneDocument, LegacySceneDocument } from '../core/types.ts';
import type { EffectId, ObjectId } from '../core/ids.ts';
import type { ImagePoint, Plane, Rgb8 } from '../core/raster.ts';
import type { Vec2 } from '../core/motion.ts';
import type { PerspectiveEye, PerspectiveGeometry } from '../core/perspective.ts';
import type { CompareMode, SampleColorRequest, SampleColorResult } from './compare.ts';
import type { RenderLocalEffect } from './local-effects.ts';
import type { MathResult } from '../core/math-expression.ts';
import type { MathPhotoRack } from './math-program.ts';
export type { CompareMode, SampleSource, SampleColorRequest, SampleColorResult } from './compare.ts';
export type { RenderLocalEffect } from './local-effects.ts';

/** Transient prepared content; never used by the saved document's deterministic exports. */
export type PerspectivePlate = { readonly key: string; readonly image: Rgb8; readonly hole: Plane<'u8'>; readonly depth: Plane<'f32'> };
export type PerspectiveRenderRequest = {
  readonly geometry: PerspectiveGeometry;
  readonly eye: PerspectiveEye;
  readonly sceneGeneration: number;
  readonly viewId: number;
  readonly frame?: number;
  readonly showSelection?: boolean;
};
export type PerspectiveRenderResult = { readonly kind: 'rendered'; readonly eye: PerspectiveEye; readonly travelScale: number; readonly reason: string | null } | { readonly kind: 'limited'; readonly reason: string };
type PerspectiveHitIdentity = { readonly sceneGeneration: number; readonly viewId: number };
export type PerspectiveHit =
  | (PerspectiveHitIdentity & { readonly kind: 'original'; readonly objectId: ObjectId | null; readonly sourceUV: ImagePoint })
  | (PerspectiveHitIdentity & { readonly kind: 'generated'; readonly objectId: null })
  | { readonly kind: 'miss' };

export type RenderScene = {
  readonly doc: SceneDocument | LegacySceneDocument;
  readonly master: ImageBitmap;
  readonly masks: ReadonlyMap<ObjectId, Plane<'u8'>>;
  readonly depth: Plane<'f32'> | null;
  readonly plate: Rgb8 | null;
  /** Persisted repair output, independently keyed from the source disparity map. */
  readonly backgroundDepth?: Plane<'f32'> | null;
  readonly selected: ObjectId | null;
  /** Screen-only source-space stencil in the neutral manual authoring view. */
  readonly manualSelection?: Plane<'u8'> | null;
  readonly livePlate?: PerspectivePlate | null;
  /** Ordered resolved C2a operations; omitted by existing v4 callers. */
  readonly localEffects?: readonly RenderLocalEffect[];
  /** C2 accepts legacy ordering only; C3 owns physical depth. */
  readonly compositing?: CompositingPolicy;
};

export type LocalEffectReadback = {
  /** Undecorated top-down RGBA8 immediately before and after local operations. */
  readonly before: Uint8Array;
  readonly after: Uint8Array;
  /** C1b owner R byte, original/generated G flag and valid A flag. */
  readonly owners: Uint8Array;
  /** RG = x high/low, BA = y high/low, normalized by 65535. */
  readonly sourceUV: Uint8Array;
};

export type RendererDebug = {
  readSimplifiedPatch(x: number, y: number, w: number, h: number): Uint8Array;
  /** Geometry id RGBA attachment, after a depth view or moving loop draw; dev only. */
  readGeometryPatch?(x: number, y: number, w: number, h: number): Uint8Array;
  perspectiveResources?(): { readonly targets: number; readonly textures: number };
  resources?(): { readonly textures: number; readonly buffers: number; readonly framebuffers: number; readonly renderbuffers: number; readonly programs: number };
  readLocalEffectPatch?(x: number, y: number, w: number, h: number): LocalEffectReadback;
  /** RGBA8; R is the exact evaluated scope weight for this effect. */
  readLocalCoveragePatch?(id: EffectId, x: number, y: number, w: number, h: number): Uint8Array;
  localResources?(): { readonly targets: number; readonly textures: number };
  paintResources?(): PaintResources;
  readPaintPixel?(x: number, y: number): { depth: number[]; linear: number[]; encoded: number[]; error: number } | null;
  timings(): { readonly lastMs: number; readonly simplifyMs: number };
};

export type PreparedPhotoRack = Readonly<{ handle: symbol }>;
export interface PhotoRackRenderer {
  /** Compile all live passes before activation. A new attempt supersedes pending preparation. */
  preparePhotoRack(rack: MathPhotoRack): MathResult<PreparedPhotoRack>;
  /** Consume the latest preparation from this renderer/photo; null restores legacy Grain. */
  activatePhotoRack(prepared: PreparedPhotoRack | null): void;
}

export type Renderer = PhotoRackRenderer & {
  setScene(scene: RenderScene): void;
  /** Atomic immutable snapshots; requires depth. Clear before replacing photo/depth identity. */
  setPaintPlanes(planes: readonly PaintPlane[]): PaintAdmission;
  /** Capture the visible opaque photo's rendered depth at normalized displayed coordinates. */
  capturePaintDepth(at: ImagePoint): PaintDepthCapture;
  /** Redraw the preceding view with a transient comparison; exports always use Edited. */
  setCompare(mode: CompareMode): void;
  /** Read the displayed image before selection decoration, or its original source hit. */
  sampleColor(request: SampleColorRequest): SampleColorResult;
  renderStill(): void;
  renderFrame(frame: number): void;
  /** Per-axis frame fractions, clamped to parallax reach; depth always uses the loop crop. */
  renderView(camera: Vec2, frame?: number, showSelection?: boolean): void;
  renderPerspective(request: PerspectiveRenderRequest): PerspectiveRenderResult;
  /** Normalized displayed-image coordinates, y down; reads the last rendered live view on demand. */
  hitTest(at: ImagePoint): PerspectiveHit;
  /** End the live attempt and release its buffers/products; temporary legacy exports do not call this. */
  endPerspective(): void;
  exportStill(): Promise<Blob>;
  /** Master-size PNG of the supplied view without selection; restores the preceding draw. */
  exportView(camera: Vec2, frame?: number): Promise<Blob>;
  dispose(): void;
  readonly debug: RendererDebug | null;
};
