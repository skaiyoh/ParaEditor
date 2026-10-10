// Structural equality over the values a scene document holds: plain objects,
// arrays, strings, numbers, booleans, and null.
// Pure: no browser global, no Node API, no I/O.

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when `a` and `b` hold the same value: primitives by `Object.is`, so
 * -0 differs from 0 and NaN equals NaN; arrays element by element, in order;
 * plain objects by their own enumerable keys, in any order, a key set to
 * undefined differing from a key absent.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  if (isPlainRecord(a) && isPlainRecord(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
  }
  return false;
}
