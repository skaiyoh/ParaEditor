import { layers, maskCovers, holeMask, holeRadius, anchorDisparity, cameraRadius, parallaxClamp, plateNeeded } from '../core/derive.ts';
import type { EffectId, ObjectId } from '../core/ids.ts';
import type { Plane } from '../core/raster.ts';
import { frameCount, loopPhase, cameraOffset, parallaxDisplacement, effectiveOrbit, loopZoom, parallaxMargin } from '../core/motion.ts';
import type { Vec2 } from '../core/motion.ts';
import { createPerspectiveGeometry, constrainEye } from '../core/perspective.ts';
import { liveCoverage } from '../core/live-coverage.ts';
import { sortedMasks } from '../core/produce.ts';
import { LOOP_FPS, wrapFrame } from './loop.ts';
import { backGrid, objectGrid, meshProjectionScale } from './mesh.ts';
import { geometry, geometryVertex, geometryCoverage, perspectiveGeometry, perspectiveVertex, perspectiveCoverage } from './shaders/geometry.ts';
import { backsource } from './shaders/backsource.ts';
import { fillBackgroundDepth } from './shaders/pushpull.ts';
import { holdIndex } from './grain.ts';
import { LUMA_TABLE, CHROMA_TABLE, crunchQuality, qualityTable } from './crunch.ts';
import { createRenderProbe, type CellReadback } from './debug.ts';
import { createGl, type Target, type Texture, type Uniform } from './gl.ts';
import { documentPalette, type Palette } from './palette.ts';
import type { Renderer, RenderScene, PerspectiveRenderRequest, PerspectiveRenderResult, PerspectiveHit } from './types.ts';
import { down } from './shaders/down.ts';
import { tensor } from './shaders/tensor.ts';
import { blur } from './shaders/blur.ts';
import { akf } from './shaders/akf.ts';
import { dog } from './shaders/dog.ts';
import { up } from './shaders/up.ts';
import { quantize } from './shaders/quantize.ts';
import { outline, OUTLINE_SLOPE_PER_WORKING_TEXEL } from './shaders/outline.ts';
import { present, copy, sourceLookup } from './shaders/present.ts';
import { parseSrgbChannels } from '../core/color.ts';
import { samplePixel, type CompareMode, type SampleColorRequest, type SampleColorResult } from './compare.ts';
import { select } from './shaders/select.ts';
import { grain, grainHashReadback } from './shaders/grain.ts';
import { clip } from './shaders/clip.ts';
import { crunchExtract, crunchRowDct, crunchColumnDct, crunchColumnIdct, crunchRowIdct, crunchCombine } from './shaders/crunch.ts';
import { ATLAS_SIZE, GLYPHS, glyphAtlas, cellGrid } from './symbols.ts';
import { cellsReduce } from './shaders/cells-reduce.ts';
import { cellsDraw } from './shaders/cells-draw.ts';
import { surface, surfaceLookup } from './shaders/surface.ts';
import { LOCAL_EFFECT_BATCH, prepareLocalEffects, type PreparedLocalEffect } from './local-effects.ts';
import { localEffects, localCoverage, stillLookup } from './shaders/local-effects.ts';
import type { LocalEffectReadback } from './types.ts';

const tex = (value: Texture): Uniform => ({ kind: 'texture', value });
const float = (value: number): Uniform => ({ kind: 'float', value });
const int = (value: number): Uniform => ({ kind: 'int', value });
const DIVISOR = 4;
type Grid = { readonly low: Target; readonly tensor: Target; readonly blur: Target; readonly a: Target; readonly b: Target };
type Buffers = { readonly grid: Grid; readonly simplified: Target; readonly quantized: Target; readonly final: Target };
type CrunchBuffers = { readonly y: readonly [Target, Target]; readonly c: readonly [Target, Target] };
type CellBuffers = { readonly variant: Target; readonly cells: Target; readonly decisions: Target; readonly size: number };
type LiveBuffers = { readonly color: Target; readonly label: Target; readonly depth: Target; readonly source: Target; readonly composite: Target };
type Lookup = { readonly label: Target; readonly source: Target };
type LiveProducts = {
  readonly identity: NonNullable<RenderScene['livePlate']> | null;
  readonly depthIdentity: RenderScene['depth']; readonly labels: string;
  readonly image: Texture | null; readonly hole: Texture;
  readonly depth: Texture; readonly objectDepths: ReadonlyMap<ObjectId, Texture>;
  readonly backgroundPlane: Plane<'f32'>; readonly objectPlanes: ReadonlyMap<ObjectId, Plane<'f32'>>;
  readonly background: Target | null; readonly simplified: Target | null;
  readonly limitation: string | null; dirty: boolean;
  projectionKey: string; projectionScale: number;
};

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
  let livePrograms: { geometry: ReturnType<typeof gpu.program>; coverage: ReturnType<typeof gpu.program>; surfaceLookup: ReturnType<typeof gpu.program> } | null = null;
  function makePrograms() {
    return {
      geometry: gpu.program(geometry, geometryVertex), coverage: gpu.program(geometryCoverage, geometryVertex), backsource: gpu.program(backsource),
      down: gpu.program(down), tensor: gpu.program(tensor), blur: gpu.program(blur), akf: gpu.program(akf),
      dog: gpu.program(dog), up: gpu.program(up), quantize: gpu.program(quantize), outline: gpu.program(outline), present: gpu.program(present), copy: gpu.program(copy), select: gpu.program(select),
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
  let liveBuffers: LiveBuffers | null = null;
  let liveWarp: { label: Target; source: Target } | null = null;
  let lastLiveLookup: { label: Target; source: Target } | null = null;
  let liveProducts: LiveProducts | null = null;
  const backMesh = gpu.mesh(backGrid());
  const objectMeshes = new Map<ObjectId, { key: string; mesh: ReturnType<typeof gpu.mesh>; mask: Plane<'u8'>; texture: Texture }>();
  let hasRendered = false;
  let sourcePrograms: { lookup: ReturnType<typeof gpu.program>; warp: ReturnType<typeof gpu.program>; still: ReturnType<typeof gpu.program> } | null = null;
  let localPrograms: { effects: ReturnType<typeof gpu.program>; coverage: ReturnType<typeof gpu.program> } | null = null;
  let legacyLookup: Lookup | null = null;
  let legacyWarp: Lookup | null = null;
  let lastFrameLookup: Lookup | null = null;
  let localBefore: Target | null = null;
  let localCoverageTarget: Target | null = null;
  let appliedLocalEffects = false;
  let preparedLocalEffects: readonly PreparedLocalEffect[] = [];
  const scopeTextures = new Map<Plane<'u8'>, Texture>();
  let lastRender: { compare: CompareMode; frame: number; loop: boolean; camera: Vec2 | null; showSelection: boolean; perspective: PerspectiveRenderRequest | null } =
    { compare: 'edited', frame: 0, loop: false, camera: null, showSelection: true, perspective: null };
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
    endPerspective();
    releaseLocalTargets();
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
  function endPerspective(): void {
    hasRendered = false;
    lastFrameLookup = null; appliedLocalEffects = false;
    releaseLiveProducts();
    if (liveBuffers !== null) for (const target of Object.values(liveBuffers)) gpu.release(target);
    if (liveWarp !== null) for (const target of Object.values(liveWarp)) gpu.release(target);
    liveBuffers = null; liveWarp = null; lastLiveLookup = null;
    lastRender = { ...lastRender, perspective: null };
  }
  function perspectiveResources(): { readonly targets: number; readonly textures: number } {
    return { targets: (liveBuffers === null ? 0 : 5) + (liveWarp === null ? 0 : 2) +
      (liveProducts?.background === null || liveProducts === null ? 0 : 1) + (liveProducts?.simplified === null || liveProducts === null ? 0 : 1),
      textures: liveProducts === null ? 0 : 2 + (liveProducts.image === null ? 0 : 1) + liveProducts.objectDepths.size };
  }
  function releaseLiveProducts(): void {
    if (liveProducts === null) return;
    for (const resource of [liveProducts.image, liveProducts.hole, liveProducts.depth, liveProducts.background, liveProducts.simplified]) {
      if (resource !== null) gpu.release(resource);
    }
    for (const resource of liveProducts.objectDepths.values()) gpu.release(resource);
    liveProducts = null;
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
    if (next.compositing === 'scene-depth' || 'compositing' in next.doc && next.doc.compositing === 'scene-depth') {
      throw new Error('Scene-depth composition is not available in C2; physical layer depth requires C3.');
    }
    const nextEffects = prepareLocalEffects(next.localEffects ?? [], next.doc.objects);
    const maxSize: unknown = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (typeof maxSize !== 'number') checkLive();
    if (typeof maxSize !== 'number' || next.master.width > maxSize || next.master.height > maxSize) throw new Error('The photo exceeds this WebGL2 device’s texture limit.');
    for (const effect of nextEffects) if (effect.plane !== null &&
      (effect.plane.size.width > maxSize || effect.plane.size.height > maxSize)) {
      throw new Error('The local selection exceeds this device’s texture limit.');
    }
    hasRendered = false;
    lastFrameLookup = null; appliedLocalEffects = false;
    if (scene?.master !== next.master) {
      endPerspective();
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
    if (dirty) { backDirty = true; if (liveProducts !== null) liveProducts.dirty = true; }
    exportedEdges = null;
    // A hit may only describe a draw of this exact scene, not a preceding edit.
    lastRender = { ...lastRender, perspective: null };
    updateScopeTextures(nextEffects);
    preparedLocalEffects = nextEffects;
    scene = next;
  }

  function prepareLiveProducts(): LiveProducts {
    if (scene === null) throw new Error('Open a photo before preparing perspective.');
    const identity = scene.livePlate ?? null;
    if (liveProducts !== null && liveProducts.identity === identity && liveProducts.depthIdentity === scene.depth && liveProducts.labels === labelKey) return liveProducts;
    releaseLiveProducts();
    const allocated: Texture[] = [];
    const keep = <T extends Texture>(resource: T): T => { allocated.push(resource); return resource; };
    try {
      const plane = scene.depth ?? { format: 'f32', size: { width: 1, height: 1 }, data: new Float32Array(1) } satisfies Plane<'f32'>;
      let background = plane;
      let image: Texture | null = null, holeTexture: Texture | null = null;
      const objectDepths = new Map<ObjectId, Texture>();
      const objectPlanes = new Map<ObjectId, Plane<'f32'>>();
      let limitation: string | null = scene.depth === null ? 'Depth is not ready' : null;
      if (scene.doc.objects.length > 0 && identity === null) limitation = 'Preparing background coverage';
      if (identity !== null) {
        const { image: plateImage, hole: plateHole } = identity;
        if (plateImage.size.width !== scene.master.width || plateImage.size.height !== scene.master.height ||
          plateHole.size.width !== scene.master.width || plateHole.size.height !== scene.master.height ||
          plateImage.data.length !== scene.master.width * scene.master.height * 3 ||
          plateHole.data.length !== scene.master.width * scene.master.height || identity.depth !== scene.depth) {
          throw new Error('The live background does not match this photo and depth.');
        }
        const bytes = new Uint8Array(scene.master.width * scene.master.height * 4);
        for (let i = 0; i < bytes.length / 4; i++) { bytes.set(plateImage.data.subarray(i * 3, i * 3 + 3), i * 4); bytes[i * 4 + 3] = 255; }
        image = keep(gpu.texture(scene.master.width, scene.master.height, 'rgba8', bytes));
        holeTexture = keep(gpu.texture(plateHole.size.width, plateHole.size.height, 'r8', plateHole.data));
        const data = new Uint8Array(plane.data.length);
        for (let y = 0; y < plane.size.height; y++) for (let x = 0; x < plane.size.width; x++) {
          const hx = Math.min(plateHole.size.width - 1, Math.floor((x + .5) * plateHole.size.width / plane.size.width));
          const hy = Math.min(plateHole.size.height - 1, Math.floor((y + .5) * plateHole.size.height / plane.size.height));
          data[y * plane.size.width + x] = plateHole.data[hy * plateHole.size.width + hx] ?? 0;
        }
        background = fillBackgroundDepth(plane, { format: 'u8', size: plane.size, data });
      }
      // Known silhouettes get their own extended depth, so a foreground triangle cannot
      // sample the original background just outside its mask and stretch across that jump.
      for (const object of scene.doc.objects) {
        if (object.hidden) continue;
        const mask = scene.masks.get(object.id);
        if (mask === undefined) continue;
        const data = new Uint8Array(plane.data.length);
        for (let y = 0; y < plane.size.height; y++) for (let x = 0; x < plane.size.width; x++) {
          data[y * plane.size.width + x] = maskCovers(mask, { x: (x + .5) / plane.size.width, y: (y + .5) / plane.size.height }) ? 0 : 255;
        }
        const ownDepth = fillBackgroundDepth(plane, { format: 'u8', size: plane.size, data });
        objectDepths.set(object.id, keep(gpu.texture(ownDepth.size.width, ownDepth.size.height, 'r16f', ownDepth.data, true)));
        objectPlanes.set(object.id, ownDepth);
      }
      liveProducts = {
        identity, depthIdentity: scene.depth, labels: labelKey, image,
        hole: holeTexture ?? keep(gpu.texture(1, 1, 'r8', new Uint8Array(1))),
        depth: keep(gpu.texture(background.size.width, background.size.height, 'r16f', background.data, true)), objectDepths,
        backgroundPlane: background, objectPlanes,
        background: image === null ? null : keep(gpu.target(scene.master.width, scene.master.height)),
        simplified: image === null ? null : keep(gpu.target(scene.master.width, scene.master.height, false, true)),
        limitation, dirty: true, projectionKey: '', projectionScale: 0,
      };
      return liveProducts;
    } catch (error) { for (const resource of allocated) gpu.release(resource); throw error; }
  }

  function perspectiveInputs(request: PerspectiveRenderRequest, cells: CellBuffers | null, treatments: boolean): LiveBuffers {
    if (scene === null || buffers === null || master === null) throw new Error('Open a photo before rendering perspective.');
    if (livePrograms === null) {
      const count: unknown = gl.getParameter(gl.MAX_DRAW_BUFFERS), attachments: unknown = gl.getParameter(gl.MAX_COLOR_ATTACHMENTS);
      if (typeof count !== 'number' || count < 4 || typeof attachments !== 'number' || attachments < 4) {
        throw new Error('Perspective picking requires four WebGL2 color attachments.');
      }
      const geometryProgram = gpu.program(perspectiveGeometry, perspectiveVertex);
      let coverageProgram: ReturnType<typeof gpu.program> | null = null;
      try {
        coverageProgram = gpu.program(perspectiveCoverage, perspectiveVertex);
        livePrograms = { geometry: geometryProgram, coverage: coverageProgram, surfaceLookup: gpu.program(surfaceLookup) };
      } catch (error) {
        gpu.releaseProgram(geometryProgram);
        if (coverageProgram !== null) gpu.releaseProgram(coverageProgram);
        throw error;
      }
    }
    if (liveBuffers === null) {
      const allocated: Target[] = [];
      const target = (depth = false): Target => { const value = gpu.target(canvas.width, canvas.height, depth ? 'r16f' : false); allocated.push(value); return value; };
      try {
        const prepared = { color: target(), label: target(), depth: target(true), source: target(), composite: target() };
        gpu.attachMany(prepared.color, [prepared.label, prepared.depth, prepared.source]); gpu.attachDepth(prepared.color);
        liveBuffers = prepared;
      } catch (error) { for (const resource of allocated) gpu.release(resource); throw error; }
    }
    const prepared = prepareLiveProducts();
    lastLiveLookup = { label: liveBuffers.label, source: liveBuffers.source };
    const validBackground = liveBackgroundMatches(prepared, request);
    if (prepared.dirty && prepared.image !== null && prepared.background !== null && prepared.simplified !== null) {
      gpu.draw(programs.backsource, prepared.background, { master: tex(master), plate: tex(prepared.image), hole: tex(prepared.hole) });
      if (treatments) {
        simplify(prepared.background, prepared.simplified, buffers.grid, scene.doc.style.simplify, { label: backgroundLabel, clarity: backgroundClarity });
        prepared.dirty = false;
      }
    }
    const { geometry: config, eye } = request;
    const uniforms = {
      apertureCenter: { kind: 'vec3', value: [config.aperture.center.x, config.aperture.center.y, 0] },
      apertureSizeCrop: { kind: 'vec3', value: [config.aperture.width, config.aperture.height, config.crop] },
      depthFactors: { kind: 'vec3', value: [config.nearFactor, config.farFactor, config.neutralDistance] },
      eye: { kind: 'vec3', value: [eye.x, eye.y, eye.z] },
      hole: tex(validBackground ? prepared.hole : backgroundLabel),
    } satisfies Record<string, Uniform>;
    const target = liveBuffers, coverageProgram = livePrograms.coverage;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.composite.framebuffer);
    gl.clearBufferfv(gl.COLOR, 0, new Float32Array([0, 0, 0, 1]));
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.color.framebuffer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2, gl.COLOR_ATTACHMENT3]);
    for (let i = 0; i < 4; i++) gl.clearBufferfv(gl.COLOR, i, new Float32Array(4));
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthRange(0, 1 - 1 / 65535); gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
    const cover = (mesh: ReturnType<typeof gpu.mesh>, mask: Texture, objectId: number, plane: Texture): void => {
      if (!featherEnabled) return;
      gl.disable(gl.DEPTH_TEST);
      const styled = treatments ? stylize(target, cells) : copyColor(target.color);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.color.framebuffer);
      // Keep the four-attachment WebGL2 floor: temporarily route only color
      // coverage to slot 3, preserving the source-UV texture for exact picking.
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT3, gl.TEXTURE_2D, target.composite.texture, 0);
      gl.drawBuffers([gl.NONE, gl.NONE, gl.NONE, gl.COLOR_ATTACHMENT3]);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.EQUAL); gl.depthMask(false);
      gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
      try {
        gpu.draw(coverageProgram, target.color, { ...uniforms, styled: tex(styled), mask: tex(mask), objectId: int(objectId),
          depthPlane: tex(plane), masterSize: { kind: 'ivec2', value: [canvas.width, canvas.height] } }, mesh);
      } finally {
        gl.disable(gl.BLEND); gl.depthMask(true); gl.depthFunc(gl.LESS);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT3, gl.TEXTURE_2D, target.source.texture, 0);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2, gl.COLOR_ATTACHMENT3]);
      }
    };
    try {
      gpu.draw(livePrograms.geometry, liveBuffers.color, { ...uniforms,
        simplified: tex(treatments ? (validBackground ? prepared.simplified ?? buffers.simplified : buffers.simplified) :
          (validBackground ? prepared.background ?? master : master)),
        depthPlane: tex(validBackground ? prepared.depth : depth ?? prepared.depth), mask: tex(label), objectId: int(0) }, backMesh);
      cover(backMesh, label, 0, validBackground ? prepared.depth : depth ?? prepared.depth);
      for (const layer of layers(scene.doc)) {
        if (layer.kind === 'plate') continue;
        const entry = objectMeshes.get(layer.object.id);
        if (entry === undefined) continue;
        gl.clear(gl.DEPTH_BUFFER_BIT);
        gpu.draw(livePrograms.geometry, liveBuffers.color, { ...uniforms, simplified: tex(treatments ? buffers.simplified : master),
          depthPlane: tex(validBackground ? prepared.objectDepths.get(layer.object.id) ?? prepared.depth : depth ?? prepared.depth),
          mask: tex(entry.texture), objectId: int(scene.doc.objects.indexOf(layer.object) + 1) }, entry.mesh);
        cover(entry.mesh, entry.texture, scene.doc.objects.indexOf(layer.object) + 1,
          validBackground ? prepared.objectDepths.get(layer.object.id) ?? prepared.depth : depth ?? prepared.depth);
      }
    } finally { gl.disable(gl.DEPTH_TEST); gl.depthRange(0, 1); }
    return liveBuffers;
  }

  function liveLimitation(prepared: LiveProducts, request: PerspectiveRenderRequest): string | null {
    if (!liveBackgroundMatches(prepared, request)) {
      return 'Preparing background coverage';
    }
    if (scene !== null) {
      const key = JSON.stringify(request.geometry);
      if (key !== prepared.projectionKey) {
        prepared.projectionKey = key;
        prepared.projectionScale = meshProjectionScale(backGrid(), prepared.backgroundPlane, request.geometry);
        for (const object of scene.doc.objects) {
          const plane = prepared.objectPlanes.get(object.id);
          if (!object.hidden && plane !== undefined) prepared.projectionScale = Math.min(prepared.projectionScale,
            meshProjectionScale(objectGrid(object.produced.bounds, scene.doc.frame.master.size, parallaxClamp(scene.doc)), plane, request.geometry));
        }
      }
      if (prepared.projectionScale <= 0) return 'Depth geometry is unavailable';
    }
    return prepared.limitation;
  }
  function liveBackgroundMatches(prepared: LiveProducts, request: PerspectiveRenderRequest): boolean {
    return scene !== null && (scene.doc.objects.length === 0 || prepared.identity !== null &&
      prepared.identity.key === liveCoverage(scene.doc, request.geometry)?.key);
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

  function geometryInputs(offset: Vec2, zoom: number, cells: CellBuffers | null, treatments: boolean): { color: Texture; label: Texture; depth: Texture } {
    if (scene === null || buffers === null || master === null) throw new Error('Open a photo before rendering.');
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
      const styled = treatments ? stylize(target, cells) : copyColor(target.color);
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
      gpu.draw(programs.geometry, target.color, { ...displacement, simplified: tex(treatments ? plateSimplified ?? buffers.simplified : backSource ?? master),
        depthPlane: tex(backgroundDepth ?? depth ?? label), mask: tex(label), objectId: int(0) }, backMesh);
      cover(backMesh, label, 0, backgroundDepth ?? depth ?? label);
      for (const layer of layers(scene.doc)) {
        if (layer.kind === 'plate') continue;
        const entry = objectMeshes.get(layer.object.id);
        if (entry === undefined) continue;
        // Layer order still owns inter-object occlusion; depth resolves folds
        // within each mesh independently.
        gl.clear(gl.DEPTH_BUFFER_BIT);
        gpu.draw(programs.geometry, target.color, { ...displacement, simplified: tex(treatments ? buffers.simplified : master),
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
  function copyColor(source: Texture): Target {
    if (buffers === null) throw new Error('Open a photo before comparing.');
    gpu.draw(programs.copy, buffers.final, { src: tex(source) });
    return buffers.final;
  }
  function setCompare(compare: CompareMode): void {
    const previous = lastRender;
    try { render(previous.frame, previous.loop, previous.showSelection, previous.camera, previous.perspective, compare); }
    catch (error) {
      try { restoreRender(previous); } catch { /* The session reports the original render failure. */ }
      throw error;
    }
  }
  function restoreRender(previous: typeof lastRender): void {
    render(previous.frame, previous.loop, previous.showSelection, previous.camera, previous.perspective, previous.compare);
  }
  function renderStill(showSelection = true): void { render(0, false, showSelection); }
  function renderFrame(frame: number, showSelection = true): void { render(frame, true, showSelection); }
  function renderView(camera: Vec2, frame = 0, showSelection = true): void { render(frame, true, showSelection, camera); }
  function renderPerspective(request: PerspectiveRenderRequest): PerspectiveRenderResult {
    checkLive();
    const geometry = createPerspectiveGeometry(request.geometry);
    if (![request.sceneGeneration, request.viewId].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error('The perspective view identity is invalid.');
    if (!Number.isFinite(request.eye.z) || Math.abs(request.eye.z - geometry.neutralDistance) > 1e-9) {
      throw new Error('Live perspective currently requires the calibrated fixed viewing distance.');
    }
    const frame = request.frame ?? 0;
    if (!Number.isSafeInteger(frame) || frame < 0) throw new Error('The perspective frame must be a nonnegative integer.');
    try {
      const prepared = prepareLiveProducts();
      const limitation = liveLimitation(prepared, request);
      if (scene?.doc.objects.some((object) => object.hidden) === true && !liveBackgroundMatches(prepared, request)) {
        // Legacy still rendering already owns authored visibility and its saved plate.
        // Until live coverage matches, preserve that composition instead of revealing the original object.
        renderStill(request.showSelection ?? true);
        return { kind: 'limited', reason: limitation ?? 'Preparing background coverage' };
      }
      const fullEye = constrainEye(request.eye, geometry);
      const eye = { x: fullEye.x * prepared.projectionScale, y: fullEye.y * prepared.projectionScale, z: fullEye.z };
      const snapshot: PerspectiveRenderRequest = { geometry,
        eye: limitation === null ? eye : { x: 0, y: 0, z: geometry.neutralDistance },
        sceneGeneration: request.sceneGeneration, viewId: request.viewId, frame, showSelection: request.showSelection ?? true };
      render(frame, true, snapshot.showSelection ?? true, null, snapshot);
      return limitation === null ? { kind: 'rendered', eye, travelScale: prepared.projectionScale,
        reason: prepared.projectionScale < 1 ? 'Travel reduced to preserve depth edges' : null } : { kind: 'limited', reason: limitation };
    } catch (error) {
      // Preserve an inspectable still if live-only program/attachment preparation fails.
      try { renderStill(); } catch { /* The existing session error path owns context-loss status. */ }
      throw error;
    }
  }
  function render(frame: number, loop: boolean, showSelection: boolean, camera: Vec2 | null = null,
    perspective: PerspectiveRenderRequest | null = null, compare: CompareMode = lastRender.compare): void {
    checkLive();
    if (scene === null || buffers === null || master === null || palette === null || lut === null) throw new Error('Open a photo before rendering.');
    hasRendered = false;
    lastFrameLookup = null; appliedLocalEffects = false;
    if (compare === 'source-photo') {
      finalTarget = selectionSource = copyColor(master);
      gpu.draw(programs.present, null, { src: tex(finalTarget) });
      checkRenderError();
      lastRender = { frame, loop, showSelection, camera: camera === null ? null : { ...camera }, perspective, compare };
      hasRendered = true;
      return;
    }
    const treatments = compare === 'edited';
    if (camera !== null) {
      if (!Number.isFinite(camera.x) || !Number.isFinite(camera.y)) throw new Error('The camera offset must contain finite frame fractions.');
      const reach = parallaxClamp(scene.doc);
      camera = { x: Math.max(-reach, Math.min(reach, camera.x)), y: Math.max(-reach, Math.min(reach, camera.y)) };
    }
    const index = loop && (camera === null || depth !== null) ? wrapFrame(frame, frameCount(scene.doc.motion, LOOP_FPS)) : 0;
    const moving = camera !== null ? depth !== null : loop && effectiveOrbit(scene.doc.motion) > 0 && !plateNeeded(scene.doc);
    const start = probe?.begin() ?? 0;
    if (dirty && treatments) {
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
      if (treatments) {
        simplify(backSource, plateSimplified, buffers.grid, scene.doc.style.simplify, { label: backgroundLabel, clarity: backgroundClarity });
        backDirty = false;
      }
    }
    const drawCamera = moving ? camera ?? cameraOffset(cameraRadius(scene.doc), loopPhase(index, frameCount(scene.doc.motion, LOOP_FPS)), scene.doc.motion.drift.direction) : { x: 0, y: 0 };
    renderedCamera = drawCamera;
    const cells = treatments && scene.doc.symbols.enabled ? ensureCells(canvas.width, canvas.height, scene.doc.symbols.cellSize) : null;
    const hiding = plate !== null && scene.doc.objects.some((object) => object.hidden);
    const inputs = perspective !== null ? perspectiveInputs(perspective, cells, treatments) : moving || hiding ? geometryInputs(drawCamera, moving ? loopZoom(scene.doc.motion.parallax) : 1, cells, treatments) :
      { color: treatments ? buffers.simplified : master, label, depth: depth ?? label };
    let displayLabel: Texture = inputs.label;
    const composite = perspective !== null ? liveBuffers?.composite : moving || hiding ? gbuffer?.composite : undefined;
    const styled = featherEnabled && composite !== undefined ? composite : treatments ? stylize(inputs, cells) : copyColor(inputs.color);
    const { style } = scene.doc;
    const currentBuffers = buffers;
    let output = styled;
    const other = (input: Target): Target => input === currentBuffers.final ? currentBuffers.quantized : currentBuffers.final;
    const coating = scene.doc.surface;
    if (treatments && coating.enabled && (coating.relief !== 0 || coating.refraction !== 0 || coating.shine !== 0)) {
      const target = other(output);
      const patterns = { bars: 0, cracks: 1, scales: 2 } satisfies Record<typeof coating.pattern, number>;
      cameraDraw('surface', programs.surface, target, { src: tex(output), depth: tex(inputs.depth), hasDepth: int(depth === null ? 0 : 1),
        seed: { kind: 'uint', value: scene.doc.seed }, pattern: int(patterns[coating.pattern]),
        relief: float(coating.relief), refraction: float(coating.refraction), shine: float(coating.shine), scale: float(coating.scale),
        phase: float(loopPhase(index, frameCount(scene.doc.motion, LOOP_FPS))),
        cameraDirection: { kind: 'vec3', value: perspective === null
          ? [drawCamera.x / parallaxMargin(scene.doc.motion.parallax), -drawCamera.y / parallaxMargin(scene.doc.motion.parallax), 1]
          : [perspective.eye.x / perspective.eye.z, perspective.eye.y / perspective.eye.z, 1] } });
      output = target;
      if (perspective !== null && coating.refraction > 0 && coating.relief > 0 && liveBuffers !== null && livePrograms !== null) {
        if (liveWarp === null) {
          const label = gpu.target(canvas.width, canvas.height);
          let source: Target | null = null;
          try {
            source = gpu.target(canvas.width, canvas.height); gpu.attach(label, source);
            liveWarp = { label, source };
          } catch (error) { gpu.release(label); if (source !== null) gpu.release(source); throw error; }
        }
        gpu.draw(livePrograms.surfaceLookup, liveWarp.label, { labels: tex(liveBuffers.label), sourceMap: tex(liveBuffers.source),
          seed: { kind: 'uint', value: scene.doc.seed }, pattern: int(patterns[coating.pattern]),
          relief: float(coating.relief), refraction: float(coating.refraction), scale: float(coating.scale),
          phase: float(loopPhase(index, frameCount(scene.doc.motion, LOOP_FPS))) });
        lastLiveLookup = liveWarp; displayLabel = liveWarp.label;
      }
    }
    if (treatments && (style.grain !== 0 || style.colorNoise !== 0)) {
      const target = other(output);
      cameraDraw('grain', programs.grain, target, { src: tex(output), label: tex(displayLabel),
        seed: { kind: 'uint', value: scene.doc.seed }, hold: { kind: 'uint', value: holdIndex(index, frameCount(scene.doc.motion, LOOP_FPS), style.grainHold) },
        grainSize: int(style.grainSize), amount: float(style.grain), colorNoise: float(style.colorNoise), clarity: { kind: 'floatArray', value: clarity } });
      output = target;
    }
    if (treatments && style.clipping !== 0) {
      const target = other(output);
      cameraDraw('clipping', programs.clip, target, { src: tex(output), amount: float(style.clipping) });
      output = target;
    }
    if (treatments && style.crunch !== 0) {
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
    const activeEffects = preparedLocalEffects.filter((effect) => treatments || effect.kind !== 2);
    if (activeEffects.length > 0) {
      const lookup = frameLookup({ frame: index, loop, camera, showSelection, perspective, compare });
      if (NOISY_DEV) {
        localBefore ??= gpu.target(canvas.width, canvas.height);
        gpu.draw(programs.copy, localBefore, { src: tex(output) });
      }
      ensureLocalPrograms();
      if (localPrograms === null) throw new Error('The local operation program is unavailable.');
      for (let index = 0; index < activeEffects.length; index += LOCAL_EFFECT_BATCH) {
        const target = other(output);
        cameraDraw('local-effects', localPrograms.effects, target, { src: tex(output), ...effectUniforms(activeEffects.slice(index, index + LOCAL_EFFECT_BATCH), lookup) });
        output = target;
      }
      appliedLocalEffects = true;
    }
    const selectedId = scene.selected;
    const selected = selectedId === null ? -1 : scene.doc.objects.findIndex((object) => object.id === selectedId);
    selectionSource = output;
    if (treatments && showSelection && selected >= 0) {
      const box = canvas.getBoundingClientRect();
      // Camera passes swap these targets; never sample the selection target.
      const target = other(output);
      gpu.draw(programs.select, target, { src: tex(output), label: tex(displayLabel), selected: int(selected + 1),
        pixelStep: { kind: 'ivec2', value: [Math.max(1, Math.round(canvas.width / (box.width || canvas.width))),
          Math.max(1, Math.round(canvas.height / (box.height || canvas.height)))] } });
      output = target;
    }
    finalTarget = output;
    if (profiling && probe !== null) {
      gl.finish(); cameraCosts.present = probe.measure(() => gpu.draw(programs.present, null, { src: tex(output) }), () => gl.finish());
    } else gpu.draw(programs.present, null, { src: tex(output) });
    checkRenderError();
    if (probe !== null) probe.end(start, loop ? index : null);
    lastRender = { frame: index, loop, camera: camera === null ? null : { ...camera }, showSelection, perspective, compare };
    hasRendered = true;
  }
  // getError blocks on the GPU; per-frame draws check it in dev builds only, as before C1b.
  function checkRenderError(): void {
    if (!NOISY_DEV) return;
    const error = gl.getError();
    if (error !== gl.NO_ERROR) { checkLive(); throw new Error(`The image render failed (WebGL 0x${error.toString(16)}).`); }
  }

  function preserveFramebuffers<T>(read: () => T): T {
    const beforeRead: unknown = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    const beforeDraw: unknown = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
    if (!(beforeRead === null || beforeRead instanceof WebGLFramebuffer) ||
      !(beforeDraw === null || beforeDraw instanceof WebGLFramebuffer)) throw new Error('The render readback state is unavailable.');
    try { return read(); }
    finally {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, beforeRead);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, beforeDraw);
    }
  }
  function readPixel(target: Target, at: Vec2): Uint8Array {
    const bytes = new Uint8Array(4);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.framebuffer);
    gl.readPixels(at.x, at.y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) { checkLive(); throw new Error(`The color sample failed (WebGL 0x${error.toString(16)}).`); }
    return bytes;
  }
  function sampled(bytes: Uint8Array): SampleColorResult {
    const result = parseSrgbChannels({ r: bytes[0] ?? 0, g: bytes[1] ?? 0, b: bytes[2] ?? 0 });
    if (result.kind === 'invalid') throw new Error(result.reason);
    return { kind: 'sampled', color: result.color };
  }
  function sampleColor({ at, source }: SampleColorRequest): SampleColorResult {
    checkLive();
    if (!hasRendered || scene === null || master === null || selectionSource === null) {
      return { kind: 'refused', reason: 'Render the current photo before sampling.' };
    }
    const pixel = samplePixel(at, canvas);
    if (pixel === null) return { kind: 'refused', reason: 'Choose a point inside the image.' };
    const sourceTexture = master;
    const editedTexture = selectionSource;
    return preserveFramebuffers(() => {
      if (source === 'edited') return sampled(readPixel(editedTexture, pixel));
      let sourceUV = at;
      if (lastRender.compare !== 'source-photo') {
        if (lastRender.perspective !== null) {
          const hit = hitTest(at);
          if (hit.kind !== 'original') return { kind: 'refused', reason: hit.kind === 'generated'
            ? 'This pixel was generated and has no source color.' : 'There is no source pixel at this point.' };
          sourceUV = hit.sourceUV;
        } else {
          const hit = legacySourceAt(pixel);
          if (hit.kind === 'refused') return hit;
          sourceUV = hit.at;
        }
      }
      const sourcePixel = samplePixel(sourceUV, sourceTexture);
      if (sourcePixel === null) return { kind: 'refused', reason: 'There is no source pixel at this point.' };
      const framebuffer = gl.createFramebuffer();
      if (framebuffer === null) throw new Error('The source sample framebuffer could not be created.');
      try {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sourceTexture.texture, 0);
        if (gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('The source sample framebuffer is incomplete.');
        return sampled(readPixel({ ...sourceTexture, framebuffer }, sourcePixel));
      } finally { gl.deleteFramebuffer(framebuffer); }
    });
  }
  function ensureSourcePrograms() {
    if (sourcePrograms !== null) return sourcePrograms;
    const allocated: ReturnType<typeof gpu.program>[] = [];
    const keep = (source: string, vertex?: string) => { const value = gpu.program(source, vertex); allocated.push(value); return value; };
    try {
      sourcePrograms = { lookup: keep(sourceLookup, geometryVertex), warp: keep(surfaceLookup), still: keep(stillLookup) };
      return sourcePrograms;
    } catch (error) { for (const value of allocated) gpu.releaseProgram(value); throw error; }
  }
  function allocateLookup(withDepth: boolean): Lookup {
    const labels = gpu.target(canvas.width, canvas.height);
    let source: Target | null = null;
    try {
      source = gpu.target(canvas.width, canvas.height); gpu.attach(labels, source);
      if (withDepth) gpu.attachDepth(labels);
      return { label: labels, source };
    } catch (error) { gpu.release(labels); if (source !== null) gpu.release(source); throw error; }
  }
  function frameLookup(snapshot: typeof lastRender): Lookup {
    if (lastFrameLookup !== null) return lastFrameLookup;
    if (scene === null) throw new Error('Open a photo before reading source coordinates.');
    if (snapshot.perspective !== null && snapshot.compare !== 'source-photo') {
      if (lastLiveLookup === null) throw new Error('The perspective source lookup is unavailable.');
      lastFrameLookup = lastLiveLookup;
      return lastFrameLookup;
    }
    const programs = ensureSourcePrograms();
    legacyLookup ??= allocateLookup(true);
    const lookup = legacyLookup;
    const moving = snapshot.compare !== 'source-photo' && (snapshot.camera !== null ? depth !== null : snapshot.loop && effectiveOrbit(scene.doc.motion) > 0 && !plateNeeded(scene.doc));
    const composed = snapshot.compare !== 'source-photo' && (moving || plate !== null && scene.doc.objects.some((object) => object.hidden));
    gl.bindFramebuffer(gl.FRAMEBUFFER, lookup.label.framebuffer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    if (!composed) {
      // C1b's static UV map was owner zero; local whole-owner scopes also
      // need the same label map used by still palette/selection rendering.
      gpu.draw(programs.still, lookup.label, { labels: tex(snapshot.compare === 'source-photo' ? backgroundLabel : label),
        frameSize: { kind: 'ivec2', value: [canvas.width, canvas.height] } });
    } else {
      const anchor = anchorDisparity(scene.doc);
      const lo = anchor === null ? { x: 0, y: 0 } : parallaxDisplacement(renderedCamera, 0, anchor);
      const hi = anchor === null ? { x: 0, y: 0 } : parallaxDisplacement(renderedCamera, 1, anchor);
      const uniforms = { displacementX: { kind: 'vec3', value: [lo.x, hi.x, 0] }, displacementY: { kind: 'vec3', value: [lo.y, hi.y, 0] },
        zoom: float(moving ? loopZoom(scene.doc.motion.parallax) : 1), hole: tex(hole ?? backgroundLabel) } satisfies Record<string, Uniform>;
      gl.clearBufferfv(gl.COLOR, 0, new Float32Array(4)); gl.clearBufferfv(gl.COLOR, 1, new Float32Array(4));
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthRange(0, 1 - 1 / 65535); gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
      try {
        gpu.draw(programs.lookup, lookup.label, { ...uniforms, depthPlane: tex(backgroundDepth ?? depth ?? label), mask: tex(label), objectId: int(0) }, backMesh);
        for (const layer of layers(scene.doc)) {
          if (layer.kind === 'plate') continue;
          const entry = objectMeshes.get(layer.object.id);
          if (entry === undefined) continue;
          gl.clear(gl.DEPTH_BUFFER_BIT);
          gpu.draw(programs.lookup, lookup.label, { ...uniforms, depthPlane: tex(depth ?? label), mask: tex(entry.texture),
            objectId: int(scene.doc.objects.indexOf(layer.object) + 1) }, entry.mesh);
        }
      } finally { gl.disable(gl.DEPTH_TEST); gl.depthRange(0, 1); }
    }
    const coating = scene.doc.surface;
    if (snapshot.compare === 'edited' && coating.enabled && coating.relief > 0 && coating.refraction > 0) {
      legacyWarp ??= allocateLookup(false);
      const patterns = { bars: 0, cracks: 1, scales: 2 } satisfies Record<typeof coating.pattern, number>;
      gpu.draw(programs.warp, legacyWarp.label, { labels: tex(lookup.label), sourceMap: tex(lookup.source),
        seed: { kind: 'uint', value: scene.doc.seed }, pattern: int(patterns[coating.pattern]), relief: float(coating.relief),
        refraction: float(coating.refraction), scale: float(coating.scale), phase: float(loopPhase(snapshot.frame, frameCount(scene.doc.motion, LOOP_FPS))) });
      lastFrameLookup = legacyWarp;
    } else lastFrameLookup = lookup;
    return lastFrameLookup;
  }
  function legacySourceAt(pixel: Vec2): { readonly kind: 'source'; readonly at: Vec2 } | { readonly kind: 'refused'; readonly reason: string } {
    const lookup = frameLookup(lastRender);
    const id = readPixel(lookup.label, pixel), uv = readPixel(lookup.source, pixel);
    if (id[3] !== 255) return { kind: 'refused', reason: 'There is no source pixel at this point.' };
    if (id[1] !== 255) return { kind: 'refused', reason: 'This pixel was generated and has no source color.' };
    return { kind: 'source', at: { x: ((uv[0] ?? 0) * 256 + (uv[1] ?? 0)) / 65535,
      y: ((uv[2] ?? 0) * 256 + (uv[3] ?? 0)) / 65535 } };
  }

  function releaseLocalTargets(): void {
    for (const lookup of [legacyLookup, legacyWarp]) if (lookup !== null) { gpu.release(lookup.label); gpu.release(lookup.source); }
    for (const target of [localBefore, localCoverageTarget]) if (target !== null) gpu.release(target);
    legacyLookup = null; legacyWarp = null; lastFrameLookup = null; localBefore = null; localCoverageTarget = null;
  }
  function updateScopeTextures(effects: readonly PreparedLocalEffect[]): void {
    const needed = new Set(effects.flatMap((effect) => effect.plane === null ? [] : [effect.plane]));
    const added: Plane<'u8'>[] = [];
    try {
      for (const plane of needed) {
        if (!scopeTextures.has(plane)) {
          scopeTextures.set(plane, gpu.texture(plane.size.width, plane.size.height, 'r8', plane.data)); added.push(plane);
        }
      }
    } catch (error) {
      for (const plane of added) { const texture = scopeTextures.get(plane); if (texture !== undefined) gpu.release(texture); scopeTextures.delete(plane); }
      throw error;
    }
    for (const [plane, texture] of scopeTextures) if (!needed.has(plane)) { gpu.release(texture); scopeTextures.delete(plane); }
  }
  function ensureLocalPrograms() {
    if (localPrograms !== null) return localPrograms;
    const effects = gpu.program(localEffects);
    try { localPrograms = { effects, coverage: gpu.program(localCoverage) }; return localPrograms; }
    catch (error) { gpu.releaseProgram(effects); throw error; }
  }
  function effectUniforms(effects: readonly PreparedLocalEffect[], lookup: Lookup): Readonly<Record<string, Uniform>> {
    const owners = new Float32Array(LOCAL_EFFECT_BATCH).fill(-1), masked = new Float32Array(LOCAL_EFFECT_BATCH);
    const kinds = new Float32Array(LOCAL_EFFECT_BATCH), colors = new Float32Array(LOCAL_EFFECT_BATCH * 3), amounts = new Float32Array(LOCAL_EFFECT_BATCH);
    const uniforms: Record<string, Uniform> = { labels: tex(lookup.label), sourceMap: tex(lookup.source), count: int(effects.length) };
    for (let index = 0; index < LOCAL_EFFECT_BATCH; index++) {
      const effect = effects[index];
      const plane = effect?.plane ?? null;
      const texture = plane === null ? backgroundLabel : scopeTextures.get(plane);
      if (texture === undefined) throw new Error('The frozen local selection texture is unavailable.');
      uniforms[`scope${index}`] = tex(texture);
      if (effect === undefined) continue;
      owners[index] = effect.label; masked[index] = plane === null ? 0 : 1; kinds[index] = effect.kind;
      colors.set(effect.color, index * 3); amounts[index] = effect.amount;
    }
    return { ...uniforms, owners: { kind: 'floatArray', value: owners }, masked: { kind: 'floatArray', value: masked },
      kinds: { kind: 'floatArray', value: kinds }, colors: { kind: 'vec3Array', value: colors }, amounts: { kind: 'floatArray', value: amounts } };
  }
  function localResources(): { readonly targets: number; readonly textures: number } {
    return { targets: (legacyLookup === null ? 0 : 2) + (legacyWarp === null ? 0 : 2) + (localBefore === null ? 0 : 1) + (localCoverageTarget === null ? 0 : 1), textures: scopeTextures.size };
  }
  function validateLocalPatch(x: number, y: number, w: number, h: number): void {
    checkLive();
    if (!hasRendered || selectionSource === null || ![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w < 1 || h < 1 ||
      x + w > canvas.width || y + h > canvas.height) throw new Error('Render the current image before reading a local patch inside the master.');
  }
  function readTargetPatch(target: Target, x: number, y: number, w: number, h: number): Uint8Array {
    const bytes = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.framebuffer); gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) { checkLive(); throw new Error(`The local readback failed (WebGL 0x${error.toString(16)}).`); }
    return bytes;
  }
  function readLocalEffectPatch(x: number, y: number, w: number, h: number): LocalEffectReadback {
    validateLocalPatch(x, y, w, h);
    if (selectionSource === null) throw new Error('The local result is unavailable.');
    const after = selectionSource, before = appliedLocalEffects && localBefore !== null ? localBefore : after;
    return preserveFramebuffers(() => {
      const lookup = frameLookup(lastRender);
      return { before: readTargetPatch(before, x, y, w, h), after: readTargetPatch(after, x, y, w, h),
        owners: readTargetPatch(lookup.label, x, y, w, h), sourceUV: readTargetPatch(lookup.source, x, y, w, h) };
    });
  }
  function readLocalCoveragePatch(id: EffectId, x: number, y: number, w: number, h: number): Uint8Array {
    validateLocalPatch(x, y, w, h);
    const effect = preparedLocalEffects.find((effect) => effect.id === id);
    if (effect === undefined && !scene?.localEffects?.some((effect) => effect.id === id)) throw new Error('The local operation is unavailable.');
    if (effect === undefined || lastRender.compare === 'source-photo' || lastRender.compare === 'treatments-off' && effect.kind === 2) {
      return Uint8Array.from({ length: w * h * 4 }, (_, index) => index % 4 === 3 ? 255 : 0);
    }
    return preserveFramebuffers(() => {
      const lookup = frameLookup(lastRender), programs = ensureLocalPrograms();
      localCoverageTarget ??= gpu.target(canvas.width, canvas.height);
      gpu.draw(programs.coverage, localCoverageTarget, effectUniforms([effect], lookup));
      return readTargetPatch(localCoverageTarget, x, y, w, h);
    });
  }

  function hitTest(at: Vec2): PerspectiveHit {
    checkLive();
    const request = lastRender.perspective;
    if (!hasRendered || lastRender.compare === 'source-photo' || request === null || lastLiveLookup === null || scene === null ||
      !Number.isFinite(at.x) || !Number.isFinite(at.y) || at.x < 0 || at.x > 1 || at.y < 0 || at.y > 1) return { kind: 'miss' };
    // Offscreen row zero is the photo's top row; present alone flips for the browser framebuffer.
    const x = Math.min(canvas.width - 1, Math.floor(at.x * canvas.width));
    const y = Math.min(canvas.height - 1, Math.floor(at.y * canvas.height));
    const labelBytes = new Uint8Array(4), uvBytes = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, lastLiveLookup.label.framebuffer);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, labelBytes);
    gl.bindFramebuffer(gl.FRAMEBUFFER, lastLiveLookup.source.framebuffer);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, uvBytes);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`The perspective hit failed (WebGL 0x${error.toString(16)}).`);
    if (labelBytes[3] !== 255) return { kind: 'miss' };
    const identity = { sceneGeneration: request.sceneGeneration, viewId: request.viewId };
    if (labelBytes[1] !== 255) return { ...identity, kind: 'generated', objectId: null };
    const index = labelBytes[0] ?? 0;
    const objectId = index === 0 ? null : scene.doc.objects[index - 1]?.id;
    if (objectId === undefined) return { kind: 'miss' };
    return { ...identity, kind: 'original', objectId,
      sourceUV: { x: ((uvBytes[0] ?? 0) * 256 + (uvBytes[1] ?? 0)) / 65535,
        y: ((uvBytes[2] ?? 0) * 256 + (uvBytes[3] ?? 0)) / 65535 } };
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
    const current = lastRender.perspective === null ? gbuffer : liveBuffers;
    if (current === null || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) {
      throw new Error('The geometry pixel is unavailable.');
    }
    const color = new Uint8Array(4), id = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, current.color.framebuffer);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, color);
    gl.bindFramebuffer(gl.FRAMEBUFFER, current.label.framebuffer);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, id);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`The geometry readback failed (WebGL 0x${error.toString(16)}).`);
    return { color: Array.from(color.subarray(0, 3)), label: id[0] ?? 0 };
  }
  function readGeometryPatch(x: number, y: number, w: number, h: number): Uint8Array {
    checkLive();
    const target = lastRender.perspective === null ? gbuffer?.label : lastLiveLookup?.label;
    if (target === undefined || ![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w < 1 || h < 1 ||
      x + w > canvas.width || y + h > canvas.height) throw new Error('The geometry patch is unavailable or outside the master.');
    const bytes = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`The geometry patch readback failed (WebGL 0x${error.toString(16)}).`);
    return bytes;
  }
  function geometryEdgesCovered(): boolean { return exportedEdges ?? readGeometryEdges(); }
  function readGeometryEdges(): boolean {
    checkLive();
    const target = lastRender.perspective === null ? gbuffer?.label : lastLiveLookup?.label;
    if (target === undefined) throw new Error('Render a moving frame before reading its geometry.');
    const { width, height } = target;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
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
    try {
      render(frame, true, false, null, null, 'edited');
      exportedEdges = scene !== null && effectiveOrbit(scene.doc.motion) > 0 && !plateNeeded(scene.doc) ? readGeometryEdges() : null;
      return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => {
        if (blob === null) reject(new Error('The loop PNG could not be encoded.'));
        else resolve(blob);
      }, 'image/png'));
    } finally { restoreRender(restore); }
  }
  function exportView(camera: Vec2, frame = 0): Promise<Blob> {
    checkLive();
    const restore = lastRender;
    try {
      render(frame, true, false, camera, null, 'edited');
      return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => {
        if (blob === null) reject(new Error('The view PNG could not be encoded.'));
        else resolve(blob);
      }, 'image/png'));
    } finally { restoreRender(restore); }
  }
  function exportStill(): Promise<Blob>;
  function exportStill(capture: LoopCapture): void;
  function exportStill(capture?: LoopCapture): Promise<Blob> | void {
    checkLive();
    const restore = lastRender;
    try {
      if (capture === undefined) render(0, false, false, null, null, 'edited');
      else render(capture.frame, true, false, null, null, 'edited');
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
    } finally { restoreRender(restore); }
  }
  return {
    setScene, setCompare, sampleColor, renderStill,
    renderFrame, renderView, exportView, renderPerspective, hitTest, endPerspective,
    exportStill,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener('webglcontextlost', onContextLost);
      endPerspective();
      gpu.dispose(); scopeTextures.clear(); preparedLocalEffects = []; legacyLookup = null; legacyWarp = null; lastFrameLookup = null; localBefore = null; localCoverageTarget = null;
      scene = null; buffers = null; cellBuffers = null; crunchBuffers = null; finalTarget = null; selectionSource = null; master = null; plate = null; depth = null; lut = null; palette = null;
    },
    debug: probe === null ? null : { ...probe.debug, readGeometryPatch, perspectiveResources,
      readLocalEffectPatch, readLocalCoveragePatch, localResources,
      motionCamera: () => ({ ...renderedCamera }),
      setMotionFeather: (enabled: boolean): void => { featherEnabled = enabled; },
    },
  };
}
