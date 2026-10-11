import type { ImagePoint, Oklch } from '../core/raster.ts';
import type { Capability } from '../session/authoring.ts';

/**
 * The scene-painting view the editor's Brush and Eraser tools need (MRX0 S9, S12), built by `paintModel(session)`
 * in paint-adapter.ts. The Stage, the tool buttons, the Size rail and the brush context bar see only this.
 * The session owns strokes, history, saving, drawing availability and every interruption.
 */

export type PaintTool = 'brush' | 'eraser';

/** Pencil and mouse are deliberate input and draw; a touch draws only while finger Draw is on (lead, 2026-10-11). */
export type PaintPointer = 'pen' | 'finger';

export type PaintSample = {
  /** Source-image pixels (S12 item 3), from the Stage's CSS-to-source conversion. */
  readonly at: ImagePoint;
  /** 0 to 1 for a pen, null otherwise. */
  readonly pressure: number | null;
};

export type PaintBrushView = {
  /** OKLCH ink (S12 item 5); format it with displayColor. */
  readonly color: Oklch;
  /** Diameter in source pixels. */
  readonly diameter: number;
  readonly minDiameter: number;
  readonly maxDiameter: number;
  /** 0 to 1. */
  readonly opacity: number;
  readonly pressure: 'off' | 'size';
};

export type PaintModel = {
  /** The active paint tool, or null while another tool is active. */
  readonly tool: PaintTool | null;
  /** Null returns to the ordinary select tool; the session interrupts any stroke on a tool change. */
  readonly setTool: (tool: PaintTool | null) => void;
  readonly brush: PaintBrushView;
  /** Ink, size, opacity and pressure are project state written through setBrush, not history actions (S9 G14). */
  readonly setBrush: (patch: Partial<Pick<PaintBrushView, 'color' | 'diameter' | 'opacity' | 'pressure'>>) => void;
  /** Whether the scene accepts paint now, or why not: no photo, or depth missing or not ready (MRX0 S13). */
  readonly drawing: Capability;
  readonly fingerDraw: boolean;
  readonly setFingerDraw: (enabled: boolean) => void;
  /** Starts a scene stroke at its first sample; null when the session refuses it (the drawing reason says why). */
  readonly begin: (pointer: PaintPointer, sample: PaintSample) => symbol | null;
  readonly extend: (stroke: symbol, samples: readonly PaintSample[]) => void;
  /** One completed stroke is one Undo step. */
  readonly end: (stroke: symbol) => void;
  /** Escape and the tool's own cancellation; a cancelled stroke leaves no mark and no save. */
  readonly cancel: (stroke: symbol) => void;
  readonly interrupt: (reason: 'second-touch' | 'lost-capture') => void;
};
