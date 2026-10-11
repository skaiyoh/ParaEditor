import type { Edit } from '../core/edits.ts';
import type { ObjectId } from '../core/ids.ts';
import type { Oklch } from '../core/raster.ts';
import { applyEdit } from '../core/reduce.ts';
import type { SceneDocument, ActiveSelection } from '../core/types.ts';
import * as coreHistory from '../core/history.ts';
import { sameValue } from '../core/equal.ts';
import { mathRefKey, type MathRef } from '../core/math-definition.ts';
import { location, mathAttempt, refuse, unwrapMath, type MathResult } from '../core/math-expression.ts';
import { admitRemixDocument, migrateV5ToV6, serializeRemixDocument, withDerivedGrainStyle,
  type RemixDocument, type RemixState } from '../core/remix-schema.ts';
import { remixNodeGroups, type RemixParameterGesture } from '../core/remix.ts';

/** Recipe actions share the scene's chronological history, without restoring analysis or paint. */
export type RecipeState = Omit<RemixState, 'drafts' | 'checkpoint'>;
export type RecipeHistoryEntry = { readonly kind: 'remix'; readonly key: null; readonly at: number;
  readonly before: RecipeState; readonly after: RecipeState };
export type AuthoringHistoryEntry = coreHistory.HistoryEntry | RecipeHistoryEntry;
export type AuthoringHistory = { readonly undo: readonly AuthoringHistoryEntry[]; readonly redo: readonly AuthoringHistoryEntry[] };
export const EMPTY_AUTHORING_HISTORY: AuthoringHistory = { undo: [], redo: [] };
export function isRecipeEntry(entry: AuthoringHistoryEntry): entry is RecipeHistoryEntry {
  return 'kind' in entry && entry.kind === 'remix';
}
function isCoreEntry(entry: AuthoringHistoryEntry): entry is coreHistory.HistoryEntry { return !isRecipeEntry(entry); }
export function recipeState(doc: RemixDocument): RecipeState {
  const { drafts: _drafts, checkpoint: _checkpoint, ...recipe } = doc.remix;
  return recipe;
}
export function remixDocument(doc: SceneDocument): MathResult<RemixDocument> {
  return doc.version === 5 ? migrateV5ToV6(doc) : admitRemixDocument(serializeRemixDocument(doc));
}
/** Draft text survives Undo without keeping an undone definition applied or owned. */
export function restoreRecipe(doc: SceneDocument, recipe: RecipeState, now = doc.updatedAt): MathResult<SceneDocument> {
  return mathAttempt(() => {
    const current = unwrapMath(remixDocument(doc));
    const functions = [...recipe.functions], blocks = [...recipe.blocks];
    const functionKeys = new Set(functions.map(mathRefKey)), blockKeys = new Set(blocks.map(mathRefKey));
    function retainFunction(ref: MathRef): void {
      if (functionKeys.has(mathRefKey(ref))) return;
      const fn = current.remix.functions.find(value => mathRefKey(value) === mathRefKey(ref));
      if (!fn) refuse('missing', 'A retained draft function revision is missing.', location(mathRefKey(ref)));
      functionKeys.add(mathRefKey(ref)); functions.push(fn);
      fn.dependencies.forEach(dependency => retainFunction(dependency.ref));
    }
    for (const layer of current.paint.layers) for (const patch of layer.patches) {
      if (blockKeys.has(mathRefKey(patch.brush))) continue;
      const block = current.remix.blocks.find(value => mathRefKey(value) === mathRefKey(patch.brush));
      if (!block) refuse('missing', 'A deposited brush revision is missing.', location(mathRefKey(patch.brush)));
      blockKeys.add(mathRefKey(block)); blocks.push(block);
      block.nodes.forEach(node => retainFunction(node.function));
    }
    const checkpoint = current.remix.checkpoint;
    let draftsChanged = false;
    const drafts = current.remix.drafts.map(draft => {
      let site = draft.site, base = draft.base;
      if (site !== null) {
        const instance = recipe.instances.find(value => value.id === site?.instance);
        const block = instance && blocks.find(value => mathRefKey(value) === mathRefKey(instance.block));
        if (site.kind === 'function') {
          const nodeId = site.node;
          const node = block && remixNodeGroups(block).find(group => group.id === nodeId)?.nodes[0];
          if (node) base = node.function;
          else { site = null; base = null; }
        } else if (!instance) site = null;
      }
      if (base !== null && !functionKeys.has(mathRefKey(base))) base = null;
      if (sameValue(base, draft.base) && sameValue(site, draft.site)) return draft;
      draftsChanged = true;
      return { ...draft, base, site, revision: checkpoint.draftRevision + 1 };
    });
    return withDerivedGrainStyle(unwrapMath(admitRemixDocument({ ...current, updatedAt: now, remix: { ...recipe, functions, blocks,
      ownership: recipe.ownership, drafts, checkpoint: { ...checkpoint, appliedRevision: checkpoint.appliedRevision + 1,
        draftRevision: checkpoint.draftRevision + Number(draftsChanged),
        checkpointRevision: checkpoint.checkpointRevision + 1 } } })));
  });
}
function trimHistory(undo: readonly AuthoringHistoryEntry[]): AuthoringHistory {
  return { undo: undo.slice(-coreHistory.HISTORY_LIMIT), redo: [] };
}
function legacyTail(history: AuthoringHistory): { readonly prefix: readonly AuthoringHistoryEntry[]; readonly history: coreHistory.History } {
  const split = history.undo.findLastIndex(isRecipeEntry) + 1;
  return { prefix: history.undo.slice(0, split), history: { undo: history.undo.slice(split).filter(isCoreEntry), redo: [] } };
}
export function pushAuthoringHistory(history: AuthoringHistory, entry: AuthoringHistoryEntry, doc: SceneDocument): AuthoringHistory {
  if (isRecipeEntry(entry)) return trimHistory([...history.undo, entry]);
  const tail = legacyTail(history);
  return trimHistory([...tail.prefix, ...coreHistory.push(tail.history, entry, doc).undo]);
}
export function recordAuthoringEdit(input: Omit<Parameters<typeof coreHistory.recordEdit>[0], 'history'> & { readonly history: AuthoringHistory }) {
  const tail = legacyTail(input.history), result = coreHistory.recordEdit({ ...input, history: tail.history });
  return { ...result, history: result.kind === 'applied' ? trimHistory([...tail.prefix, ...result.history.undo]) : input.history };
}
export function recordAuthoringSelection(input: Omit<Parameters<typeof coreHistory.recordSelection>[0], 'history'> & { readonly history: AuthoringHistory }): AuthoringHistory {
  if (sameValue(input.before, input.after)) return input.history;
  const tail = legacyTail(input.history);
  return trimHistory([...tail.prefix, ...coreHistory.recordSelection({ ...input, history: tail.history }).undo]);
}
export function authoringReferencedAssets(history: AuthoringHistory) {
  return coreHistory.referencedAssets({ undo: history.undo.filter(isCoreEntry), redo: history.redo.filter(isCoreEntry) });
}
export type AuthoringHistoryStep = (Omit<Extract<coreHistory.HistoryStep, { kind: 'document' }>, 'history'>
  | Omit<Extract<coreHistory.HistoryStep, { kind: 'selection' }>, 'history'>
  | { readonly kind: 'remix'; readonly recipe: RecipeState }) & { readonly history: AuthoringHistory };
export function stepAuthoringHistory(history: AuthoringHistory, direction: 'undo' | 'redo'): AuthoringHistoryStep | null {
  const entry = history[direction].at(-1);
  if (!entry) return null;
  const closed = (value: AuthoringHistoryEntry): AuthoringHistoryEntry => value.key === null ? value : { ...value, key: null };
  const remaining = history.undo.slice(0, -1), top = remaining.at(-1);
  const next: AuthoringHistory = direction === 'undo'
    ? { undo: top ? [...remaining.slice(0, -1), closed(top)] : [], redo: [...history.redo, entry] }
    : { undo: [...history.undo, closed(entry)], redo: history.redo.slice(0, -1) };
  if (isRecipeEntry(entry)) return { kind: 'remix', recipe: direction === 'undo' ? entry.before : entry.after, history: next };
  const step = direction === 'undo' ? coreHistory.undo({ undo: [entry], redo: [] }) : coreHistory.redo({ undo: [], redo: [entry] });
  return step === null ? null : { ...step, history: next };
}

export type OperationTarget =
  | { readonly kind: 'scene' }
  | { readonly kind: 'background' }
  | { readonly kind: 'layer'; readonly id: ObjectId }
  | { readonly kind: 'selection' };
export type CompareMode = 'edited' | 'source-photo' | 'treatments-off';
export type SampleMode = 'edited' | 'source';
/** C1 tools only; manual selection, transform and paint arrive with their consuming paths. */
export type Tool = 'select' | 'sample' | 'rectangle' | 'freehand' | 'navigate' | 'brush' | 'eraser';
export type ParameterValue = Extract<Edit, { kind: 'style' | 'fry' | 'surface' | 'motion' | 'symbols' }>;
export type GestureValue = ParameterValue | { readonly kind: 'color'; readonly color: Oklch | null }
  | { readonly kind: 'fill'; readonly color: Oklch | null } | { readonly kind: 'clipping'; readonly amount: number } | RemixParameterGesture;
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
  readonly interrupt?: (reason: 'tool-change') => void;
  readonly selection?: () => ActiveSelection;
  readonly localEdit?: (value: Extract<GestureValue, { kind: 'color' | 'fill' | 'clipping' }>, target: OperationTarget,
    previous: Extract<Edit, { kind: 'effect.set' }> | null) => Edit | null;
  readonly remix?: { readonly begin: () => symbol; readonly update: (token: symbol, value: RemixParameterGesture) => CommandResult;
    readonly commit: (token: symbol) => CommandResult; readonly cancel: (token: symbol) => void };
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
    readonly scene: SceneDocument['id']; readonly remixToken: symbol | null; edit: Edit | null; localIdentity: Extract<Edit, { kind: 'effect.set' }> | null } | null = null;

  function capability(input: { readonly operation: string; readonly target: OperationTarget }): Capability {
    const doc = host.read();
    if (doc === null) return { kind: 'unavailable', reason: 'Open a photo first.' };
    if (host.localEdit !== undefined && ['color', 'fill', 'clipping'].includes(input.operation)) {
      if (input.target.kind === 'scene') return { kind: 'unavailable', reason: 'This local operation requires a layer, Background or Selection.' };
      if (input.target.kind === 'selection') return host.selection?.() == null
        ? { kind: 'unavailable', reason: 'Create a selection first.' } : { kind: 'available' };
      if (input.target.kind === 'background') return { kind: 'available' };
      return doc.objects.some(object => object.id === (input.target as Extract<OperationTarget, {kind:'layer'}>).id)
        ? { kind: 'available' } : { kind: 'unavailable', reason: 'That layer is no longer in this photo.' };
    }
    if (input.operation === 'color') {
      if (input.target.kind !== 'layer') return { kind: 'unavailable', reason: 'Color currently requires a layer; Background and selection color arrive in C2.' };
      const id = input.target.id;
      return doc.objects.some((object) => object.id === id)
        ? { kind: 'available' } : { kind: 'unavailable', reason: 'That layer is no longer in this photo.' };
    }
    switch (input.operation) {
      case 'remix-parameter': return host.remix && input.target.kind === 'scene' ? { kind: 'available' }
        : { kind: 'unavailable', reason: 'Remix parameters require the photo rack.' };
      case 'style': case 'fry': case 'surface': case 'motion': case 'symbols':
        return input.target.kind === 'scene' ? { kind: 'available' }
          : { kind: 'unavailable', reason: 'This effect is Scene-only.' };
      default: return { kind: 'unavailable', reason: 'This operation is not available yet.' };
    }
  }
  function cancelGesture(token: GestureToken): void {
    if (gesture?.token !== token) return;
    const remixToken = gesture.remixToken;
    gesture = null; state = { ...state, gesture: null }; host.changed();
    if (remixToken !== null) host.remix?.cancel(remixToken);
  }
  function cancel(): void { if (gesture !== null) cancelGesture(gesture.token); }
  function setTarget(target: OperationTarget): CommandResult {
    const doc = host.read();
    if (doc === null) return { kind: 'refused', reason: 'Open a photo first.' };
    if (target.kind === 'layer' && !doc.objects.some((object) => object.id === target.id)) {
      return { kind: 'refused', reason: 'That layer is no longer in this photo.' };
    }
    if (target.kind === 'selection' && host.selection?.() == null) return { kind: 'refused', reason: 'There is no active selection.' };
    if (state.target.kind === target.kind && (target.kind !== 'layer' || (state.target.kind === 'layer' && state.target.id === target.id))) return { kind: 'unchanged' };
    cancel(); state = { ...state, target: { ...target } }; host.changed(); return { kind: 'applied' };
  }
  function setTool(tool: Tool): CommandResult {
    if (tool === state.tool) return { kind: 'unchanged' };
    host.interrupt?.('tool-change');
    cancel(); state = { ...state, tool }; host.changed(); return { kind: 'applied' };
  }
  function toEdit(value: GestureValue, target: OperationTarget, previous: Extract<Edit, { kind: 'effect.set' }> | null = null): Edit | null {
    if (value.kind === 'remix-parameter') return null;
    // C1's existing whole-layer color remains the sole writer of legacy recolor.
    if (value.kind === 'color' && target.kind === 'layer') return { kind: 'object.set', id: target.id,
      patch: { recolor: value.color === null ? { kind: 'none' } : { kind: 'target', color: value.color } } };
    if (value.kind === 'color' || value.kind === 'fill' || value.kind === 'clipping') {
      if (host.localEdit !== undefined) return host.localEdit(value, target, previous);
      if (value.kind !== 'color') return null;
    } else return value;
    return target.kind === 'layer' ? { kind: 'object.set', id: target.id,
      patch: { recolor: value.color === null ? { kind: 'none' } : { kind: 'target', color: value.color } } } : null;
  }
  function beginGesture(input: GestureStart): GestureToken | null {
    const doc = host.read();
    if (doc === null || capability(input).kind === 'unavailable') return null;
    cancel();
    const start = { ...input, target: { ...input.target } };
    const token = Symbol('authoring gesture');
    gesture = { token, start, scene: doc.id, remixToken: input.operation === 'remix-parameter' ? host.remix?.begin() ?? null : null,
      edit: null, localIdentity: null };
    state = { ...state, gesture: start }; host.changed(); return token;
  }
  function updateGesture(input: GestureUpdate): CommandResult {
    const current = gesture, doc = host.read();
    if (current === null || current.token !== input.token || doc?.id !== current.scene) return { kind: 'cancelled' };
    if (input.value.kind !== current.start.operation) return { kind: 'refused', reason: 'The value belongs to another tool.' };
    const available = capability(current.start);
    if (available.kind === 'unavailable') return { kind: 'refused', reason: available.reason };
    if (input.value.kind === 'remix-parameter') return current.remixToken !== null && host.remix
      ? host.remix.update(current.remixToken, input.value) : { kind: 'cancelled' };
    const edit = toEdit(input.value, current.start.target, current.localIdentity);
    if (edit === null) return { kind: 'refused', reason: 'The target cannot receive this edit.' };
    const result = applyEdit(doc, edit, doc.updatedAt);
    if (result.kind === 'refused') return { kind: 'refused', reason: result.detail };
    // Each update is the complete value/patch since begin, evaluated against the committed doc.
    current.edit = structuredClone(edit);
    if (edit.kind === 'effect.set' && edit.value !== null) current.localIdentity = structuredClone(edit);
    host.changed(); return { kind: result.kind };
  }
  function commitGesture(token: GestureToken): CommandResult {
    const current = gesture;
    if (current === null || current.token !== token || host.read()?.id !== current.scene) return { kind: 'cancelled' };
    gesture = null; state = { ...state, gesture: null };
    const result = current.remixToken !== null && host.remix ? host.remix.commit(current.remixToken)
      : current.edit === null ? { kind: 'unchanged' } satisfies CommandResult : host.record(current.edit);
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
      const target = (state.target.kind === 'layer' && !exists(state.target.id)) || (state.target.kind === 'selection' && host.selection?.() == null)
        ? { kind: 'scene' } satisfies OperationTarget : state.target;
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
