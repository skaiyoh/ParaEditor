import { z } from '../../../src/core/zod.ts';
import type { MathResult } from '../../../src/core/math-expression.ts';
import type { MathPhotoRack } from '../../../src/render/math-program.ts';
import { fiveClusterDocument } from '../../fixtures/documents.ts';
import type { Scenario } from '../scenario.ts';

const deltaSchema = z.object({ pixels: z.number(), changed: z.number(), max: z.number(), overlapChanged: z.number() });
const evidenceSchema = z.object({
  renderer: z.string(), fixtures: z.array(z.object({ seed: z.number(), amount: z.number(), colorNoise: z.number(),
    size: z.number(), frame: z.number(), clarity: z.number(), surface: z.boolean(), delta: deltaSchema, restored: deltaSchema })),
  checks: z.array(z.object({ name: z.string(), pass: z.boolean(), detail: z.string() })),
  comparisons: z.array(z.object({ name: z.string(), delta: deltaSchema })),
});

/** Runs the production renderer in an isolated canvas. Only the test hook supplies module access. */
async function proof(templateText: string, mode: string): Promise<unknown> {
  const api = window.__noisyTest?.demo.mathGrain;
  if (!api) throw new Error('The MRX3m proof hooks are missing.');
  const unwrap = <T>(result: MathResult<T>): T => {
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.value;
  };
  const base = api.parseScene(JSON.parse(templateText)), presets = unwrap(api.createMathPresets());
  const width = 192, height = 128, size = { width, height };
  const canvas = document.createElement('canvas'), renderer = api.createRenderer(canvas);
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('WebGL2 is missing.');
  const source = new OffscreenCanvas(width, height), context = source.getContext('2d');
  if (!context) throw new Error('The fixture source is unavailable.');
  const pixels = context.createImageData(width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    pixels.data.set([25 + (x * 17 + y * 11) % 205, 30 + (x * 3 + y * 7) % 200,
      35 + (x * 13 + y * 5) % 195, 255], (y * width + x) * 4);
  }
  context.putImageData(pixels, 0, 0);
  const master = await createImageBitmap(source);
  const objects = base.objects.map((object, index) => ({ ...object, subject: index === 0,
    recolor: { kind: 'none' } as const, produced: { ...object.produced,
      mask: { ...object.produced.mask, size }, bounds: { x: 0, y: 0, width, height } } }));
  const masks = new Map(objects.map((object, index) => [object.id, { format: 'u8' as const, size,
    data: Uint8Array.from({ length: width * height }, (_, i) => index === 0 ? (i % width < 160 ? 255 : 0) : (i % width >= 96 ? 255 : 0)) }]));
  const doc = { ...base, objects, seed: 123456789,
    frame: { ...base.frame, master: { ...base.frame.master, size } },
    analysis: { ...base.analysis, depth: null, plate: null },
    symbols: { ...base.symbols, enabled: false }, motion: { ...base.motion, enabled: false, loopSeconds: 3 },
    style: { ...base.style, simplify: 0, outline: 0, clipping: 0, crunch: 0, grain: .52, colorNoise: .32,
      grainSize: 3, grainHold: 2, subjectClarity: .8 }, surface: { ...base.surface, enabled: false } };
  let scene = { doc, master, masks, depth: null, plate: null, selected: null };
  renderer.setScene(scene);
  const read = () => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const bytes = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('GPU readback failed.');
    return bytes;
  };
  const delta = (a: Uint8Array, b: Uint8Array) => {
    let max = 0, changed = 0, overlapChanged = 0;
    for (let i = 0; i < a.length; i += 4) {
      let different = false;
      for (let c = 0; c < 4; c++) { const d = Math.abs((a[i + c] ?? 0) - (b[i + c] ?? 0)); max = Math.max(max, d); different ||= d !== 0; }
      if (different) { changed++; if ((i / 4) % width >= 96 && (i / 4) % width < 160) overlapChanged++; }
    }
    return { pixels: a.length / 4, changed, max, overlapChanged };
  };
  const checks: { name: string; pass: boolean; detail: string }[] = [];
  const check = (name: string, pass: boolean, detail: unknown = '') => checks.push({ name, pass, detail: JSON.stringify(detail) });
  const fixtures = [], comparisons = [];
  const board = document.createElement('div');
  board.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#171717;color:white;padding:20px;display:flex;gap:16px;flex-wrap:wrap;align-content:flex-start;font:16px monospace';
  document.body.append(board);
  function picture(label: string) {
    const figure = document.createElement('figure'), caption = document.createElement('figcaption'), copy = document.createElement('canvas');
    copy.width = width; copy.height = height; copy.style.cssText = 'width:384px;height:256px;image-rendering:pixelated';
    copy.getContext('2d')?.drawImage(canvas, 0, 0); caption.textContent = label; figure.style.margin = '0';
    figure.append(copy, caption); board.append(figure);
  }
  const rack = (amount = .52, colorNoise = .32, grainSize = 3) => unwrap(api.compilePhotoRack([
    { block: presets.grain, parameters: { amount, colorNoise, grainSize }, enabled: true }]));
  const render = (value: MathPhotoRack | null, frame = 14) => {
    renderer.activatePhotoRack(value === null ? null : unwrap(renderer.preparePhotoRack(value)));
    renderer.renderFrame(frame); return read();
  };
  const gpuInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const gpuName = String(gpuInfo ? gl.getParameter(gpuInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  try {
    if (mode === 'parity') {
      for (const seed of [0, 123456789, 0xffffffff]) for (const amount of [.52, 1]) for (const colorNoise of [0, .32]) for (const grainSize of [1, 3]) {
        scene = { ...scene, doc: { ...doc, seed, style: { ...doc.style, grain: amount, colorNoise, grainSize } } };
        renderer.setScene(scene);
        const legacy = render(null), authored = render(rack(amount, colorNoise, grainSize)), restored = render(null);
        fixtures.push({ seed, amount, colorNoise, size: grainSize, frame: 14, clarity: .8, surface: false,
          delta: delta(legacy, authored), restored: delta(legacy, restored) });
      }
      // Exercise the neighboring treatment order and the still (hold zero) path too.
      scene = { ...scene, doc: { ...doc, surface: { ...doc.surface, enabled: true },
        style: { ...doc.style, clipping: .43, crunch: .62 } } };
      renderer.setScene(scene);
      const legacy = render(null, 0); picture('Legacy Grain + Surface / Clipping / Crunch');
      const authored = render(rack(), 0); picture('Authored Grain - exact pixel parity');
      fixtures.push({ seed: doc.seed, amount: .52, colorNoise: .32, size: 3, frame: 0, clarity: .8, surface: true,
        delta: delta(legacy, authored), restored: delta(legacy, render(null, 0)) });
      const held = render(rack(), 14), sameHold = render(rack(), 15), nextHold = render(rack(), 16);
      check('hold index 7 repeats within its hold', delta(held, sameHold).max === 0);
      check('hold index changes the noise', delta(held, nextHold).changed > 0);
      scene = { ...scene, doc: { ...doc, style: { ...doc.style, subjectClarity: 0 } } };
      renderer.setScene(scene); const noClarity = render(rack());
      scene = { ...scene, doc }; renderer.setScene(scene);
      check('subject clarity changes actual pixels', delta(noClarity, render(rack())).changed > 0);
    } else {
      const original = rack(), unchanged = render(original); picture('Authored Identity');
      const threshold = unwrap(api.replaceMathNode({ block: presets.grain, library: presets.library, node: 'remap0',
        replacement: { id: 'grain-threshold', revision: 1 }, ref: { id: 'threshold-grain', revision: 1 } }));
      const thresholdRack = unwrap(api.compilePhotoRack([{ block: threshold, parameters: { amount: .52, colorNoise: .32, grainSize: 3 }, enabled: true }]));
      const changed = render(thresholdRack); picture('Identity replaced with Threshold');
      comparisons.push({ name: 'Identity to Threshold', delta: delta(unchanged, changed) });
      const grain = { block: presets.grain, parameters: { amount: .52, colorNoise: .32, grainSize: 3 }, enabled: true };
      const contrast = { block: presets.contrast, parameters: { strength: 1.6 }, enabled: true };
      const forward = unwrap(api.compilePhotoRack([grain, contrast])), reverse = unwrap(api.compilePhotoRack([contrast, grain]));
      const first = render(forward); picture('Grain then Contrast');
      const second = render(reverse); picture('Contrast then Grain');
      comparisons.push({ name: 'Grain/Contrast order', delta: delta(first, second) });

      // Observe each real authored draw's framebuffer and the next pass's actual input texture.
      const drawArrays = gl.drawArrays.bind(gl);
      const passes: { bits: number[]; bytes: Uint8Array; input: Uint8Array }[] = [];
      gl.drawArrays = (mode, start, count) => {
        const program: unknown = gl.getParameter(gl.CURRENT_PROGRAM);
        const authored = program instanceof WebGLProgram && (gl.getAttachedShaders(program) ?? []).some(shader => gl.getShaderSource(shader)?.includes('m_block('));
        let input = new Uint8Array(0);
        if (authored && program instanceof WebGLProgram) {
          const bound: unknown = gl.getParameter(gl.FRAMEBUFFER_BINDING), active: unknown = gl.getParameter(gl.ACTIVE_TEXTURE);
          const location = gl.getUniformLocation(program, 'src');
          const unit: unknown = location === null ? null : gl.getUniform(program, location);
          if (!(bound instanceof WebGLFramebuffer) || typeof active !== 'number' || typeof unit !== 'number') throw new Error('Missing authored source binding.');
          gl.activeTexture(gl.TEXTURE0 + unit);
          const texture: unknown = gl.getParameter(gl.TEXTURE_BINDING_2D), frame = gl.createFramebuffer();
          if (!(texture instanceof WebGLTexture) || frame === null) throw new Error('Missing authored input texture.');
          gl.bindFramebuffer(gl.FRAMEBUFFER, frame); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
          input = new Uint8Array(width * height * 4); gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, input);
          gl.bindFramebuffer(gl.FRAMEBUFFER, bound); gl.deleteFramebuffer(frame); gl.activeTexture(active);
        }
        drawArrays(mode, start, count);
        if (authored) {
          const bits = [gl.FRAMEBUFFER_ATTACHMENT_RED_SIZE, gl.FRAMEBUFFER_ATTACHMENT_GREEN_SIZE, gl.FRAMEBUFFER_ATTACHMENT_BLUE_SIZE, gl.FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE]
            .map(parameter => Number(gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, parameter)));
          const bytes = new Uint8Array(width * height * 4); gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
          passes.push({ bits, bytes, input });
        }
      };
      try {
        render(forward);
        check('each block draws to a distinct RGBA8 boundary', passes.length === 2 && passes.every(pass => pass.bits.every(bit => bit === 8)), passes.map(pass => pass.bits));
        const a = passes[0], b = passes[1];
        check('second block samples every quantized byte of the first', a !== undefined && b !== undefined && delta(a.bytes, b.input).max === 0);
        passes.length = 0;
        scene = { ...scene, doc: { ...doc, style: { ...doc.style, grain: 0, colorNoise: 0 } } }; renderer.setScene(scene);
        const zeroLegacy = render(null), zeroAuthored = render(rack(0, 0));
        check('zero Grain bypass has no authored draw and exact bytes', passes.length === 0 && delta(zeroLegacy, zeroAuthored).max === 0);
        const disabled = unwrap(api.compilePhotoRack([{ ...grain, enabled: false }]));
        check('disabled block bypass is exact', delta(zeroLegacy, render(disabled)).max === 0 && passes.length === 0);
      } finally { gl.drawArrays = drawArrays; }

      scene = { ...scene, doc }; renderer.setScene(scene); const active = render(thresholdRack);
      const beforeSwap = unwrap(renderer.preparePhotoRack(forward)); renderer.renderFrame(14);
      check('preparation leaves active pixels unchanged', delta(active, read()).max === 0);
      const shaderSource = gl.shaderSource.bind(gl), deleted: WebGLProgram[] = [], deleteProgram = gl.deleteProgram.bind(gl);
      let compiled = 0;
      gl.shaderSource = (shader, source) => shaderSource(shader, source.includes('m_block(') && ++compiled === 2
        ? source.replace('  vec3 m_n', '  MRX3m_forced_failure m_n') : source);
      gl.deleteProgram = program => { if (program !== null) deleted.push(program); deleteProgram(program); };
      try {
        const failed = renderer.preparePhotoRack(forward); renderer.renderFrame(14);
        check('second-pass compile failure returns mapped diagnostic and preserves active', !failed.ok && failed.error.message.includes('MRX3m_forced_failure') &&
          failed.error.sourceId.startsWith('block:') && delta(active, read()).max === 0, failed);
        check('compile failure releases compiled and failed programs plus older pending', compiled === 2 && deleted.length === 4, { compiled, deleted: deleted.length });
      } finally { gl.shaderSource = shaderSource; gl.deleteProgram = deleteProgram; }
      const rejected = renderer.preparePhotoRack({ ...original, passes: [...original.passes, ...original.passes] }); renderer.renderFrame(14);
      check('unadmitted rack is refused and preserves active', !rejected.ok && rejected.error.kind === 'context' && delta(active, read()).max === 0, rejected);
      const bad = api.compilePhotoRack([{ ...grain, parameters: { amount: 2 } }]);
      check('out-of-range source parameter is refused', !bad.ok, bad);
      const refused = (name: string, work: () => void) => {
        try { work(); check(name, false, 'activation succeeded'); } catch (error) { check(name, error instanceof Error && /stale|another renderer|disposed/.test(error.message), String(error)); }
      };
      refused('failed attempt invalidates preceding prepared handle', () => renderer.activatePhotoRack(beforeSwap));
      const stale = unwrap(renderer.preparePhotoRack(original)), latest = unwrap(renderer.preparePhotoRack(forward));
      refused('newer preparation rejects stale handle', () => renderer.activatePhotoRack(stale));
      const foreignCanvas = document.createElement('canvas'), foreign = api.createRenderer(foreignCanvas);
      try { refused('another renderer rejects foreign handle', () => foreign.activatePhotoRack(latest)); } finally { foreign.dispose(); }
      renderer.activatePhotoRack(latest);
      refused('activation consumes handle', () => renderer.activatePhotoRack(latest));
      const canceled = unwrap(renderer.preparePhotoRack(original)); renderer.activatePhotoRack(null);
      refused('null invalidates pending handle', () => renderer.activatePhotoRack(canceled));
      const moved = unwrap(renderer.preparePhotoRack(original)), replacement = await createImageBitmap(source);
      renderer.setScene({ ...scene, master: replacement });
      refused('new photo rejects previous preparation', () => renderer.activatePhotoRack(moved));
      renderer.setScene(scene); replacement.close();
      refused('restoring the old photo cannot revive a stale handle', () => renderer.activatePhotoRack(moved));
      const finalHandle = unwrap(renderer.preparePhotoRack(original)); renderer.dispose();
      refused('disposed renderer rejects prepared handle', () => renderer.activatePhotoRack(finalHandle));
    }
    return { renderer: gpuName, fixtures, checks, comparisons };
  } finally { renderer.dispose(); master.close(); }
}

export const scenarios: readonly Scenario[] = ['parity', 'remix'].map(mode => ({
  id: `math-remix-grain.${mode}`, title: `Authored Grain real WebGL2 ${mode}`, target: 'dev', covers: [], timeoutMs: 180_000,
  async run(t) {
    await t.page.goto('/');
    await t.page.waitFor('math Grain hooks', z.boolean(), () => window.__noisyTest?.demo.mathGrain !== undefined);
    const result = await t.page.evaluate(evidenceSchema, proof, JSON.stringify(fiveClusterDocument()), mode);
    await t.file(`${mode}.json`, JSON.stringify(result, null, 2));
    for (const fixture of result.fixtures) {
      const name = `seed ${fixture.seed} amount ${fixture.amount} color ${fixture.colorNoise} size ${fixture.size} frame ${fixture.frame} surface ${fixture.surface}`;
      t.equal(`${name}: every channel equals legacy`, fixture.delta.max, 0, fixture);
      t.equal(`${name}: null restores every legacy channel`, fixture.restored.max, 0);
    }
    for (const comparison of result.comparisons) t.ok(`${comparison.name} visibly changes overlapping pixels`, comparison.delta.overlapChanged > 100 && comparison.delta.max > 5, comparison);
    for (const check of result.checks) t.ok(check.name, check.pass, check.detail);
    await t.page.screenshot(`math-grain-${mode}`);
  },
}));
