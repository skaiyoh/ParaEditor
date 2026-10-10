import { srgbToOklab, type Oklab } from '../core/color.ts';
import type { Analysis } from '../core/types.ts';

type Sample = { readonly lab: Oklab; count: number };
const distance = (a: Oklab, b: Oklab): number => (a.L - b.L) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2;

/** Small integer hash PRNG. The document's seed is its only entropy. */
function randomFrom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Weighted k-means++ over distinct RGB colors, followed by at most 20 Lloyd iterations. */
function pixelStats(pixels: Uint8ClampedArray, seed: number, count: number): Pick<Analysis, 'colors' | 'tone'> {
  const total = pixels.length / 4;
  if (total < 1 || !Number.isInteger(total)) throw new Error('Statistics need a nonempty RGBA image.');
  const histogram = new Map<number, Sample>();
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i] ?? 0;
    const g = pixels[i + 1] ?? 0;
    const b = pixels[i + 2] ?? 0;
    const key = (r << 16) | (g << 8) | b;
    const existing = histogram.get(key);
    if (existing !== undefined) existing.count++;
    else histogram.set(key, { lab: srgbToOklab({ r: r / 255, g: g / 255, b: b / 255 }), count: 1 });
  }
  const samples = [...histogram.values()];
  const first = samples[0];
  if (first === undefined) throw new Error('Statistics need at least one color.');
  const random = randomFrom(seed);
  const pick = (weights: readonly number[], sum: number): Oklab => {
    let target = random() * sum;
    let last = first.lab;
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      const weight = weights[i] ?? 0;
      if (sample === undefined || weight <= 0) continue;
      last = sample.lab;
      target -= weight;
      if (target < 0) return last;
    }
    return last;
  };
  let centers = [pick(samples.map((sample) => sample.count), total)];
  const nearest = new Float64Array(samples.length).fill(Infinity);
  while (centers.length < Math.min(count, samples.length)) {
    const latest = centers.at(-1);
    if (latest === undefined) break;
    let sum = 0;
    const weights = samples.map((sample, i) => {
      const d = Math.min(nearest[i] ?? Infinity, distance(sample.lab, latest));
      nearest[i] = d;
      const weight = d * sample.count;
      sum += weight;
      return weight;
    });
    if (sum <= 0) break;
    centers.push(pick(weights, sum));
  }

  const assign = () => {
    const sums = centers.map(() => ({ L: 0, a: 0, b: 0, count: 0 }));
    for (const sample of samples) {
      let best = 0;
      let least = Infinity;
      for (let i = 0; i < centers.length; i++) {
        const center = centers[i];
        if (center === undefined) continue;
        const d = distance(sample.lab, center);
        if (d < least) { least = d; best = i; }
      }
      const sum = sums[best];
      if (sum === undefined) throw new Error('No cluster center.');
      sum.L += sample.lab.L * sample.count;
      sum.a += sample.lab.a * sample.count;
      sum.b += sample.lab.b * sample.count;
      sum.count += sample.count;
    }
    return sums.filter((sum) => sum.count > 0).map((sum) => ({
      lab: { L: sum.L / sum.count, a: sum.a / sum.count, b: sum.b / sum.count },
      weight: sum.count / total,
    }));
  };
  let colors: Analysis['colors'][number][] = [];
  for (let iteration = 0; iteration < 20; iteration++) {
    colors = assign();
    const stable = colors.length === centers.length && colors.every((cluster, i) => {
      const center = centers[i];
      return center !== undefined && distance(cluster.lab, center) < 1e-16;
    });
    centers = colors.map((cluster) => cluster.lab);
    if (stable) break;
  }
  colors = [...colors].sort((a, b) => b.weight - a.weight);
  const ordered = [...samples].sort((a, b) => a.lab.L - b.lab.L);
  const percentile = (fraction: number): number => {
    const rank = Math.floor((total - 1) * fraction);
    let count = 0;
    for (const sample of ordered) {
      count += sample.count;
      if (count > rank) return sample.lab.L;
    }
    return ordered.at(-1)?.lab.L ?? 0;
  };
  const dominant = colors[0];
  if (dominant === undefined) throw new Error('Statistics produced no color clusters.');
  return { colors: [dominant, ...colors.slice(1)], tone: { p01: percentile(0.01), p05: percentile(0.05), p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) } };
}

/** Reuses photo k-means on an explicit, packed RGBA pixel list. */
export function clusterPixels(pixels: Uint8ClampedArray, seed: number, count: 2 | 3): Analysis['colors'] {
  return pixelStats(pixels, seed, count).colors;
}

export function photoStats(image: { readonly data: Uint8ClampedArray; readonly width: number; readonly height: number }, seed: number): Pick<Analysis, 'colors' | 'tone'> {
  if (image.data.length !== image.width * image.height * 4) throw new Error('Statistics need a nonempty RGBA image.');
  return pixelStats(image.data, seed, 16);
}
