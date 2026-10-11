import type { SceneDocument } from '../core/types.ts';
import type { ObjectId } from '../core/ids.ts';
import type { ImagePoint, Plane, Rgb8 } from '../core/raster.ts';
import type { Vec2 } from '../core/motion.ts';
import type { PerspectiveEye, PerspectiveGeometry } from '../core/perspective.ts';

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
  readonly doc: SceneDocument;
  readonly master: ImageBitmap;
  readonly masks: ReadonlyMap<ObjectId, Plane<'u8'>>;
  readonly depth: Plane<'f32'> | null;
  readonly plate: Rgb8 | null;
  readonly selected: ObjectId | null;
  readonly livePlate?: PerspectivePlate | null;
};

export type RendererDebug = {
  readSimplifiedPatch(x: number, y: number, w: number, h: number): Uint8Array;
  /** Geometry id RGBA attachment, after a depth view or moving loop draw; dev only. */
  readGeometryPatch?(x: number, y: number, w: number, h: number): Uint8Array;
  perspectiveResources?(): { readonly targets: number; readonly textures: number };
  timings(): { readonly lastMs: number; readonly simplifyMs: number };
};

export type Renderer = {
  setScene(scene: RenderScene): void;
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
