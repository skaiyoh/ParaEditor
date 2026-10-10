// The Fry curve: the macro dial's mapping from one number in 0..1 to the eight
// style fields it sets. The `fry` edit writes the curve's values into the
// document as absolute numbers, so a stored scene never depends on the curve,
// and changing the curve later changes no saved scene.
// Pure: no browser global, no Node API, no I/O.

import { clampToRange } from './ranges.ts';
import type { Style } from './types.ts';

/** The eight style fields the macro dial sets, in the order the curve lists them. */
export const FRIED_FIELDS = ['colors', 'saturation', 'simplify', 'bands', 'grain', 'colorNoise', 'crunch', 'clipping'] as const;

export type FriedField = (typeof FRIED_FIELDS)[number];
export type FriedStyle = Pick<Style, FriedField>;

/** The curve's two ends: the dial at 0, barely fried, and at 1, fully fried. */
export const FRY_AT_0: FriedStyle = { colors: 12, saturation: 0.2, simplify: 0.1, bands: 6, grain: 0.1, colorNoise: 0.05, crunch: 0, clipping: 0 };
export const FRY_AT_1: FriedStyle = { colors: 4, saturation: 0.9, simplify: 0.8, bands: 3, grain: 0.8, colorNoise: 0.5, crunch: 0.7, clipping: 0.5 };

/**
 * Real fields are rounded to this many decimal places, so that the curve's
 * ends and its default position give the same numbers as their literals:
 * unrounded, `0.2 + (0.9 - 0.2) * 1` is 0.8999999999999999 in doubles.
 */
const DECIMALS = 1e6;

/**
 * The eight fried fields at dial position `f`, interpolated linearly between
 * FRY_AT_0 and FRY_AT_1. `f` is clamped to `style.fry`'s range first. `colors`
 * and `bands` are rounded to whole numbers, as their ranges require, and the
 * real fields to six decimal places. `f` must be finite: the `fry` edit
 * refuses a non-finite one before it gets here.
 */
export function fryCurve(f: number): FriedStyle {
  const t = clampToRange('style.fry', f);
  const lerp = (field: FriedField): number => FRY_AT_0[field] + (FRY_AT_1[field] - FRY_AT_0[field]) * t;
  const real = (field: FriedField): number => Math.round(lerp(field) * DECIMALS) / DECIMALS;
  return {
    colors: clampToRange('style.colors', lerp('colors')),
    saturation: real('saturation'),
    simplify: real('simplify'),
    bands: clampToRange('style.bands', lerp('bands')),
    grain: real('grain'),
    colorNoise: real('colorNoise'),
    crunch: real('crunch'),
    clipping: real('clipping'),
  };
}
