// The scene document's numeric ranges, lower bounds, and length bounds, in three
// tables keyed by field path. core/schema.ts reads every numeric bound and every
// string and array length bound from here, and code that clamps a field or
// builds its slider looks the field up by its path, clampToRange doing the
// clamping; test/schema.test.ts checks that every bound of the schema matches
// an entry and that no entry is unused.
// Pure: no browser global, no Node API, no I/O.

/** `integer` takes whole numbers only, `even-integer` even whole numbers only. */
export type NumberKind = 'real' | 'integer' | 'even-integer';

/**
 * Inclusive at both ends, unless `minExclusive` makes the minimum exclusive:
 * then the field must lie above `min`. For an `even-integer` both ends are even.
 */
export type NumberRange = { readonly min: number; readonly max: number; readonly kind: NumberKind; readonly minExclusive?: true };

/** An inclusive lower bound on a measured value with no upper bound, which no slider sets. */
export type NumberFloor = { readonly min: number; readonly kind: 'real' | 'integer' };

/**
 * Inclusive bounds on an array's length, or on a string's length in Unicode code
 * points, as zod counts it and `[...text].length` counts it: a character outside
 * the Basic Multilingual Plane, such as an emoji, is one code point and two
 * UTF-16 code units of `text.length`.
 */
export type LengthRange = { readonly min: number; readonly max: number };

const unit = { min: 0, max: 1, kind: 'real' } as const satisfies NumberRange;
const hue = { min: 0, max: 360, kind: 'real' } as const satisfies NumberRange;
const lightness = unit;
/** A target color's chroma: up to 0.4, above the largest Oklch chroma of any sRGB color (about 0.32, pure magenta). */
const targetChroma = { min: 0, max: 0.4, kind: 'real' } as const satisfies NumberRange;
const masterSide = { min: 2, max: 2048, kind: 'even-integer' } as const satisfies NumberRange;
const tapCoordinate = unit;
const candidate = { min: 0, max: 2, kind: 'integer' } as const satisfies NumberRange;

/**
 * Every bounded numeric field of the scene document, keyed by its path: object
 * keys joined by dots, and `[]` for every element of an array.
 * A field inside a union arm has one path for every arm that holds it.
 */
export const RANGES = {
  seed: { min: 0, max: 0xffff_ffff, kind: 'integer' },
  'frame.master.size.width': masterSide,
  'frame.master.size.height': masterSide,

  'analysis.colors[].weight': { min: 0, max: 1, kind: 'real', minExclusive: true },
  'analysis.depth.stats.p10': unit,
  'analysis.depth.stats.median': unit,
  'analysis.depth.stats.p90': unit,

  'style.fry': unit,
  'style.colors': { min: 2, max: 12, kind: 'integer' },
  'style.saturation': unit,
  'style.harmony.strength': unit,
  'style.paletteTargets[].cluster': { min: 0, max: 15, kind: 'integer' },
  'style.paletteTargets[].color.l': lightness,
  'style.paletteTargets[].color.c': targetChroma,
  'style.paletteTargets[].color.h': hue,
  'style.bands': { min: 2, max: 6, kind: 'integer' },
  'style.simplify': unit,
  'style.outline': unit,
  'style.subjectClarity': unit,
  'style.grain': unit,
  'style.colorNoise': unit,
  'style.grainSize': { min: 1, max: 4, kind: 'integer' },
  'style.grainHold': { min: 1, max: 3, kind: 'integer' },
  'style.crunch': unit,
  'style.clipping': unit,

  'symbols.cellSize': { min: 6, max: 48, kind: 'even-integer' },
  'symbols.amount': unit,

  'surface.relief': unit,
  'surface.refraction': unit,
  'surface.shine': unit,
  'surface.scale': unit,

  'motion.drift.amount': unit,
  'motion.parallax': { min: 0.5, max: 3, kind: 'real' },
  'motion.loopSeconds': { min: 2, max: 6, kind: 'real' },
  'motion.focus': unit,

  'lighting.ambient': unit,
  'lighting.relief': { min: 0.25, max: 4, kind: 'real' },

  'objects[].recolor.color.l': lightness,
  'objects[].recolor.color.c': targetChroma,
  'objects[].recolor.color.h': hue,
  'objects[].motion.amount': unit,
  'objects[].thickness': { min: 0.05, max: 2, kind: 'real' },
  'objects[].produced.selection.points[].at.x': tapCoordinate,
  'objects[].produced.selection.points[].at.y': tapCoordinate,
  'objects[].produced.selection.seed.at.x': tapCoordinate,
  'objects[].produced.selection.seed.at.y': tapCoordinate,
  'objects[].produced.selection.candidate': candidate,
  'objects[].produced.depth.p10': unit,
  'objects[].produced.depth.median': unit,
  'objects[].produced.depth.p90': unit,
  'objects[].produced.color.clusters[].weight': unit,

  'lights[].at.x': { min: -0.5, max: 1.5, kind: 'real' },
  'lights[].at.y': { min: -0.5, max: 1.5, kind: 'real' },
  'lights[].depth': unit,
  'lights[].color.l': lightness,
  'lights[].color.c': { min: 0, max: 0.25, kind: 'real' },
  'lights[].color.h': hue,
  'lights[].intensity': { min: 0, max: 2, kind: 'real' },
  'lights[].radius': { min: 0.05, max: 2, kind: 'real' },
  'lights[].rays': unit,
  'lights[].softness': unit,
} as const satisfies Readonly<Record<string, NumberRange>>;

export type RangePath = keyof typeof RANGES;

const pixelCount = { min: 1, kind: 'integer' } as const satisfies NumberFloor;
const masterPixels = { min: 0, kind: 'real' } as const satisfies NumberFloor;

/** Every numeric field of the scene document bounded below only, keyed by path as in RANGES. */
export const FLOORS = {
  'frame.source.byteLength': { min: 0, kind: 'integer' },
  'frame.original.size.width': pixelCount,
  'frame.original.size.height': pixelCount,
  'analysis.depth.map.size.width': pixelCount,
  'analysis.depth.map.size.height': pixelCount,
  'analysis.plate.image.size.width': pixelCount,
  'analysis.plate.image.size.height': pixelCount,
  'objects[].produced.mask.size.width': pixelCount,
  'objects[].produced.mask.size.height': pixelCount,
  'objects[].produced.bounds.x': masterPixels,
  'objects[].produced.bounds.y': masterPixels,
  'objects[].produced.bounds.width': masterPixels,
  'objects[].produced.bounds.height': masterPixels,
} as const satisfies Readonly<Record<string, NumberFloor>>;

export type FloorPath = keyof typeof FLOORS;

/**
 * Every bounded string and array of the scene document, keyed by path as in
 * RANGES. A non-empty array the type declares as `NonEmpty<T>` has its minimum
 * of one from that type, and is listed here only when it has a maximum too.
 */
export const LENGTHS = {
  title: { min: 1, max: 80 },
  'frame.original.name': { min: 0, max: 255 },
  'analysis.colors': { min: 1, max: 16 },
  'style.paletteTargets': { min: 0, max: 16 },
  objects: { min: 0, max: 32 },
  'objects[].name': { min: 1, max: 80 },
  'objects[].produced.color.clusters': { min: 2, max: 3 },
  lights: { min: 0, max: 4 },
} as const satisfies Readonly<Record<string, LengthRange>>;

export type LengthPath = keyof typeof LENGTHS;

/** A RANGES path whose minimum is inclusive: every field a clamp can bring into range, since no value sits just above an exclusive minimum. */
export type ClampPath = { [P in RangePath]: (typeof RANGES)[P] extends { readonly minExclusive: true } ? never : P }[RangePath];

/**
 * `value` brought into RANGES[path]: rounded to a whole number for an
 * `integer` entry and to an even one for an `even-integer` entry, then held
 * between the ends. A value already in range and on its grid is returned as it
 * is, so -0 stays -0. `value` must be finite; NaN has no nearest value in range.
 */
export function clampToRange(path: ClampPath, value: number): number {
  const range: NumberRange = RANGES[path];
  const { min, max, kind } = range;
  let onGrid: number;
  switch (kind) {
    case 'real':
      onGrid = value;
      break;
    case 'integer':
      onGrid = Math.round(value);
      break;
    case 'even-integer':
      onGrid = 2 * Math.round(value / 2);
      break;
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
  if (onGrid === value && value >= min && value <= max) return value;
  return Math.min(max, Math.max(min, onGrid));
}
