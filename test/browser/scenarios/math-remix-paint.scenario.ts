import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { z } from '../../../src/core/zod.ts';
import { encodeRaster } from '../../../src/core/asset-codec.ts';
import { compositionDocumentSchema } from '../../../src/core/composition-schema.ts';
import { isAssetId, isSceneId } from '../../../src/core/ids.ts';
import { minimalDocument, DEPTH_MODEL } from '../../fixtures/documents.ts';
import type { Scenario, ScenarioContext } from '../scenario.ts';

const size = { width: 512, height: 512 };
function hash(bytes: Uint8Array) {
  const id = createHash('sha256').update(bytes).digest('hex');
  if (!isAssetId(id)) throw new Error('Invalid fixture hash.');
  return id;
}
function png(): Uint8Array {
  const chunk = (name: string, bytes: Uint8Array): Buffer => {
    const body = Buffer.concat([Buffer.from(name), bytes]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
    const header = Buffer.alloc(4), tail = Buffer.alloc(4); header.writeUInt32BE(bytes.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([header, body, tail]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(512, 0); header.writeUInt32BE(512, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc(512 * (512 * 4 + 1));
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) rows.set(x < 256 ? [48, 64, 80, 255] : [208, 96, 40, 255], y * 2049 + 1 + x * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', new Uint8Array())]);
}
/** A real Projects reopen supplies resident depth, avoiding inference or CPU
 * sampling substitutes. Photo ordering remains the project's legacy ordering. */
async function installFixture(t: ScenarioContext): Promise<string> {
  await t.page.goto(t.baseUrl);
  const id = randomUUID(); if (!isSceneId(id)) throw new Error('Invalid fixture id.');
  const photo = png(), depth = encodeRaster({ format: 'f32', size, data: Float32Array.from({ length: 512 * 512 }, (_v, i) => i % 512 < 256 ? .25 : .75) });
  const photoId = hash(photo), depthId = hash(depth), base = minimalDocument();
  const doc = compositionDocumentSchema.parse({ ...base, id, title: 'Paint scene',
    frame: { source: { asset: photoId, mediaType: 'image/png', byteLength: photo.length }, master: { asset: photoId, size },
      original: { name: 'paint-scene.png', mediaType: 'image/png', size } },
    analysis: { ...base.analysis, autoSubject: 'done', depth: { model: DEPTH_MODEL, map: { asset: depthId, format: 'f32', size }, stats: { p10: .25, median: .5, p90: .75 } } } });
  await t.page.evaluate(z.literal(true), async ({ id, photoId, depthId, photo, depth, documentJson }) => {
    const bytes = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0));
    const put = async (path: string, body: BodyInit, mediaType: string) => {
      const response = await fetch(`/api/projects/${id}/${path}`, { method: 'PUT', headers: { 'Content-Type': mediaType }, body });
      if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
    };
    await put(`assets/${photoId}`, bytes(photo), 'application/octet-stream');
    await put(`assets/${depthId}`, bytes(depth), 'application/octet-stream');
    const bitmap = await createImageBitmap(new Blob([bytes(photo)], { type: 'image/png' }));
    const thumbnail = new OffscreenCanvas(256, 256), context = thumbnail.getContext('2d');
    if (context === null) throw new Error('No thumbnail context.');
    context.drawImage(bitmap, 0, 0, 256, 256); bitmap.close();
    await put('thumbnail', await thumbnail.convertToBlob({ type: 'image/jpeg', quality: .8 }), 'image/jpeg');
    await put('scene', JSON.stringify({ transportVersion: 2, document: JSON.parse(documentJson), revision: 0 }), 'application/json');
    const demo = window.__noisyTest?.demo;
    if (demo === undefined || !await demo.openProject(id)) throw new Error(demo?.scene().status ?? 'No session.');
    return true;
  }, { id, photoId, depthId, photo: Buffer.from(photo).toString('base64'), depth: Buffer.from(depth).toString('base64'), documentJson: JSON.stringify(doc) });
  return id;
}

const brushScenario: Scenario = {
  id: 'math-remix.brush', target: 'dev', title: 'Canonical brush pad, canvas resizing and readable settings', covers: ['MRX4b-paint-6', 'MRX4b-paint-8', 'MRX4b-paint-9', 'MRX4b-paint-10', 'MRX4b-paint-11'],
  async run(t) {
    await t.page.goto(t.baseUrl);
    const result = await t.page.evaluate(z.record(z.string(), z.boolean()), async () => {
      const demo = window.__noisyTest?.demo; if (demo === undefined) throw new Error('No brush session.');
      const paint = demo.paint, canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 128;
      canvas.style.cssText = 'position:fixed;left:24px;top:24px;width:512px;height:256px;z-index:99999;background:repeating-conic-gradient(#ddd 0% 25%,#fff 0% 50%) 0/24px 24px'; document.body.append(canvas);
      const context = canvas.getContext('2d', { willReadFrequently: true }); if (context === null) throw new Error('No pad context.');
      const read = () => context.getImageData(0, 0, canvas.width, canvas.height).data;
      paint.attachBrushPreview(canvas);
      await paint.setBrush({ operation: 'draw', diameter: 30, opacity: .5, pressure: 'size', color: { l: .7, c: .2, h: 25 } });
      const original = read(), state = paint.state();
      const replayed = original.some((value, i) => i % 4 === 3 && value > 0), transparent = original[3] === 0;
      canvas.width = 512; canvas.height = 256; await new Promise(resolve => setTimeout(resolve, 0));
      const resized = read().some((value, i) => i % 4 === 3 && value > 0);
      paint.resetBrushPreview(); const reset = read().every(value => value === 0);
      const input = { surface: 'pad' as const, pointer: 'finger' as const, sample: { at: { x: .4, y: .4 }, pressure: .01 } };
      const denied = paint.beginStroke(input); paint.setFingerDraw(true); const begun = paint.beginStroke(input);
      const accepted = begun.kind === 'began' && (await paint.endStroke(begun.token)).kind === 'applied';
      demo.setTool('eraser'); const eraser = paint.state(); demo.setTool('brush'); const brush = paint.state();
      await paint.replayBrushPreview(); const availability = paint.drawingAvailability();
      return { replayed, transparent, resized, reset, fingerDenied: denied.kind === 'refused', fingerAccepted: accepted && paint.state().fingerDraw,
        brushReadable: state.brush.operation === 'draw' && state.brush.diameter === 30 && state.brush.opacity === .5 && state.brush.color.h === 25,
        toolsReadable: eraser.tool === 'eraser' && eraser.brush.operation === 'erase' && brush.tool === 'brush' && brush.brush.operation === 'draw' && brush.brush.color.h === 25,
        noPhoto: availability.kind === 'unavailable' && availability.reason.includes('Open a photo') && !('action' in availability) };
    });
    await t.file('brush.json', JSON.stringify(result, null, 2));
    for (const [check, passed] of Object.entries(result)) t.ok(check, passed);
    await t.page.screenshot('brush-pad');
  },
};

const depthScenario: Scenario = {
  id: 'math-remix.depth', target: 'dev', timeoutMs: 180_000, title: 'Scene captures, opaque occlusion, exact Undo and atomic erasure', covers: ['MRX4b-paint-1', 'MRX4b-paint-2', 'MRX4b-paint-3', 'MRX4b-paint-5'],
  async run(t) {
    await installFixture(t);
    const result = await t.page.evaluate(z.object({ checks: z.record(z.string(), z.boolean()), details: z.string(), pixels: z.array(z.array(z.number())) }), async () => {
      const demo = window.__noisyTest?.demo; if (demo === undefined) throw new Error('No paint session.');
      const paint = demo.paint;
      const read = async () => { const bitmap = await createImageBitmap(await demo.downloadPng()), canvas = new OffscreenCanvas(512, 512), context = canvas.getContext('2d', { willReadFrequently: true });
        if (context === null) throw new Error('No pixels.'); context.drawImage(bitmap, 0, 0); bitmap.close(); return context.getImageData(0, 0, 512, 512).data; };
      const stroke = async (x: number, y: number, end: number) => { const begun = paint.beginStroke({ surface: 'scene', pointer: 'pen', sample: { at: { x, y }, pressure: 1 } });
        if (begun.kind === 'refused') throw new Error(begun.reason);
        paint.extendStroke(begun.token, [{ at: { x: end, y }, pressure: 1 }]); const result = await paint.endStroke(begun.token);
        if (result.kind !== 'applied') throw new Error(JSON.stringify(result)); return begun.token; };
      const baseline = await read(), startHistory = demo.historyState().undoDepth;
      await paint.setBrush({ operation: 'draw', diameter: 24, opacity: 1, pressure: 'size', color: { l: .8, c: .2, h: 145 } });
      const available = paint.drawingAvailability().kind === 'available';
      await stroke(64, 180, 448); await stroke(448, 220, 64);
      const doc = demo.document(); if (doc?.version !== 6) throw new Error('No saved paint section.');
      const patches = doc.paint.layers.flatMap(layer => layer.patches), painted = await read();
      const equal = (a: Uint8ClampedArray, b: Uint8ClampedArray) => a.every((value, i) => value === b[i]);
      const pixel = (bytes: Uint8ClampedArray, x: number, y: number) => [...bytes.slice((y * 512 + x) * 4, (y * 512 + x) * 4 + 4)];
      const onePerStroke = demo.historyState().undoDepth === startHistory + 2;
      // Replay the exact session plane identities through MRX3 at two eyes.
      const perspectiveCanvas = document.createElement('canvas'); perspectiveCanvas.width = perspectiveCanvas.height = 512;
      const renderer = demo.paintProof.createRenderer(perspectiveCanvas), original = demo.projectAssets().find(asset => asset.asset === doc.frame.master.asset);
      if (original === undefined) throw new Error('No saved photo pixels.');
      const master = await createImageBitmap(new Blob([new Uint8Array(original.bytes)], { type: 'image/png' }));
      const projection = { aperture: { center: { x: 0, y: 0 }, width: .8, height: .8 }, crop: .1, neutralDistance: 2, nearFactor: 1.1, farFactor: 2 };
      const comparison = new OffscreenCanvas(512, 512), pixels = comparison.getContext('2d', { willReadFrequently: true }); if (pixels === null) throw new Error('No perspective readback.');
      renderer.setScene({ doc, master, selected: null, masks: new Map(), plate: null, depth: { format: 'f32', size: { width: 512, height: 512 }, data: Float32Array.from({ length: 512 * 512 }, (_v, i) => i % 512 < 256 ? .25 : .75) } });
      const perspectiveChecks: boolean[] = [];
      for (const eyeX of [0, .2]) {
        const view = { geometry: projection, eye: { x: eyeX, y: 0, z: 2 }, sceneGeneration: 1, viewId: 1 };
        renderer.setPaintPlanes([]); const control = renderer.renderPerspective(view); pixels.drawImage(perspectiveCanvas, 0, 0); const photo = pixels.getImageData(0, 0, 512, 512).data;
        const acceptedEyeX = control.kind === 'limited' ? 0 : control.eye.x;
        const admission = renderer.setPaintPlanes(paint.planes()), drawn = renderer.renderPerspective({ ...view, viewId: 2 }); pixels.drawImage(perspectiveCanvas, 0, 0); const marks = pixels.getImageData(0, 0, 512, 512).data;
        const position = (x: number, y: number, d: number) => { const factor = 2 * (1 - d) + 1.1 * d; return { x: Math.round((.5 + (x / 512 - .5 + (1 - 1 / factor) * acceptedEyeX) / .8) * 512), y: Math.round((.5 + (y / 512 - .5) / .8) * 512) }; };
        const far = position(340, 180, .25), near = position(100, 220, .75);
        const same = (point: { x: number; y: number }) => { const at = (point.y * 512 + point.x) * 4; return [0, 1, 2, 3].every(c => photo[at + c] === marks[at + c]); };
        perspectiveChecks.push(control.kind !== 'limited' && drawn.kind !== 'limited' && drawn.eye.x === acceptedEyeX && control.travelScale > 0 && drawn.travelScale === control.travelScale && admission.kind === 'accepted' && same(far) && !same(near));
      }
      renderer.dispose(); master.close();
      const outsideUnchanged = painted.every((value, i) => { const y = Math.floor(i / 4 / 512); return y >= 167 && y <= 233 || value === baseline[i]; });
      const farHidden = pixel(painted, 400, 180).every((v, i) => v === pixel(baseline, 400, 180)[i]);
      const nearVisible = pixel(painted, 100, 220).some((v, i) => v !== pixel(baseline, 100, 220)[i]);
      demo.c2Undo(); demo.c2Undo(); const undoExact = equal(await read(), baseline);
      demo.c2Redo(); demo.c2Redo(); const redoExact = equal(await read(), painted);
      demo.setTool('brush'); const beforeCancel = JSON.stringify(demo.document()), beforeHistory = demo.historyState().undoDepth;
      for (const reason of ['explicit', 'second-touch', 'lost-capture', 'tool-change', 'generation-change'] as const) {
        const begun = paint.beginStroke({ surface: 'scene', pointer: 'pen', sample: { at: { x: 80, y: 300 }, pressure: 1 } });
        if (begun.kind !== 'began') throw new Error(begun.reason);
        if (reason === 'explicit') paint.cancelStroke(begun.token);
        else if (reason === 'tool-change') demo.setTool('select');
        else if (reason === 'second-touch') paint.beginStroke({ surface: 'scene', pointer: 'finger', sample: { at: { x: 90, y: 300 }, pressure: null } });
        else paint.interrupt(reason);
        await paint.endStroke(begun.token);
      }
      const cancellation = JSON.stringify(demo.document()) === beforeCancel && demo.historyState().undoDepth === beforeHistory;
      const motionGesture = demo.beginGesture({ operation: 'motion', target: { kind: 'scene' } });
      if (motionGesture === null) throw new Error('No motion gesture.');
      demo.updateGesture({ token: motionGesture, value: { kind: 'motion', patch: { enabled: true, parallax: .8 } } });
      const overlap = paint.beginStroke({ surface: 'scene', pointer: 'pen', sample: { at: { x: 80, y: 300 }, pressure: 1 } });
      if (overlap.kind !== 'began') throw new Error(overlap.reason);
      const staleMotion = demo.updateGesture({ token: motionGesture, value: { kind: 'motion', patch: { parallax: .1 } } });
      paint.cancelStroke(overlap.token);
      const motionOverlap = staleMotion.kind === 'cancelled' && (await paint.endStroke(overlap.token)).kind === 'cancelled' && JSON.stringify(demo.document()) === beforeCancel;
      // Cancellation must also win after release, while native tile hashing is pending.
      const nativeDigest = crypto.subtle.digest.bind(crypto.subtle); let releaseHash = () => {}, hashStarted = false;
      const hashGate = new Promise<void>(resolve => { releaseHash = resolve; });
      crypto.subtle.digest = async (algorithm, input) => { const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
        if (bytes[0] === 78 && bytes[1] === 83 && bytes[2] === 82 && bytes[3] === 65) { hashStarted = true; await hashGate; }
        return nativeDigest(algorithm, input); };
      let hashCancellation = false;
      try {
        const begun = paint.beginStroke({ surface: 'scene', pointer: 'pen', sample: { at: { x: 80, y: 300 }, pressure: 1 } });
        if (begun.kind !== 'began') throw new Error(begun.reason);
        const ended = paint.endStroke(begun.token);
        for (let attempt = 0; attempt < 100 && !hashStarted; attempt++) await new Promise(resolve => setTimeout(resolve, 0));
        paint.cancelStroke(begun.token); releaseHash();
        hashCancellation = hashStarted && (await ended).kind === 'cancelled' && JSON.stringify(demo.document()) === beforeCancel && demo.historyState().undoDepth === beforeHistory;
      } finally { releaseHash(); crypto.subtle.digest = nativeDigest; }
      await paint.flush();
      const generationDoc = demo.document(); if (generationDoc?.version !== 6) throw new Error('No generation checkpoint.');
      const oldGeneration = paint.beginStroke({ surface: 'scene', pointer: 'pen', sample: { at: { x: 80, y: 300 }, pressure: 1 } });
      if (oldGeneration.kind !== 'began') throw new Error(oldGeneration.reason);
      const opened = await demo.openProject(generationDoc.id), afterGeneration = demo.document();
      const reopenFailure = opened ? null : demo.scene().status;
      if (!opened) paint.cancelStroke(oldGeneration.token);
      const generationEnd = await paint.endStroke(oldGeneration.token);
      const generationCancellation = opened && generationEnd.kind === 'cancelled' && afterGeneration?.version === 6 && JSON.stringify(afterGeneration.paint.layers) === JSON.stringify(generationDoc.paint.layers);
      const capturedView = paint.renderPerspective(projection, { x: .2, y: 0, z: 2 });
      if (capturedView.kind === 'limited') throw new Error(capturedView.reason);
      const projected = paint.beginStroke({ surface: 'scene', pointer: 'pen', sample: { at: { x: 380, y: 380 }, pressure: 1 } });
      if (projected.kind !== 'began') throw new Error(projected.reason);
      const beforeSettings = demo.document(); if (beforeSettings?.version !== 6) throw new Error('No settings document.');
      const originalLayers = JSON.stringify(beforeSettings.paint.layers);
      await paint.setBrush({ operation: 'draw', diameter: 8, opacity: 1, pressure: 'off', color: { l: .65, c: .2, h: 255 } });
      const settingsDoc = demo.document(), futureOnly = settingsDoc?.version === 6 && JSON.stringify(settingsDoc.paint.layers) === originalLayers;
      const projectedResult = await paint.endStroke(projected.token), projectedDoc = demo.document();
      const capturedPatch = projectedDoc?.version === 6 ? projectedDoc.paint.layers[0]?.patches.at(-1) : undefined;
      const capturedFactor = 2 * (1 - (capturedPatch?.disparity ?? 0)) + 1.1 * (capturedPatch?.disparity ?? 0);
      const capturedAt = { x: Math.round(((380 / 512 - .5) * .8 + .5 - (1 - 1 / capturedFactor) * capturedView.eye.x) * 512), y: Math.round(((380 / 512 - .5) * .8 + .5) * 512) };
      const projectedPixels = await read(), originalInk = pixel(painted, 100, 220);
      const captureInverse = projectedResult.kind === 'applied' && projectedDoc?.version === 6 && projectedDoc.paint.layers[0]?.patches.length === 3 &&
        pixel(projectedPixels, capturedAt.x, capturedAt.y).every((v, i) => v === originalInk[i]) && pixel(projectedPixels, 380, 380).every((v, i) => v === pixel(baseline, 380, 380)[i]);
      demo.c2Undo();
      paint.selectPaintLayer(null); await stroke(420, 180, 450);
      const layers = demo.document(); if (layers?.version !== 6 || layers.paint.layers.length !== 2) throw new Error('No second layer.');
      const first = layers.paint.layers[0], other = layers.paint.layers[1]; if (first === undefined || other === undefined) throw new Error('No layers.');
      paint.selectPaintLayer(first.id); await paint.setBrush({ operation: 'erase', diameter: 100, opacity: 1, pressure: 'off' });
      const beforeErase = demo.historyState().undoDepth; await stroke(200, 200, 450);
      const erased = demo.document();
      const eraseOneAction = demo.historyState().undoDepth === beforeErase + 1;
      const otherLayerExact = erased?.version === 6 && JSON.stringify(erased.paint.layers[1]) === JSON.stringify(other);
      const allPatchesErased = erased?.version === 6 && erased.paint.layers[0]?.patches.every((patch, i) => JSON.stringify(patch.tiles) !== JSON.stringify(first.patches[i]?.tiles)) === true;
      demo.c2Undo();
      const restored = demo.document(); const eraseUndoExact = restored?.version === 6 && JSON.stringify(restored.paint.layers[0]) === JSON.stringify(first);
      const flushed = await paint.flush();
      return { checks: { available, twoCapturedDepths: patches.length === 2 && Math.abs((patches[0]?.disparity ?? 0) - (patches[1]?.disparity ?? 0)) > .4,
        onePerStroke, perspectiveNeutral: perspectiveChecks[0] === true, perspectiveExtreme: perspectiveChecks[1] === true, outsideUnchanged, farHidden, nearVisible, undoExact, redoExact, cancellation, motionOverlap, hashCancellation, generationCancellation, futureOnly, captureInverse, eraseOneAction, otherLayerExact, allPatchesErased, eraseUndoExact,
        policyUnchanged: doc.compositing === 'legacy-order' && doc.policyTransition === null, saved: flushed.kind === 'saved' },
        details: JSON.stringify({ disparities: patches.map(patch => patch.disparity), reopenFailure, history: demo.historyState(), doc: demo.document() }),
        pixels: [pixel(baseline, 400, 180), pixel(painted, 400, 180), pixel(baseline, 100, 220), pixel(painted, 100, 220)] };
    });
    await t.file('depth.json', JSON.stringify(result, null, 2));
    for (const [check, passed] of Object.entries(result.checks)) t.ok(check, passed, result.pixels);
    await t.page.screenshot('depth-strokes');
  },
};

const outputScenario: Scenario = {
  id: 'math-remix.output', target: 'dev', timeoutMs: 240_000, title: 'Paint assets reopen, publish and enter all real export paths', covers: ['MRX4b-paint-1', 'MRX4b-paint-4'],
  async run(t) {
    const id = await installFixture(t);
    const saved = await t.page.evaluate(z.object({ png: z.string(), patches: z.string(), tiles: z.array(z.string()), checks: z.record(z.string(), z.boolean()) }), async (id) => {
      const demo = window.__noisyTest?.demo; if (demo === undefined) throw new Error('No scene.');
      await demo.paint.setBrush({ operation: 'draw', diameter: 40, opacity: 1, pressure: 'off', color: { l: .8, c: .2, h: 145 } });
      const begun = demo.paint.beginStroke({ surface: 'scene', pointer: 'pen', sample: { at: { x: 448, y: 220 }, pressure: 1 } });
      if (begun.kind !== 'began') throw new Error(begun.reason);
      demo.paint.extendStroke(begun.token, [{ at: { x: 64, y: 220 }, pressure: 1 }]);
      const ended = await demo.paint.endStroke(begun.token); if (ended.kind !== 'applied') throw new Error(JSON.stringify(ended));
      const flushed = await demo.paint.flush(), doc = demo.document(); if (doc?.version !== 6) throw new Error('No v6 paint.');
      const tileIds = doc.paint.layers.flatMap(layer => layer.patches.flatMap(patch => patch.tiles.map(tile => tile.rgba.asset)));
      const assets = demo.projectAssets(); let exactAssets = true;
      for (const asset of tileIds) {
        const bytes = new Uint8Array(await (await fetch(`/api/projects/${id}/assets/${asset}`)).arrayBuffer()), resident = assets.find(value => value.asset === asset);
        exactAssets &&= resident !== undefined && bytes.length === resident.bytes.length && bytes.every((v, i) => v === resident.bytes[i]);
      }
      const blob = await demo.downloadPng(), png = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result.split(',')[1] ?? '') : reject(new Error('No PNG.')); reader.onerror = reject; reader.readAsDataURL(blob); });
      return { png, patches: JSON.stringify(doc.paint.layers), tiles: tileIds, checks: { checkpointSaved: flushed.kind === 'saved', exactAssets } };
    }, id);
    await t.file('paint.png', Buffer.from(saved.png, 'base64'));
    const requests = await t.server.requestLog(), checkpoint = requests.filter(line => line.method === 'PUT' && line.path === `/api/projects/${id}/scene`).at(-1);
    t.ok('tile uploads precede acknowledged checkpoint', checkpoint !== undefined && saved.tiles.every(asset => requests.some(line => line.method === 'PUT' && line.path === `/api/projects/${id}/assets/${asset}` && line.status === 200 && line.seq < checkpoint.seq)), requests.filter(line => line.path.startsWith(`/api/projects/${id}`)));
    const output = await t.page.evaluate(z.object({ checks: z.record(z.string(), z.boolean()), gif: z.string(), movie: z.string(), extension: z.string(), published: z.string(), url: z.string() }), async () => {
      const demo = window.__noisyTest?.demo; if (demo === undefined) throw new Error('No export session.');
      const toData = (blob: Blob) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result.split(',')[1] ?? '') : reject(new Error('No bytes.')); reader.onerror = reject; reader.readAsDataURL(blob); });
      const canvas = new OffscreenCanvas(512, 512), context = canvas.getContext('2d', { willReadFrequently: true }); if (context === null) throw new Error('No output pixels.');
      const read = async (blob: Blob) => { const bitmap = await createImageBitmap(blob); context.drawImage(bitmap, 0, 0, 512, 512); bitmap.close(); return context.getImageData(0, 0, 512, 512).data; };
      const clean = await read(await demo.downloadPng());
      const pad = document.createElement('canvas'); pad.width = 256; pad.height = 128; demo.paint.attachBrushPreview(pad); await demo.paint.replayBrushPreview();
      const selection = demo.beginSelection({ space: { kind: 'photo' }, pointerId: 101, kind: 'shape', tool: 'rectangle', mode: 'replace', at: { x: 30, y: 30 } });
      if (selection.kind !== 'began') throw new Error(selection.reason);
      demo.extendSelection({ token: selection.token, pointerId: 101, kind: 'shape', at: { x: 480, y: 480 } }); await demo.endSelection({ token: selection.token, pointerId: 101 });
      demo.setCompare('source-photo');
      const still = await read(await demo.downloadPng()), undecorated = still.every((v, i) => v === clean[i]);
      const selected = demo.selectionState().selection !== null;
      const downloads = new Map<string, Blob>(), urls = new Map<string, Blob>();
      const click = HTMLAnchorElement.prototype.click, createUrl = URL.createObjectURL;
      URL.createObjectURL = object => { const url = createUrl.call(URL, object); if (object instanceof Blob) urls.set(url, object); return url; };
      HTMLAnchorElement.prototype.click = function() { const blob = urls.get(this.href); if (blob === undefined) throw new Error('No captured export Blob.'); downloads.set(this.download, blob); };
      let gif: Blob | undefined, movie: Blob | undefined, stereo: Blob | undefined;
      try {
        await demo.saveStereo(); stereo = downloads.get('HNI_0001.JPG');
        demo.setMotion({ enabled: true, loopSeconds: 2, parallax: .5, drift: { direction: 'side', amount: 0 } });
        await demo.saveLoop('gif'); gif = [...downloads].find(([name]) => name.endsWith('.gif'))?.[1];
        await demo.saveLoop('movie'); movie = [...downloads].find(([name]) => /\.(mp4|webm)$/.test(name))?.[1];
      } finally { HTMLAnchorElement.prototype.click = click; URL.createObjectURL = createUrl; }
      if (gif === undefined || movie === undefined || stereo === undefined) throw new Error(`Missing export: ${demo.scene().status}`);
      const green = (bytes: Uint8ClampedArray) => { const i = (220 * 512 + 100) * 4; return (bytes[i + 1] ?? 0) > (bytes[i] ?? 0) + 30 && (bytes[i + 1] ?? 0) > (bytes[i + 2] ?? 0) + 30; };
      const stereoPixels = await read(stereo);
      const stereoGreen = stereoPixels.some((value, i) => i % 4 === 1 && value > (stereoPixels[i - 1] ?? 0) + 30 && value > (stereoPixels[i + 1] ?? 0) + 30);
      if (window.ImageDecoder === undefined) throw new Error('No GIF decoder.');
      const decoder = new window.ImageDecoder({ data: new Uint8Array(await gif.arrayBuffer()), type: 'image/gif' }); await decoder.tracks.ready;
      const gifCount = decoder.tracks.selectedTrack?.frameCount ?? 0; let gifGreen = true;
      for (const frameIndex of [0, Math.floor(gifCount / 2)]) { const frame = await decoder.decode({ frameIndex }); context.drawImage(frame.image, 0, 0, 512, 512); frame.image.close(); gifGreen &&= green(context.getImageData(0, 0, 512, 512).data); } decoder.close();
      const video = document.createElement('video'); video.muted = true; const url = URL.createObjectURL(movie); video.src = url;
      await new Promise<void>((resolve, reject) => { video.onloadeddata = () => resolve(); video.onerror = () => reject(new Error('Movie decode failed.')); video.load(); });
      context.drawImage(video, 0, 0, 512, 512); const movieGreen = green(context.getImageData(0, 0, 512, 512).data), movieWidth = video.videoWidth;
      video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url);
      demo.setMotion({ enabled: false });
      const published = await demo.gallery.publish(); if (published.kind !== 'published') throw new Error(published.sentence);
      const manifest: unknown = await (await fetch(`/api/gallery/${published.id}`)).json();
      const v3 = manifest !== null && typeof manifest === 'object' && 'version' in manifest && manifest.version === 3;
      const doc = demo.document(); if (doc?.version !== 6) throw new Error('No published paint.');
      let galleryAssetsExact = true;
      for (const tile of doc.paint.layers.flatMap(layer => layer.patches.flatMap(patch => patch.tiles))) {
        const remote = new Uint8Array(await (await fetch(`/api/gallery/${published.id}/assets/${tile.rgba.asset}`)).arrayBuffer()), resident = demo.projectAssets().find(asset => asset.asset === tile.rgba.asset);
        galleryAssetsExact &&= resident !== undefined && remote.length === resident.bytes.length && remote.every((v, i) => v === resident.bytes[i]);
      }
      return { checks: { selected, undecorated, stillGreen: green(still), stereoGreen, gifGreen: gifGreen && gifCount === 30, movieGreen: movieGreen && movieWidth === 512, galleryV3: v3, galleryAssetsExact },
        gif: await toData(gif), movie: await toData(movie), extension: movie.type.includes('mp4') ? 'mp4' : 'webm', published: published.id, url: published.url };
    });
    await t.file('paint.gif', Buffer.from(output.gif, 'base64')); await t.file(`paint.${output.extension}`, Buffer.from(output.movie, 'base64'));
    await t.page.goto(output.url);
    await t.page.waitFor('published paint viewer', z.literal(true), () => window.__noisyGallery?.viewer()?.status().kind === 'running' ? true : null);
    const viewerGreen = await t.page.evaluate(z.boolean(), () => { const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="gallery-canvas"]');
      window.__noisyGallery?.viewer()?.stop(); if (canvas === null) throw new Error('No gallery canvas.');
      const copy = new OffscreenCanvas(canvas.width, canvas.height), context = copy.getContext('2d', { willReadFrequently: true }); if (context === null) throw new Error('No gallery pixels.');
      context.drawImage(canvas, 0, 0); const bytes = context.getImageData(0, 0, canvas.width, canvas.height).data;
      return bytes.some((value, i) => i % 4 === 1 && value > (bytes[i - 1] ?? 0) + 30 && value > (bytes[i + 1] ?? 0) + 30); });
    const outputChecks = { ...saved.checks, ...output.checks, viewerGreen };
    await t.file('output.json', JSON.stringify(outputChecks, null, 2));
    for (const [check, passed] of Object.entries(outputChecks)) t.ok(check, passed);
    await t.page.screenshot('published-paint');
    // Reopen is a separate real transport boundary. Record completed export and
    // gallery evidence before crossing it, without hiding any reopen failure.
    await t.page.goto(t.baseUrl);
    const reopened = await t.page.evaluate(z.record(z.string(), z.boolean()), async ({ id, patches, png }) => {
      const demo = window.__noisyTest?.demo; if (demo === undefined) throw new Error('No reopened session.');
      const convert = OffscreenCanvas.prototype.convertToBlob; let photoEncodes = 0;
      OffscreenCanvas.prototype.convertToBlob = function(options) { if (options?.type === 'image/png') photoEncodes++; return convert.call(this, options); };
      let opened: boolean;
      try { opened = await demo.openProject(id); } finally { OffscreenCanvas.prototype.convertToBlob = convert; }
      const doc = demo.document(); if (!opened || doc?.version !== 6) throw new Error(demo.scene().status);
      const baseline = await createImageBitmap(new Blob([Uint8Array.from(atob(png), c => c.charCodeAt(0))], { type: 'image/png' })), restored = await createImageBitmap(await demo.downloadPng());
      const canvas = new OffscreenCanvas(512, 512), context = canvas.getContext('2d', { willReadFrequently: true }); if (context === null) throw new Error('No reopen pixels.');
      context.drawImage(baseline, 0, 0); const expected = context.getImageData(0, 0, 512, 512).data; context.drawImage(restored, 0, 0); const actual = context.getImageData(0, 0, 512, 512).data;
      baseline.close(); restored.close();
      return { identicalPatches: JSON.stringify(doc.paint.layers) === patches, identicalPixels: expected.every((v, i) => v === actual[i]), noPhotoReencode: photoEncodes === 0 };
    }, { id, patches: saved.patches, png: saved.png });
    await t.file('reopen.json', JSON.stringify(reopened, null, 2));
    for (const [check, passed] of Object.entries(reopened)) t.ok(check, passed);
  },
};

export const scenarios: readonly Scenario[] = [brushScenario, depthScenario, outputScenario];
