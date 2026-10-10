import type { SceneDocument } from '../core/types.ts';
import type { ObjectId } from '../core/ids.ts';
import type { Plane, Rgb8 } from '../core/raster.ts';
import type { Vec2 } from '../core/motion.ts';

export type RenderScene = {
  readonly doc: SceneDocument;
  readonly master: ImageBitmap;
  readonly masks: ReadonlyMap<ObjectId, Plane<'u8'>>;
  readonly depth: Plane<'f32'> | null;
  readonly plate: Rgb8 | null;
  readonly selected: ObjectId | null;
};

export type RendererDebug = {
  readSimplifiedPatch(x: number, y: number, w: number, h: number): Uint8Array;
  /** Geometry id RGBA attachment, after a depth view or moving loop draw; dev only. */
  readGeometryPatch?(x: number, y: number, w: number, h: number): Uint8Array;
  timings(): { readonly lastMs: number; readonly simplifyMs: number };
};

export type Renderer = {
  setScene(scene: RenderScene): void;
  renderStill(): void;
  renderFrame(frame: number): void;
  /** Per-axis frame fractions, clamped to parallax reach; depth always uses the loop crop. */
  renderView(camera: Vec2, frame?: number, showSelection?: boolean): void;
  exportStill(): Promise<Blob>;
  /** Master-size PNG of the supplied view without selection; restores the preceding draw. */
  exportView(camera: Vec2, frame?: number): Promise<Blob>;
  dispose(): void;
  readonly debug: RendererDebug | null;
};
