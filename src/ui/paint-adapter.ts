import type { PaintBrush } from '../core/paint.ts';
import type { Oklch } from '../core/raster.ts';
import type { Result } from '../core/result.ts';
import type { Capability, CommandResult, Tool } from '../session/authoring.ts';
import type { SceneDocument } from '../core/types.ts';
import type { PaintBrushView, PaintModel, PaintPointer, PaintSample, PaintTool } from './paint-model.ts';

/** Temporary S12 boundary; snapshot field placement is recorded in MRX5uJ's Return. */
export type PaintSessionPort = {
  /** DemoState carries the brush and finger Draw (scene.ts DemoState), next to authoring's tool. */
  snapshot(): { readonly authoring: { readonly tool: Tool | PaintTool }; readonly brush: PaintBrush; readonly fingerDraw: boolean };
  setTool(tool: Tool | PaintTool): CommandResult;
  setBrush(brush: PaintBrush): CommandResult | Promise<CommandResult>;
  attachBrushPreview(canvas: HTMLCanvasElement | null): void;
  resetBrushPreview(): void;
  drawingAvailability(): Capability;
  beginStroke(input: { readonly surface: 'scene' | 'pad'; readonly pointer: PaintPointer; readonly sample: PaintSample }): Result<symbol, string>;
  extendStroke(token: symbol, samples: readonly PaintSample[]): CommandResult;
  endStroke(token: symbol): CommandResult | Promise<CommandResult>;
  cancelStroke(token: symbol): void;
  interrupt(reason: 'second-touch' | 'lost-capture'): void;
  setFingerDraw(enabled: boolean): void;
};

type Session = { readonly previewDocument: () => SceneDocument | null };
export function paintPortOf(session: Session): PaintSessionPort | null {
  const candidate: unknown = session;
  const methods = ['snapshot', 'setTool', 'setBrush', 'attachBrushPreview', 'resetBrushPreview', 'drawingAvailability',
    'beginStroke', 'extendStroke', 'endStroke', 'cancelStroke', 'interrupt', 'setFingerDraw'];
  if (typeof candidate !== 'object' || candidate === null ||
    !methods.every(name => typeof Reflect.get(candidate, name) === 'function')) return null;
  return candidate as PaintSessionPort; // Single line MRX4b replaces with the typed session port.
}

const inks = new WeakMap<PaintSessionPort, Oklch>();
/** MRX2 keeps its schema private; these are its diameter bounds (paint.ts brushFields). */
export function paintBrushView(port: PaintSessionPort): PaintBrushView {
  const brush = port.snapshot().brush;
  if (brush.operation === 'draw') inks.set(port, brush.color);
  return { color: brush.operation === 'draw' ? brush.color : inks.get(port) ?? { l: .2, c: 0, h: 0 },
    diameter: brush.diameter, minDiameter: 1, maxDiameter: 256, opacity: brush.opacity, pressure: brush.pressure };
}

/** Merge at call time so independent size/color controls cannot restore stale settings. */
export function setPaintBrush(port: PaintSessionPort, patch: Parameters<PaintModel['setBrush']>[0]): void {
  const brush = port.snapshot().brush;
  if (patch.color !== undefined) inks.set(port, patch.color);
  const common = { diameter: patch.diameter ?? brush.diameter, opacity: patch.opacity ?? brush.opacity, pressure: patch.pressure ?? brush.pressure };
  void port.setBrush(brush.operation === 'draw' ? { ...common, operation: 'draw', color: patch.color ?? brush.color }
    : { ...common, operation: 'erase' });
}

export function paintModel(session: Session): PaintModel | null {
  const port = paintPortOf(session), doc = session.previewDocument();
  // The session upgrades a v5 document to v6 on its first stroke, so freshly imported photos can paint too.
  if (port === null || doc === null) return null;
  const tool = port.snapshot().authoring.tool, drawing = port.drawingAvailability();
  return {
    tool: tool === 'brush' || tool === 'eraser' ? tool : null,
    setTool: tool => { port.setTool(tool ?? 'select'); },
    brush: paintBrushView(port), setBrush: patch => setPaintBrush(port, patch),
    drawing,
    fingerDraw: port.snapshot().fingerDraw, setFingerDraw: enabled => port.setFingerDraw(enabled),
    begin: (pointer, sample) => { const result = port.beginStroke({ surface: 'scene', pointer, sample }); return result.ok ? result.value : null; },
    extend: (token, samples) => { port.extendStroke(token, samples); },
    end: token => { void port.endStroke(token); }, cancel: token => port.cancelStroke(token),
    interrupt: reason => port.interrupt(reason),
  };
}
