// Nearest-rank percentiles: the value at rank ceil(p n) of n values in
// ascending order, so the median of an even count is the lower middle value.
// The depth stage's statistics read their percentiles here, and the
// renderer's hole fill, not built yet, is to read its median here too, so the
// two agree.
// Pure: no browser global, no Node API, no I/O.

import { err, ok, type Result } from './result.ts';

/** Values sorted ascending, at least one, none NaN; built by `rank`, which copies its input. */
export type Ranked = { readonly kind: 'ranked'; readonly ascending: Float64Array };

/**
 * Copies `values` into a new array and sorts it ascending.
 * Refuses an empty input and one holding NaN; an infinity sorts to its end.
 * The copy is a Float64Array, so every value of a Float32Array or a number array is held exactly.
 * `values` is only read.
 */
export function rank(values: ArrayLike<number>): Result<Ranked, string> {
  const n = values.length;
  if (n === 0) return err('there are no values to rank');
  const ascending = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const value = values[i];
    if (value === undefined || Number.isNaN(value)) return err(`value ${i} is not a number`);
    ascending[i] = value;
  }
  ascending.sort();
  return ok({ kind: 'ranked', ascending });
}

/**
 * The value at rank ceil(p n) in ascending order, ranks counted from 1, for `p` in (0, 1].
 * The product p n is taken as exact: the rank is the least r from 1 to n with r / n >= p,
 * so p 0.07 over 100 values is rank 7, where Math.ceil(0.07 * 100) is 8.
 * Refuses a `p` that is not in (0, 1].
 */
export function nearestRank(ranked: Ranked, p: number): Result<number, string> {
  if (!(p > 0 && p <= 1)) return err(`p must be in (0, 1], got ${p}`);
  const { ascending } = ranked;
  const n = ascending.length;
  let r = Math.min(n, Math.max(1, Math.ceil(p * n)));
  while (r > 1 && (r - 1) / n >= p) r -= 1;
  while (r < n && r / n < p) r += 1;
  const value = ascending[r - 1];
  return value === undefined ? err('there are no values to rank') : ok(value);
}

/** `nearestRank` over `values`, ranked once; `values` is only read. */
export function percentile(values: ArrayLike<number>, p: number): Result<number, string> {
  const ranked = rank(values);
  return ranked.ok ? nearestRank(ranked.value, p) : ranked;
}
