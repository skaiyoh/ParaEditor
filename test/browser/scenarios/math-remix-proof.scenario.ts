import { z } from '../../../src/core/zod.ts';
import { legacyFiveClusterDocument } from '../../fixtures/documents.ts';
import { liveCoverage } from '../../../src/core/live-coverage.ts';
import { lateralEnvelope } from '../../../src/core/perspective.ts';
import { cameraOffset, loopPhase, frameCount, loopZoom } from '../../../src/core/motion.ts';
import { cameraRadius } from '../../../src/core/derive.ts';
import type { PerspectiveGeometry } from '../../../src/core/perspective.ts';
import type { LegacySceneDocument } from '../../../src/core/types.ts';
import type { PaintPlane } from '../../../src/render/paint.ts';
import { migrateV4ToV5 } from '../../../src/core/composition.ts';
export type PaintProofTools = {
  createRenderer: typeof import('../../../src/render/renderer.ts').createRenderer;
  encodeLoopGif: typeof import('../../../src/session/loop.ts').encodeLoopGif;
  movieFormat: typeof import('../../../src/export/movie.ts').movieFormat;
  recordMovie: typeof import('../../../src/export/movie.ts').recordMovie;
};
import type { Scenario, ScenarioContext } from '../scenario.ts';

type View = { kind: 'still' } | { kind: 'motion'; frame: number; x: number; y: number; zoom: number }
  | { kind: 'perspective'; x: number; y: number };
const sampleSchema = z.object({ name: z.string(), x: z.number(), y: z.number(), photoDepth: z.number(), expected: z.array(z.number()), actual: z.array(z.number()), maxError: z.number() });
type Sample = z.infer<typeof sampleSchema>;
export type PaintProofHarness = {
  renderer: ReturnType<PaintProofTools['createRenderer']>; canvas: HTMLCanvasElement; planes: readonly PaintPlane[];
  view: View; baseline: Uint8ClampedArray; geometry: PerspectiveGeometry;
  setView(view: View): void; read(): Uint8ClampedArray; samples(bytes?: Uint8ClampedArray): Sample[];
  setSelected(selected: boolean): void; dispose(): void;
};
const geometry: PerspectiveGeometry = { aperture: { center: { x: .07, y: -.04 }, width: .8, height: .8 }, crop: .1, neutralDistance: 2, nearFactor: 1.1, farFactor: 2 };
const template = legacyFiveClusterDocument(), object = template.objects[0];
if (object === undefined || template.analysis.depth === null || template.analysis.plate === null) throw new Error('Missing proof template.');
const size = { width: 512, height: 512 };
const doc: LegacySceneDocument = { ...template,
  frame: { ...template.frame, master: { ...template.frame.master, size } },
  objects: [{ ...object, subject: false, recolor: { kind: 'none' }, motion: { kind: 'none' },
    produced: { ...object.produced, bounds: { x: 192, y: 160, width: 128, height: 192 },
      mask: { ...object.produced.mask, size }, depth: { p10: .625, median: .625, p90: .625 } } }],
  analysis: { ...template.analysis, depth: { ...template.analysis.depth, stats: { p10: .125, median: .125, p90: .625 }, map: { ...template.analysis.depth.map, size } },
    plate: { ...template.analysis.plate, forMasks: [object.produced.mask.asset], image: { ...template.analysis.plate.image, size } } },
  style: { ...template.style, simplify: 0, outline: 0, grain: 0, colorNoise: 0, crunch: 0, clipping: 0, subjectClarity: 0 },
  symbols: { ...template.symbols, enabled: false }, surface: { ...template.surface, enabled: false },
  motion: { ...template.motion, enabled: true, focus: 0, drift: { direction: 'circle', amount: 1 }, parallax: 1, loopSeconds: 2 },
};
const coverage = liveCoverage(doc, geometry);
if (coverage === null) throw new Error('No proof coverage.');
const views: readonly { name: string; view: View }[] = [
  { name: 'still', view: { kind: 'still' } },
  { name: 'neutral', view: { kind: 'perspective', x: 0, y: 0 } },
  { name: 'negative-extreme', view: { kind: 'perspective', ...lateralEnvelope(geometry).min } },
  { name: 'positive-extreme', view: { kind: 'perspective', ...lateralEnvelope(geometry).max } },
];
const migrated = migrateV4ToV5(doc);
if (!migrated.ok) throw new Error(`Proof migration failed: ${JSON.stringify(migrated.error)}`);
const motionViews = [0, 15, 30, 45].map(frame => ({ kind: 'motion', frame,
  ...cameraOffset(cameraRadius(migrated.value), loopPhase(frame, frameCount(doc.motion, 30)), doc.motion.drift.direction), zoom: loopZoom(doc.motion.parallax) } satisfies View));

async function install(t: ScenarioContext): Promise<void> {
  await t.page.goto(t.baseUrl);
  await t.page.evaluate(z.literal(true), async ({ docJson, geometry, key }) => {
    const doc: LegacySceneDocument = JSON.parse(docJson);
    const tools = window.__noisyTest?.demo.paintProof;
    if (tools === undefined) throw new Error('No paint proof entry points.');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
    canvas.style.cssText = 'position:fixed;left:20px;top:20px;width:640px;height:640px;z-index:99999;border:1px solid white';
    document.body.append(canvas);
    const source = document.createElement('canvas'); source.width = source.height = 512;
    const ctx = source.getContext('2d'); if (ctx === null) throw new Error('No fixture context.');
    ctx.fillStyle = '#304050'; ctx.fillRect(0, 0, 512, 512);
    ctx.fillStyle = '#d06028'; ctx.fillRect(192, 160, 128, 192);
    const master = await createImageBitmap(source), renderer = tools.createRenderer(canvas);
    const object = doc.objects[0]; if (object === undefined) throw new Error('No fixture object.');
    const data = new Float32Array(512 * 512).fill(.125), mask = new Uint8Array(512 * 512), hole = new Uint8Array(512 * 512);
    const plate = new Uint8Array(512 * 512 * 3);
    for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
      const i = y * 512 + x;
      if (x >= 192 && x < 320 && y >= 160 && y < 352) { data[i] = .625; mask[i] = 255; }
      if (x >= 184 && x < 328 && y >= 152 && y < 360) hole[i] = 255;
      plate.set([48, 64, 80], i * 3);
    }
    const depth = { format: 'f32', size: { width: 512, height: 512 }, data } satisfies import('../../../src/core/raster.ts').Plane<'f32'>;
    const scene = { doc, master, depth, selected: null, masks: new Map([[object.id, { format: 'u8', size: depth.size, data: mask } satisfies import('../../../src/core/raster.ts').Plane<'u8'>]]),
      plate: { size: depth.size, data: plate, format: 'rgb8' as const }, backgroundDepth: { ...depth, data: new Float32Array(512 * 512).fill(.125) },
      livePlate: { key, depth, image: { size: depth.size, data: plate, format: 'rgb8' as const }, hole: { size: depth.size, data: hole, format: 'u8' as const } } };
    renderer.setScene(scene);
    const make = (id: string, disparity: number, bounds: PaintPlane['bounds'], rgb: readonly number[], order: number, shaped: boolean): PaintPlane => {
      const tiles: PaintPlane['tiles'][number][] = [];
      for (let ty = 0; ty * 256 < bounds.height; ty++) for (let tx = 0; tx * 256 < bounds.width; tx++) {
        const width = Math.min(256, bounds.width - tx * 256), height = Math.min(256, bounds.height - ty * 256), rgba = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const px = x + tx * 256, py = y + ty * 256;
          const hole = shaped && px >= 64 && px < 112 && py >= 80 && py < 144;
          const edge = shaped ? Math.min(1, (px + .5) / 24, (bounds.width - px - .5) / 24, (py + .5) / 24, (bounds.height - py - .5) / 24) : 1;
          rgba.set([rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0, hole ? 0 : Math.round(128 * edge)], (y * width + x) * 4);
        }
        tiles.push({ x: tx, y: ty, width, height, rgba });
      }
      return { id, disparity, bounds, tiles, visible: true, opacity: .8, order };
    };
    const planes = [
      make('far', .375, { x: 64, y: 64, width: 384, height: 384 }, [20, 225, 70], 1, false),
      make('near', .75, { x: 128, y: 96, width: 320, height: 320 }, [50, 70, 240], 2, true),
      make('tie-first', .5, { x: 24, y: 360, width: 96, height: 96 }, [240, 30, 40], 3, false),
      make('tie-later', .5, { x: 24, y: 360, width: 96, height: 96 }, [40, 220, 200], 4, false),
      make('photo-tie', .625, { x: 260, y: 280, width: 40, height: 40 }, [240, 230, 20], 5, false),
    ];
    const gl = canvas.getContext('webgl2'); if (gl === null) throw new Error('No real WebGL2 context.');
    const read = () => {
      const previous: unknown = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      const raw = new Uint8Array(512 * 512 * 4), topDown = new Uint8ClampedArray(raw.length);
      gl.readPixels(0, 0, 512, 512, gl.RGBA, gl.UNSIGNED_BYTE, raw);
      for (let y = 0; y < 512; y++) topDown.set(raw.subarray((511 - y) * 2048, (512 - y) * 2048), y * 2048);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previous instanceof WebGLFramebuffer ? previous : null);
      return topDown;
    };
    let view: View = { kind: 'still' }, baseline = new Uint8ClampedArray();
    const draw = () => {
      if (view.kind === 'still') renderer.renderStill();
      else if (view.kind === 'motion') renderer.renderFrame(view.frame);
      else {
        const result = renderer.renderPerspective({ geometry, eye: { x: view.x, y: view.y, z: geometry.neutralDistance }, sceneGeneration: 1, viewId: 1, showSelection: false });
        if (result.kind !== 'rendered' || result.travelScale !== 1 || Math.abs(result.eye.x - view.x) > 1e-8 || Math.abs(result.eye.y - view.y) > 1e-8) throw new Error(`Full perspective was not exercised: ${JSON.stringify(result)}`);
      }
    };
    const inverse = (x: number, y: number, d: number) => {
      if (view.kind === 'still') return { x: x + .5, y: y + .5 };
      if (view.kind === 'motion') return { x: ((x + .5) / 512 / view.zoom + .5 - .5 / view.zoom - view.x * d) * 512,
        y: ((y + .5) / 512 / view.zoom + .5 - .5 / view.zoom - view.y * d) * 512 };
      const factor = geometry.farFactor * (1 - d) + geometry.nearFactor * d, k = 1 - 1 / factor, span = 1 - 2 * geometry.crop;
      return { x: (.5 + (((x + .5) / 512 - .5) - k * view.x / geometry.aperture.width) * span) * 512,
        y: (.5 + (((y + .5) / 512 - .5) + k * view.y / geometry.aperture.height) * span) * 512 };
    };
    const linear = (s: number) => s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
    const srgb = (v: number) => Math.round(255 * (v <= .0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - .055));
    const sample = (plane: PaintPlane, x: number, y: number) => {
      const p = inverse(x, y, plane.disparity), px = p.x - plane.bounds.x, py = p.y - plane.bounds.y;
      if (px < 0 || py < 0 || px >= plane.bounds.width || py >= plane.bounds.height) return [0, 0, 0, 0];
      const texel = (x: number, y: number) => {
        if (x < 0 || y < 0 || x >= plane.bounds.width || y >= plane.bounds.height) return [0, 0, 0, 0];
        const tile = plane.tiles.find(tile => tile.x === Math.floor(x / 256) && tile.y === Math.floor(y / 256));
        if (tile === undefined) return [0, 0, 0, 0];
        const i = ((y % 256) * tile.width + x % 256) * 4, a = (tile.rgba[i + 3] ?? 0) / 255 * plane.opacity;
        return [linear((tile.rgba[i] ?? 0) / 255) * a, linear((tile.rgba[i + 1] ?? 0) / 255) * a, linear((tile.rgba[i + 2] ?? 0) / 255) * a, a];
      };
      const ix = Math.floor(px - .5), iy = Math.floor(py - .5), fx = px - .5 - ix, fy = py - .5 - iy;
      const taps = [texel(ix, iy), texel(ix + 1, iy), texel(ix, iy + 1), texel(ix + 1, iy + 1)];
      return [0, 1, 2, 3].map(c => ((taps[0]?.[c] ?? 0) * (1 - fx) + (taps[1]?.[c] ?? 0) * fx) * (1 - fy)
        + ((taps[2]?.[c] ?? 0) * (1 - fx) + (taps[3]?.[c] ?? 0) * fx) * fy);
    };
    const samples = (bytes = read()) => {
      const found = new Map<string, Sample>();
      for (let y = 2; y < 510; y += 3) for (let x = 2; x < 510; x += 3) {
        const fore = inverse(x, y, .625), foreground = fore.x >= 192 && fore.x < 320 && fore.y >= 160 && fore.y < 352;
        if (Math.min(Math.abs(fore.x - 192), Math.abs(fore.x - 320), Math.abs(fore.y - 160), Math.abs(fore.y - 352)) < 10) continue;
        const photoDepth = foreground ? .625 : .125;
        const values = planes.map(plane => sample(plane, x, y)), far = values[0]?.[3] ?? 0, near = values[1]?.[3] ?? 0;
        const holePoint = inverse(x, y, .75), inHole = holePoint.x > 198 && holePoint.x < 234 && holePoint.y > 182 && holePoint.y < 234;
        const tied = (values[2]?.[3] ?? 0) > .39 && (values[3]?.[3] ?? 0) > .39;
        const photoTie = (values[4]?.[3] ?? 0) > .39;
        const names: string[] = [];
        if (foreground && far > .39 && near === 0 && inHole) names.push('occluded-hole');
        if (!foreground && far > .39 && near > .39) names.push('overlap');
        if (foreground && far > .39 && near > .39 && !photoTie) names.push('near-over-foreground');
        if (!foreground && near > .04 && near < .25) names.push('feather');
        if (!foreground && values.every(value => value[3] === 0)) names.push('uncovered');
        if (!foreground && tied && near === 0) names.push('equal-paint-depth');
        const tiePoint = inverse(x, y, .625);
        if (foreground && photoTie && tiePoint.x > 265 && tiePoint.x < 295 && tiePoint.y > 285 && tiePoint.y < 315) names.push('equal-photo-depth');
        const nearPoint = inverse(x, y, .75);
        if (!foreground && near > .39 && Math.abs(nearPoint.x - 384) < 1.5) names.push('tile-seam');
        if (names.every(name => found.has(name))) continue;
        let color = [0, 1, 2].map(c => linear((baseline[(y * 512 + x) * 4 + c] ?? 0) / 255));
        for (const plane of [...planes].sort((a, b) => a.disparity - b.disparity || a.order - b.order)) {
          if (plane.disparity < photoDepth) continue;
          const ink = sample(plane, x, y), alpha = ink[3] ?? 0;
          color = color.map((v, c) => (ink[c] ?? 0) + v * (1 - alpha));
        }
        const expected = [...color.map(srgb), 255], actual = Array.from(bytes.subarray((y * 512 + x) * 4, (y * 512 + x) * 4 + 4));
        for (const name of names) if (!found.has(name)) found.set(name, { name, x, y, photoDepth, expected, actual,
          maxError: Math.max(...expected.map((v, c) => Math.abs(v - (actual[c] ?? 0)))) });
      }
      return [...found.values()];
    };
    const harness: PaintProofHarness = { renderer, canvas, planes, geometry, view, baseline, read, samples,
      setView(next) {
        renderer.setScene(scene);
        view = next; harness.view = next;
        renderer.setPaintPlanes([]); draw(); baseline = read(); harness.baseline = baseline;
        const admitted = renderer.setPaintPlanes(planes); if (admitted.kind !== 'accepted') throw new Error(admitted.reason);
        draw();
      },
      setSelected(selected) { renderer.setScene({ ...scene, selected: selected ? object.id : null }); },
      dispose() { renderer.dispose(); master.close(); canvas.remove(); },
    };
    window.__paintProof = harness;
    harness.setView({ kind: 'still' });
    return true;
  }, { docJson: JSON.stringify(doc), geometry, key: coverage?.key ?? '' });
}

const depthScenario: Scenario = {
  id: 'math-remix-proof.depth', title: 'Independent paint depth, linear alpha, perspective extremes and resource refusal', target: 'dev', covers: [], timeoutMs: 180_000,
  async run(t) {
    await install(t);
    for (const { name, view } of views) {
      const samples = await t.page.evaluate(z.array(sampleSchema), view => {
        const proof = window.__paintProof; if (proof === undefined) throw new Error('No proof.');
        proof.setView(view); return proof.samples();
      }, view);
      await t.file(`${name}.json`, JSON.stringify(samples, null, 2));
      await t.file(`${name}-diagnostics.json`, await t.page.evaluate(z.string(), () => JSON.stringify({ resources: window.__paintProof?.renderer.debug?.paintResources?.(), pixel: window.__paintProof?.renderer.debug?.readPaintPixel?.(152,119) }, null, 2))); 
      for (const category of ['occluded-hole', 'overlap', 'near-over-foreground', 'feather', 'uncovered', 'equal-paint-depth', 'equal-photo-depth', 'tile-seam']) {
        const sample = samples.find(value => value.name === category);
        t.ok(`${name}: ${category} CPU reference within 2 RGBA8 levels`, sample !== undefined && sample.maxError <= 2, sample);
      }
      await t.page.screenshot(`paint-${name}`);
    }
  },
};



async function resourceProof(t: ScenarioContext): Promise<void> {
  const result = await t.page.evaluate(z.object({ admitted: z.string(), refused: z.string(), reason: z.string(), retained: z.boolean(),
    unchanged: z.boolean(), finite: z.boolean(), oldColor: z.array(z.number()), paintColor: z.array(z.number()),
    allocationsOnRefusal: z.number(), metadataAllocations: z.number(), metadataChanged: z.boolean(), usage: z.string(), noPaintMs: z.array(z.number()), paintMs: z.array(z.number()), renderer: z.string(), released: z.boolean() }), async (docJson) => {
    const tools = window.__noisyTest?.demo.paintProof; if (tools === undefined) throw new Error('No proof tools.');
    window.__paintProof?.dispose();
    const doc: LegacySceneDocument = JSON.parse(docJson), size = { width: 2048, height: 2048 };
    const source = document.createElement('canvas'); source.width = source.height = 2048;
    const context = source.getContext('2d'); if (context === null) throw new Error('No budget fixture.');
    context.fillStyle = '#304050'; context.fillRect(0, 0, 2048, 2048);
    const master = await createImageBitmap(source), canvas = document.createElement('canvas'), renderer = tools.createRenderer(canvas);
    const gl = canvas.getContext('webgl2'); if (gl === null) throw new Error('No WebGL2.');
    const scene = { doc: { ...doc, objects: [], analysis: { ...doc.analysis, plate: null }, frame: { ...doc.frame, master: { ...doc.frame.master, size } } },
      master, depth: { format: 'f32' as const, size: { width: 1, height: 1 }, data: new Float32Array([.125]) }, masks: new Map(), plate: null, selected: null };
    renderer.setScene(scene); renderer.renderStill();
    const pixel = () => {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      const bytes = new Uint8Array(4); gl.readPixels(128, 2048 - 128 - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes); return Array.from(bytes);
    };
    const timings = () => Array.from({ length: 7 }, () => { gl.finish(); const start = performance.now(); renderer.renderStill(); gl.finish(); return performance.now() - start; });
    const noPaintMs = timings(), oldColor = pixel();
    const rgba = new Uint8Array(256 * 256 * 4);
    for (let i = 0; i < rgba.length; i += 4) rgba.set([20, 225, 70, 128], i);
    // 64 patches fill the 64 MiB decoded-raster budget; replacement peak shares the GPU cap.
    const planes: PaintPlane[] = Array.from({ length: 64 }, (_, order) => ({ id: `budget-${order}`, order, disparity: .75,
      bounds: { x: 0, y: 0, width: 2048, height: 2048 }, opacity: .025, visible: true,
      tiles: Array.from({ length: 4 }, (_, x) => ({ x, y: 0, width: 256, height: 256, rgba })) }));
    const admitted = renderer.setPaintPlanes(planes);
    if (admitted.kind !== 'accepted') throw new Error(admitted.reason);
    renderer.renderStill(); const paintColor = pixel(), paintMs = timings(), usage = renderer.debug?.paintResources?.();
    const originalCreateTexture = gl.createTexture.bind(gl); let metadataAllocations = 0;
    gl.createTexture = () => { metadataAllocations++; return originalCreateTexture(); };
    const metadata = renderer.setPaintPlanes(planes.map(plane => ({ ...plane, opacity: .01 })));
    if (metadata.kind !== 'accepted') throw new Error(metadata.reason);
    renderer.renderStill(); const metadataChanged = pixel().some((v, i) => v !== paintColor[i]);
    renderer.setPaintPlanes(planes); renderer.renderStill();
    gl.createTexture = originalCreateTexture;
    const replacement = rgba.slice(); replacement[0] = 240;
    const createTexture = gl.createTexture.bind(gl); let allocationsOnRefusal = 0;
    gl.createTexture = () => { allocationsOnRefusal++; return createTexture(); };
    const refused = renderer.setPaintPlanes(planes.map((plane, index) => index < 7
      ? { ...plane, tiles: plane.tiles.map(tile => ({ ...tile, rgba: replacement })) } : plane));
    gl.createTexture = createTexture;
    renderer.renderStill(); const after = pixel();
    const retained = JSON.stringify(usage) === JSON.stringify(renderer.debug?.paintResources?.());
    renderer.setPaintPlanes([]); renderer.renderStill(); const cleared = pixel();
    const released = renderer.debug?.paintResources?.().residentBytes === 0 && cleared.every((v, i) => v === oldColor[i]);
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const rendererName: unknown = info === null ? gl.getParameter(gl.RENDERER) : gl.getParameter(info.UNMASKED_RENDERER_WEBGL);
    renderer.dispose(); master.close();
    return { admitted: admitted.kind, refused: refused.kind, reason: refused.kind === 'refused' ? refused.reason : '', retained,
      unchanged: after.every((v, i) => v === paintColor[i]), finite: usage !== undefined && Object.values(usage).every(Number.isFinite),
      oldColor, paintColor, allocationsOnRefusal, metadataAllocations, metadataChanged, usage: JSON.stringify(usage), noPaintMs, paintMs, renderer: String(rendererName), released };
  }, JSON.stringify(doc));
  await t.file('resources.json', JSON.stringify({ ...result, usage: JSON.parse(result.usage) }, null, 2));
  t.equal('64 overlapping patches admitted at 256 sparse textures', result.admitted, 'accepted');
  t.equal('cap refuses replacement before dropping admitted planes', result.refused, 'refused', result.reason);
  t.ok('refusal preserves counts and GPU pixels before any texture allocation', result.retained && result.unchanged && result.finite && result.allocationsOnRefusal === 0);
  t.ok('opacity edits reuse immutable tile textures and change pixels', result.metadataAllocations === 0 && result.metadataChanged);
  t.ok('admitted paint changes the actual framebuffer', result.paintColor.some((v, i) => v !== result.oldColor[i]));
  t.ok('clear releases every additional target and restores original pixels', result.released);
}

const outputScenario: Scenario = {
  id: 'math-remix-proof.output', title: 'Motion, PNG, worker GIF and recorded movie carry the same undecorated paint', target: 'dev', covers: [], timeoutMs: 240_000,
  async run(t) {
    await install(t);
    for (const view of motionViews) {
      const samples = await t.page.evaluate(z.array(sampleSchema), view => {
        const proof = window.__paintProof; if (proof === undefined) throw new Error('No proof.');
        proof.setView(view); return proof.samples();
      }, view);
      await t.file(`motion-${view.frame}.json`, JSON.stringify(samples, null, 2));
      t.ok(`Motion ${view.frame} uses the shared depth and alpha evaluation`, samples.length === 8 && samples.every(sample => sample.maxError <= 2), samples);
    }
    const result = await t.page.evaluate(z.object({ png: z.string(), gif: z.string(), movie: z.string(), movieType: z.string(),
      pngSamples: z.array(sampleSchema), gifSamples: z.array(sampleSchema), movieSamples: z.array(sampleSchema),
      undecorated: z.boolean(), restored: z.boolean(), gifFrames: z.number(), gifProgress: z.number(), movieProgress: z.number(), movieWidth: z.number(), movieHeight: z.number() }), async (motionViews) => {
      const proof = window.__paintProof, tools = window.__noisyTest?.demo.paintProof;
      if (proof === undefined || tools === undefined) throw new Error('No output proof.');
      const toData = (blob: Blob) => new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result.split(',')[1] ?? '') : reject(new Error('No data URL.'));
        reader.onerror = reject; reader.readAsDataURL(blob);
      });
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
      const context = canvas.getContext('2d', { willReadFrequently: true }); if (context === null) throw new Error('No export canvas.');
      const decoded = async (blob: Blob) => { const bitmap = await createImageBitmap(blob); context.drawImage(bitmap, 0, 0); bitmap.close(); return context.getImageData(0, 0, 512, 512).data; };
      proof.setView({ kind: 'still' });
      const clean = await proof.renderer.exportStill();
      proof.setSelected(true); proof.renderer.renderStill(); const decorated = proof.read();
      const png = await proof.renderer.exportStill(), pngBytes = await decoded(png), cleanBytes = await decoded(clean);
      const pngSamples = proof.samples(pngBytes);
      const undecorated = pngBytes.every((value, i) => value === cleanBytes[i]) && decorated.some((value, i) => value !== cleanBytes[i]);
      const restored = proof.read().every((value, i) => value === decorated[i]);
      const signal = new AbortController().signal;
      let gifProgress = 0, movieProgress = 0;
      const gif = await tools.encodeLoopGif({ canvas, frames: 30, fps: 15, signal,
        render: frame => proof.renderer.exportStill({ frame: frame * 2, canvas }), progress: n => { gifProgress = n; } });
      if (window.ImageDecoder === undefined) throw new Error('Chrome ImageDecoder is unavailable for GIF byte verification.');
      const decoder = new window.ImageDecoder({ data: new Uint8Array(await gif.arrayBuffer()), type: 'image/gif' });
      await decoder.tracks.ready;
      const gifFrames = decoder.tracks.selectedTrack?.frameCount ?? 0, gifSamples: Sample[] = [];
      // Decode the worker's real bytes at both halves of the Motion period.
      for (const frameIndex of [0, 15]) {
        const frame = await decoder.decode({ frameIndex });
        context.drawImage(frame.image, 0, 0); frame.image.close();
        const bytes = context.getImageData(0, 0, 512, 512).data;
        const view = motionViews.find(view => view.frame === frameIndex * 2); if (view === undefined) throw new Error('No GIF view.');
        proof.setView(view); gifSamples.push(...proof.samples(bytes).map(sample => ({ ...sample, name: `${frameIndex}:${sample.name}` })));
      }
      decoder.close();
      const format = tools.movieFormat(); if (format === null) throw new Error('No movie encoder.');
      proof.setSelected(true); proof.renderer.renderFrame(0);
      const frames: Blob[] = [];
      for (let frame = 0; frame < 60; frame++) {
        proof.renderer.exportStill({ frame, canvas });
        frames.push(await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob === null ? reject(new Error('No movie frame.')) : resolve(blob), 'image/png')));
      }
      const movie = await tools.recordMovie({ canvas, frames, fps: 30, format, signal, progress: n => { movieProgress = n; } });
      const video = document.createElement('video'); video.muted = true; video.preload = 'auto';
      const url = URL.createObjectURL(movie); video.src = url;
      await new Promise<void>((resolve, reject) => { video.onloadeddata = () => resolve(); video.onerror = () => reject(new Error('The exported movie did not decode.')); video.load(); });
      context.drawImage(video, 0, 0); const movieBytes = context.getImageData(0, 0, 512, 512).data;
      const first = motionViews[0]; if (first === undefined) throw new Error('No movie reference.');
      proof.setView(first);
      const movieSamples = proof.samples(movieBytes), movieWidth = video.videoWidth, movieHeight = video.videoHeight;
      video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url);
      return { png: await toData(png), gif: await toData(gif), movie: await toData(movie), movieType: format.extension,
        pngSamples, gifSamples, movieSamples, undecorated, restored, gifFrames, gifProgress, movieProgress, movieWidth, movieHeight };
    }, motionViews);
    await t.file('paint.png', Buffer.from(result.png, 'base64'));
    await t.file('paint.gif', Buffer.from(result.gif, 'base64'));
    await t.file(`paint.${result.movieType}`, Buffer.from(result.movie, 'base64'));
    const { png, gif, movie, ...evidence } = result;
    await t.file('output.json', JSON.stringify({ ...evidence, pngBytes: Buffer.from(png, 'base64').length,
      gifBytes: Buffer.from(gif, 'base64').length, movieBytes: Buffer.from(movie, 'base64').length }, null, 2));
    t.ok('actual PNG matches CPU paint reference', result.pngSamples.length === 8 && result.pngSamples.every(sample => sample.maxError <= 2), result.pngSamples);
    t.ok('PNG excludes selection and restores the displayed decorated frame', result.undecorated && result.restored);
    t.ok('worker GIF has all 30 frames and paint at both halves', result.gifFrames === 30 && result.gifProgress === 30 && result.gifSamples.length === 16 && result.gifSamples.every(sample => sample.maxError <= 8), result.gifSamples);
    t.ok('actual movie decodes the painted first frame at the intended dimensions', result.movieWidth === 512 && result.movieHeight === 512 && result.movieProgress > 0 && result.movieSamples.length === 8 && result.movieSamples.every(sample => sample.maxError <= 10), result.movieSamples);
    await t.page.screenshot('paint-output');
  },
};



async function attachmentAndSparseProof(t: ScenarioContext): Promise<void> {
  const report = await t.page.evaluate(z.object({
    captures: z.array(z.object({ field: z.string(), view: z.string(), disparity: z.number(), expected: z.array(z.number()), actual: z.array(z.number()), error: z.number() })),
    sparse: z.array(z.object({ view: z.string(), x: z.number(), y: z.number(), missing: z.boolean(), expected: z.array(z.number()), actual: z.array(z.number()), error: z.number() })),
    preparationAccounted: z.boolean(), capturePreservedPixels: z.boolean(), mutationInvalidated: z.boolean(), clearInvalidated: z.boolean(),
  }), async ({ docJson, geometry, extremes }) => {
    const tools = window.__noisyTest?.demo.paintProof; if (tools === undefined) throw new Error('No proof tools.');
    window.__paintProof?.dispose();
    const template: LegacySceneDocument = JSON.parse(docJson), size = { width: 512, height: 512 };
    const doc = { ...template, objects: [], analysis: { ...template.analysis, plate: null } };
    const source = document.createElement('canvas'); source.width = source.height = 512;
    const context = source.getContext('2d'); if (context === null) throw new Error('No fixture canvas.');
    context.fillStyle = '#304050'; context.fillRect(0, 0, 512, 512);
    const master = await createImageBitmap(source), canvas = document.createElement('canvas'), renderer = tools.createRenderer(canvas);
    const gl = canvas.getContext('webgl2'); if (gl === null) throw new Error('No real GPU.');
    const pixel = (x: number, y: number) => {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); const bytes = new Uint8Array(4);
      gl.readPixels(x, 511 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes); return Array.from(bytes);
    };
    const linear = (v: number) => v / 255 <= .04045 ? v / 255 / 12.92 : ((v / 255 + .055) / 1.055) ** 2.4;
    const srgb = (v: number) => Math.round(255 * (v <= .0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - .055));
    const error = (expected: readonly number[], actual: readonly number[]) => Math.max(...expected.map((v, i) => Math.abs(v - (actual[i] ?? 0))));
    const tile = (x: number, y: number, width: number, height: number, rgb: readonly number[]) => {
      const rgba = new Uint8Array(width * height * 4);
      for (let i = 0; i < rgba.length; i += 4) rgba.set([rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0, 128], i);
      return { x, y, width, height, rgba };
    };
    let view: { name: string; x: number; y: number } = { name: 'neutral', x: 0, y: 0 };
    const draw = () => {
      const result = renderer.renderPerspective({ geometry, eye: { x: view.x, y: view.y, z: geometry.neutralDistance }, sceneGeneration: 2, viewId: 2, showSelection: false });
      if (result.kind !== 'rendered' || result.travelScale !== 1) throw new Error('The precision fixture did not exercise its supported view.');
    };
    const captures = [], sparse = [];
    let preparationAccounted = true, capturePreservedPixels = true, mutationInvalidated = true, clearInvalidated = true;
    for (const field of ['constant-0.3', 'constant-0.7', 'interpolated', 'refracted-interpolated']) {
      renderer.setPaintPlanes([]);
      const data = new Float32Array(512 * 512);
      for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) data[y * 512 + x] = field === 'constant-0.3' ? .3 : field === 'constant-0.7' ? .7 : .29 + x / 511 * .021;
      renderer.setScene({ doc: { ...doc, surface: { ...doc.surface, enabled: field === 'refracted-interpolated', relief: 1, refraction: 1, shine: 0 } },
        master, depth: { format: 'f32', size, data }, masks: new Map(), plate: null, selected: null });
      for (view of [{ name: 'neutral', x: 0, y: 0 }, ...extremes]) {
        renderer.setPaintPlanes([]); draw();
        const at = { x: 273.5 / 512, y: 237.5 / 512 }, before = pixel(273, 237), captured = renderer.capturePaintDepth(at);
        if (captured.kind !== 'captured') throw new Error(captured.reason);
        const usage = renderer.debug?.paintResources?.();
        preparationAccounted &&= usage?.planes === 0 && usage.targets === 4 && usage.accountedBytes > 0;
        capturePreservedPixels &&= pixel(273, 237).every((v, i) => v === before[i]);
        const plane: PaintPlane = { id: 'captured', disparity: captured.disparity, bounds: { x: 0, y: 0, width: 512, height: 512 },
          tiles: [tile(0, 0, 256, 256, [10, 240, 90]), tile(1, 0, 256, 256, [10, 240, 90]), tile(0, 1, 256, 256, [10, 240, 90]), tile(1, 1, 256, 256, [10, 240, 90])],
          opacity: 1, visible: true, order: 1 };
        const admitted = renderer.setPaintPlanes([plane]); if (admitted.kind !== 'accepted') throw new Error(admitted.reason);
        mutationInvalidated &&= renderer.sampleColor({ at, source: 'edited' }).kind === 'refused';
        draw(); const actual = pixel(273, 237), alpha = 128 / 255;
        const expected = [...[10, 240, 90].map((v, c) => srgb(linear(v) * alpha + linear(before[c] ?? 0) * (1 - alpha))), 255];
        captures.push({ field, view: view.name, disparity: captured.disparity, expected, actual, error: error(expected, actual) });
        renderer.setPaintPlanes([]);
        clearInvalidated &&= renderer.sampleColor({ at, source: 'edited' }).kind === 'refused';
      }
    }
    const plane: PaintPlane = { id: 'sparse-diagonal', disparity: .75, bounds: { x: 32, y: 32, width: 448, height: 448 },
      tiles: [tile(1, 0, 192, 256, [240, 30, 40]), tile(0, 1, 256, 192, [20, 225, 70])], opacity: .8, visible: true, order: 1 };
    renderer.setScene({ doc, master, depth: { format: 'f32', size: { width: 1, height: 1 }, data: new Float32Array([.125]) }, masks: new Map(), plate: null, selected: null });
    for (view of [{ name: 'neutral', x: 0, y: 0 }, ...extremes]) {
      renderer.setPaintPlanes([]); draw(); const background = pixel(256, 256);
      const admitted = renderer.setPaintPlanes([plane]); if (admitted.kind !== 'accepted') throw new Error(admitted.reason);
      draw();
      const factor = geometry.farFactor * .25 + geometry.nearFactor * .75, k = 1 - 1 / factor, span = 1 - 2 * geometry.crop;
      const borderX = ((288 / 512 - .5) / span + .5 + k * view.x / geometry.aperture.width) * 512 - .5;
      const borderY = ((288 / 512 - .5) / span + .5 - k * view.y / geometry.aperture.height) * 512 - .5;
      const texel = (x: number, y: number) => {
        const tx = Math.floor(x / 256), ty = Math.floor(y / 256), resident = plane.tiles.find(tile => tile.x === tx && tile.y === ty);
        if (resident === undefined || x < 0 || y < 0 || x >= 448 || y >= 448) return [0, 0, 0, 0];
        const offset = ((y - ty * 256) * resident.width + x - tx * 256) * 4, a = 128 / 255 * plane.opacity;
        return [0, 1, 2].map(c => linear(resident.rgba[offset + c] ?? 0) * a).concat(a);
      };
      // Four sides of the diagonal corner include two absent destination cells.
      for (const x of [Math.floor(borderX), Math.ceil(borderX)]) for (const y of [Math.floor(borderY), Math.ceil(borderY)]) {
        const px = (.5 + (((x + .5) / 512 - .5) - k * view.x / geometry.aperture.width) * span) * 512 - 32;
        const py = (.5 + (((y + .5) / 512 - .5) + k * view.y / geometry.aperture.height) * span) * 512 - 32;
        const ix = Math.floor(px - .5), iy = Math.floor(py - .5), fx = px - .5 - ix, fy = py - .5 - iy;
        const taps = [texel(ix, iy), texel(ix + 1, iy), texel(ix, iy + 1), texel(ix + 1, iy + 1)];
        const ink = [0, 1, 2, 3].map(c => ((taps[0]?.[c] ?? 0) * (1 - fx) + (taps[1]?.[c] ?? 0) * fx) * (1 - fy)
          + ((taps[2]?.[c] ?? 0) * (1 - fx) + (taps[3]?.[c] ?? 0) * fx) * fy);
        const expected = [...[0, 1, 2].map(c => srgb((ink[c] ?? 0) + linear(background[c] ?? 0) * (1 - (ink[3] ?? 0)))), 255];
        const actual = pixel(x, y), missing = (px < 256) === (py < 256);
        sparse.push({ view: view.name, x, y, missing, expected, actual, error: error(expected, actual) });
      }
    }
    renderer.dispose(); master.close();
    return { captures, sparse, preparationAccounted, capturePreservedPixels, mutationInvalidated, clearInvalidated };
  }, { docJson: JSON.stringify(doc), geometry, extremes: [{ name: 'negative', ...lateralEnvelope(geometry).min }, { name: 'positive', ...lateralEnvelope(geometry).max }] });
  await t.file('attachment-sparse.json', JSON.stringify(report, null, 2));
  t.ok('captured half-float, interpolated and refracted depth ties are visible in all views', report.captures.length === 12 && report.captures.every(value => value.error <= 2), report.captures);
  t.ok('sparse diagonal corner filters into absent cells exactly once', report.sparse.length === 12 && report.sparse.some(value => value.missing) && report.sparse.every(value => value.error <= 2), report.sparse);
  t.ok('empty preparation is accounted and preserves displayed pixels', report.preparationAccounted && report.capturePreservedPixels);
  t.ok('accepted paint edits and clear invalidate stale readbacks', report.mutationInvalidated && report.clearInvalidated);
}

export const scenarios: readonly Scenario[] = [{ ...depthScenario, async run(t) {
  await depthScenario.run(t); await attachmentAndSparseProof(t); await resourceProof(t);
} }, outputScenario];
