// Neutral authoring coordinates only. No document, Motion or live-camera state.
import { compositionSizeSchema } from './composition-schema.ts';
import { sourcePointSchema, type SourcePoint } from './mask-edit.ts';
import { z } from './zod.ts';

export const authoringLayoutSchema = z.strictObject({
  source: compositionSizeSchema,
  viewport: z.strictObject({ x: z.number().finite(), y: z.number().finite(),
    width: z.number().finite().positive(), height: z.number().finite().positive() }).readonly(),
  dpr: z.number().finite().positive(),
}).readonly();
export type AuthoringLayout = z.infer<typeof authoringLayoutSchema>;
export type AuthoringView = { readonly layout: AuthoringLayout; readonly zoom: number; readonly pan: SourcePoint };
/** CSS points are client coordinates. Device points are local backing-store pixels,
 * with the same top-left/y-down convention (not WebGL's bottom-left readback). */
export type ViewPoint = { readonly kind: 'css' | 'device'; readonly x: number; readonly y: number };

export function fitAuthoringView(layout: AuthoringLayout): AuthoringView {
  const parsed = authoringLayoutSchema.parse(layout);
  return { layout: parsed, zoom: 1, pan: { x: 0, y: 0 } };
}

export function authoringScale(view: AuthoringView): number {
  return Math.min(view.layout.viewport.width / view.layout.source.width,
    view.layout.viewport.height / view.layout.source.height) * view.zoom;
}

function cssPoint(layout: AuthoringLayout, point: ViewPoint): SourcePoint {
  sourcePointSchema.parse({ x: point.x, y: point.y });
  return point.kind === 'css' ? { x: point.x, y: point.y }
    : { x: layout.viewport.x + point.x / layout.dpr, y: layout.viewport.y + point.y / layout.dpr };
}

export function viewToSource(view: AuthoringView, point: ViewPoint): SourcePoint {
  const css = cssPoint(view.layout, point), { viewport, source } = view.layout, scale = authoringScale(view);
  return { x: (css.x - viewport.x - viewport.width / 2 - view.pan.x) / scale + source.width / 2,
    y: (css.y - viewport.y - viewport.height / 2 - view.pan.y) / scale + source.height / 2 };
}

export function sourceToView(view: AuthoringView, point: SourcePoint, kind: ViewPoint['kind']): ViewPoint {
  sourcePointSchema.parse(point);
  const { viewport, source, dpr } = view.layout, scale = authoringScale(view);
  const x = viewport.width / 2 + view.pan.x + (point.x - source.width / 2) * scale;
  const y = viewport.height / 2 + view.pan.y + (point.y - source.height / 2) * scale;
  return kind === 'css' ? { kind, x: viewport.x + x, y: viewport.y + y } : { kind, x: x * dpr, y: y * dpr };
}

export function panAuthoringView(view: AuthoringView, delta: SourcePoint): AuthoringView {
  sourcePointSchema.parse(delta);
  const pan = sourcePointSchema.parse({ x: view.pan.x + delta.x, y: view.pan.y + delta.y });
  return { ...view, pan };
}

/** Numeric zoom and pinch share this anchor-preserving operation; zoom is times Fit. */
export function zoomAuthoringView(view: AuthoringView, zoom: number, anchor: ViewPoint): AuthoringView {
  z.number().finite().parse(zoom);
  const at = viewToSource(view, anchor), css = cssPoint(view.layout, anchor);
  const next = { ...view, zoom: Math.max(1, Math.min(8, zoom)) };
  const moved = sourceToView(next, at, 'css');
  return panAuthoringView(next, { x: css.x - moved.x, y: css.y - moved.y });
}

/** Rotation/layout changes preserve the owner point at the viewport center and
 * magnification relative to Fit. A different source extent resets to Fit. */
export function reframeAuthoringView(view: AuthoringView, layout: AuthoringLayout): AuthoringView {
  const fit = fitAuthoringView(layout);
  if (layout.source.width !== view.layout.source.width || layout.source.height !== view.layout.source.height) return fit;
  const next = { ...fit, zoom: view.zoom }, ratio = authoringScale(next) / authoringScale(view);
  return { ...next, pan: sourcePointSchema.parse({ x: view.pan.x * ratio, y: view.pan.y * ratio }) };
}
