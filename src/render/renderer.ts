import { layers, maskCovers, holeMask, holeRadius, anchorDisparity, cameraRadius, parallaxClamp, plateNeeded } from '../core/derive.ts';
import type { ObjectId } from '../core/ids.ts';
import type { Plane } from '../core/raster.ts';
import { frameCount, loopPhase, cameraOffset, parallaxDisplacement, effectiveOrbit, loopZoom, parallaxMargin } from '../core/motion.ts';
import type { Vec2 } from '../core/motion.ts';
import { sortedMasks } from '../core/produce.ts';
import { LOOP_FPS, wrapFrame } from './loop.ts';
import { backGrid, objectGrid } from './mesh.ts';
import { geometry, geometryVertex, geometryCoverage } from './shaders/geometry.ts';
import { backsource } from './shaders/backsource.ts';
import { fillBackgroundDepth } from './shaders/pushpull.ts';
import { holdIndex } from './grain.ts';
import { LUMA_TABLE, CHROMA_TABLE, crunchQuality, qualityTable } from './crunch.ts';
import { createRenderProbe, type CellReadback } from './debug.ts';
import { createGl, type Target, type Texture, type Uniform } from './gl.ts';
import { documentPalette, type Palette } from './palette.ts';
import type { Renderer, RenderScene } from './types.ts';
import { down } from './shaders/down.ts';
import { tensor } from './shaders/tensor.ts';
import { blur } from './shaders/blur.ts';
import { akf } from './shaders/akf.ts';
import { dog } from './shaders/dog.ts';
import { up } from './shaders/up.ts';
import { quantize } from './shaders/quantize.ts';
import { outline, OUTLINE_SLOPE_PER_WORKING_TEXEL } from './shaders/outline.ts';
import { present } from './shaders/present.ts';
import { select } from './shaders/select.ts';
import { grain, grainHashReadback } from './shaders/grain.ts';
import { clip } from './shaders/clip.ts';
import { crunchExtract, crunchRowDct, crunchColumnDct, crunchColumnIdct, crunchRowIdct, crunchCombine } from './shaders/crunch.ts';
import { ATLAS_SIZE, GLYPHS, glyphAtlas, cellGrid } from './symbols.ts';
import { cellsReduce } from './shaders/cells-reduce.ts';
import { cellsDraw } from './shaders/cells-draw.ts';
import { surface } from './shaders/surface.ts';

const tex = (value: Texture): Uniform => ({ kind: 'texture', value });
const float = (value: number): Uniform => ({ kind: 'float', value });
const int = (value: number): Uniform => ({ kind: 'int', value });
const DIVISOR = 4;
type Grid = { readonly low: Target; readonly tensor: Target; readonly blur: Target; readonly a: Target; readonly b: Target };
type Buffers = { readonly grid: Grid; readonly simplified: Target; readonly quantized: Target; readonly final: Target };
type CrunchBuffers = { readonly y: readonly [Target, Target]; readonly c: readonly [Target, Target] };
type CellBuffers = { readonly variant: Target; readonly cells: Target; readonly decisions: Target; readonly size: number };

/** Offline frames share the still export's selection-free draw and restoration. */
export type LoopCapture = { readonly frame: number; readonly canvas: HTMLCanvasElement };
type ExportRenderer = Omit<Renderer, 'exportStill' | 'debug'> & {
  exportStill(): Promise<Blob>;
  exportStill(capture: LoopCapture): void;
  readonly debug: (NonNullable<Renderer['debug']> & {
    motionCamera(): Vec2;
    setMotionFeather(enabled: boolean): void;
  }) | null;
};

export function createRenderer(canvas: HTMLCanvasElement): ExportRenderer {
  const gpu = createGl(canvas);
  const { gl } = gpu;
  let lost = false;
  const onContextLost = (): void => { lost = true; };
  canvas.addEventListener('webglcontextlost', onContextLost);
  let programs: ReturnType<typeof makePrograms>;
  function makePrograms() {
    return {
      geometry: gpu.program(geometry, geometryVertex), coverage: gpu.program(geometryCoverage, geometryVertex), backsource: gpu.program(backsource),
      down: gpu.program(down), tensor: gpu.program(tensor), blur: gpu.program(blur), akf: gpu.program(akf),
      dog: gpu.program(dog), up: gpu.program(up), quantize: gpu.program(quantize), outline: gpu.program(outline), present: gpu.program(present), select: gpu.program(select),
      grain: gpu.program(grain), clip: gpu.program(clip), extract: gpu.program(crunchExtract), rowDct: gpu.program(crunchRowDct),
      columnDct: gpu.program(crunchColumnDct), columnIdct: gpu.program(crunchColumnIdct), rowIdct: gpu.program(crunchRowIdct), combine: gpu.program(crunchCombine),
      hash: NOISY_DEV ? gpu.program(grainHashReadback) : null,
      cellsReduce: gpu.program(cellsReduce), cellsDraw: gpu.program(cellsDraw),
      surface: gpu.program(surface),
    };
  }
  try { programs = makePrograms(); }
  catch (error) { canvas.removeEventListener('webglcontextlost', onContextLost); gpu.dispose(); throw error; }
  let scene: RenderScene | null = null;
  let master: Texture | null = null;
  let plate: Texture | null = null;
  let plateSimplified: Target | null = null;
  let backSource: Target | null = null;
  let plateIdentity: RenderScene['plate'] = null;
  let backDirty = true;
  let hole: Texture | null = null;
  let holePlane: Plane<'u8'> | null = null;
  let holeKey = '';
  let backgroundDepth: Texture | null = null;
  let backgroundKey = '';
  let backgroundPlane: RenderScene['depth'] = null;
  let gbuffer: { color: Target; label: Target; depth: Target; composite: Target } | null = null;
  const backMesh = gpu.mesh(backGrid());
  const objectMeshes = new Map<ObjectId, { key: string; mesh: ReturnType<typeof gpu.mesh>; mask: Plane<'u8'>; texture: Texture }>();
  let lastRender: { frame: number; loop: boolean; camera: Vec2 | null; showSelection: boolean } =
    { frame: 0, loop: false, camera: null, showSelection: true };
  let featherEnabled = true;
  let renderedCamera: Vec2 = { x: 0, y: 0 };
  let exportedEdges: boolean | null = null;
  let buffers: Buffers | null = null;
  let crunchBuffers: CrunchBuffers | null = null;
  let cellBuffers: CellBuffers | null = null;
  const atlas = gpu.texture(ATLAS_SIZE * GLYPHS.length, ATLAS_SIZE, 'r8', glyphAtlas(), true);
  const symbolModes = new Float32Array(33);
  let finalTarget: Target | null = null;
  let selectionSource: Target | null = null;
  let depth: Texture | null = null;
  let depthRange = 0;
  let profiling = false;
  let cameraCosts: Record<string, number> = {};
  let label = gpu.texture(1, 1, 'r8', new Uint8Array(1));
  let lut: Texture | null = null;
  let palette: Palette | null = null;
  let paletteKey = '';
  let labelKey = '';
  let subjectKey = '';
  let dirty = true;
  let disposed = false;
  const clarity = new Float32Array(256);
  const backgroundClarity = new Float32Array(256);
  const backgroundLabel = gpu.texture(1, 1, 'r8', new Uint8Array(1));
  const maskIdentities = new WeakMap<Plane<'u8'>, number>();
  let nextMaskIdentity = 1;
  const one = new Uint8Array(4);
  function maskIdentity(mask: Plane<'u8'> | undefined): number {
    return mask === undefined ? 0 : maskIdentities.get(mask) ?? 0;
  }
  function checkLive(): void {
    if (disposed) throw new Error('The renderer has been disposed.');
    if (lost || gl.isContextLost()) {
      lost = true;
      throw new Error('The graphics context was lost; reload the page');
    }
  }
  function complete(target: Target): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one);
  }
  function readPatch(x: number, y: number, w: number, h: number): Uint8Array {
    checkLive();
    if (buffers === null) throw new Error('Open a photo before reading the simplified image.');
    if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w < 1 || h < 1 ||
      x + w > buffers.simplified.width || y + h > buffers.simplified.height) throw new Error('The simplified patch is outside the master.');
    const bytes = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, buffers.simplified.framebuffer);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    return bytes;
  }
  const probe = NOISY_DEV ? createRenderProbe({
    readPatch, finish: () => { if (finalTarget !== null) complete(finalTarget); }, profileCamera, hashCells, readCellTable,
    exportFrame, geometryEdgesCovered, geometryPixel, selectionPixel,
  }) : null;

  function readCellTable(cx: number, cy: number): CellReadback {
    checkLive();
    if (cellBuffers === null || scene?.doc.symbols.enabled !== true || palette === null) throw new Error('Enable Symbols before reading cells.');
    if (![cx, cy].every(Number.isInteger) || cx < 0 || cy < 0 || cx >= cellBuffers.cells.width || cy >= cellBuffers.cells.height) {
      throw new Error('The cell is outside the cell table.');
    }
    const v = new Uint8Array(4), d = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, cellBuffers.cells.framebuffer);
    gl.readPixels(cx, cy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, v);
    gl.bindFramebuffer(gl.FRAMEBUFFER, cellBuffers.decisions.framebuffer);
    gl.readPixels(cx, cy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, d);
    const label = v[0] ?? 0, entry = v[1] ?? 0, band = v[2] ?? 0;
    const inkBand = d[1] ?? 0, paperBand = d[2] ?? 0;
    const currentPalette = palette;
    const rgb = (b: number): readonly number[] => {
      const offset = (label * currentPalette.width + entry * 6 + b) * 4;
      return Array.from(currentPalette.lut.subarray(offset, offset + 3));
    };
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`The cell readback failed (WebGL 0x${error.toString(16)}).`);
    return { label, entry, band, tone: (v[3] ?? 0) / 255, glyphIndex: (d[0] ?? 0) - 1, inkBand, paperBand,
      ink: rgb(inkBand), paper: rgb(paperBand) };
  }

  function hashCells(): readonly number[] {
    checkLive();
    if (programs.hash === null) throw new Error('Grain readback is available only in dev builds.');
    const target = gpu.target(4, 1), bytes = new Uint8Array(16);
    try {
      gpu.draw(programs.hash, target, {});
      gl.readPixels(0, 0, 4, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      const error = gl.getError();
      if (error !== gl.NO_ERROR) throw new Error(`The grain hash readback failed (WebGL 0x${error.toString(16)}).`);
      return Array.from({ length: 4 }, (_, i) => ((bytes[i*4] ?? 0) | ((bytes[i*4+1] ?? 0) << 8) |
        ((bytes[i*4+2] ?? 0) << 16) | ((bytes[i*4+3] ?? 0) << 24)) >>> 0);
    } finally { gpu.release(target); }
  }

  function profileCamera(): Readonly<Record<string, number>> {
    cameraCosts = {}; profiling = true;
    try { gl.finish(); renderStill(); return { ...cameraCosts }; }
    finally { profiling = false; }
  }
  function cameraDraw(name: string, program: Parameters<typeof gpu.draw>[0], target: Target, uniforms: Readonly<Record<string, Uniform>>): void {
    const draw = (): void => gpu.draw(program, target, uniforms);
    if (profiling && probe !== null) {
      // Exclude pending upstream draws from the first camera pass's cost.
      gl.finish(); cameraCosts[name] = probe.measure(draw, () => gl.finish());
    }
    else draw();
  }

  function releaseBuffers(): void {
    releaseCells();
    if (crunchBuffers !== null) for (const target of [...crunchBuffers.y, ...crunchBuffers.c]) gpu.release(target);
    crunchBuffers = null; finalTarget = null; selectionSource = null;
    if (buffers !== null) {
      for (const target of Object.values(buffers.grid)) gpu.release(target);
      gpu.release(buffers.simplified); gpu.release(buffers.quantized); gpu.release(buffers.final);
    }
    if (plateSimplified !== null) gpu.release(plateSimplified);
    if (backSource !== null) gpu.release(backSource);
    if (gbuffer !== null) for (const target of Object.values(gbuffer)) gpu.release(target);
    plateSimplified = null; backSource = null; gbuffer = null; backDirty = true;
    buffers = null;
  }
  function releaseCells(): void {
    if (cellBuffers === null) return;
    gpu.release(cellBuffers.variant); gpu.release(cellBuffers.cells); gpu.release(cellBuffers.decisions);
    cellBuffers = null;
  }
  function ensureCells(width: number, height: number, size: number): CellBuffers {
    if (cellBuffers?.size === size) return cellBuffers;
    const variant = cellBuffers?.variant ?? gpu.target(width, height);
    if (cellBuffers !== null) { gpu.release(cellBuffers.cells); gpu.release(cellBuffers.decisions); }
    const grid = cellGrid(width, height, size);
    const cells = gpu.target(grid.width, grid.height), decisions = gpu.target(grid.width, grid.height);
    gpu.attach(cells, decisions);
    cellBuffers = { variant, cells, decisions, size };
    return cellBuffers;
  }
  function allocate(width: number, height: number): Buffers {
    const w = Math.ceil(width / DIVISOR);
    const h = Math.ceil(height / DIVISOR);
    return {
      grid: { low: gpu.target(w, h), tensor: gpu.target(w, h, true), blur: gpu.target(w, h, true), a: gpu.target(w, h), b: gpu.target(w, h) },
      simplified: gpu.target(width, height, false, true), quantized: gpu.target(width, height), final: gpu.target(width, height),
    };
  }
  function rebuildLabels(next: RenderScene): void {
    const order = layers(next.doc);
    const key = order.map((layer) => {
      if (layer.kind === 'plate') return 'plate';
      const mask = next.masks.get(layer.object.id);
      if (mask !== undefined && !maskIdentities.has(mask)) maskIdentities.set(mask, nextMaskIdentity++);
      return [layer.object.id, next.doc.objects.indexOf(layer.object), layer.object.produced.mask.asset, mask === undefined ? 0 : maskIdentities.get(mask)];
    });
    const signature = JSON.stringify([next.master.width, next.master.height, key]);
    if (signature === labelKey) return;
    labelKey = signature;
    gpu.release(label);
    if (next.doc.objects.length === 0) label = gpu.texture(1, 1, 'r8', new Uint8Array(1));
    else {
      const scale = 1024 / Math.max(next.master.width, next.master.height);
      const width = Math.max(1, Math.round(next.master.width * scale));
      const height = Math.max(1, Math.round(next.master.height * scale));
      const bytes = new Uint8Array(width * height);
      const ids = new Map<ObjectId, number>(next.doc.objects.map((object, i) => [object.id, i + 1]));
      for (const layer of order) {
        if (layer.kind === 'plate') continue;
        const mask = next.masks.get(layer.object.id);
        if (mask === undefined) continue;
        const id = ids.get(layer.object.id) ?? 0;
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          if (maskCovers(mask, { x: (x + 0.5) / width, y: (y + 0.5) / height })) bytes[y * width + x] = id;
        }
      }
      label = gpu.texture(width, height, 'r8', bytes);
    }
    dirty = true;
  }
  function setScene(next: RenderScene): void {
    checkLive();
    const maxSize: unknown = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (typeof maxSize !== 'number') checkLive();
    if (typeof maxSize !== 'number' || next.master.width > maxSize || next.master.height > maxSize) throw new Error('The photo exceeds this WebGL2 device’s texture limit.');
    if (scene?.master !== next.master) {
      if (master !== null) gpu.release(master);
      master = gpu.bitmap(next.master);
      dirty = true;
    }
    if (buffers === null || buffers.simplified.width !== next.master.width || buffers.simplified.height !== next.master.height) {
      releaseBuffers();
      canvas.width = next.master.width;
      canvas.height = next.master.height;
      buffers = allocate(next.master.width, next.master.height);
      dirty = true;
    }
    const masks = sortedMasks(next.doc);
    const forMasks = next.doc.analysis.plate?.forMasks;
    const freshPlate = next.doc.objects.length > 0 && forMasks !== undefined && masks.length === forMasks.length &&
      masks.every((asset, i) => asset === forMasks[i]) ? next.plate : null;
    if (plateIdentity !== freshPlate) {
      if (plate !== null) gpu.release(plate);
      plate = null; plateIdentity = freshPlate; backDirty = true;
      if (freshPlate !== null) {
        const { width, height } = freshPlate.size;
        if (width !== next.master.width || height !== next.master.height) throw new Error('The plate must match the master size.');
        const bytes = new Uint8Array(width * height * 4);
        for (let i = 0; i < width * height; i++) {
          bytes.set(freshPlate.data.subarray(i * 3, i * 3 + 3), i * 4); bytes[i * 4 + 3] = 255;
        }
        plate = gpu.texture(width, height, 'rgba8', bytes);
      }
    }
    if (plate !== null && plateSimplified === null) {
      plateSimplified = gpu.target(next.master.width, next.master.height, false, true);
      backSource = gpu.target(next.master.width, next.master.height);
      backDirty = true;
    } else if (plate === null) {
      if (plateSimplified !== null) gpu.release(plateSimplified);
      if (backSource !== null) gpu.release(backSource);
      plateSimplified = null; backSource = null;
    }
    if (scene?.depth !== next.depth) {
      if (depth !== null) gpu.release(depth);
      depth = null; depthRange = 0;
      if (next.depth !== null) {
        const { width, height } = next.depth.size;
        if (width < 1 || height < 1 || next.depth.data.length !== width * height) throw new Error('The depth plane has an invalid size.');
        let min = Infinity, max = -Infinity;
        for (const value of next.depth.data) {
          if (!Number.isFinite(value)) throw new Error('The depth plane must contain finite values.');
          min = Math.min(min, value); max = Math.max(max, value);
        }
        depthRange = max - min;
        depth = gpu.texture(width, height, 'r16f', next.depth.data, true);
      }
    }
    rebuildLabels(next);
    const subjects = JSON.stringify([next.doc.style.subjectClarity, next.doc.objects.map((object) => [object.id, object.subject])]);
    if (subjects !== subjectKey) {
      clarity.fill(0);
      next.doc.objects.forEach((object, i) => { if (object.subject) clarity[i + 1] = next.doc.style.subjectClarity; });
      subjectKey = subjects;
      dirty = true;
    }
    if (scene?.doc.style.simplify !== next.doc.style.simplify) dirty = true;
    symbolModes.fill(0);
    next.doc.objects.forEach((object, i) => { symbolModes[i + 1] = object.symbols === 'always' ? 1 : object.symbols === 'never' ? 2 : 0; });
    const key = JSON.stringify([next.doc.analysis.colors, next.doc.analysis.tone, next.doc.style.colors, next.doc.style.bands,
      next.doc.style.saturation, next.doc.style.paletteTargets, subjects, next.doc.objects.map((object) => [object.recolor, object.produced.color])]);
    if (key !== paletteKey) {
      palette = documentPalette(next.doc);
      if (lut !== null) gpu.release(lut);
      lut = gpu.texture(palette.width, palette.rows, 'rgba8', palette.lut);
      paletteKey = key;
    }
    rebuildGeometryInputs(next);
    if (dirty) backDirty = true;
    exportedEdges = null;
    scene = next;
  }

  function rebuildGeometryInputs(next: RenderScene): void {
    for (const [id, entry] of objectMeshes) if (!next.doc.objects.some((object) => object.id === id)) {
      gpu.releaseMesh(entry.mesh); gpu.release(entry.texture); objectMeshes.delete(id);
    }
    for (const object of next.doc.objects) {
      const mask = next.masks.get(object.id);
      if (mask === undefined) {
        const previous = objectMeshes.get(object.id);
        if (previous !== undefined) { gpu.releaseMesh(previous.mesh); gpu.release(previous.texture); objectMeshes.delete(object.id); }
        continue;
      }
      const key = JSON.stringify([object.produced.bounds, next.doc.frame.master.size, parallaxClamp(next.doc)]);
      const previous = objectMeshes.get(object.id);
      if (previous?.key === key && previous.mask === mask) continue;
      if (previous !== undefined) { gpu.releaseMesh(previous.mesh); gpu.release(previous.texture); }
      objectMeshes.set(object.id, { key, mask, mesh: gpu.mesh(objectGrid(object.produced.bounds, next.doc.frame.master.size, parallaxClamp(next.doc))),
        texture: gpu.texture(mask.size.width, mask.size.height, 'r8', mask.data, true) });
    }
    const key = plate === null ? '' : JSON.stringify([next.master.width, next.master.height, holeRadius(next.doc, next.doc.frame.master.size),
      next.doc.objects.map((object) => [object.id, object.produced.mask.asset, maskIdentity(next.masks.get(object.id))]).sort()]);
    if (key !== holeKey) {
      if (hole !== null) gpu.release(hole);
      hole = null; holePlane = null; holeKey = key; backDirty = true;
      if (plate !== null) {
        holePlane = holeMask(next.doc, next.masks, next.doc.frame.master.size);
        hole = gpu.texture(holePlane.size.width, holePlane.size.height, 'r8', holePlane.data);
      }
    }
    if (backgroundPlane !== next.depth || backgroundKey !== holeKey) {
      if (backgroundDepth !== null) gpu.release(backgroundDepth);
      backgroundDepth = null; backgroundPlane = next.depth; backgroundKey = holeKey;
      if (next.depth !== null && holePlane !== null) {
        const { width, height } = next.depth.size;
        const data = new Uint8Array(width * height);
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const hx = Math.min(holePlane.size.width - 1, Math.floor((x + .5) * holePlane.size.width / width));
          const hy = Math.min(holePlane.size.height - 1, Math.floor((y + .5) * holePlane.size.height / height));
          data[y * width + x] = holePlane.data[hy * holePlane.size.width + hx] ?? 0;
        }
        const filled = fillBackgroundDepth(next.depth, { format: 'u8', size: next.depth.size, data });
        backgroundDepth = gpu.texture(width, height, 'r16f', filled.data, true);
      }
    }
  }

  function geometryInputs(offset: Vec2, zoom: number, cells: CellBuffers | null): { color: Texture; label: Texture; depth: Texture } {
    if (scene === null || buffers === null) throw new Error('Open a photo before rendering.');
    if (gbuffer === null) {
      gbuffer = { color: gpu.target(canvas.width, canvas.height), label: gpu.target(canvas.width, canvas.height), depth: gpu.target(canvas.width, canvas.height, 'r16f'), composite: gpu.target(canvas.width, canvas.height) };
      gpu.attachMany(gbuffer.color, [gbuffer.label, gbuffer.depth, gbuffer.composite]);
      gpu.attachDepth(gbuffer.color);
    }
    const target = gbuffer;
    const anchor = anchorDisparity(scene.doc);
    const lo = anchor === null ? { x: 0, y: 0 } : parallaxDisplacement(offset, 0, anchor);
    const hi = anchor === null ? { x: 0, y: 0 } : parallaxDisplacement(offset, 1, anchor);
    const displacement = { displacementX: { kind: 'vec3', value: [lo.x, hi.x, 0] },
      displacementY: { kind: 'vec3', value: [lo.y, hi.y, 0] }, zoom: float(zoom) } satisfies Record<string, Uniform>;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.color.framebuffer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2, gl.COLOR_ATTACHMENT3]);
    gl.clearBufferfv(gl.COLOR, 3, new Float32Array([0, 0, 0, 1]));
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    gl.clearBufferfv(gl.COLOR, 0, new Float32Array([0, 0, 0, 0]));
    gl.clearBufferfv(gl.COLOR, 1, new Float32Array(4)); gl.clearBufferfv(gl.COLOR, 2, new Float32Array(4));
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    // Reserve the last 16-bit depth value for clear: disparity zero must
    // still pass LESS instead of disappearing at the far clipping plane.
    gl.depthRange(0, 1 - 1 / 65535);
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    const cover = (mesh: ReturnType<typeof gpu.mesh>, mask: Texture, objectId: number, plane: Texture): void => {
      if (!featherEnabled) return;
      // Styling before coverage keeps palette bands and glyph cells from
      // turning the soft rim back into a hard edge. Each layer sees the
      // existing accumulated scene, using the very same styling programs.
      gl.disable(gl.DEPTH_TEST);
      const styled = stylize(target, cells);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.color.framebuffer);
      gl.drawBuffers([gl.NONE, gl.NONE, gl.NONE, gl.COLOR_ATTACHMENT3]);
      gl.enable(gl.DEPTH_TEST);
      // The preceding hard draw resolved folds. Blend only that nearest
      // surface, never another triangle of this object underneath it.
      gl.depthFunc(gl.EQUAL); gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
      try {
        gpu.draw(programs.coverage, target.color, { ...displacement, styled: tex(styled), mask: tex(mask), objectId: int(objectId),
          depthPlane: tex(plane), masterSize: { kind: 'ivec2', value: [canvas.width, canvas.height] } }, mesh);
      } finally {
        gl.disable(gl.BLEND); gl.depthMask(true); gl.depthFunc(gl.LESS);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
      }
    };
    try {
      gpu.draw(programs.geometry, target.color, { ...displacement, simplified: tex(plateSimplified ?? buffers.simplified),
        depthPlane: tex(backgroundDepth ?? depth ?? label), mask: tex(label), objectId: int(0) }, backMesh);
      cover(backMesh, label, 0, backgroundDepth ?? depth ?? label);
      for (const layer of layers(scene.doc)) {
        if (layer.kind === 'plate') continue;
        const entry = objectMeshes.get(layer.object.id);
        if (entry === undefined) continue;
        // Layer order still owns inter-object occlusion; depth resolves folds
        // within each mesh independently.
        gl.clear(gl.DEPTH_BUFFER_BIT);
        gpu.draw(programs.geometry, target.color, { ...displacement, simplified: tex(buffers.simplified),
          depthPlane: tex(depth ?? label), mask: tex(entry.texture), objectId: int(scene.doc.objects.indexOf(layer.object) + 1) }, entry.mesh);
        cover(entry.mesh, entry.texture, scene.doc.objects.indexOf(layer.object) + 1, depth ?? label);
      }
    } finally {
      gl.disable(gl.DEPTH_TEST);
      gl.depthRange(0, 1);
    }
    return target;
  }

  function simplify(source: Texture, destination: Target, grid: Grid, amount: number,
    inputs: { readonly label: Texture; readonly clarity: Float32Array } = { label, clarity }): void {
    const table: Uniform = { kind: 'floatArray', value: inputs.clarity };
    gpu.draw(programs.down, grid.low, { master: tex(source), label: tex(inputs.label), div: int(DIVISOR), aware: int(1) });
    gpu.draw(programs.tensor, grid.tensor, { src: tex(grid.low) });
    gpu.draw(programs.blur, grid.blur, { src: tex(grid.tensor), dir: { kind: 'ivec2', value: [1, 0] } });
    gpu.draw(programs.blur, grid.tensor, { src: tex(grid.blur), dir: { kind: 'ivec2', value: [0, 1] } });
    const uniforms = { tfm: tex(grid.tensor), R: float(6 * amount), clarity: table };
    gpu.draw(programs.akf, grid.a, { ...uniforms, src: tex(grid.low) });
    gpu.draw(programs.akf, grid.b, { ...uniforms, src: tex(grid.a) });
    gpu.draw(programs.akf, grid.a, { ...uniforms, src: tex(grid.b) });
    gpu.draw(programs.dog, grid.b, { src: tex(grid.a) });
    gpu.draw(programs.up, destination, { simp: tex(grid.b), low: tex(grid.low), master: tex(source), label: tex(inputs.label),
      div: int(DIVISOR), dBg: float(Math.max(0, 1 - 3 * amount)), clarity: table, simplify: float(amount) });
  }
  function stylize(inputs: { color: Texture; label: Texture; depth: Texture }, cells: CellBuffers | null): Target {
    if (scene === null || buffers === null || palette === null || lut === null) throw new Error('Open a photo before styling.');
    if (cells !== null) gpu.attach(buffers.quantized, cells.variant);
    cameraDraw('quantize', programs.quantize, buffers.quantized, { src: tex(inputs.color), label: tex(inputs.label), lut: tex(lut),
      entries: { kind: 'vec3Array', value: palette.sources }, entryCount: int(palette.entries.length),
      bandCounts: { kind: 'floatArray', value: palette.bandCounts }, symbolsEnabled: int(cells === null ? 0 : 1),
      p01: float(palette.tone.p01), p99: float(palette.tone.p99) });
    if (cells !== null) {
      gpu.attach(buffers.quantized, null);
      cameraDraw('cells.reduce', programs.cellsReduce, cells.cells, { variant: tex(cells.variant), cellSize: int(cells.size),
        amount: float(scene.doc.symbols.amount), modes: { kind: 'floatArray', value: symbolModes },
        bandCounts: { kind: 'floatArray', value: palette.bandCounts } });
      cameraDraw('cells.draw', programs.cellsDraw, buffers.final, { cells: tex(cells.cells), decisions: tex(cells.decisions),
        lut: tex(lut), atlas: tex(atlas), cellSize: int(cells.size), frameSize: { kind: 'ivec2', value: [canvas.width, canvas.height] } });
    } else {
      cameraDraw('outline', programs.outline, buffers.final, { src: tex(buffers.quantized), simplified: tex(inputs.color), label: tex(inputs.label),
        amount: float(scene.doc.style.outline), ink: { kind: 'vec3', value: palette.darkest },
        slopePerMasterPixel: float(OUTLINE_SLOPE_PER_WORKING_TEXEL / DIVISOR),
        depth: tex(inputs.depth), hasDepth: int(depth === null ? 0 : 1), depthRange: float(depthRange) });
    }
    return buffers.final;
  }
  function renderStill(showSelection = true): void { render(0, false, showSelection); }
  function renderFrame(frame: number, showSelection = true): void { render(frame, true, showSelection); }
  function renderView(camera: Vec2, frame = 0, showSelection = true): void { render(frame, true, showSelection, camera); }
  function render(frame: number, loop: boolean, showSelection: boolean, camera: Vec2 | null = null): void {
    checkLive();
    if (scene === null || buffers === null || master === null || palette === null || lut === null) throw new Error('Open a photo before rendering.');
    if (camera !== null) {
      if (!Number.isFinite(camera.x) || !Number.isFinite(camera.y)) throw new Error('The camera offset must contain finite frame fractions.');
      const reach = parallaxClamp(scene.doc);
      camera = { x: Math.max(-reach, Math.min(reach, camera.x)), y: Math.max(-reach, Math.min(reach, camera.y)) };
    }
    const index = loop && (camera === null || depth !== null) ? wrapFrame(frame, frameCount(scene.doc.motion, LOOP_FPS)) : 0;
    const moving = camera !== null ? depth !== null : loop && effectiveOrbit(scene.doc.motion) > 0 && !plateNeeded(scene.doc);
    const start = probe?.begin() ?? 0;
    if (dirty) {
      const run = (): void => {
        if (scene === null || buffers === null || master === null) return;
        simplify(master, buffers.simplified, buffers.grid, scene.doc.style.simplify);
      };
      if (probe === null) run();
      else probe.simplify(run, () => { if (buffers !== null) complete(buffers.simplified); });
      dirty = false;
    }
    if (backDirty && plate !== null && plateSimplified !== null && backSource !== null && hole !== null) {
      gpu.draw(programs.backsource, backSource, { master: tex(master), plate: tex(plate), hole: tex(hole) });
      simplify(backSource, plateSimplified, buffers.grid, scene.doc.style.simplify, { label: backgroundLabel, clarity: backgroundClarity });
      backDirty = false;
    }
    const drawCamera = moving ? camera ?? cameraOffset(cameraRadius(scene.doc), loopPhase(index, frameCount(scene.doc.motion, LOOP_FPS)), scene.doc.motion.drift.direction) : { x: 0, y: 0 };
    renderedCamera = drawCamera;
    const cells = scene.doc.symbols.enabled ? ensureCells(canvas.width, canvas.height, scene.doc.symbols.cellSize) : null;
    const hiding = plate !== null && scene.doc.objects.some((object) => object.hidden);
    const inputs = moving || hiding ? geometryInputs(drawCamera, moving ? loopZoom(scene.doc.motion.parallax) : 1, cells) :
      { color: buffers.simplified, label, depth: depth ?? label };
    const styled = featherEnabled && (moving || hiding) && gbuffer !== null ? gbuffer.composite : stylize(inputs, cells);
    const { style } = scene.doc;
    const currentBuffers = buffers;
    let output = styled;
    const other = (input: Target): Target => input === currentBuffers.final ? currentBuffers.quantized : currentBuffers.final;
    const coating = scene.doc.surface;
    if (coating.enabled && (coating.relief !== 0 || coating.refraction !== 0 || coating.shine !== 0)) {
      const target = other(output);
      const patterns = { bars: 0, cracks: 1, scales: 2 } satisfies Record<typeof coating.pattern, number>;
      cameraDraw('surface', programs.surface, target, { src: tex(output), depth: tex(inputs.depth), hasDepth: int(depth === null ? 0 : 1),
        seed: { kind: 'uint', value: scene.doc.seed }, pattern: int(patterns[coating.pattern]),
        relief: float(coating.relief), refraction: float(coating.refraction), shine: float(coating.shine), scale: float(coating.scale),
        phase: float(loopPhase(index, frameCount(scene.doc.motion, LOOP_FPS))),
        cameraDirection: { kind: 'vec3', value: [drawCamera.x / parallaxMargin(scene.doc.motion.parallax), -drawCamera.y / parallaxMargin(scene.doc.motion.parallax), 1] } });
      output = target;
    }
    if (style.grain !== 0 || style.colorNoise !== 0) {
      const target = other(output);
      cameraDraw('grain', programs.grain, target, { src: tex(output), label: tex(inputs.label),
        seed: { kind: 'uint', value: scene.doc.seed }, hold: { kind: 'uint', value: holdIndex(index, frameCount(scene.doc.motion, LOOP_FPS), style.grainHold) },
        grainSize: int(style.grainSize), amount: float(style.grain), colorNoise: float(style.colorNoise), clarity: { kind: 'floatArray', value: clarity } });
      output = target;
    }
    if (style.clipping !== 0) {
      const target = other(output);
      cameraDraw('clipping', programs.clip, target, { src: tex(output), amount: float(style.clipping) });
      output = target;
    }
    if (style.crunch !== 0) {
      if (crunchBuffers === null) {
        // Edge-replicate incomplete 8x8 blocks, retaining all coefficients.
        const pad = (n: number): number => Math.ceil(n / 8) * 8;
        const w = pad(canvas.width), h = pad(canvas.height), cw = pad(Math.ceil(canvas.width / 2)), ch = pad(Math.ceil(canvas.height / 2));
        crunchBuffers = { y: [gpu.target(w, h, 'r16f'), gpu.target(w, h, 'r16f')], c: [gpu.target(cw, ch, 'rg16f'), gpu.target(cw, ch, 'rg16f')] };
      }
      const quality = crunchQuality(style.crunch);
      for (const [name, targets, table, chroma] of [
        ['y', crunchBuffers.y, LUMA_TABLE, 0], ['chroma', crunchBuffers.c, CHROMA_TABLE, 1],
      ] satisfies readonly (readonly [string, readonly [Target, Target], readonly number[], number])[]) {
        const [a, b] = targets;
        cameraDraw(`${name}.extract`, programs.extract, a, { src: tex(output), chroma: int(chroma) });
        cameraDraw(`${name}.row-dct`, programs.rowDct, b, { src: tex(a) });
        cameraDraw(`${name}.column-dct-quantize`, programs.columnDct, a, { src: tex(b), table: { kind: 'floatArray', value: qualityTable(table, quality) } });
        cameraDraw(`${name}.column-idct`, programs.columnIdct, b, { src: tex(a) });
        cameraDraw(`${name}.row-idct`, programs.rowIdct, a, { src: tex(b) });
      }
      const target = other(output);
      cameraDraw('crunch.combine', programs.combine, target, { luma: tex(crunchBuffers.y[0]), chroma: tex(crunchBuffers.c[0]) });
      output = target;
    }
    const selectedId = scene.selected;
    const selected = selectedId === null ? -1 : scene.doc.objects.findIndex((object) => object.id === selectedId);
    selectionSource = output;
    if (showSelection && selected >= 0) {
      const box = canvas.getBoundingClientRect();
      // Camera passes swap these targets; never sample the selection target.
      const target = other(output);
      gpu.draw(programs.select, target, { src: tex(output), label: tex(inputs.label), selected: int(selected + 1),
        pixelStep: { kind: 'ivec2', value: [Math.max(1, Math.round(canvas.width / (box.width || canvas.width))),
          Math.max(1, Math.round(canvas.height / (box.height || canvas.height)))] } });
      output = target;
    }
    finalTarget = output;
    if (profiling && probe !== null) {
      gl.finish(); cameraCosts.present = probe.measure(() => gpu.draw(programs.present, null, { src: tex(output) }), () => gl.finish());
    } else gpu.draw(programs.present, null, { src: tex(output) });
    if (NOISY_DEV) {
      const error = gl.getError();
      if (error !== gl.NO_ERROR) { checkLive(); throw new Error(`The ${loop ? 'loop' : 'still'} render failed (WebGL 0x${error.toString(16)}).`); }
    }
    if (probe !== null) probe.end(start, loop ? index : null);
    lastRender = { frame: index, loop, camera, showSelection };
  }
  function selectionPixel(x: number, y: number) {
    checkLive();
    if (![x, y].every(Number.isInteger) || x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) {
      throw new Error('The selection pixel is outside the master.');
    }
    // Offscreen targets survive the browser clearing its default framebuffer.
    if (finalTarget === null || selectionSource === null) throw new Error('Open a photo before reading the selection.');
    const read = (target: Target): readonly number[] => {
      const bytes = new Uint8Array(4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      return Array.from(bytes.subarray(0, 3));
    };
    const color = read(finalTarget), undimmed = read(selectionSource);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`The selection readback failed (WebGL 0x${error.toString(16)}).`);
    return { color, undimmed };
  }
  function geometryPixel(x: number, y: number): { readonly color: readonly number[]; readonly label: number } {
    checkLive();
    if (gbuffer === null || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) {
      throw new Error('The geometry pixel is unavailable.');
    }
    const color = new Uint8Array(4), id = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, gbuffer.color.framebuffer);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, color);
    gl.bindFramebuffer(gl.FRAMEBUFFER, gbuffer.label.framebuffer);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, id);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`The geometry readback failed (WebGL 0x${error.toString(16)}).`);
    return { color: Array.from(color.subarray(0, 3)), label: id[0] ?? 0 };
  }
  function readGeometryPatch(x: number, y: number, w: number, h: number): Uint8Array {
    checkLive();
    if (gbuffer === null || ![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w < 1 || h < 1 ||
      x + w > canvas.width || y + h > canvas.height) throw new Error('The geometry patch is unavailable or outside the master.');
    const bytes = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, gbuffer.label.framebuffer);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`The geometry patch readback failed (WebGL 0x${error.toString(16)}).`);
    return bytes;
  }
  function geometryEdgesCovered(): boolean { return exportedEdges ?? readGeometryEdges(); }
  function readGeometryEdges(): boolean {
    checkLive();
    if (gbuffer === null) throw new Error('Render a moving frame before reading its geometry.');
    const { width, height } = gbuffer.label;
    gl.bindFramebuffer(gl.FRAMEBUFFER, gbuffer.label.framebuffer);
    const row = new Uint8Array(width * 4), column = new Uint8Array(height * 4);
    for (const y of [0, height - 1]) {
      gl.readPixels(0, y, width, 1, gl.RGBA, gl.UNSIGNED_BYTE, row);
      for (let i = 3; i < row.length; i += 4) if (row[i] !== 255) return false;
    }
    for (const x of [0, width - 1]) {
      gl.readPixels(x, 0, 1, height, gl.RGBA, gl.UNSIGNED_BYTE, column);
      for (let i = 3; i < column.length; i += 4) if (column[i] !== 255) return false;
    }
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`The geometry border readback failed (WebGL 0x${error.toString(16)}).`);
    return true;
  }
  function exportFrame(frame: number): Promise<Blob> {
    checkLive();
    const restore = lastRender;
    renderFrame(frame, false);
    exportedEdges = scene !== null && effectiveOrbit(scene.doc.motion) > 0 && !plateNeeded(scene.doc) ? readGeometryEdges() : null;
    try {
      return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => {
        if (blob === null) reject(new Error('The loop PNG could not be encoded.'));
        else resolve(blob);
      }, 'image/png'));
    } finally { render(restore.frame, restore.loop, restore.showSelection, restore.camera); }
  }
  function exportView(camera: Vec2, frame = 0): Promise<Blob> {
    checkLive();
    const restore = lastRender;
    renderView(camera, frame, false);
    try {
      return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => {
        if (blob === null) reject(new Error('The view PNG could not be encoded.'));
        else resolve(blob);
      }, 'image/png'));
    } finally { render(restore.frame, restore.loop, restore.showSelection, restore.camera); }
  }
  function exportStill(): Promise<Blob>;
  function exportStill(capture: LoopCapture): void;
  function exportStill(capture?: LoopCapture): Promise<Blob> | void {
    checkLive();
    const restore = lastRender;
    try {
      if (capture === undefined) renderStill(false);
      else renderFrame(capture.frame, false);
      if (capture !== undefined) {
        const context = capture.canvas.getContext('2d', { alpha: false, willReadFrequently: true });
        if (context === null) throw new Error('The loop export canvas could not be created.');
        context.drawImage(canvas, 0, 0, capture.canvas.width, capture.canvas.height);
        return;
      }
      // toBlob snapshots at invocation; restore before the browser paints.
      return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => {
        if (blob === null) reject(new Error('The rendered PNG could not be encoded.'));
        else resolve(blob);
      }, 'image/png'));
    } finally { render(restore.frame, restore.loop, restore.showSelection, restore.camera); }
  }
  return {
    setScene, renderStill,
    renderFrame, renderView, exportView,
    exportStill,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener('webglcontextlost', onContextLost);
      gpu.dispose(); scene = null; buffers = null; cellBuffers = null; crunchBuffers = null; finalTarget = null; selectionSource = null; master = null; plate = null; depth = null; lut = null; palette = null;
    },
    debug: probe === null ? null : { ...probe.debug, readGeometryPatch,
      motionCamera: () => ({ ...renderedCamera }),
      setMotionFeather: (enabled: boolean): void => { featherEnabled = enabled; },
    },
  };
}
