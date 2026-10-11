// The values a new scene, a new object, and a new light start with. They are
// written into the document when it is made, so changing one here later never
// changes a saved scene. Ids, the time, and the seed arrive as arguments:
// nothing here mints an id, reads a clock, or draws a random number.
// Pure: no browser global, no Node API, no I/O.

import type { BuildId, LightId, ObjectId, SceneId } from './ids.ts';
import { LEGACY_COMPOSITING_POLICY } from './composition-ranges.ts';
import type { ImagePoint } from './raster.ts';
import type { Analysis, Frame, Light, Lighting, Motion, ObjectProduced, SceneDocument, SceneObject, Style, Symbols, Surface } from './types.ts';

/**
 * The style a new scene starts with: the macro dial at 0.6, and the eight
 * fields that dial sets at that position stored beside it.
 */
export function defaultStyle(): Style {
  return {
    fry: 0.6,
    colors: 7,
    saturation: 0.62,
    harmony: { kind: 'auto', strength: 0.5 },
    paletteTargets: [],
    bands: 4,
    simplify: 0.52,
    outline: 0.4,
    subjectClarity: 0.6,
    grain: 0.52,
    colorNoise: 0.32,
    grainSize: 2,
    grainHold: 2,
    crunch: 0.42,
    clipping: 0.3,
  };
}

/** Symbols start off. */
export function defaultSymbols(): Symbols {
  return { enabled: false, cellSize: 12, amount: 0.3 };
}

/** The refracting surface starts off, with all four dials at their midpoint. */
export function defaultSurface(): Surface {
  return { enabled: false, pattern: 'bars', relief: 0.5, refraction: 0.5, shine: 0.5, scale: 0.5 };
}

/** Motion starts off; `focus` null follows the subject, or the frame. */
export function defaultMotion(): Motion {
  return { enabled: false, drift: { direction: 'side', amount: 0.6 }, parallax: 2, loopSeconds: 3, focus: null };
}

export function defaultLighting(): Lighting {
  return { ambient: 0.7, relief: 1 };
}

/** What a new scene is made from: the import's results and the values `core` cannot make itself. */
export type NewDocumentInput = {
  readonly id: SceneId;
  readonly title: string;
  /** ISO 8601 in UTC: both `createdAt` and `updatedAt`. */
  readonly now: string;
  /** A uint32 the caller drew. */
  readonly seed: number;
  readonly frame: Frame;
  readonly analysis: Analysis;
  readonly writer: BuildId;
  /** The importing browser's user agent. */
  readonly importedOn: string;
};

/**
 * A new baseline scene, with the default style, symbols,
 * motion, and lighting, and no objects or lights. It is not validated here;
 * the caller's parse is what checks it.
 */
export function newDocument(input: NewDocumentInput): SceneDocument {
  return {
    format: 'noisy-scene',
    // Remix activation upgrades on write; opening/importing a photo preserves
    // the frozen composition path until its session integration is activated.
    version: 5,
    id: input.id,
    title: input.title,
    createdAt: input.now,
    updatedAt: input.now,
    seed: input.seed,
    frame: input.frame,
    analysis: input.analysis,
    style: defaultStyle(),
    symbols: defaultSymbols(),
    surface: defaultSurface(),
    motion: defaultMotion(),
    lighting: defaultLighting(),
    objects: [],
    sources: [],
    removals: [],
    localEffects: [],
    compositing: LEGACY_COMPOSITING_POLICY,
    lights: [],
    provenance: { writer: input.writer, importedOn: input.importedOn },
  };
}

/** `Object N` for the smallest N from 1 up that no object in `existing` is named. */
export function nextObjectName(existing: readonly Pick<SceneObject, 'name'>[]): string {
  const taken = new Set(existing.map((object) => object.name));
  let n = 1;
  while (taken.has(`Object ${n}`)) n++;
  return `Object ${n}`;
}

/**
 * A new object over what analysis produced for it, named after the scene's
 * existing objects. `subject` starts false: making the first object the
 * subject when the scene has none is left to the edit that adds it.
 */
export function newObject(input: { readonly id: ObjectId; readonly produced: ObjectProduced; readonly existing: readonly SceneObject[] }): SceneObject {
  const bounds = input.produced.bounds;
  const placement = { translate: { x: 0, y: 0 }, pivot: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }, scale: 1, rotation: 0 };
  return {
    id: input.id,
    name: nextObjectName(input.existing),
    hidden: false,
    subject: false,
    recolor: { kind: 'none' },
    symbols: 'slider',
    motion: { kind: 'none' },
    thickness: 0.3,
    produced: input.produced,
    content: { kind: 'source', source: { kind: 'photo' } },
    origin: { kind: 'photo-region' },
    placement,
    home: placement,
    opacity: 1,
    depthAttachment: { kind: 'plane', disparity: input.produced.depth?.median ?? .5 },
  };
}

/** A new light at `at`: a near, soft, white key light with visible rays and shadows on. */
export function newLight(input: { readonly id: LightId; readonly at: ImagePoint }): Light {
  return {
    id: input.id,
    at: input.at,
    depth: 0.8,
    color: { l: 0.95, c: 0, h: 0 },
    intensity: 1,
    radius: 0.6,
    rays: 0.3,
    shadows: true,
    softness: 0.3,
  };
}
