// The undo history: a bounded stack of undo entries and a stack of redo
// entries, each entry the edits that redo a step and the edits that undo it.
// Document edits and selection operations share it; products and dropped
// sources never enter it. The history
// is never persisted; the session holds it while a scene is open.
// Pure: no browser global, no Node API, no I/O, no clock. Times arrive as
// arguments, in milliseconds on any clock that does not go backwards.

import type { Edit, EditResult } from './edits.ts';
import { sameValue } from './equal.ts';
import type { AssetId, NonEmpty } from './ids.ts';
import { applyEdit, applyEdits } from './reduce.ts';
import type { ActiveSelection, SceneDocument } from './types.ts';
import type { Plane } from './raster.ts';
import { activeSelectionSchema } from './selection.ts';

/** The most entries the undo stack holds; pushing one more drops the oldest. */
export const HISTORY_LIMIT = 50;

/** Two consecutive edits with one coalescing key, at most this many milliseconds apart, form one undo step. */
export const COALESCE_WINDOW_MS = 600;

/**
 * One undo step. `key` is the coalescing key of the edits it holds, or null
 * for a step that never takes in another, which is also what an entry's key
 * becomes once an undo or a redo has passed it; `at` is when its last edit was
 * applied. `forward` redoes the step and `inverse` undoes it; a step that
 * took in later edits keeps its first inverse and its last forward.
 */
export type SelectionTransition = { readonly before: ActiveSelection; readonly after: ActiveSelection };
export type DocumentHistoryEntry = {
  readonly key: string | null;
  readonly at: number;
  readonly forward: NonEmpty<Edit>;
  readonly inverse: NonEmpty<Edit>;
  /** Session-owned mask products, shared with the active store while this step is retained. */
  readonly masks?: ReadonlyMap<AssetId, Plane<'u8'>>;
  readonly selection?: SelectionTransition;
};
export type SelectionHistoryEntry = {
  readonly kind: 'selection'; readonly key: null; readonly at: number;
  readonly selection: SelectionTransition;
  readonly masks?: ReadonlyMap<AssetId, Plane<'u8'>>;
};
export type HistoryEntry = DocumentHistoryEntry | SelectionHistoryEntry;

/** Both stacks list their entries oldest first, so the last entry of each is the next to undo or redo. */
export type History = { readonly undo: readonly HistoryEntry[]; readonly redo: readonly HistoryEntry[] };

/** What undoing or redoing a step applies, with `applyEdits`, and the history once it has. */
export type HistoryStep =
  | { readonly kind: 'document'; readonly edits: NonEmpty<Edit>; readonly selection?: ActiveSelection; readonly history: History }
  | { readonly kind: 'selection'; readonly selection: ActiveSelection; readonly history: History };

export const EMPTY_HISTORY: History = { undo: [], redo: [] };

/** A public action is its own step unless a legacy caller explicitly supplies a key. */
export function recordEdit(input: {
  readonly doc: SceneDocument; readonly history: History; readonly edit: Edit;
  readonly now: string; readonly at: number; readonly key?: string | null;
  readonly masks?: ReadonlyMap<AssetId, Plane<'u8'>>;
  readonly selection?: SelectionTransition;
}): EditResult & { readonly history: History } {
  const result = applyEdit(input.doc, input.edit, input.now);
  if (result.kind !== 'applied') return { ...result, history: input.history };
  const masks = new Map<AssetId, Plane<'u8'>>();
  for (const asset of editAssets([input.edit, ...result.inverse])) {
    const mask = input.masks?.get(asset);
    if (mask !== undefined) masks.set(asset, mask);
  }
  for (const selection of [input.selection?.before, input.selection?.after]) {
    if (selection === null || selection === undefined) continue;
    const mask = input.masks?.get(selection.mask.plane.asset);
    if (mask !== undefined) masks.set(selection.mask.plane.asset, mask);
  }
  return { ...result, history: push(input.history, {
    key: input.key ?? null, at: input.at, forward: [input.edit], inverse: result.inverse, masks,
    ...(input.selection === undefined ? {} : { selection: frozenSelectionTransition(input.selection) }),
  }, result.doc) };
}

function frozenSelectionTransition(value: SelectionTransition): SelectionTransition {
  return Object.freeze({ before: activeSelectionSchema.parse(value.before), after: activeSelectionSchema.parse(value.after) });
}

/** A completed selection operation shares the chronological 50-step history. */
export function recordSelection(input: {
  readonly doc: SceneDocument; readonly history: History; readonly before: ActiveSelection;
  readonly after: ActiveSelection; readonly at: number; readonly masks?: ReadonlyMap<AssetId, Plane<'u8'>>;
}): History {
  if (sameValue(input.before, input.after)) return input.history;
  const selection = frozenSelectionTransition(input);
  const masks = new Map<AssetId, Plane<'u8'>>();
  for (const root of [selection.before, selection.after]) {
    if (root === null) continue;
    const mask = input.masks?.get(root.mask.plane.asset);
    if (mask !== undefined) masks.set(root.mask.plane.asset, mask);
  }
  return push(input.history, { kind: 'selection', key: null, at: input.at, selection, masks }, input.doc);
}

/**
 * The key under which consecutive edits coalesce into one undo step, or null
 * for an edit that is always a step of its own.
 * - `title`: `title`.
 * - `style`, `symbols`, `motion`, `lighting` with a one-field patch:
 *   `<kind>:<field>`, such as `style:saturation`, so two sliders keep their
 *   own steps.
 * - `fry`: `fry`.
 * - `palette.target`: `palette.target:<cluster>`, so each swatch keeps its
 *   own steps; `String(-0)` is `0`, so -0 and 0 share the key of cluster 0.
 * - `object.set` with a one-field patch: `object.set:<id>:<field>`, except a
 *   patch that sets the object's motion to none, which is null: the step
 *   before it may have turned the scene's motion on, and its forward alone
 *   would not redo that.
 * - `light.set` with a one-field patch: `light.set:<id>:<field>`.
 * - A patch of several fields or none, `object.add`, `object.refine`,
 *   `object.remove`, `light.add`, and `light.remove`: null.
 * Every edit under one key sets the same fields, and sets them to the same
 * stored value whatever they held before, so the last forward of a coalesced
 * step redoes all of it.
 */
export function coalesceKey(edit: Edit): string | null {
  switch (edit.kind) {
    case 'title':
    case 'fry':
      return edit.kind;
    case 'style':
    case 'symbols':
    case 'motion':
    case 'surface':
    case 'lighting': {
      const field = onlyKey(edit.patch);
      return field === null ? null : `${edit.kind}:${field}`;
    }
    case 'palette.target':
      return `palette.target:${String(edit.cluster)}`;
    case 'object.set': {
      const field = onlyKey(edit.patch);
      if (field === null || edit.patch.motion?.kind === 'none') return null;
      return `object.set:${edit.id}:${field}`;
    }
    case 'light.set': {
      const field = onlyKey(edit.patch);
      return field === null ? null : `light.set:${edit.id}:${field}`;
    }
    case 'object.add':
    case 'object.refine':
    case 'object.remove':
    case 'object.rename':
    case 'object.hide':
    case 'object.show':
    case 'light.add':
    case 'light.remove':
    case 'layer.add': case 'layer.remove': case 'layer.placement': case 'layer.opacity': case 'layer.coverage': case 'layer.depth':
    case 'source.add': case 'source.remove': case 'removal.set': case 'effect.set': case 'compositing':
      return null;
    default: {
      const unhandled: never = edit;
      return unhandled;
    }
  }
}

/** The one key of a patch, or null for a patch of none or several. */
function onlyKey(patch: object): string | null {
  const keys = Object.keys(patch);
  const [only] = keys;
  return keys.length === 1 && only !== undefined ? only : null;
}

/**
 * Records a step the owner just took: `entry` holds the applied edit as its
 * forward list, the inverse `applyEdit` returned, the edit's coalescing key,
 * and the time, and `doc` is the document that edit produced. The redo stack
 * is cleared. When the last undo entry has the same non-null key and
 * `entry.at` is 0 to COALESCE_WINDOW_MS after its `at`, the two become one
 * entry with the earlier inverse, the later forward, and the later time; if
 * that inverse would leave `doc` unchanged, because the edits returned their
 * fields to where they started, the entry is dropped instead, so no step that
 * undoes nothing stays on the stack, and the entry it leaves on top is closed
 * as `undo` closes one, so the next edit does not join a step taken before
 * the dropped one. Otherwise `entry` is added, and past
 * HISTORY_LIMIT entries the oldest is dropped. Push only an edit `applyEdit`
 * answered `applied`: an unchanged one has no inverse and is no step.
 */
export function push(history: History, entry: HistoryEntry, doc: SceneDocument): History {
  const last = history.undo.at(-1);
  if (last !== undefined && !isSelectionEntry(last) && !isSelectionEntry(entry) && coalesces(last, entry)) {
    const rest = history.undo.slice(0, -1);
    // Only the kind of the result is read, so the time stamped is immaterial.
    if (applyEdits(doc, last.inverse, doc.updatedAt).kind === 'unchanged') return { undo: closeTop(rest), redo: [] };
    const merged: HistoryEntry = { key: last.key, at: entry.at, forward: entry.forward, inverse: last.inverse,
      ...(last.masks === undefined && entry.masks === undefined ? {} : { masks: new Map([...(last.masks ?? []), ...(entry.masks ?? [])]) }) };
    return { undo: [...rest, merged], redo: [] };
  }
  const undo = [...history.undo, entry];
  return { undo: undo.length > HISTORY_LIMIT ? undo.slice(undo.length - HISTORY_LIMIT) : undo, redo: [] };
}

function isSelectionEntry(entry: HistoryEntry): entry is SelectionHistoryEntry {
  return 'kind' in entry && entry.kind === 'selection';
}

function coalesces(last: DocumentHistoryEntry, entry: DocumentHistoryEntry): boolean {
  const gap = entry.at - last.at;
  return last.selection === undefined && entry.selection === undefined && last.key !== null && last.key === entry.key && gap >= 0 && gap <= COALESCE_WINDOW_MS;
}

/**
 * The step Cmd-Z takes, or null when there is nothing to undo: the last undo
 * entry's inverse, and the history with that entry moved onto the redo stack.
 * The caller applies `edits` with `applyEdits` and keeps `history`. The entry
 * left on top of the undo stack is closed, its key set to null, so the next
 * edit starts a step of its own rather than joining one taken before the undo.
 */
export function undo(history: History): HistoryStep | null {
  const entry = history.undo.at(-1);
  if (entry === undefined) return null;
  const next = { undo: closeTop(history.undo.slice(0, -1)), redo: [...history.redo, entry] };
  return isSelectionEntry(entry) ? { kind: 'selection', selection: entry.selection.before, history: next }
    : { kind: 'document', edits: entry.inverse, history: next,
      ...(entry.selection === undefined ? {} : { selection: entry.selection.before }) };
}

/**
 * The step redo takes, or null when there is nothing to redo: the last redo
 * entry's forward, and the history with that entry moved back onto the undo
 * stack, closed as `undo` closes the entry it leaves on top.
 */
export function redo(history: History): HistoryStep | null {
  const entry = history.redo.at(-1);
  if (entry === undefined) return null;
  const next = { undo: [...history.undo, closed(entry)], redo: history.redo.slice(0, -1) };
  return isSelectionEntry(entry) ? { kind: 'selection', selection: entry.selection.after, history: next }
    : { kind: 'document', edits: entry.forward, history: next,
      ...(entry.selection === undefined ? {} : { selection: entry.selection.after }) };
}

/** The stack with its top entry closed, so no later edit coalesces into it. */
function closeTop(stack: readonly HistoryEntry[]): readonly HistoryEntry[] {
  const top = stack.at(-1);
  return top === undefined ? stack : [...stack.slice(0, -1), closed(top)];
}

function closed(entry: HistoryEntry): HistoryEntry {
  return entry.key === null ? entry : { ...entry, key: null };
}

/**
 * Every asset named by a retained edit or selection root on either stack.
 * Inverses retain removed layers, source images, effects, and removals.
 * The session keeps these bytes while their undo or redo step is reachable.
 */
export function referencedAssets(history: History): ReadonlySet<AssetId> {
  const assets = new Set<AssetId>();
  for (const entry of [...history.undo, ...history.redo]) {
    if (!isSelectionEntry(entry)) for (const asset of editAssets([...entry.forward, ...entry.inverse])) assets.add(asset);
    for (const selection of [entry.selection?.before, entry.selection?.after]) {
      if (selection !== null && selection !== undefined) assets.add(selection.mask.plane.asset);
    }
  }
  return assets;
}

/** Referenced bytes only; historical provenance hashes are not assets. */
function editAssets(edits: readonly Edit[]): ReadonlySet<AssetId> {
  const assets = new Set<AssetId>();
  for (const edit of edits) {
    switch (edit.kind) {
      case 'object.add': case 'layer.add': {
        const layer = edit.kind === 'object.add' ? edit.object : edit.layer;
        assets.add(layer.produced.mask.asset);
        if (layer.depthAttachment.kind === 'source') assets.add(layer.depthAttachment.map.asset);
        break;
      }
      case 'object.refine': assets.add(edit.produced.mask.asset); break;
      case 'layer.coverage': assets.add(edit.value.mask.asset); break;
      case 'layer.depth': if (edit.value.kind === 'source') assets.add(edit.value.map.asset); break;
      case 'source.add': assets.add(edit.source.image.asset); break;
      case 'removal.set': if (edit.value !== null) assets.add(edit.value.mask.plane.asset); break;
      case 'effect.set': if (edit.value?.scope.kind === 'mask') assets.add(edit.value.scope.mask.plane.asset); break;
      default: break;
    }
  }
  return assets;
}
