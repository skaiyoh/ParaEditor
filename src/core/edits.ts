// What changes a scene document: the owner's edits, which are undoable, and
// analysis products, which the analysis driver applies and which never enter
// the undo history. core/reduce.ts applies edits, core/produce.ts applies
// products, and core/history.ts holds the undo history.
// Pure: no browser global, no Node API, no I/O.

import type { LightId, NonEmpty, ObjectId } from './ids.ts';
import type { Oklch } from './raster.ts';
import type { DepthProduct, DepthStats, Light, Lighting, Motion, ObjectProduced, PlateProduct, SceneDocument, SceneObject, Style, Symbols, Surface } from './types.ts';

/** A style patch may carry `fry`, so that a `fry` edit's inverse is one edit; palette targets have their own edit. */
export type StylePatch = Partial<Omit<Style, 'paletteTargets'>>;
/** Every field of an object but its id and what analysis produced for it. */
export type ObjectPatch = Partial<Omit<SceneObject, 'id' | 'produced'>>;
/** Every field of a light but its id. */
export type LightPatch = Partial<Omit<Light, 'id'>>;

/**
 * Where a removed object or light goes back to, carried only by the inverse of
 * its removal: the index it had, and no side effect of an add.
 */
export type Restore = { readonly index: number };

/** The owner's actions. Each has an inverse edit list, so each is undoable. */
export type Edit =
  | { readonly kind: 'title'; readonly title: string }
  | { readonly kind: 'style'; readonly patch: StylePatch }
  /** The macro dial: rewrites the eight fried style fields through fryCurve and stores `fry`. */
  | { readonly kind: 'fry'; readonly fry: number }
  | { readonly kind: 'symbols'; readonly patch: Partial<Symbols> }
  | { readonly kind: 'surface'; readonly patch: Partial<Surface> }
  | { readonly kind: 'motion'; readonly patch: Partial<Motion> }
  | { readonly kind: 'lighting'; readonly patch: Partial<Lighting> }
  /** Sets one palette target, or clears it when `color` is null. */
  | { readonly kind: 'palette.target'; readonly cluster: number; readonly color: Oklch | null }
  /** An object from a tap, its mask asset already stored; `restore` only on the inverse of `object.remove`. */
  | { readonly kind: 'object.add'; readonly object: SceneObject; readonly restore?: Restore }
  | { readonly kind: 'object.set'; readonly id: ObjectId; readonly patch: ObjectPatch }
  | { readonly kind: 'object.rename'; readonly id: ObjectId; readonly name: string }
  | { readonly kind: 'object.hide'; readonly id: ObjectId }
  | { readonly kind: 'object.show'; readonly id: ObjectId }
  /** A new selection and mask for an object, together. */
  | { readonly kind: 'object.refine'; readonly id: ObjectId; readonly produced: ObjectProduced }
  | { readonly kind: 'object.remove'; readonly id: ObjectId }
  /** `restore` only on the inverse of `light.remove`. */
  | { readonly kind: 'light.add'; readonly light: Light; readonly restore?: Restore }
  | { readonly kind: 'light.set'; readonly id: LightId; readonly patch: LightPatch }
  | { readonly kind: 'light.remove'; readonly id: LightId };

export type EditKind = Edit['kind'];

/** Analysis results, applied by the analysis driver and never on the undo history. */
export type Produce =
  | { readonly kind: 'depth'; readonly depth: DepthProduct }
  | { readonly kind: 'plate'; readonly plate: PlateProduct }
  | { readonly kind: 'object.depth'; readonly id: ObjectId; readonly depth: DepthStats }
  /** Sets `analysis.autoSubject` to done; adds the object as the subject, or nothing when null. */
  | { readonly kind: 'auto-subject'; readonly found: SceneObject | null };

/**
 * Why an edit changed nothing:
 * - `invalid`: a value of the wrong type, a string of the wrong length, an
 *   unknown key inside a value (a harmony, a color, an added object or light),
 *   or anything else the document's schema refuses (`detail` lists the paths);
 * - `unknown-key`: a patch has a key that is not a field it may set, `id` and
 *   `produced` of an object, `id` of a light, and `paletteTargets` of the
 *   style among them;
 * - `non-finite`: a number the reducer clamps, a palette target's cluster, or
 *   a restoring add's index is NaN or infinite (one inside an object's
 *   `produced`, which is not clamped, is `invalid`);
 * - `unknown-id`: no object or light has the id;
 * - `duplicate-id`: an object or light with the added one's id exists;
 * - `limit`: the scene already has the most objects or lights it may hold;
 * - `out-of-range`: a palette target's cluster is not a whole number below
 *   `analysis.colors.length`.
 */
export type RefusalReason = 'invalid' | 'unknown-key' | 'non-finite' | 'unknown-id' | 'duplicate-id' | 'limit' | 'out-of-range';

export type Refusal = { readonly reason: RefusalReason; readonly detail: string };

/**
 * What applying an edit, or a list of them, did. An applied edit returns the
 * new document, `updatedAt` stamped, and the inverse list that undoes it. An
 * edit that leaves every field it sets as it was, and sets off no side effect,
 * is unchanged: the result holds the input document itself, unstamped, and no
 * inverse, so it belongs on no undo history and needs no save. A refused one
 * returns the input document itself, unchanged and unstamped, and why; it has
 * no inverse either.
 */
export type EditResult =
  | { readonly kind: 'applied'; readonly doc: SceneDocument; readonly inverse: NonEmpty<Edit> }
  | { readonly kind: 'unchanged'; readonly doc: SceneDocument }
  | ({ readonly kind: 'refused'; readonly doc: SceneDocument } & Refusal);

/**
 * What applying a product did. Applied, the result holds the new document
 * with `updatedAt` stamped. A product the document has moved past, or one
 * that would leave the document as it is, is unchanged: the result holds the
 * input document itself, unstamped. A product whose value the document's
 * schema refuses is refused, with the input document itself and the failing
 * paths. A product never has an inverse.
 */
export type ProduceResult =
  | { readonly kind: 'applied'; readonly doc: SceneDocument }
  | { readonly kind: 'unchanged'; readonly doc: SceneDocument }
  | { readonly kind: 'refused'; readonly doc: SceneDocument; readonly detail: string };
