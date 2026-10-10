import type { SceneDocument } from '../core/types.ts';

export const GLYPHS = ['.', '-', '+', '*', '#'] satisfies readonly string[];
export const ATLAS_SIZE = 64;
export const SDF_SCALE = 508; // One byte spans 1/508 of a cell; zero is byte 128.
export type SymbolMode = SceneDocument['objects'][number]['symbols'];
export type SymbolDecision = {
  readonly glyphIndex: number; // -1 is a solid cell.
  readonly inkBand: number;
  readonly paperBand: number;
};

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

export function normalizedTone(lightness: number, p01: number, p99: number): number {
  return clamp((lightness - p01) / Math.max(p99 - p01, 1e-6), 0, 1);
}

/** The glyph-rule experiments use this window, including its zero guard. */
export function symbolDecision({ tone, band, bands, amount, mode }: {
  readonly tone: number; readonly band: number; readonly bands: number;
  readonly amount: number; readonly mode: SymbolMode;
}): SymbolDecision {
  const e = Math.abs(tone - 0.5);
  if (mode === 'never' || (mode !== 'always' && !(amount > 0 && e >= 0.5 * (1 - amount)))) {
    return { glyphIndex: -1, inkBand: band, paperBand: band };
  }
  const glyphIndex = amount > 0 ? clamp(Math.floor(5 * (e - 0.5 * (1 - amount)) / (0.5 * amount)), 0, 4) : 0;
  const side = tone < 0.5 ? -1 : 1;
  const inkBand = clamp(band + side, 0, bands - 1);
  return { glyphIndex, inkBand, paperBand: inkBand - side };
}

/** A cell's geometric center is exactly the frame center, even at odd sizes. */
export function cellGrid(width: number, height: number, cellSize: number) {
  const origin = (size: number): number => {
    const anchor = (size - cellSize) / 2;
    return anchor - Math.ceil(anchor / cellSize) * cellSize;
  };
  return { width: Math.ceil(width / cellSize) + 1, height: Math.ceil(height / cellSize) + 1,
    originX: origin(width), originY: origin(height) };
}

function barDistance(x: number, y: number, halfLength: number, halfStroke: number): number {
  const dx = Math.abs(x) - halfLength, dy = Math.abs(y) - halfStroke;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
}

/** Coordinates are cell fractions relative to the glyph center; inside < 0. */
export function glyphDistance(glyph: number, x: number, y: number): number {
  const length = 0.35, stroke = 0.042;
  switch (glyph) {
    case 0: return Math.hypot(x, y) - 0.105;
    case 1: return barDistance(x, y, length, stroke);
    case 2: return Math.min(barDistance(x, y, length, stroke), barDistance(y, x, length, stroke));
    case 3: {
      const c = 0.5, s = Math.sqrt(3) / 2;
      return Math.min(barDistance(x, y, length, stroke),
        barDistance(c*x + s*y, -s*x + c*y, length, stroke),
        barDistance(-c*x + s*y, -s*x - c*y, length, stroke));
    }
    case 4: return Math.min(barDistance(x, y - 0.14, length, stroke), barDistance(x, y + 0.14, length, stroke),
      barDistance(y, x - 0.14, length, stroke), barDistance(y, x + 0.14, length, stroke));
    default: throw new RangeError('The glyph index must be 0..4.');
  }
}

export function glyphAtlas(): Uint8Array {
  const width = ATLAS_SIZE * GLYPHS.length;
  const bytes = new Uint8Array(width * ATLAS_SIZE);
  for (let glyph = 0; glyph < GLYPHS.length; glyph++) for (let y = 0; y < ATLAS_SIZE; y++) for (let x = 0; x < ATLAS_SIZE; x++) {
    const distance = glyphDistance(glyph, (x + 0.5) / ATLAS_SIZE - 0.5, (y + 0.5) / ATLAS_SIZE - 0.5);
    bytes[y * width + glyph * ATLAS_SIZE + x] = clamp(Math.round(128 + SDF_SCALE * distance), 0, 255);
  }
  return bytes;
}
