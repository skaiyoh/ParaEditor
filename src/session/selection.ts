// Staged C2 selection boundary. The host owns history and immutable-asset admission;
// this controller owns only transient stencil bytes and neutral navigation.
import { fitAuthoringView, panAuthoringView, reframeAuthoringView, sourceToView, viewToSource,
  zoomAuthoringView, type AuthoringLayout, type AuthoringView, type ViewPoint } from '../core/authoring-view.ts';
import { combineMasks, copyMask, emptyMask, featherMask, featherRadiusSchema, invertMask, materializeMask,
  rasterizeMask, sameMask, sourcePointSchema, type MaskCombine, type SourcePoint } from '../core/mask-edit.ts';
import type { Plane, Size } from '../core/raster.ts';
import { err, ok, type Result } from '../core/result.ts';
import { selectionSpaceSchema } from '../core/selection.ts';
import type { SelectionSpace } from '../core/types.ts';
import type { CommandResult } from './authoring.ts';

export type SelectionPixels = { readonly space: SelectionSpace; readonly plane: Plane<'u8'> };
export type SelectionOperation = 'rectangle' | 'freehand' | 'add' | 'remove' | 'feather' | 'invert' | 'clear' | 'initialize';
export type SelectionChange = { readonly before: SelectionPixels | null; readonly after: SelectionPixels | null;
  readonly operation: SelectionOperation };
/** Generations must be monotonic, including delete/recreate with the same id.
 * editEpoch advances for tool/target/history changes; selecting a layer row alone
 * does not retarget the existing stencil. readOwner returns null for a deleted owner. */
export type SelectionOwner = { readonly sceneGeneration: number; readonly editEpoch: number;
  readonly ownerGeneration: number; readonly size: Size };
export type SelectionHost = {
  readonly readOwner: (space: SelectionSpace) => SelectionOwner | null;
  /** Record one non-coalescing transient selection action, never a document/save edit.
   * Snapshots are detached and may be retained directly by the host. */
  readonly record: (change: SelectionChange) => CommandResult;
  readonly changed: () => void;
};
export type SelectionGestureToken = symbol;
export type SelectionGestureStart = { readonly space: SelectionSpace; readonly pointerId: number } & (
  | { readonly kind: 'shape'; readonly tool: 'rectangle' | 'freehand'; readonly mode: MaskCombine; readonly at: SourcePoint }
  | { readonly kind: 'feather' }
);
export type SelectionGestureUpdate = { readonly token: SelectionGestureToken; readonly pointerId: number } & (
  | { readonly kind: 'shape'; readonly at: SourcePoint }
  | { readonly kind: 'feather'; readonly radius: number }
);
type Gesture = { readonly token: SelectionGestureToken; readonly owner: SelectionOwner;
  readonly start: SelectionGestureStart; readonly baseline: Plane<'u8'>; readonly points: SourcePoint[];
  preview: Plane<'u8'> | null };

function sameSpace(a: SelectionSpace, b: SelectionSpace): boolean {
  return a.kind === b.kind && (a.kind !== 'layer' || (b.kind === 'layer' && a.id === b.id));
}
function snapshot(selection: SelectionPixels | null): SelectionPixels | null {
  return selection === null ? null : { space: { ...selection.space }, plane: copyMask(selection.plane) };
}
function sameOwner(a: SelectionOwner, b: SelectionOwner): boolean {
  return a.sceneGeneration === b.sceneGeneration && a.editEpoch === b.editEpoch && a.ownerGeneration === b.ownerGeneration &&
    a.size.width === b.size.width && a.size.height === b.size.height;
}
function failure(error: unknown): CommandResult {
  return { kind: 'refused', reason: error instanceof Error ? error.message : 'Invalid selection input.' };
}

export function createSelection(host: SelectionHost, layout: AuthoringLayout) {
  let view = fitAuthoringView(layout), selection: SelectionPixels | null = null;
  let selectionOwner: SelectionOwner | null = null, gesture: Gesture | null = null;

  function cancel(token: SelectionGestureToken): CommandResult {
    if (gesture?.token !== token) return { kind: 'cancelled' };
    gesture = null; host.changed(); return { kind: 'cancelled' };
  }
  function cancelActive(): void { if (gesture !== null) cancel(gesture.token); }
  function reconcile(): void {
    if (gesture !== null) {
      const owner = host.readOwner(gesture.start.space);
      if (owner === null || !sameOwner(owner, gesture.owner)) cancelActive();
    }
    if (selection !== null && selectionOwner !== null) {
      const owner = host.readOwner(selection.space);
      if (owner === null || owner.sceneGeneration !== selectionOwner.sceneGeneration ||
        owner.ownerGeneration !== selectionOwner.ownerGeneration || owner.size.width !== selectionOwner.size.width || owner.size.height !== selectionOwner.size.height) {
        selection = null; selectionOwner = null; host.changed();
      }
    }
  }
  function publish(after: SelectionPixels | null, operation: SelectionOperation): CommandResult {
    const empty = after !== null && !after.plane.data.some(value => value !== 0);
    const next = empty ? null : after;
    if ((selection === null && next === null) || (selection !== null && next !== null &&
      sameSpace(selection.space, next.space) && sameMask(selection.plane, next.plane))) return { kind: 'unchanged' };
    const owned = snapshot(next);
    const result = host.record({ before: snapshot(selection), after: snapshot(owned), operation });
    if (result.kind === 'applied') {
      selection = owned;
      selectionOwner = owned === null ? null : structuredClone(host.readOwner(owned.space));
      host.changed();
    }
    return result;
  }
  function begin(input: SelectionGestureStart): Result<SelectionGestureToken, string> {
    reconcile();
    try {
      selectionSpaceSchema.parse(input.space);
      if (!Number.isSafeInteger(input.pointerId)) return err('A gesture needs a stable integer pointer id.');
      if (input.kind === 'shape') sourcePointSchema.parse(input.at);
      const owner = host.readOwner(input.space);
      if (owner === null) return err('The selection owner no longer exists.');
      if (selection !== null && !sameSpace(selection.space, input.space)) return err('Clear or explicitly replace the selection before editing another owner.');
      if (input.kind === 'feather' && selection === null) return err('Create a selection before feathering.');
      const baseline = selection === null ? emptyMask(owner.size) : copyMask(selection.plane);
      cancelActive();
      const token = Symbol('selection gesture');
      gesture = { token, owner: structuredClone(owner), start: structuredClone(input), baseline,
        points: input.kind === 'shape' ? [{ ...input.at }] : [], preview: null };
      host.changed(); return ok(token);
    } catch (error) { const result = failure(error); return err(result.kind === 'refused' ? result.reason : 'Invalid selection input.'); }
  }
  function extend(input: SelectionGestureUpdate): CommandResult {
    reconcile();
    const current = gesture;
    if (current === null || current.token !== input.token || current.start.pointerId !== input.pointerId) return { kind: 'cancelled' };
    try {
      if (input.kind === 'feather' && current.start.kind === 'feather') {
        featherRadiusSchema.parse(input.radius);
        current.preview = featherMask(current.baseline, input.radius);
      } else if (input.kind === 'shape' && current.start.kind === 'shape') {
        sourcePointSchema.parse(input.at);
        if (current.start.tool === 'freehand') current.points.push({ ...input.at });
        const brush = current.start.tool === 'rectangle'
          ? rasterizeMask(current.owner.size, { kind: 'rectangle', from: current.start.at, to: input.at })
          : rasterizeMask(current.owner.size, { kind: 'path', points: current.points });
        current.preview = combineMasks(current.baseline, brush, current.start.mode);
      } else return { kind: 'refused', reason: 'This update belongs to another selection tool.' };
      host.changed(); return { kind: 'applied' };
    } catch (error) { return failure(error); }
  }
  function end(input: { readonly token: SelectionGestureToken; readonly pointerId: number }): CommandResult {
    reconcile();
    const current = gesture;
    if (current === null || current.token !== input.token || current.start.pointerId !== input.pointerId) return { kind: 'cancelled' };
    gesture = null;
    const operation = current.start.kind === 'feather' ? 'feather' : current.start.mode === 'replace' ? current.start.tool : current.start.mode;
    const result = current.preview === null ? { kind: 'unchanged' } satisfies CommandResult
      : publish({ space: current.start.space, plane: current.preview }, operation);
    host.changed(); return result;
  }
  function navigate(next: AuthoringView): CommandResult {
    if (JSON.stringify(next) === JSON.stringify(view)) return { kind: 'unchanged' };
    cancelActive(); view = next; host.changed(); return { kind: 'applied' };
  }
  function navigationAction(action: () => AuthoringView): CommandResult {
    try { return navigate(action()); } catch (error) { return failure(error); }
  }
  return {
    begin, extend, end, cancel, cancelActive, reconcile,
    snapshot(): SelectionPixels | null { reconcile(); return snapshot(selection); },
    preview(): SelectionPixels | null {
      reconcile();
      return gesture?.preview === null || gesture === null ? snapshot(selection)
        : snapshot({ space: gesture.start.space, plane: gesture.preview });
    },
    invert(): CommandResult {
      reconcile(); cancelActive();
      return selection === null ? { kind: 'refused', reason: 'Create a selection before inverting.' }
        : publish({ space: selection.space, plane: invertMask(selection.plane) }, 'invert');
    },
    clear(): CommandResult { reconcile(); cancelActive(); return publish(null, 'clear'); },
    /** Explicit owner retarget/materialization; callers pass visible coverage, never inference callbacks. */
    initialize(input: { readonly space: SelectionSpace; readonly plane: Plane<'u8'>;
      readonly sampling: 'coverage' | 'legacy-threshold' }): CommandResult {
      reconcile();
      try {
        selectionSpaceSchema.parse(input.space);
        const owner = host.readOwner(input.space);
        if (owner === null) return { kind: 'refused', reason: 'The selection owner no longer exists.' };
        const plane = materializeMask({ plane: input.plane, owner: owner.size, sampling: input.sampling });
        cancelActive(); return publish({ space: input.space, plane }, 'initialize');
      } catch (error) { return failure(error); }
    },
    /** Host Undo/Redo/import restoration, without recording another action. */
    restore(value: SelectionPixels | null): CommandResult {
      try {
        let next: SelectionPixels | null = null;
        if (value !== null) {
          selectionSpaceSchema.parse(value.space);
          const owner = host.readOwner(value.space);
          if (owner === null) return { kind: 'refused', reason: 'The selection owner no longer exists.' };
          next = { space: { ...value.space }, plane: materializeMask({ plane: value.plane, owner: owner.size, sampling: 'coverage' }) };
        }
        cancelActive(); selection = next;
        selectionOwner = next === null ? null : structuredClone(host.readOwner(next.space));
        host.changed(); return { kind: 'applied' };
      } catch (error) { return failure(error); }
    },
    navigation: {
      snapshot: (): AuthoringView => structuredClone(view),
      toSource: (point: ViewPoint): SourcePoint => viewToSource(view, point),
      toView: (point: SourcePoint, kind: ViewPoint['kind']): ViewPoint => sourceToView(view, point, kind),
      pan: (delta: SourcePoint): CommandResult => navigationAction(() => panAuthoringView(view, delta)),
      zoom: (input: { readonly zoom: number; readonly anchor: ViewPoint }): CommandResult => navigationAction(() => zoomAuthoringView(view, input.zoom, input.anchor)),
      pinch(input: { readonly from: ViewPoint; readonly to: ViewPoint; readonly factor: number }): CommandResult {
        return navigationAction(() => {
          if (!Number.isFinite(input.factor) || input.factor <= 0) throw new RangeError('Pinch factor must be positive and finite.');
          const next = zoomAuthoringView(view, view.zoom * input.factor, input.from);
          const from = sourceToView(next, viewToSource(next, input.from), 'css');
          const to = sourceToView(next, viewToSource(next, input.to), 'css');
          return panAuthoringView(next, { x: to.x - from.x, y: to.y - from.y });
        });
      },
      fit: (): CommandResult => navigationAction(() => fitAuthoringView(view.layout)),
      layout: (next: AuthoringLayout): CommandResult => navigationAction(() => reframeAuthoringView(view, next)),
    },
  };
}
