import type { Edit } from '../core/edits.ts';
import type { ObjectId } from '../core/ids.ts';
import type { Oklch } from '../core/raster.ts';
import { applyEdit } from '../core/reduce.ts';
import type { SceneDocument } from '../core/types.ts';

export type OperationTarget =
  | { readonly kind: 'scene' }
  | { readonly kind: 'background' }
  | { readonly kind: 'layer'; readonly id: ObjectId }
  | { readonly kind: 'selection' };
export type CompareMode = 'edited' | 'source-photo' | 'treatments-off';
export type SampleMode = 'edited' | 'source';
/** C1 tools only; manual selection, transform and paint arrive with their consuming paths. */
export type Tool = 'select' | 'sample';
export type ParameterValue = Extract<Edit, { kind: 'style' | 'fry' | 'surface' | 'motion' | 'symbols' }>;
export type GestureValue = ParameterValue | { readonly kind: 'color'; readonly color: Oklch | null };
export type AuthoringOperation = GestureValue['kind'];
export type CommandResult =
  | { readonly kind: 'applied' | 'unchanged' | 'cancelled' }
  | { readonly kind: 'refused'; readonly reason: string };
export type Capability = { readonly kind: 'available' } | { readonly kind: 'unavailable'; readonly reason: string };
export type GestureStart = { readonly operation: AuthoringOperation; readonly target: OperationTarget };
/** Opaque identity: a stale token can never address a later gesture. */
export type GestureToken = symbol;
export type GestureUpdate = { readonly token: GestureToken; readonly value: GestureValue };
export type AuthoringState = {
  readonly activeLayer: ObjectId | null;
  readonly target: OperationTarget;
  readonly tool: Tool;
  readonly compare: CompareMode;
  readonly sampleMode: SampleMode;
  readonly gesture: GestureStart | null;
};
export type AuthoringHost = {
  readonly read: () => SceneDocument | null;
  /** Must record one non-coalescing action, and publish only an applied document. */
  readonly record: (edit: Edit) => CommandResult;
  /** Redraw/notify only. Never stamp a document or observe it for autosave. */
  readonly changed: () => void;
};

const initialState = (): AuthoringState => ({ activeLayer: null, target: { kind: 'scene' },
  tool: 'select', compare: 'edited', sampleMode: 'edited', gesture: null });

/** Capture must snapshot pixels before returning, even when encoding returns a promise. */
export function captureCommitted<T>(input: {
  readonly document: SceneDocument;
  readonly render: (document: SceneDocument) => void;
  readonly capture: () => T;
  readonly restore: () => void;
}): T {
  try { input.render(input.document); return input.capture(); }
  finally { input.restore(); }
}

/** Session-only authoring. Preview stores an edit, never a historical document snapshot. */
export function createAuthoring(host: AuthoringHost) {
  let state = initialState();
  let gesture: { readonly token: GestureToken; readonly start: GestureStart;
    readonly scene: SceneDocument['id']; edit: Edit | null } | null = null;

  function capability(input: { readonly operation: string; readonly target: OperationTarget }): Capability {
    const doc = host.read();
    if (doc === null) return { kind: 'unavailable', reason: 'Open a photo first.' };
    if (input.operation === 'color') {
      if (input.target.kind !== 'layer') return { kind: 'unavailable', reason: 'Color currently requires a layer; Background and selection color arrive in C2.' };
      const id = input.target.id;
      return doc.objects.some((object) => object.id === id)
        ? { kind: 'available' } : { kind: 'unavailable', reason: 'That layer is no longer in this photo.' };
    }
    switch (input.operation) {
      case 'style': case 'fry': case 'surface': case 'motion': case 'symbols':
        return input.target.kind === 'scene' ? { kind: 'available' }
          : { kind: 'unavailable', reason: 'This effect is Scene-only.' };
      default: return { kind: 'unavailable', reason: 'This operation is not available yet.' };
    }
  }
  function cancelGesture(token: GestureToken): void {
    if (gesture?.token !== token) return;
    gesture = null; state = { ...state, gesture: null }; host.changed();
  }
  function cancel(): void { if (gesture !== null) cancelGesture(gesture.token); }
  function setTarget(target: OperationTarget): CommandResult {
    const doc = host.read();
    if (doc === null) return { kind: 'refused', reason: 'Open a photo first.' };
    if (target.kind === 'layer' && !doc.objects.some((object) => object.id === target.id)) {
      return { kind: 'refused', reason: 'That layer is no longer in this photo.' };
    }
    if (target.kind === 'selection') return { kind: 'refused', reason: 'There is no active selection.' };
    if (state.target.kind === target.kind && (target.kind !== 'layer' || (state.target.kind === 'layer' && state.target.id === target.id))) return { kind: 'unchanged' };
    cancel(); state = { ...state, target: { ...target } }; host.changed(); return { kind: 'applied' };
  }
  function setTool(tool: Tool): CommandResult {
    if (tool === state.tool) return { kind: 'unchanged' };
    cancel(); state = { ...state, tool }; host.changed(); return { kind: 'applied' };
  }
  function toEdit(value: GestureValue, target: OperationTarget): Edit | null {
    if (value.kind !== 'color') return value;
    return target.kind === 'layer' ? { kind: 'object.set', id: target.id,
      patch: { recolor: value.color === null ? { kind: 'none' } : { kind: 'target', color: value.color } } } : null;
  }
  function beginGesture(input: GestureStart): GestureToken | null {
    const doc = host.read();
    if (doc === null || capability(input).kind === 'unavailable') return null;
    cancel();
    const start = { ...input, target: { ...input.target } };
    const token = Symbol('authoring gesture');
    gesture = { token, start, scene: doc.id, edit: null };
    state = { ...state, gesture: start }; host.changed(); return token;
  }
  function updateGesture(input: GestureUpdate): CommandResult {
    const current = gesture, doc = host.read();
    if (current === null || current.token !== input.token || doc?.id !== current.scene) return { kind: 'cancelled' };
    if (input.value.kind !== current.start.operation) return { kind: 'refused', reason: 'The value belongs to another tool.' };
    const available = capability(current.start);
    if (available.kind === 'unavailable') return { kind: 'refused', reason: available.reason };
    const edit = toEdit(input.value, current.start.target);
    if (edit === null) return { kind: 'refused', reason: 'The target cannot receive this edit.' };
    const result = applyEdit(doc, edit, doc.updatedAt);
    if (result.kind === 'refused') return { kind: 'refused', reason: result.detail };
    // Each update is the complete value/patch since begin, evaluated against the committed doc.
    current.edit = structuredClone(edit);
    host.changed(); return { kind: result.kind };
  }
  function commitGesture(token: GestureToken): CommandResult {
    const current = gesture;
    if (current === null || current.token !== token || host.read()?.id !== current.scene) return { kind: 'cancelled' };
    gesture = null; state = { ...state, gesture: null };
    const result = current.edit === null ? { kind: 'unchanged' } satisfies CommandResult : host.record(current.edit);
    host.changed(); return result;
  }
  function setColor(input: { readonly color: Oklch | null; readonly target: OperationTarget }): CommandResult {
    const available = capability({ operation: 'color', target: input.target });
    if (available.kind === 'unavailable') return { kind: 'refused', reason: available.reason };
    const edit = toEdit({ kind: 'color', color: input.color }, input.target);
    if (edit === null) return { kind: 'refused', reason: 'The target cannot receive color.' };
    cancel(); return host.record(edit);
  }
  return {
    snapshot: (): AuthoringState => state,
    capability, setTarget, setTool, setColor, beginGesture, updateGesture, commitGesture, cancelGesture, cancel,
    setCompare(compare: CompareMode): void {
      if (compare === state.compare) return;
      cancel(); state = { ...state, compare }; host.changed();
    },
    setSampleMode(sampleMode: SampleMode): void {
      if (sampleMode === state.sampleMode) return;
      state = { ...state, sampleMode }; host.changed();
    },
    /** Called before publishing analysis or other committed changes; does not notify recursively. */
    reconcile(doc: SceneDocument, activeLayer: ObjectId | null): void {
      const exists = (id: ObjectId): boolean => doc.objects.some((object) => object.id === id);
      const target = state.target.kind === 'layer' && !exists(state.target.id) ? { kind: 'scene' } satisfies OperationTarget : state.target;
      if (gesture !== null && (gesture.scene !== doc.id || activeLayer !== state.activeLayer ||
        (gesture.start.target.kind === 'layer' && !exists(gesture.start.target.id)))) gesture = null;
      state = { ...state, activeLayer, target, gesture: gesture?.start ?? null };
    },
    previewDocument(doc: SceneDocument): SceneDocument {
      if (gesture?.scene !== doc.id || gesture.edit === null) return doc;
      return applyEdit(doc, gesture.edit, doc.updatedAt).doc;
    },
    reset(): void { gesture = null; state = initialState(); host.changed(); },
  };
}
