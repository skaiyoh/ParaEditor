/** A 0.05-wide quadratic knee followed by a quadratic highlight shoulder.
 * Value and slope agree at both joins; the slope at white is 1 - clipping.
 * A single quadratic with slope 1 at the start and fixed white is identity.
 */
export function clipLightness(lightness: number, clipping: number): number {
  if (clipping === 0) return lightness;
  const width = 0.05;
  const start = 1 - 0.35 * clipping - width;
  if (lightness <= start) return lightness;
  if (lightness >= 1) return 1;
  const span = 1 - start;
  const rest = span - width;
  const a = clipping * rest / (2 * width * span);
  const t = lightness - start;
  if (t <= width) return start + t + a * t * t;
  const u = t - width;
  const b = -a * width * (2 * span - width) / (rest * rest);
  return start + width + a * width * width + (1 + 2 * a * width) * u + b * u * u;
}
