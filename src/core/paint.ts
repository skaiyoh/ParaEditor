// Pointer-independent, transient round-brush coverage. No document or asset ownership.
import { oklchToSrgb } from './color.ts';
import { COMPOSITION_LIMITS } from './composition-ranges.ts';
import type { Rect, Size } from './raster.ts';
import { err, ok, type Result } from './result.ts';
import { z } from './zod.ts';

export const PAINT_TILE_SIZE = 256;
export const PAINT_LIMITS = Object.freeze({ patches: 64, tiles: 64, bytes: COMPOSITION_LIMITS.dirtyStrokeBytes, dabs: 1_000_000 });
/** Math adapter seam: ONLY normalized scalar texture coverage, without tip,
 * opacity, ink, color encoding or premultiplication. Coordinates belong to the
 * captured stroke plane, so the texture never restarts at a dab or tile edge. */
export type PaintCoverageSource = (x: number, y: number, seed: number) => number;
export const solidPaintCoverage: PaintCoverageSource = () => 1;

const pointSchema = z.strictObject({ x: z.number().finite(), y: z.number().finite() }).readonly();
export type PaintPoint = z.infer<typeof pointSchema>;
const sampleSchema = z.strictObject({ x: z.number().finite(), y: z.number().finite(),
  pressure: z.number().finite().nullable().optional() }).readonly();
export type StrokeSample = z.infer<typeof sampleSchema>;
const brushFields = {
  diameter: z.number().min(1).max(256), opacity: z.number().min(0).max(1), pressure: z.enum(['off', 'size']),
};
const drawBrushSchema = z.strictObject({ ...brushFields, operation: z.literal('draw'),
  color: z.strictObject({ l: z.number().min(0).max(1), c: z.number().min(0).max(.4), h: z.number().min(0).max(360) }).readonly() }).readonly();
const eraseBrushSchema = z.strictObject({ ...brushFields, operation: z.literal('erase') }).readonly();
export type PaintDrawBrush = z.infer<typeof drawBrushSchema>;
export type PaintEraseBrush = z.infer<typeof eraseBrushSchema>;
export type PaintBrush = PaintDrawBrush | PaintEraseBrush;
const sizeSchema = z.strictObject({ width: z.number().int().min(1).max(COMPOSITION_LIMITS.rasterSide),
  height: z.number().int().min(1).max(COMPOSITION_LIMITS.rasterSide) }).readonly();
const tileSizeSchema = z.strictObject({ width: z.number().int().min(1).max(PAINT_TILE_SIZE),
  height: z.number().int().min(1).max(PAINT_TILE_SIZE) });

/** Typed arrays cannot be frozen. Keep bytes private and expose only reads/copies.
 * Internal construction writes directly into the final allocation, with no commit copy. */
class RasterSnapshot {
  readonly size: Size;
  readonly format = 'rgba8-srgb-straight';
  readonly byteLength: number;
  readonly #bytes: Uint8Array;
  constructor(size: Size, read: (offset: number) => number) {
    this.size = Object.freeze({ ...size });
    this.byteLength = size.width * size.height * 4;
    this.#bytes = new Uint8Array(this.byteLength);
    for (let i = 0; i < this.byteLength; i++) this.#bytes[i] = read(i);
    Object.freeze(this);
  }
  byteAt(offset: number): number { return this.#bytes[offset] ?? 0; }
  copyBytes(): Uint8Array { return this.#bytes.slice(); }
}
export type PaintRaster = RasterSnapshot;

/** Snapshot caller-owned codec bytes on hydration; never retain their buffer. */
export function snapshotPaintRaster(input: { readonly size: Size; readonly data: Uint8Array }): PaintRaster {
  const size = tileSizeSchema.parse(input.size);
  if (!(input.data instanceof Uint8Array) || input.data.byteLength !== size.width * size.height * 4) {
    throw new RangeError('The paint tile bytes must match its clipped dimensions.');
  }
  return new RasterSnapshot(size, i => input.data[i] ?? 0);
}

/** x/y are tile indices, not pixel origins. Absent tiles are transparent. */
export type PaintTile = { readonly x: number; readonly y: number; readonly raster: PaintRaster };
export type PaintTilePatch = { readonly x: number; readonly y: number; readonly size: Size;
  readonly before: PaintRaster | null; readonly after: PaintRaster | null };
const identitySchema = z.string().min(1).max(256);
const captureSchema = z.strictObject({
  owner: identitySchema, sceneGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  viewGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  brushRevision: identitySchema, functionRevision: identitySchema, seed: z.number().int().min(0).max(0xffffffff),
  start: sampleSchema,
  attachment: z.strictObject({ depthSample: pointSchema, disparity: z.number().min(0).max(1) }).readonly(),
  /** Origin is the first texel center, matching MRX1's planeOrigin uniform.
   * Texture coordinate = origin + (local pixel center - .5) * pixelScale. */
  plane: z.strictObject({ origin: pointSchema, pixelScale: z.number().finite().positive() }).readonly(),
}).readonly();
export type PaintCapture = z.infer<typeof captureSchema>;
export type PaintAttachment = PaintCapture['attachment'];
export type PaintPatchMemory = {
  readonly tileBytes: number; readonly bounds: Rect | null;
  /** RGBA8, no mipmaps/padding: either one resource per tile or a tight alpha crop. */
  readonly sparseGpuBytes: number; readonly croppedGpuBytes: number;
};
const tileSchema = z.strictObject({ x: z.number().int().min(0), y: z.number().int().min(0),
  raster: z.instanceof(RasterSnapshot) }).readonly();
const patchInputSchema = z.strictObject({ id: identitySchema, size: sizeSchema, capture: captureSchema,
  brush: drawBrushSchema, tiles: z.array(tileSchema).max(PAINT_LIMITS.tiles).readonly() });
export type PaintPatchInput = z.input<typeof patchInputSchema>;

class PatchSnapshot {
  readonly id: string; readonly size: Size; readonly capture: PaintCapture;
  readonly brush: PaintDrawBrush; readonly tiles: readonly PaintTile[];
  readonly memory: PaintPatchMemory;
  constructor(input: PaintPatchInput) {
    this.id = input.id; this.size = input.size; this.capture = input.capture;
    this.brush = input.brush; this.tiles = input.tiles;
    this.memory = measurePaintPatch(this);
    Object.freeze(this);
  }
}
export type PaintPatch = PatchSnapshot;
export type PaintPatchChange = {
  readonly patchId: string; readonly before: PaintPatch | null; readonly after: PaintPatch | null;
  readonly tiles: readonly PaintTilePatch[];
};
export type PaintStrokeMemory = {
  /** Peak reserved dirty capacity: f32 max coverage + candidate RGBA8.
   * Before/after/retained tile totals below refer ONLY to changed tile refs.
   * GPU totals cover the complete changed patches, including shared tiles. */
  readonly coverageBytes: number; readonly candidateTileBytes: number; readonly peakDirtyBytes: number;
  readonly beforeTileBytes: number; readonly afterTileBytes: number; readonly retainedTileBytes: number;
  readonly beforeSparseGpuBytes: number; readonly afterSparseGpuBytes: number;
  readonly beforeCroppedGpuBytes: number; readonly afterCroppedGpuBytes: number;
};
export type PaintStrokeResult = {
  readonly kind: 'draw' | 'erase'; readonly capture: PaintCapture;
  readonly changes: readonly PaintPatchChange[]; readonly memory: PaintStrokeMemory;
};
export type PaintUsage = { readonly dirtyTiles: number; readonly reservedBytes: number;
  readonly coverageBytes: number; readonly candidateTileBytes: number;
  readonly peakReservedBytes: number; readonly dabs: number };
export type PaintStroke = {
  readonly extend: (samples: readonly StrokeSample[]) => Result<PaintUsage, string>;
  readonly finish: () => Result<PaintStrokeResult | null, string>;
  readonly cancel: () => void;
  readonly usage: () => PaintUsage;
};
const planeMapSchema = z.strictObject({ offset: pointSchema, scale: z.number().finite().positive() }).readonly();
/** targetPixel = offset + eraserPlanePixel * scale. The caller captures this
 * inverse-view mapping for each depth plane; erasure never reattaches a patch. */
export type PaintPlaneMap = z.infer<typeof planeMapSchema>;
export type PaintEraseTarget = { readonly patch: PaintPatch; readonly toPatch: PaintPlaneMap };
const coverageSourceSchema = z.custom<PaintCoverageSource>(value => typeof value === 'function');
const commonInput = {
  capture: captureSchema,
  projectPatchCount: z.number().int().min(0).max(PAINT_LIMITS.patches),
  coverageSource: coverageSourceSchema.optional(),
  budget: z.strictObject({ tiles: z.number().int().min(0).max(PAINT_LIMITS.tiles),
    bytes: z.number().int().min(0).max(PAINT_LIMITS.bytes) }).optional(),
};
const inputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...commonInput, kind: z.literal('draw'), id: identitySchema, size: sizeSchema, brush: drawBrushSchema }),
  z.strictObject({ ...commonInput, kind: z.literal('erase'), brush: eraseBrushSchema,
    targets: z.array(z.strictObject({ patch: z.instanceof(PatchSnapshot), toPatch: planeMapSchema }).readonly()).max(PAINT_LIMITS.patches) }),
]);
export type PaintStrokeInput = z.input<typeof inputSchema>;
/** MRX4 supplies a current project-wide count and unique draw ID, complete
 * active-owner erase targets, and captures their inverse-view maps. It must
 * reject stale owner/generations and recheck the project cap before commit. */
export type PaintDrawInput = Extract<PaintStrokeInput, { kind: 'draw' }>;
export type PaintEraseInput = Extract<PaintStrokeInput, { kind: 'erase' }>;
type DirtyTile = { readonly x: number; readonly y: number; readonly size: Size;
  readonly before: PaintRaster | null; readonly coverage: Float32Array };
type Target = { readonly id: string; readonly before: PaintPatch | null; readonly size: Size;
  readonly toPatch: PaintPlaneMap; readonly baseline: Map<number, PaintRaster>; readonly dirty: Map<number, DirtyTile> };
const clamp = (n: number): number => Math.max(0, Math.min(1, n));

/** Actual alpha bounds, including holes. These estimates allocate no GPU data.
 * MRX3 must add its atlas padding, formats, mipmaps and scratch to its own cap. */
export function measurePaintPatch(patch: { readonly tiles: readonly PaintTile[] }): PaintPatchMemory {
  let tileBytes = 0, left = Infinity, top = Infinity, right = -1, bottom = -1;
  for (const tile of patch.tiles) {
    tileBytes += tile.raster.byteLength;
    for (let y = 0; y < tile.raster.size.height; y++) for (let x = 0; x < tile.raster.size.width; x++) {
      if (tile.raster.byteAt((y * tile.raster.size.width + x) * 4 + 3) === 0) continue;
      const px = tile.x * PAINT_TILE_SIZE + x, py = tile.y * PAINT_TILE_SIZE + y;
      left = Math.min(left, px); top = Math.min(top, py); right = Math.max(right, px); bottom = Math.max(bottom, py);
    }
  }
  const bounds = right < 0 ? null : Object.freeze({ x: left, y: top, width: right - left + 1, height: bottom - top + 1 });
  return Object.freeze({ tileBytes, bounds, sparseGpuBytes: tileBytes,
    croppedGpuBytes: bounds === null ? 0 : bounds.width * bounds.height * 4 });
}

export function measurePaintStroke(input: { readonly changes: readonly PaintPatchChange[]; readonly peakDirtyBytes: number }): PaintStrokeMemory {
  let beforeTileBytes = 0, afterTileBytes = 0, beforeSparseGpuBytes = 0, afterSparseGpuBytes = 0;
  let beforeCroppedGpuBytes = 0, afterCroppedGpuBytes = 0;
  const retained = new Set<PaintRaster>();
  for (const change of input.changes) {
    for (const tile of change.tiles) {
      beforeTileBytes += tile.before?.byteLength ?? 0; afterTileBytes += tile.after?.byteLength ?? 0;
      if (tile.before !== null) retained.add(tile.before);
      if (tile.after !== null) retained.add(tile.after);
    }
    beforeSparseGpuBytes += change.before?.memory.sparseGpuBytes ?? 0;
    afterSparseGpuBytes += change.after?.memory.sparseGpuBytes ?? 0;
    beforeCroppedGpuBytes += change.before?.memory.croppedGpuBytes ?? 0;
    afterCroppedGpuBytes += change.after?.memory.croppedGpuBytes ?? 0;
  }
  return Object.freeze({ coverageBytes: input.peakDirtyBytes / 2, candidateTileBytes: input.peakDirtyBytes / 2,
    peakDirtyBytes: input.peakDirtyBytes, beforeTileBytes, afterTileBytes,
    retainedTileBytes: [...retained].reduce((sum, raster) => sum + raster.byteLength, 0),
    beforeSparseGpuBytes, afterSparseGpuBytes, beforeCroppedGpuBytes, afterCroppedGpuBytes });
}

function tileMap(size: Size, tiles: readonly PaintTile[]): Result<Map<number, PaintRaster>, string> {
  const columns = Math.ceil(size.width / PAINT_TILE_SIZE), rows = Math.ceil(size.height / PAINT_TILE_SIZE);
  const map = new Map<number, PaintRaster>();
  for (const tile of tiles) {
    const key = tile.y * columns + tile.x;
    if (tile.x >= columns || tile.y >= rows || map.has(key) ||
        tile.raster.size.width !== Math.min(PAINT_TILE_SIZE, size.width - tile.x * PAINT_TILE_SIZE) ||
        tile.raster.size.height !== Math.min(PAINT_TILE_SIZE, size.height - tile.y * PAINT_TILE_SIZE)) {
      return err('Paint tiles must be unique and match their clipped surface dimensions.');
    }
    map.set(key, tile.raster);
  }
  return ok(map);
}

/** MRX4 hydration seam: immutable raster bytes are supplied after asset decode. */
export function snapshotPaintPatch(input: PaintPatchInput): Result<PaintPatch, string> {
  const parsed = patchInputSchema.safeParse(input);
  if (!parsed.success) return err('The paint patch metadata or tile references are invalid.');
  const checked = tileMap(parsed.data.size, parsed.data.tiles);
  if (!checked.ok) return checked;
  const tiles = Object.freeze([...parsed.data.tiles].sort((a, b) => a.y - b.y || a.x - b.x));
  return ok(new PatchSnapshot({ ...parsed.data, tiles }));
}

function coverage(source: PaintCoverageSource, x: number, y: number, seed: number, tip: number, opacity: number): Result<number, string> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return err('The stroke-plane texture coordinates must be finite.');
  let texture: number;
  try { texture = source(x, y, seed); }
  catch { return err('The brush texture failed; the stroke was cancelled.'); }
  if (!Number.isFinite(texture) || texture < 0 || texture > 1) return err('The brush texture must return finite coverage between zero and one.');
  // One multiplication path; the max buffer already includes tip AND opacity.
  return ok(Math.fround(texture * tip * opacity));
}

/** CPU scalar evaluator used by the same rasterizer as recorded/live paths. */
export function evaluatePaintCoverage(input: { readonly source: PaintCoverageSource; readonly at: PaintPoint;
  readonly seed: number; readonly roundTip: number; readonly opacity: number }): Result<number, string> {
  const parsed = z.strictObject({ source: coverageSourceSchema, at: pointSchema,
    seed: z.number().int().min(0).max(0xffffffff), roundTip: z.number().min(0).max(1), opacity: z.number().min(0).max(1) }).safeParse(input);
  if (!parsed.success) return err('The coverage source, plane coordinates, seed, tip, or opacity is invalid.');
  const sample = parsed.data;
  return coverage(sample.source, sample.at.x, sample.at.y, sample.seed, sample.roundTip, sample.opacity);
}

/** Start/extend only accumulate max coverage. Finish alone deposits color, once.
 * Any refusal cancels the entire candidate, preserving every input tile. */
export function beginPaintStroke(input: PaintStrokeInput): Result<PaintStroke, string> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return err('The stroke metadata, project patch count, brush, targets, or budget is invalid.');
  const settings = parsed.data;
  if (settings.kind === 'draw' && settings.projectPatchCount >= PAINT_LIMITS.patches) {
    return err('The project already has 64 paint patches; erase or remove a patch before drawing.');
  }
  if (settings.kind === 'erase' && settings.targets.length > settings.projectPatchCount) return err('The project patch count is smaller than the erasure target count.');
  const { capture, brush } = settings, { start, seed, plane } = capture;
  const source = settings.coverageSource ?? solidPaintCoverage;
  const budget = settings.budget ?? { tiles: PAINT_LIMITS.tiles, bytes: PAINT_LIMITS.bytes };
  const targets: Target[] = [];
  if (settings.kind === 'draw') {
    // Draw has no baseline seam: every new stroke belongs to its own depth plane.
    targets.push({ id: settings.id, before: null, size: settings.size,
      toPatch: { offset: { x: 0, y: 0 }, scale: 1 }, baseline: new Map(), dirty: new Map() });
  } else {
    const ids = new Set<string>();
    for (const target of settings.targets) {
      if (target.patch.capture.owner !== capture.owner) return err('Erasure targets must belong to the active paint layer.');
      if (ids.has(target.patch.id)) return err('Erasure targets must have unique patch IDs.');
      ids.add(target.patch.id);
      const baseline = tileMap(target.patch.size, target.patch.tiles);
      if (!baseline.ok) return baseline;
      targets.push({ id: target.patch.id, before: target.patch, size: target.patch.size,
        toPatch: target.toPatch, baseline: baseline.value, dirty: new Map() });
    }
  }
  // Ink is encoded straight sRGB, independent of coverage. No color mixing,
  // sRGB->linear conversion or premultiplication occurs here. MRX3's compositor
  // decodes sRGB and premultiplies each sampled texel by stored alpha BEFORE
  // filtering/blending in linear light. It must not reapply tip/texture/opacity.
  const ink = brush.operation === 'draw' ? oklchToSrgb(brush.color) : { r: 0, g: 0, b: 0 };
  const channels = [ink.r, ink.g, ink.b].map(channel => Math.round(clamp(channel) * 255));
  let reservedBytes = 0, peakReservedBytes = 0, dirtyTiles = 0, dabs = 0;
  let closed: string | null = null;
  let previous = start;
  let lastDab: { readonly x: number; readonly y: number; readonly radius: number } | null = null;
  // A fixed spacing at the smallest enabled tip guarantees <= diameter/4 even
  // during falling pressure. It also avoids event-dependent spacing decisions.
  const spacing = brush.diameter * (brush.pressure === 'size' ? .1 : 1) / 4;
  let residual = 0;
  const usage = (): PaintUsage => Object.freeze({ dirtyTiles, reservedBytes, coverageBytes: reservedBytes / 2,
    candidateTileBytes: reservedBytes / 2, peakReservedBytes, dabs });
  function close(sentence: string): Result<never, string> {
    closed = sentence;
    for (const target of targets) { target.dirty.clear(); target.baseline.clear(); }
    targets.length = 0; reservedBytes = 0; dirtyTiles = 0;
    return err(sentence);
  }
  const radius = (sample: StrokeSample): number => brush.diameter / 2 *
    (brush.pressure === 'off' || sample.pressure == null ? 1 : .1 + .9 * clamp(sample.pressure));

  function dab(at: StrokeSample): Result<void, string> {
    const r = radius(at);
    if (lastDab !== null && at.x === lastDab.x && at.y === lastDab.y && r === lastDab.radius) return ok(undefined);
    if (dabs >= PAINT_LIMITS.dabs) return close('The stroke exceeds the dab limit; draw a shorter stroke.');
    dabs++;
    lastDab = { x: at.x, y: at.y, radius: r };
    if (brush.opacity === 0) return ok(undefined);
    for (const target of targets) {
      const { size, toPatch, baseline, dirty } = target, { offset, scale } = toPatch;
      const columns = Math.ceil(size.width / PAINT_TILE_SIZE);
      const centerX = offset.x + at.x * scale, centerY = offset.y + at.y * scale, extent = (r + .5) * scale;
      if (![centerX, centerY, extent].every(Number.isFinite)) return close('The erase plane mapping produced invalid coordinates.');
      const left = Math.max(0, Math.floor(centerX - extent)), right = Math.min(size.width - 1, Math.floor(centerX + extent));
      const top = Math.max(0, Math.floor(centerY - extent)), bottom = Math.min(size.height - 1, Math.floor(centerY + extent));
      for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
        // Inverse mapping keeps the one-pixel fringe and the texture in the SAME
        // captured eraser-plane units, including scaled/translated target patches.
        const qx = (x + .5 - offset.x) / scale, qy = (y + .5 - offset.y) / scale;
        const tip = clamp(r + .5 - Math.hypot(qx - at.x, qy - at.y));
        if (tip === 0) continue;
        const evaluated = coverage(source, plane.origin.x + (qx - .5) * plane.pixelScale,
          plane.origin.y + (qy - .5) * plane.pixelScale, seed, tip, brush.opacity);
        if (!evaluated.ok) return close(evaluated.error);
        if (evaluated.value === 0) continue;
        const tx = Math.floor(x / PAINT_TILE_SIZE), ty = Math.floor(y / PAINT_TILE_SIZE), key = ty * columns + tx;
        let tile = dirty.get(key);
        if (tile === undefined) {
          const before = baseline.get(key) ?? null;
          if (brush.operation === 'erase' && before === null) continue;
          const tileSize = Object.freeze({ width: Math.min(PAINT_TILE_SIZE, size.width - tx * PAINT_TILE_SIZE),
            height: Math.min(PAINT_TILE_SIZE, size.height - ty *PAINT_TILE_SIZE) });
          // Reserve f32 coverage + candidate RGBA8. Immutable before references
          // allocate no dirty bytes; active/history owners account for those assets.
          const bytes = tileSize.width * tileSize.height * 8;
          if (dirtyTiles + 1 > budget.tiles) return close('The stroke exceeds the dirty tile limit; draw a smaller stroke.');
          if (reservedBytes + bytes > budget.bytes) return close('The stroke exceeds the dirty byte limit; draw a smaller stroke.');
          let buffer: Float32Array;
          try { buffer = new Float32Array(tileSize.width * tileSize.height); }
          catch { return close('The stroke coverage buffer could not be allocated; the stroke was cancelled.'); }
          tile = { x: tx, y: ty, size: tileSize, before, coverage: buffer };
          dirty.set(key, tile); dirtyTiles++; reservedBytes += bytes; peakReservedBytes = Math.max(peakReservedBytes, reservedBytes);
        }
        const index = (y - ty * PAINT_TILE_SIZE) * tile.size.width + x - tx * PAINT_TILE_SIZE;
        tile.coverage[index] = Math.max(tile.coverage[index] ?? 0, evaluated.value);
      }
    }
    return ok(undefined);
  }
  function extend(samples: readonly StrokeSample[]): Result<PaintUsage, string> {
    if (closed !== null) return err(closed);
    for (const candidate of samples) {
      const parsedSample = sampleSchema.safeParse(candidate);
      if (!parsedSample.success) return close('Stroke positions and reported pressure must be finite.');
      const next = parsedSample.data;
      const length = Math.hypot(next.x - previous.x, next.y - previous.y);
      if (!Number.isFinite(length) || Math.floor((residual + length) / spacing) > PAINT_LIMITS.dabs - dabs) {
        return close('The stroke exceeds the dab limit; draw a shorter stroke.');
      }
      if (length === 0 && radius(next) !== radius(previous)) {
        const result = dab(next);
        if (!result.ok) return result;
      } else if (length > 0) {
        let travelled = spacing - residual;
        while (travelled <= length) {
          const t = travelled / length;
          // Interpolate effective pressure: absence means full size, including at a transition.
          const p0 = previous.pressure == null ? 1 : clamp(previous.pressure);
          const p1 = next.pressure == null ? 1 : clamp(next.pressure);
          const result = dab({ x: previous.x + (next.x - previous.x) * t,
            y: previous.y + (next.y - previous.y) * t, pressure: p0 + (p1 - p0) * t });
          if (!result.ok) return result;
          travelled += spacing;
        }
        residual = length - (travelled - spacing);
      }
      previous = next;
    }
    return ok(usage());
  }
  function finish(): Result<PaintStrokeResult | null, string> {
    if (closed !== null) return err(closed);
    const endpoint = dab(previous);
    if (!endpoint.ok) return endpoint;
    const changes: PaintPatchChange[] = [];
    for (const target of targets) {
      const patches: PaintTilePatch[] = [];
      const columns = Math.ceil(target.size.width / PAINT_TILE_SIZE), replacements = new Map(target.baseline);
      for (const tile of [...target.dirty.values()].sort((a, b) => a.y - b.y || a.x - b.x)) {
        let changed = false, visible = false, after: PaintRaster;
        try {
          after = new RasterSnapshot(tile.size, offset => {
            const pixel = Math.floor(offset / 4), channel = offset % 4;
            const old = tile.before?.byteAt(offset) ?? 0, alpha = tile.before?.byteAt(pixel * 4 + 3) ?? 0;
            const amount = tile.coverage[pixel] ?? 0;
            let value = old;
            if (amount > 0) {
              const alphaByte = Math.round(brush.operation === 'erase' ? alpha * (1 - amount) : amount * 255);
              if (channel === 3) value = alphaByte;
              else if (alphaByte === 0) value = 0;
              else if (brush.operation === 'draw') value = channels[channel] ?? 0;
              // Erase scales premultiplied color and alpha equally, so straight
              // RGB stays unchanged until alpha quantizes to zero.
            }
            if (value !== old) changed = true;
            if (channel === 3 && value !== 0) visible = true;
            return value;
          });
        } catch { return close('The stroke tile bytes could not be allocated; the stroke was cancelled.'); }
        if (changed) {
          const result = visible ? after : null;
          patches.push(Object.freeze({ x: tile.x, y: tile.y, size: tile.size, before: tile.before, after: result }));
          const key = tile.y * columns + tile.x;
          if (result === null) replacements.delete(key); else replacements.set(key, result);
        }
      }
      if (patches.length === 0) continue;
      const tiles = Object.freeze([...replacements].sort(([a], [b]) => a - b).map(([key, raster]) =>
        Object.freeze({ x: key % columns, y: Math.floor(key / columns), raster })));
      let after: PaintPatch | null;
      if (tiles.length === 0) after = null;
      else if (target.before !== null) after = new PatchSnapshot({ ...target.before, tiles });
      else if (settings.kind === 'draw') after = new PatchSnapshot({ id: target.id, size: target.size, capture, brush: settings.brush, tiles });
      else return close('An erase target lost its captured patch.');
      changes.push(Object.freeze({ patchId: target.id, before: target.before, after, tiles: Object.freeze(patches) }));
    }
    const memory = measurePaintStroke({ changes, peakDirtyBytes: peakReservedBytes });
    close('The stroke has already finished.');
    return ok(changes.length === 0 ? null : Object.freeze({ kind: settings.kind, capture, changes: Object.freeze(changes), memory }));
  }
  const first = dab(start);
  if (!first.ok) return first;
  return ok(Object.freeze({ extend, finish, cancel: () => { close('The stroke was cancelled.'); }, usage }));
}

/** Canonical recorded-path hook. It exercises exactly the live sampler and
 * source evaluation, without maintaining another preview/color implementation. */
export function evaluatePaintStroke(input: PaintStrokeInput, batches: readonly (readonly StrokeSample[])[]): Result<PaintStrokeResult | null, string> {
  const begun = beginPaintStroke(input);
  if (!begun.ok) return begun;
  for (const samples of batches) {
    const result = begun.value.extend(samples);
    if (!result.ok) return result;
  }
  return begun.value.finish();
}
