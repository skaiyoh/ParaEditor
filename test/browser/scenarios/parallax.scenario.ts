import { z } from 'zod';
import type { Scenario } from '../scenario.ts';
import { fiveClusterDocument } from '../../fixtures/documents.ts';
import { createPerspectiveGeometry, constrainEye, projectSource } from '../../../src/core/perspective.ts';
import { liveCoverage } from '../../../src/core/live-coverage.ts';
import { currentDocumentSchema } from '../../../src/core/schema.ts';

const checks = z.object({ rendered: z.boolean(), travel: z.number(), expectedTravel: z.number(),
  nearUV: z.boolean(), farUV: z.boolean(), generated: z.boolean(), borders: z.boolean(),
  restored: z.boolean(), immutable: z.boolean(), staleCoverage: z.boolean(),
  neutralGradientError: z.number(), surfaceMoved: z.boolean(), surfaceRoundtrip: z.boolean(), released: z.boolean(),
  hiddenUnsafe: z.boolean(), hiddenPending: z.boolean(), featherChanged: z.number(), featherOutside: z.number(), featherPicking: z.boolean() });

const perspective: Scenario = {
  id: 'parallax.perspective', title: 'Screen-window geometry, provenance, refraction picking and export isolation',
  target: 'dev', covers: ['PX5'], timeoutMs: 300_000,
  async run(context) {
    const { page } = context;
    await page.goto(context.baseUrl);
    await page.evaluate(z.boolean(), async () => {
      const demo = window.__noisyTest?.demo;
      if (demo === undefined) throw new Error('Missing demo surface.');
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
      const ctx = canvas.getContext('2d'); if (ctx === null) throw new Error('No fixture context.');
      ctx.fillStyle = '#777777'; ctx.fillRect(0, 0, 640, 480);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value === null ? reject(new Error('No fixture PNG.')) : resolve(value)));
      await demo.importFile(new File([blob], 'perspective-fixture.png', { type: 'image/png' }));
      if (demo.scene().master === null) throw new Error(`Fixture import failed: ${demo.scene().status}`);
      const start = performance.now();
      while (!demo.analysis().decoderReady || !demo.analysis().depth || demo.analysis().alive.heavy) {
        if (performance.now() - start > 150_000) throw new Error(`Fixture preparation timed out: ${demo.analysis().status}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      demo.setMotion({ enabled: false });
      return true;
    });
    const base = fiveClusterDocument(), first = base.objects[0];
    if (first === undefined || base.analysis.depth === null || base.analysis.plate === null) throw new Error('The scene fixture lacks depth/object/repair metadata.');
    const size = { width: 640, height: 480 }, depthSize = { width: 128, height: 96 };
    const depth = { ...base.analysis.depth, map: { ...base.analysis.depth.map, size: depthSize } };
    const placement = { translate: { x: 0, y: 0 }, pivot: { x: 320, y: 240 }, scale: 1, rotation: 0 };
    const object = { ...first, placement, home: placement,
      depthAttachment: first.depthAttachment.kind === 'source' ? { ...first.depthAttachment, map: depth.map } : first.depthAttachment,
      recolor: { kind: 'none' } satisfies typeof first.recolor, motion: { kind: 'none' } satisfies typeof first.motion,
      produced: { ...first.produced, bounds: { x: 240, y: 180, width: 160, height: 120 },
        mask: { ...first.produced.mask, size: depthSize }, depth: { p10: .9, median: .9, p90: .9 } } };
    const removal = base.removals.find((entry) => entry.ownership.kind === 'legacy-layer' && entry.ownership.layer === object.id);
    if (removal === undefined) throw new Error('The scene fixture lacks its linked source removal.');
    const motion = { ...base.motion, enabled: false, parallax: 2 };
    const doc = { ...base, frame: { ...base.frame, master: { ...base.frame.master, size } },
      analysis: { ...base.analysis, depth, plate: { ...base.analysis.plate,
        image: { ...base.analysis.plate.image, size }, backgroundDepth: { ...base.analysis.plate.backgroundDepth, size: depthSize },
        key: { ...base.analysis.plate.key, source: base.frame.master.asset, size,
          radius: Math.ceil(Math.ceil(Math.max(size.width, size.height) / 100) * motion.parallax), purpose: { kind: 'still' } as const } } },
      style: { ...base.style, simplify: 0, outline: 0, grain: 0, colorNoise: 0, clipping: 0, crunch: 0 },
      symbols: { ...base.symbols, enabled: false }, surface: { ...base.surface, enabled: false }, motion,
      objects: [object], removals: [{ ...removal, mask: { plane: object.produced.mask, provenance: object.produced.provenance } }] };
    const geometry = createPerspectiveGeometry({ aperture: { center: { x: .12, y: -.06 }, width: .8, height: .6 },
      crop: .04, neutralDistance: 1, nearFactor: 1.1, farFactor: 2 });
    const eye = constrainEye({ x: 1, y: 0 }, geometry), coverage = liveCoverage(doc, geometry);
    if (coverage === null) throw new Error('No fixture coverage.');
    const displayPoint = (uv: { x: number; y: number }, disparity: number) => {
      const p = projectSource(uv, disparity, geometry, eye);
      return { x: .5 + (p.x - geometry.aperture.center.x) / geometry.aperture.width,
        y: .5 - (p.y - geometry.aperture.center.y) / geometry.aperture.height };
    };
    const nearAt = displayPoint({ x: .5, y: .5 }, .9), farAt = displayPoint({ x: .15, y: .2 }, .2);
    const result = await page.evaluate(checks, async ({ documentJson, geometry, eye, key, nearAt, farAt }) => {
      // The harness parses this generated fixture with currentDocumentSchema before serialization.
      const doc: import('../../../src/core/types.ts').SceneDocument = JSON.parse(documentJson);
      const renderer = window.__noisyTest?.session?.renderer();
      const stage = document.querySelector('[data-testid="stage"]');
      if (renderer === null || renderer === undefined || !(stage instanceof HTMLCanvasElement)) throw new Error('Missing renderer.');
      const size = doc.frame.master.size, depthSize = { width: 128, height: 96 }, object = doc.objects[0];
      if (object === undefined) throw new Error('No fixture object.');
      const source = document.createElement('canvas'); source.width = size.width; source.height = size.height;
      const ctx = source.getContext('2d', { willReadFrequently: true }); if (ctx === null) throw new Error('No source context.');
      for (let y = 0; y < size.height; y += 8) for (let x = 0; x < size.width; x += 8) {
        ctx.fillStyle = (x / 8 + y / 8) % 2 === 0 ? '#8b9baf' : '#bbcbdc'; ctx.fillRect(x, y, 8, 8);
      }
      const background = ctx.getImageData(0, 0, size.width, size.height);
      ctx.fillStyle = '#ed382d'; ctx.fillRect(240, 180, 160, 120);
      const bitmap = await createImageBitmap(source);
      const mask = { format: 'u8', size: depthSize, data: new Uint8Array(128 * 96) } satisfies import('../../../src/core/raster.ts').Plane<'u8'>;
      const depth = { format: 'f32', size: depthSize, data: new Float32Array(128 * 96).fill(.2) } satisfies import('../../../src/core/raster.ts').Plane<'f32'>;
      for (let y = 36; y < 60; y++) for (let x = 48; x < 80; x++) { mask.data[y * 128 + x] = 255; depth.data[y * 128 + x] = .9; }
      const hole = { format: 'u8', size, data: new Uint8Array(size.width * size.height) } satisfies import('../../../src/core/raster.ts').Plane<'u8'>;
      for (let y = 160; y < 320; y++) for (let x = 220; x < 420; x++) hole.data[y * size.width + x] = 255;
      const image = { size, data: new Uint8Array(size.width * size.height * 3) };
      for (let i = 0; i < size.width * size.height; i++) image.data.set(background.data.subarray(i * 4, i * 4 + 3), i * 3);
      const scene = { doc, master: bitmap, masks: new Map([[object.id, mask]]), depth, plate: null, selected: null,
        livePlate: { key, image, hole, depth } };
      const request = { geometry: { ...geometry, aperture: { ...geometry.aperture, center: { ...geometry.aperture.center } } },
        eye: { ...eye }, sceneGeneration: 31, viewId: 47, frame: 0, showSelection: false };
      renderer.setScene(scene);
      renderer.renderPerspective({ ...request, eye: { x: 0, y: 0, z: eye.z } });
      const centroid = () => {
        const bytes = renderer.debug?.readGeometryPatch?.(0, 0, size.width, size.height);
        if (bytes === undefined) throw new Error('Missing geometry labels.');
        let total = 0, count = 0;
        for (let i = 0; i < bytes.length; i += 4) if (bytes[i] === 1) { total += i / 4 % size.width; count++; }
        if (count === 0) throw new Error('No rendered object.');
        return total / count;
      };
      const centered = centroid(), rendered = renderer.renderPerspective(request).kind === 'rendered';
      const travel = centroid() - centered, expectedTravel = (nearAt.x - .5) * size.width;
      const nearHit = renderer.hitTest(nearAt), farHit = renderer.hitTest(farAt);
      const nearUV = nearHit.kind === 'original' && nearHit.objectId === object.id && Math.abs(nearHit.sourceUV.x - .5) < 2 / size.width && Math.abs(nearHit.sourceUV.y - .5) < 2 / size.height;
      const farUV = farHit.kind === 'original' && farHit.objectId === null && Math.abs(farHit.sourceUV.x - .15) < 2 / size.width && Math.abs(farHit.sourceUV.y - .2) < 2 / size.height;
      let generated = false;
      for (let x = .34; x <= .7; x += .01) if (renderer.hitTest({ x, y: .5 }).kind === 'generated') generated = true;
      const border = renderer.debug?.readGeometryPatch?.(0, 0, size.width, size.height);
      const borders = border !== undefined && Array.from({ length: size.width }, (_, x) => [x, (size.height - 1) * size.width + x]).flat()
        .concat(Array.from({ length: size.height }, (_, y) => [y * size.width, y * size.width + size.width - 1]).flat()).every((i) => border[i * 4 + 3] === 255);
      const capture = () => { ctx.drawImage(stage, 0, 0); return ctx.getImageData(0, 0, size.width, size.height).data; };
      const probe = window.__noisyTest?.demo.render;
      if (probe === null || probe === undefined || border === undefined) throw new Error('Missing feather comparison probes.');
      const feathered = capture(), featherHit = renderer.hitTest(nearAt);
      probe.setMotionFeather(false);
      renderer.renderPerspective(request);
      const hard = capture(), hardLabels = probe.readGeometryPatch?.(0, 0, size.width, size.height);
      const featherPicking = hardLabels !== undefined && border.every((value, i) => value === hardLabels[i]) &&
        JSON.stringify(featherHit) === JSON.stringify(renderer.hitTest(nearAt));
      let featherChanged = 0, featherOutside = 0;
      for (let i = 0; i < hard.length; i += 4) {
        if (hard[i] === feathered[i] && hard[i + 1] === feathered[i + 1] && hard[i + 2] === feathered[i + 2]) continue;
        featherChanged++;
        const x = i / 4 % size.width, y = Math.floor(i / 4 / size.width), id = border[i];
        let rim = false;
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
          const px = Math.max(0, Math.min(size.width - 1, x + dx)), py = Math.max(0, Math.min(size.height - 1, y + dy));
          if (border[(py * size.width + px) * 4] !== id) rim = true;
        }
        if (!rim) featherOutside++;
      }
      probe.setMotionFeather(true);
      renderer.renderPerspective(request);
      const before = capture();
      request.eye.x = -eye.x; request.geometry.aperture.center.x = .44;
      await renderer.exportStill();
      const after = capture(), restored = before.every((value, i) => value === after[i]);
      const restoredHit = renderer.hitTest(nearAt);
      const immutable = restoredHit.kind === 'original' && restoredHit.viewId === 47 && restoredHit.sceneGeneration === 31 && restoredHit.objectId === object.id;
      const normalRequest = { ...request, geometry, eye };
      const staleCoverage = renderer.renderPerspective({ ...normalRequest, geometry: { ...geometry, crop: .03 } }).kind === 'limited';
      const unsafe = { ...depth, data: new Float32Array(depth.data.length) };
      for (let y = 0; y < depthSize.height; y++) for (let x = 0; x < depthSize.width; x++) unsafe.data[y * depthSize.width + x] = x < 63 ? .3 : .6;
      const hiddenDoc = { ...doc, objects: [{ ...object, hidden: true }] };
      renderer.setScene({ ...scene, doc: hiddenDoc, depth: unsafe, livePlate: { key, image, hole, depth: unsafe } });
      const limitedHidden = renderer.renderPerspective(normalRequest);
      const hiddenUnsafe = limitedHidden.kind === 'rendered' && limitedHidden.travelScale > 0 && limitedHidden.travelScale < 1 &&
        renderer.hitTest({ x: .5, y: .5 }).kind === 'generated';
      const savedMetadata = doc.analysis.plate;
      if (savedMetadata === null) throw new Error('Fixture requires saved plate metadata.');
      const savedScene = { ...scene, livePlate: null, plate: image,
        doc: { ...hiddenDoc, analysis: { ...doc.analysis, plate: { ...savedMetadata, image: { ...savedMetadata.image, size } } } } };
      renderer.setScene(savedScene); renderer.renderStill(); const savedHidden = capture();
      const pendingHidden = renderer.renderPerspective(normalRequest), pendingPixels = capture();
      const hiddenPending = pendingHidden.kind === 'limited' && savedHidden.every((value, i) => value === pendingPixels[i]);
      // Varying depth inside every grid cell must still preserve source UV at neutral.
      const gradient = { ...depth, data: new Float32Array(depth.data.length) };
      // Alternating depths vary strongly inside a mesh cell, exposing incorrect 1/w UV interpolation.
      // Its travel may be limited by the depth-edge guard; the neutral image must still be exact.
      for (let y = 0; y < depthSize.height; y++) for (let x = 0; x < depthSize.width; x++) gradient.data[y * depthSize.width + x] = x % 2;
      renderer.setScene({ ...scene, doc: { ...doc, objects: [], removals: [] }, depth: gradient, masks: new Map(), livePlate: null });
      renderer.renderPerspective({ ...normalRequest, eye: { x: 0, y: 0, z: eye.z } });
      let neutralGradientError = 0;
      for (const at of [{ x: .1234, y: .2367 }, { x: .6789, y: .7654 }]) {
        const hit = renderer.hitTest(at);
        if (hit.kind !== 'original') throw new Error('No gradient source hit.');
        const px = (Math.floor(at.x * size.width) + .5) / size.width, py = (Math.floor(at.y * size.height) + .5) / size.height;
        neutralGradientError = Math.max(neutralGradientError, Math.abs(hit.sourceUV.x - (.5 + (px - .5) * (1 - 2 * geometry.crop))),
          Math.abs(hit.sourceUV.y - (.5 + (py - .5) * (1 - 2 * geometry.crop))));
      }
      const surfaceDoc = { ...doc, surface: { enabled: true, pattern: 'bars', relief: 1, refraction: 1, shine: 0, scale: .5 } satisfies typeof doc.surface };
      renderer.setScene({ ...scene, doc: surfaceDoc }); renderer.renderPerspective(normalRequest);
      let surfaceMoved = false, surfaceRoundtrip = true;
      // Refraction lookup should move source coordinates while retaining stable original-object hits.
      for (const x of [.46, .48, .5, .52, .54]) {
        const refracted = renderer.hitTest({ x, y: .5 });
        renderer.setScene(scene); renderer.renderPerspective(normalRequest);
        const plain = renderer.hitTest({ x, y: .5 });
        renderer.setScene({ ...scene, doc: surfaceDoc }); renderer.renderPerspective(normalRequest);
        const again = renderer.hitTest({ x, y: .5 });
        if (refracted.kind === 'original' && plain.kind === 'original') surfaceMoved ||= Math.abs(refracted.sourceUV.x - plain.sourceUV.x) > .001;
        surfaceRoundtrip &&= JSON.stringify(refracted) === JSON.stringify(again);
      }
      renderer.endPerspective();
      const resources = renderer.debug?.perspectiveResources?.();
      const released = resources?.targets === 0 && resources.textures === 0 && renderer.hitTest({ x: .5, y: .5 }).kind === 'miss';
      renderer.renderPerspective(normalRequest);
      return { rendered, travel, expectedTravel, nearUV, farUV, generated, borders, restored, immutable, staleCoverage,
        neutralGradientError, surfaceMoved, surfaceRoundtrip, released, hiddenUnsafe, hiddenPending, featherChanged, featherOutside, featherPicking };
    }, { documentJson: JSON.stringify(currentDocumentSchema.parse(doc)), geometry, eye, key: coverage.key, nearAt, farAt });
    context.ok('prepared live scene renders', result.rendered, result);
    context.ok('near-feature travel agrees with the CPU reference within one render pixel', Math.abs(result.travel - result.expectedTravel) <= 1, result);
    context.ok('near and far hits retain analytical original UV', result.nearUV && result.farUV, result);
    context.ok('generated background is not reported as an original-photo prompt', result.generated);
    context.ok('the permitted view has opaque borders', result.borders);
    context.ok('live perspective keeps MOT1 feather color at the rim and exact picking',
      result.featherChanged > 0 && result.featherOutside === 0 && result.featherPicking, result);
    context.ok('export restores live pixels and immutable view identity', result.restored && result.immutable, result);
    context.ok('stale prepared coverage is limited at neutral', result.staleCoverage);
    context.ok('neutral source interpolation remains exact on a depth gradient', result.neutralGradientError < 2 / 65535, result);
    context.ok('refraction remaps source UV deterministically', result.surfaceMoved && result.surfaceRoundtrip, result);
    context.ok('ending the live attempt releases all live textures/targets and invalidates hits', result.released);
    context.ok('bounded geometry keeps hidden objects erased using the matching live plate', result.hiddenUnsafe);
    context.ok('missing live coverage preserves the saved hidden-object still', result.hiddenPending);
    await page.screenshot('perspective-window');
    await context.file('perspective.json', JSON.stringify(result, null, 2));
  },
};

export const scenarios: readonly Scenario[] = [perspective];
