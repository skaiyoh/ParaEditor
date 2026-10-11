// Staged brush input boundary. The host owns project state and document admission;
// this module owns transient strokes and the canonical, document-free pad.
import { beginPaintStroke, PAINT_LIMITS, type PaintAttachment, type PaintBrush, type PaintCapture,
  type PaintCoverageSource, type PaintEraseTarget, type PaintPatch, type PaintPoint, type PaintStroke,
  type PaintStrokeResult, type StrokeSample } from '../core/paint.ts';
import type { Size } from '../core/raster.ts';
import { err, ok, type Result } from '../core/result.ts';
import { z } from '../core/zod.ts';
import type { CommandResult } from './authoring.ts';

const pointSchema = z.strictObject({ x: z.number().finite(), y: z.number().finite() }).readonly();
const sampleSchema = z.strictObject({ at: pointSchema, pressure: z.number().finite().nullable() }).readonly();
const startSchema = z.strictObject({ surface: z.enum(['scene', 'pad']), pointer: z.enum(['pen', 'finger']), sample: sampleSchema });
export type PointerSample = z.infer<typeof sampleSchema>;
export type StrokeStart = z.infer<typeof startSchema>;
export type StrokeToken = symbol;
/** All epochs are monotonic. owner advances on tool/owner changes, including ABA. */
export type PaintGenerations = Readonly<{ scene: number; view: number; owner: number }>;
export type PaintBrushRef = Readonly<{ brushRevision: string; functionRevision: string }>;
export type SessionBrush = PaintBrushRef & { readonly brush: PaintBrush };
export type DrawingAvailability = { readonly kind: 'available' } | {
  readonly kind: 'unavailable'; readonly reason: string;
};
export type PaintInterruption = 'second-touch' | 'lost-capture' | 'context-loss' | 'generation-change' | 'tool-change';
export type BrushPreviewFrame = {
  readonly size: Size;
  /** Ordered layers, each containing immutable rgba8-srgb-straight tiles.
   * Replace the whole frame, compositing in linear light; absent tiles are clear. */
  readonly patches: readonly PaintPatch[];
};
export type BrushPreviewSink = (frame: BrushPreviewFrame) => void;
export type PaintCommitGuard = { readonly signal: AbortSignal; readonly isCurrent: () => boolean };
export type PaintStrokePlane = {
  readonly size: Size; readonly texture: PaintCapture['plane'];
  /** Pure mapping pinned to the accepted rendered eye and start disparity. */
  readonly toPlane: (imagePoint: PaintPoint) => PaintPoint;
};
export type PaintSessionHost = {
  readonly sceneSurface: () => { readonly owner: string; readonly depthAvailable: boolean } | null;
  readonly generations: () => PaintGenerations;
  readonly depthAt: (imagePoint: PaintPoint) => PaintAttachment | null;
  readonly capturePlane: (input: { readonly at: PaintPoint; readonly attachment: PaintAttachment }) => PaintStrokePlane;
  readonly readBrush: () => SessionBrush;
  /** Validate and synchronously apply project state, scheduling save without history. */
  readonly writeBrush: (brush: PaintBrush) => CommandResult;
  /** Return a closure pinned to these revisions, never a live lookup of the rack. */
  readonly brushCoverage: (ref: PaintBrushRef) => PaintCoverageSource;
  readonly nextStroke: () => { readonly id: string; readonly seed: number };
  readonly projectPatchCount: () => number;
  readonly activePatches: (capture: PaintCapture) => readonly PaintEraseTarget[];
  /** One non-coalescing action per call. Before atomic publication, recheck the
   * guard, project cap and erase before-refs. Abandon cancelled asset work.
   * Serialize document admission here, and resolve in the publication turn. */
  readonly commit: (result: PaintStrokeResult, guard: PaintCommitGuard) => Promise<CommandResult>;
};

const previewPath: readonly PointerSample[] = [
  { at: { x: .125, y: .65 }, pressure: .2 }, { at: { x: .25, y: .3 }, pressure: .55 },
  { at: { x: .375, y: .25 }, pressure: 1 }, { at: { x: .5, y: .65 }, pressure: .7 },
  { at: { x: .625, y: .75 }, pressure: .35 }, { at: { x: .75, y: .35 }, pressure: .85 },
  { at: { x: .875, y: .45 }, pressure: .2 },
];
/** Normalized pad coordinates; one pad pixel is one source-image pixel, regardless
 * of CSS size, device pixel ratio or scene zoom. Constants are part of the replay. */
export const BRUSH_PREVIEW = Object.freeze({ size: Object.freeze({ width: 256, height: 128 }), seed: 0x4d525834,
  plane: Object.freeze({ origin: Object.freeze({ x: .5, y: .5 }), pixelScale: 1 }),
  backingBrush: Object.freeze({ operation: 'draw', diameter: 48, opacity: 1, pressure: 'off',
    color: Object.freeze({ l: .7, c: 0, h: 0 }) } satisfies PaintBrush),
  path: Object.freeze(previewPath.map(sample => Object.freeze({ ...sample, at: Object.freeze({ ...sample.at }) }))),
});
const stale = (): CommandResult => ({ kind: 'cancelled' });
const refused = (reason: string): CommandResult => ({ kind: 'refused', reason });
const failure = (error: unknown): string => error instanceof Error ? error.message : 'The paint operation failed.';
const sameGenerations = (a: PaintGenerations, b: PaintGenerations): boolean =>
  a.scene === b.scene && a.view === b.view && a.owner === b.owner;
const padPlane: PaintStrokePlane = Object.freeze({ size: BRUSH_PREVIEW.size, texture: BRUSH_PREVIEW.plane,
  toPlane: (at: PaintPoint) => ({ x: at.x * BRUSH_PREVIEW.size.width, y: at.y * BRUSH_PREVIEW.size.height }) });
type Prepared = { readonly owner: string; readonly plane: PaintStrokePlane; readonly attachment: PaintAttachment };
type InFlight = { readonly generations: PaintGenerations; readonly controller: AbortController };
type Gesture = InFlight & { readonly token: StrokeToken; readonly surface: StrokeStart['surface'];
  readonly pointer: StrokeStart['pointer']; readonly stroke: PaintStroke; readonly plane: PaintStrokePlane };

export function createPaintSession(host: PaintSessionHost) {
  let fingerDraw = false, gesture: Gesture | null = null;
  const pending = new Map<StrokeToken, Gesture>();
  let sink: BrushPreviewSink | null = null, padPatches: readonly PaintPatch[] = Object.freeze([]), padId = 0;
  let previewStatus: CommandResult = { kind: 'unchanged' };

  function cancelStroke(token: StrokeToken): void {
    if (gesture?.token === token) {
      gesture.stroke.cancel(); gesture.controller.abort(); gesture = null;
    }
    pending.get(token)?.controller.abort();
  }
  function interrupt(_reason: PaintInterruption): void {
    if (gesture !== null) cancelStroke(gesture.token);
    for (const work of pending.values()) work.controller.abort();
  }
  function current(work: InFlight): boolean {
    return !work.controller.signal.aborted && sameGenerations(work.generations, host.generations());
  }
  function reconcile(): void {
    if (gesture !== null && !current(gesture)) cancelStroke(gesture.token);
    for (const work of pending.values()) if (!current(work)) work.controller.abort();
  }
  function prepare(input?: StrokeStart): Result<Prepared | null, Exclude<DrawingAvailability, { kind: 'available' }>> {
    if (input?.pointer === 'finger' && !fingerDraw) {
      return err({ kind: 'unavailable', reason: 'Turn on finger Draw to paint with a finger.' });
    }
    if (input?.surface === 'pad') return ok({ owner: 'brush-preview', plane: padPlane,
      attachment: { depthSample: { x: 0, y: 0 }, disparity: .5 } });
    const scene = host.sceneSurface();
    if (scene === null) return err({ kind: 'unavailable', reason: 'Open a photo and choose a paint layer before drawing.' });
    if (!scene.depthAvailable) return err({ kind: 'unavailable', reason: 'Depth is unavailable for this photo.' });
    if (input === undefined) return ok(null);
    const attachment = host.depthAt(input.sample.at);
    if (attachment === null) return err({ kind: 'unavailable', reason: 'Depth is unavailable at the stroke start.' });
    const captured = host.capturePlane({ at: input.sample.at, attachment });
    const plane: PaintStrokePlane = Object.freeze({ size: Object.freeze({ ...captured.size }), toPlane: captured.toPlane,
      texture: Object.freeze({ origin: Object.freeze({ ...captured.texture.origin }), pixelScale: captured.texture.pixelScale }) });
    return ok({ owner: scene.owner, plane, attachment });
  }
  function drawingAvailability(input?: StrokeStart): DrawingAvailability {
    try {
      if (input !== undefined) {
        const parsed = startSchema.safeParse(input);
        if (!parsed.success) return { kind: 'unavailable', reason: 'The stroke input is invalid.' };
        samplesFor(parsed.data.surface, [parsed.data.sample]);
        input = parsed.data;
      }
      const result = prepare(input);
      return result.ok ? { kind: 'available' } : result.error;
    } catch (error) { return { kind: 'unavailable', reason: failure(error) }; }
  }
  function samplesFor(surface: StrokeStart['surface'], samples: readonly PointerSample[], plane?: PaintStrokePlane,
    pointer: StrokeStart['pointer'] = 'pen'): StrokeSample[] {
    return samples.map(input => {
      const sample = sampleSchema.parse(input);
      if (surface === 'pad' && (sample.at.x < 0 || sample.at.x > 1 || sample.at.y < 0 || sample.at.y > 1)) {
        throw new RangeError('Pad coordinates must be between zero and one.');
      }
      const at = plane?.toPlane(sample.at) ?? sample.at;
      return { ...at, pressure: pointer === 'pen' ? sample.pressure : null };
    });
  }
  function openStroke(input: StrokeStart, prepared: Prepared, generations: PaintGenerations): Result<PaintStroke, string> {
    const settings = host.readBrush(), ref = Object.freeze({ brushRevision: settings.brushRevision,
      functionRevision: settings.functionRevision });
    const identity = input.surface === 'pad' ? { id: `pad-${++padId}`, seed: BRUSH_PREVIEW.seed } : host.nextStroke();
    const start = samplesFor(input.surface, [input.sample], prepared.plane, input.pointer)[0];
    if (start === undefined) return err('A stroke needs a start sample.');
    const capture: PaintCapture = { owner: prepared.owner, sceneGeneration: generations.scene, viewGeneration: generations.view,
      ...ref, seed: identity.seed, start, attachment: prepared.attachment, plane: prepared.plane.texture };
    const common = { capture, brush: settings.brush, coverageSource: host.brushCoverage(ref),
      projectPatchCount: input.surface === 'pad' ? padPatches.length : host.projectPatchCount() };
    return settings.brush.operation === 'draw'
      ? beginPaintStroke({ ...common, kind: 'draw', brush: settings.brush, id: identity.id, size: prepared.plane.size })
      : beginPaintStroke({ ...common, kind: 'erase', brush: settings.brush,
        targets: input.surface === 'pad' ? padPatches.map(patch => ({ patch, toPatch: { offset: { x: 0, y: 0 }, scale: 1 } }))
          : [...host.activePatches(capture)] });
  }
  function beginStroke(input: StrokeStart): Result<StrokeToken, string> {
    reconcile();
    // The driver routes a second contact here (or to interrupt) before navigation.
    if (gesture !== null) { interrupt('second-touch'); return err('The stroke was cancelled by another pointer.'); }
    try {
      const parsed = startSchema.safeParse(input);
      if (!parsed.success) return err('The stroke input is invalid.');
      input = parsed.data;
      samplesFor(input.surface, [input.sample]);
      const generations = Object.freeze({ ...host.generations() }), prepared = prepare(input);
      if (!prepared.ok) return err(prepared.error.reason);
      if (prepared.value === null) return err('A stroke needs a surface.');
      const begun = openStroke(input, prepared.value, generations);
      if (!begun.ok) return begun;
      const work: Gesture = { token: Symbol('paint stroke'), surface: input.surface, pointer: input.pointer,
        stroke: begun.value, plane: prepared.value.plane, generations, controller: new AbortController() };
      if (!current(work)) { work.stroke.cancel(); return err('The paint surface changed before the stroke began.'); }
      gesture = work;
      return ok(work.token);
    } catch (error) { return err(failure(error)); }
  }
  function extendStroke(token: StrokeToken, samples: readonly PointerSample[]): CommandResult {
    reconcile();
    if (gesture === null || gesture.token !== token) return stale();
    try {
      const result = gesture.stroke.extend(samplesFor(gesture.surface, samples, gesture.plane, gesture.pointer));
      if (!result.ok) { cancelStroke(token); return refused(result.error); }
      return { kind: 'applied' };
    } catch (error) { cancelStroke(token); return refused(failure(error)); }
  }
  function publishPad(): void { sink?.(Object.freeze({ size: BRUSH_PREVIEW.size, patches: padPatches })); }
  function applyPad(result: PaintStrokeResult): void {
    const patches = new Map(padPatches.map(patch => [patch.id, patch]));
    for (const change of result.changes) {
      if (change.after === null) patches.delete(change.patchId); else patches.set(change.patchId, change.after);
    }
    padPatches = Object.freeze([...patches.values()]);
    publishPad();
  }
  async function endStroke(token: StrokeToken): Promise<CommandResult> {
    reconcile();
    const work = gesture;
    if (work === null || work.token !== token) return stale();
    gesture = null; // Freeze exactly once, before any host await or reentrancy.
    try {
      const finished = work.stroke.finish();
      if (!finished.ok) return refused(finished.error);
      if (!current(work)) return stale();
      const result = finished.value;
      if (result === null) return { kind: 'unchanged' };
      if (work.surface === 'pad') { applyPad(result); return { kind: 'applied' }; }
      if (result.kind === 'draw' && host.projectPatchCount() >= PAINT_LIMITS.patches) {
        return refused('The project already has 64 paint patches; erase or remove a patch before drawing.');
      }
      pending.set(token, work);
      return await host.commit(result, { signal: work.controller.signal, isCurrent: () => current(work) });
    } catch (error) {
      work.stroke.cancel();
      return work.controller.signal.aborted ? stale() : refused(failure(error));
    }
    finally { pending.delete(token); }
  }
  function resetBrushPreview(): void {
    if (gesture?.surface === 'pad') cancelStroke(gesture.token);
    previewStatus = { kind: 'unchanged' };
    padPatches = Object.freeze([]); publishPad();
  }
  function replayPreview(): CommandResult {
    resetBrushPreview();
    const [first, ...rest] = BRUSH_PREVIEW.path;
    if (first === undefined) return refused('The recorded brush path is empty.');
    const input: StrokeStart = { surface: 'pad', pointer: 'pen', sample: first };
    const prepared = prepare(input);
    if (!prepared.ok) return refused(prepared.error.reason);
    if (prepared.value === null) return refused('The preview surface is unavailable.');
    // A fixed neutral mark makes erasure inspectable without document targets.
    if (host.readBrush().brush.operation === 'erase') {
      const start = samplesFor('pad', [first], padPlane)[0];
      if (start === undefined) return refused('The recorded brush path is empty.');
      const backing = beginPaintStroke({ kind: 'draw', id: 'pad-backing', size: BRUSH_PREVIEW.size,
        brush: BRUSH_PREVIEW.backingBrush, projectPatchCount: 0, capture: { owner: 'brush-preview',
          sceneGeneration: 0, viewGeneration: 0, brushRevision: 'pad-backing@1', functionRevision: 'solid@1',
          seed: BRUSH_PREVIEW.seed, start, attachment: prepared.value.attachment, plane: BRUSH_PREVIEW.plane } });
      if (!backing.ok) return refused(backing.error);
      const extended = backing.value.extend(samplesFor('pad', rest, padPlane));
      if (!extended.ok) return refused(extended.error);
      const finished = backing.value.finish();
      if (!finished.ok) return refused(finished.error);
      if (finished.value !== null) applyPad(finished.value);
    }
    const begun = openStroke(input, prepared.value, { ...host.generations() });
    if (!begun.ok) return refused(begun.error);
    try {
      const extended = begun.value.extend(samplesFor('pad', rest, padPlane));
      if (!extended.ok) return refused(extended.error);
      const finished = begun.value.finish();
      if (!finished.ok) return refused(finished.error);
      if (finished.value !== null) applyPad(finished.value);
      return { kind: 'applied' };
    } finally { begun.value.cancel(); }
  }
  function updatePreview(): CommandResult {
    try { previewStatus = replayPreview(); } catch (error) { previewStatus = refused(failure(error)); }
    return previewStatus;
  }
  async function replayBrushPreview(): Promise<CommandResult> { return updatePreview(); }
  async function setBrush(brush: PaintBrush): Promise<CommandResult> {
    try {
      const previousOperation = host.readBrush().brush.operation, result = host.writeBrush(brush);
      if (result.kind !== 'applied' && result.kind !== 'unchanged') return result;
      if (previousOperation !== host.readBrush().brush.operation) interrupt('tool-change');
      // Future-strokes-only policy lives here. Never rewrite completed scene pixels
      // or the captured live brush.
      updatePreview();
      // A pad failure cannot undo or misreport an already-applied project edit.
      return result;
    } catch (error) { return refused(failure(error)); }
  }
  return {
    beginStroke, extendStroke, endStroke, cancelStroke, interrupt, reconcile, drawingAvailability,
    setBrush, replayBrushPreview, resetBrushPreview,
    brushPreviewStatus: (): CommandResult => previewStatus,
    attachBrushPreview(next: BrushPreviewSink | null): void { sink = next; publishPad(); },
    setFingerDraw(enabled: boolean): void {
      fingerDraw = enabled;
      if (!enabled && gesture?.pointer === 'finger') cancelStroke(gesture.token);
      if (!enabled) for (const work of pending.values()) if (work.pointer === 'finger') work.controller.abort();
    },
  };
}
export type PaintSession = ReturnType<typeof createPaintSession>;
