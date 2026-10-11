import type { Size } from '../core/raster.ts';
import type { createGl, Mesh, Program, Target, Texture, Uniform } from './gl.ts';
import { geometryVertex, perspectiveVertex } from './shaders/geometry.ts';
import { compositionDecode, compositionEncode, paintFragment, paintVertex, resolvedDepth } from './shaders/composition.ts';
import { surfaceDepth } from './shaders/surface.ts';
import { admitPaintResources, paintResources, paintTileUpload, validatePaintPlanes, samePaintPixels, PAINT_TILE_SIZE, PAINT_UPLOAD_SIDE,
  type PaintPlane, type PaintTile, type PaintAdmission } from './paint.ts';

type Gpu = ReturnType<typeof createGl>;
type Resident = { readonly plane: PaintPlane; readonly tiles: readonly { readonly tile: PaintTile; readonly texture: Texture }[] };
type Resources = {
  readonly resolved: Target; readonly warped: Target; readonly linear: Target; readonly encoded: Target; readonly quad: Mesh;
  readonly motionDepth: Program; readonly liveDepth: Program; readonly motionPaint: Program; readonly livePaint: Program;
  readonly decode: Program; readonly encode: Program; readonly warp: Program;
};
export type PhotoDepthDraw = { readonly mesh: Mesh; readonly depth: Texture; readonly mask: Texture; readonly objectId: number };
export type PaintProjection = { readonly kind: 'motion' | 'perspective'; readonly uniforms: Readonly<Record<string, Uniform>> };
const tex = (value: Texture): Uniform => ({ kind: 'texture', value });

/** Additional, bounded renderer resources. No document, brush, history, or export ownership. */
export function createPaintComposition(gpu: Gpu) {
  const { gl } = gpu;
  let current: readonly Resident[] = [], resources: Resources | null = null;
  let size: Size = { width: 0, height: 0 };
  function usage() { return paintResources(size, current.length, current.reduce((sum, value) => sum + value.tiles.length, 0), resources !== null); }
  function releaseResources(value: Resources): void {
    for (const target of [value.resolved, value.warped, value.linear, value.encoded]) gpu.release(target);
    for (const program of [value.motionDepth, value.liveDepth, value.motionPaint, value.livePaint, value.decode, value.encode, value.warp]) gpu.releaseProgram(program);
    gpu.releaseMesh(value.quad);
  }
  function allocate(dimensions: Size): Resources {
    const targets: Target[] = [], programs: Program[] = [];
    let quad: Mesh | null = null;
    const target = (format: Parameters<Gpu['target']>[2]) => {
      const value = gpu.target(dimensions.width, dimensions.height, format); targets.push(value); return value;
    };
    const program = (fragment: string, vertex?: string) => { const value = gpu.program(fragment, vertex); programs.push(value); return value; };
    try {
      const resolved = target('r32f'); gpu.attachDepth(resolved);
      const warped = target('r32f'), linear = target(true), encoded = target(false);
      quad = gpu.mesh({ vertices: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), indices: new Uint16Array([0, 1, 2, 2, 1, 3]) });
      return { resolved, warped, linear, encoded, quad,
        motionDepth: program(resolvedDepth(false), geometryVertex), liveDepth: program(resolvedDepth(true), perspectiveVertex),
        motionPaint: program(paintFragment, paintVertex(false)), livePaint: program(paintFragment, paintVertex(true)),
        decode: program(compositionDecode), encode: program(compositionEncode), warp: program(surfaceDepth) };
    } catch (error) {
      for (const value of targets) gpu.release(value);
      for (const value of programs) gpu.releaseProgram(value);
      if (quad !== null) gpu.releaseMesh(quad);
      throw error;
    }
  }
  function setPlanes(planes: readonly PaintPlane[], dimensions: Size): PaintAdmission {
    const candidates: Resident[] = [], allocated: Texture[] = [];
    let prepared: Resources | null = null;
    try {
      const validated = validatePaintPlanes(planes, dimensions);
      const byId = new Map(current.map(value => [value.plane.id, value]));
      const retained = new Map(planes.flatMap(input => {
        const previous = byId.get(input.id);
        return previous !== undefined && samePaintPixels(previous.plane, input) ? [[input, previous] satisfies [PaintPlane, Resident]] : [];
      }));
      const originals = new Map(planes.map(value => [value.id, value]));
      const next = paintResources(dimensions, validated.length, validated.reduce((sum, plane) => sum + plane.tiles.length, 0));
      const reused = planes.reduce((sum, input) => sum + (retained.get(input)?.tiles.length ?? 0), 0);
      const oldBytes = usage().tileBytes - reused * PAINT_UPLOAD_SIDE ** 2 * 4;
      const admitted = admitPaintResources(next, oldBytes);
      if (admitted.kind === 'refused') return admitted;
      if (validated.length === 0) { dispose(); size = { width: dimensions.width, height: dimensions.height }; return { kind: 'accepted' }; }
      if (resources !== null && (size.width !== dimensions.width || size.height !== dimensions.height)) throw new Error('Clear paint before changing photo dimensions.');
      prepared = resources === null ? allocate(dimensions) : null;
      for (const plane of validated) {
        const input = originals.get(plane.id);
        if (input === undefined) throw new Error('The paint snapshot is missing.');
        const previous = retained.get(input);
        if (previous !== undefined) { candidates.push({ plane, tiles: previous.tiles }); continue; }
        const tiles = plane.tiles.map(tile => {
          const texture = gpu.texture(PAINT_UPLOAD_SIDE, PAINT_UPLOAD_SIDE, 'rgba8', paintTileUpload(plane, tile));
          allocated.push(texture);
          // The GPU owns the snapshot; it does not retain a second decoded pixel copy.
          return { tile, texture };
        });
        candidates.push({ plane, tiles });
      }
      const keep = new Set(candidates.flatMap(value => value.tiles.map(tile => tile.texture)));
      for (const old of current) for (const tile of old.tiles) if (!keep.has(tile.texture)) gpu.release(tile.texture);
      resources ??= prepared;
      current = candidates; size = { width: dimensions.width, height: dimensions.height };
      return { kind: 'accepted' };
    } catch (error) {
      for (const texture of allocated) gpu.release(texture);
      if (prepared !== null) releaseResources(prepared);
      return { kind: 'refused', reason: error instanceof Error ? error.message : String(error) };
    }
  }
  function prepare(dimensions: Size): void {
    if (resources !== null) return;
    const admission = admitPaintResources(paintResources(dimensions, 0, 0, true), 0);
    if (admission.kind === 'refused') throw new Error(admission.reason);
    resources = allocate(dimensions); size = { width: dimensions.width, height: dimensions.height };
  }
  function resolve(draws: readonly PhotoDepthDraw[], projection: PaintProjection,
    surface: Readonly<Record<string, Uniform>> | null): Target {
    if (resources === null) throw new Error('Prepare paint before resolving depth.');
    const target = resources;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.resolved.framebuffer);
    gl.clearBufferfv(gl.COLOR, 0, new Float32Array([1, 0, 0, 0]));
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true);
    gl.depthRange(0, 1 - 1 / 65535); gl.clearDepth(1);
    try {
      // Color persists between objects. Only each mesh's fold-resolution buffer clears.
      for (const draw of draws) {
        gl.clear(gl.DEPTH_BUFFER_BIT);
        gpu.draw(projection.kind === 'perspective' ? target.liveDepth : target.motionDepth, target.resolved,
          { ...projection.uniforms, depthPlane: tex(draw.depth), mask: tex(draw.mask), objectId: { kind: 'int', value: draw.objectId } }, draw.mesh);
      }
    } finally { gl.disable(gl.DEPTH_TEST); gl.depthRange(0, 1); }
    let resolved = target.resolved;
    if (surface !== null) {
      gpu.draw(target.warp, target.warped, { ...surface, src: tex(resolved) }); resolved = target.warped;
    }
    return resolved;
  }
  function capture(x: number, y: number, dimensions: Size, draws: readonly PhotoDepthDraw[], projection: PaintProjection,
    surface: Readonly<Record<string, Uniform>> | null): number | null {
    prepare(dimensions);
    const target = resolve(draws, projection, surface);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.framebuffer);
    const pixel = new Float32Array(4); gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, pixel);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`The paint depth readback failed (${error}).`);
    const value = pixel[0] ?? 1;
    if (!Number.isFinite(value) || value >= 1) return null;
    return Math.max(0, Math.min(1, 1 - value / (1 - 1 / 65535)));
  }
  function composite(photo: Texture, draws: readonly PhotoDepthDraw[], projection: PaintProjection,
    surface: Readonly<Record<string, Uniform>> | null): Target {
    const resolved = resolve(draws, projection, surface);
    if (resources === null) throw new Error('Admit paint before rendering it.');
    const target = resources;
    gpu.draw(target.decode, target.linear, { src: tex(photo) });
    gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthRange(0, 1 - 1 / 65535);
    try {
      for (const { plane, tiles } of current) {
        if (!plane.visible || plane.opacity === 0) continue;
        const occupied = new Set(tiles.map(({ tile }) => `${tile.x},${tile.y}`));
        for (const { tile, texture } of tiles) {
          let neighbors = 0;
          for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
            if (occupied.has(`${tile.x + x},${tile.y + y}`)) neighbors |= 1 << ((y + 1) * 3 + x + 1);
          }
          const left = tile.x === 0 ? 0 : -.5, top = tile.y === 0 ? 0 : -.5;
          const right = tile.x * PAINT_TILE_SIZE + tile.width === plane.bounds.width ? 0 : .5;
          const bottom = tile.y * PAINT_TILE_SIZE + tile.height === plane.bounds.height ? 0 : .5;
          gpu.draw(projection.kind === 'perspective' ? target.livePaint : target.motionPaint, target.linear, {
          ...projection.uniforms, tile: tex(texture), resolved: tex(resolved),
          disparity: { kind: 'float', value: plane.disparity }, opacity: { kind: 'float', value: plane.opacity },
          origin: { kind: 'vec2', value: [plane.bounds.x + tile.x * PAINT_TILE_SIZE, plane.bounds.y + tile.y * PAINT_TILE_SIZE] },
          neighbors: { kind: 'int', value: neighbors }, tileStart: { kind: 'vec2', value: [left, top] },
          tileSize: { kind: 'vec2', value: [tile.width + right - left, tile.height + bottom - top] }, imageSize: { kind: 'vec2', value: [size.width, size.height] },
        }, target.quad);
        }
      }
    } finally { gl.disable(gl.BLEND); gl.depthRange(0, 1); }
    gpu.draw(target.encode, target.encoded, { src: tex(target.linear) });
    return target.encoded;
  }
  function dispose(): void {
    for (const plane of current) for (const tile of plane.tiles) gpu.release(tile.texture);
    if (resources !== null) releaseResources(resources);
    current = []; resources = null;
  }
  function readPixel(x: number, y: number) {
    if (resources === null) return null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, resources.resolved.framebuffer);
    const depth = new Float32Array(4); gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, resources.linear.framebuffer);
    const linear = new Float32Array(4); gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, linear);
    gl.bindFramebuffer(gl.FRAMEBUFFER, resources.encoded.framebuffer);
    const encoded = new Uint8Array(4); gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, encoded);
    return { depth: Array.from(depth), linear: Array.from(linear), encoded: Array.from(encoded), error: gl.getError() };
  }
  return { setPlanes, composite, capture, readPixel, resources: usage, active: () => current.some(({ plane }) => plane.visible && plane.opacity > 0),
    hasPlanes: () => current.length > 0, dispose };
}
