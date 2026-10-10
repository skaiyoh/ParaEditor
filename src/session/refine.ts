import type { Plane } from '../core/raster.ts';

export type RefineCandidate = { readonly mask: Plane<'u8'>; readonly score: number };
export type RankedCandidate = RefineCandidate & { readonly candidate: number; readonly area: number };

export function maskArea(mask: Plane<'u8'>): number {
  let area = 0;
  for (const value of mask.data) if (value >= 128) area++;
  return area;
}

export function rankCandidates(candidates: readonly [RefineCandidate, RefineCandidate, RefineCandidate]): readonly [RankedCandidate, RankedCandidate, RankedCandidate] {
  const ranked = candidates.map((candidate, index) => ({ ...candidate, candidate: index, area: maskArea(candidate.mask) }))
    .sort((a, b) => a.area - b.area || a.candidate - b.candidate);
  const [small, middle, large] = ranked;
  if (small === undefined || middle === undefined || large === undefined) throw new Error('Refinement needs three masks.');
  return [small, middle, large];
}

/** The neutral threshold of a candidate, preserving the original decoder choice. */
export function candidateSize(candidates: ReturnType<typeof rankCandidates>, candidate: number): number {
  const rank = candidates.findIndex((entry) => entry.candidate === candidate);
  if (rank < 0) throw new Error('The selection candidate is unavailable.');
  return (rank + 0.5) / 3;
}

export function refinementChoice(size: number): { readonly rank: 0 | 1 | 2; readonly threshold: number } {
  const scaled = Math.max(0, Math.min(1, size)) * 3;
  const rank = scaled < 1 ? 0 : scaled < 2 ? 1 : 2;
  const within = scaled - rank;
  // Two linear halves put 128 at the midpoint, while keeping both specified endpoints.
  const threshold = within <= 0.5 ? 192 - within * 128 : 128 - (within - 0.5) * 64;
  return { rank, threshold };
}

/** 120 CSS pixels reaches either endpoint from the object's current size. */
export function draggedSize(start: number, travel: number): number {
  const delta = Math.max(-1, Math.min(1, travel / 120));
  return start + delta * (delta < 0 ? start : 1 - start);
}

/** Anchor a legacy .5 selection at its preserved candidate, retaining both endpoints. */
export function anchoredSize(size: number, start: number, anchor: number): number {
  if (anchor === start) return size;
  return size <= start ? (start === 0 ? anchor : size * anchor / start)
    : anchor + (size - start) * (1 - anchor) / (1 - start);
}

/** Keep the soft edge, mapping exactly the chosen inside threshold onto 128. */
export function thresholdMask(mask: Plane<'u8'>, threshold: number): Plane<'u8'> {
  const data = new Uint8Array(mask.data.length);
  for (let i = 0; i < data.length; i++) {
    const value = mask.data[i] ?? 0;
    // Floor keeps every source value below the threshold below the renderer's crossing.
    data[i] = value < threshold ? Math.floor(value * 128 / threshold)
      : Math.floor(128 + (value - threshold) * 127 / (255 - threshold));
  }
  return { format: 'u8', size: mask.size, data };
}
