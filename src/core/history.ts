// The undo history: a bounded stack of undo entries and a stack of redo
// entries, each entry the edits that redo a step and the edits that undo it.
// Only edits enter it: a product or a dropped source never does. The history
// is never persisted; the session holds it while a scene is open.
// Pure: no browser global, no Node API, no I/O, no clock. Times arrive as
// arguments, in milliseconds on any clock that does not go backwards.

import type { Edit } from './edits.ts';
import type { AssetId, NonEmpty } from './ids.ts';
import { applyEdits } from './reduce.ts';
import type { SceneDocument } from './types.ts';
import type { Plane } from './raster.ts';

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
export type HistoryEntry = {
  readonly key: string | null;
  readonly at: number;
  readonly forward: NonEmpty<Edit>;
  readonly inverse: NonEmpty<Edit>;
  /** Session-owned mask products, released from the active store on deletion. */
  readonly masks?: ReadonlyMap<AssetId, Plane<'u8'>>;
};

/** Both stacks list their entries oldest first, so the last entry of each is the next to undo or redo. */
export type History = { readonly undo: readonly HistoryEntry[]; readonly redo: readonly HistoryEntry[] };

/** What undoing or redoing a step applies, with `applyEdits`, and the history once it has. */
export type HistoryStep = { readonly edits: NonEmpty<Edit>; readonly history: History };

export const EMPTY_HISTORY: History = { undo: [], redo: [] };

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
  if (last !== undefined && coalesces(last, entry)) {
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

function coalesces(last: HistoryEntry, entry: HistoryEntry): boolean {
  const gap = entry.at - last.at;
  return last.key !== null && last.key === entry.key && gap >= 0 && gap <= COALESCE_WINDOW_MS;
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
  return { edits: entry.inverse, history: { undo: closeTop(history.undo.slice(0, -1)), redo: [...history.redo, entry] } };
}

/**
 * The step redo takes, or null when there is nothing to redo: the last redo
 * entry's forward, and the history with that entry moved back onto the undo
 * stack, closed as `undo` closes the entry it leaves on top.
 */
export function redo(history: History): HistoryStep | null {
  const entry = history.redo.at(-1);
  if (entry === undefined) return null;
  return { edits: entry.forward, history: { undo: [...history.undo, closed(entry)], redo: history.redo.slice(0, -1) } };
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
 * Every asset a mask in the history names: the mask of each `object.add` and
 * each `object.refine` in any entry's forward or inverse list, on either
 * stack. The inverse of an `object.remove` is an `object.add`, so a removed
 * object's mask is among them. The session keeps these assets cached and
 * stored while the scene is open, so any undo or redo finds its mask.
 */
export function referencedAssets(history: History): ReadonlySet<AssetId> {
  const assets = new Set<AssetId>();
  for (const entry of [...history.undo, ...history.redo]) {
    for (const edit of [...entry.forward, ...entry.inverse]) {
      if (edit.kind === 'object.add') assets.add(edit.object.produced.mask.asset);
      else if (edit.kind === 'object.refine') assets.add(edit.produced.mask.asset);
    }
  }
  return assets;
}
