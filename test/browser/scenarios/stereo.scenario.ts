import { z } from '../../../src/core/zod.ts';
import type { Scenario, ScenarioContext } from '../scenario.ts';
import { encodeMpo } from '../../../src/export/mpo.ts';

const imageSchema = z.object({ type: z.string(), width: z.number(), height: z.number(), centroid: z.number(), count: z.number(), blackSides: z.boolean() });
const pairSchema = z.object({
  left: imageSchema, right: imageSchema, pixelsDiffer: z.boolean(),
  leftBytes: z.array(z.number()), rightBytes: z.array(z.number()), mpoBytes: z.array(z.number()),
  downloadNames: z.array(z.string()), downloadTypes: z.array(z.string()), twinMatches: z.boolean(),
  index: z.object({ count: z.number(), version: z.string(), attributes: z.array(z.number()), sizes: z.array(z.number()), offsets: z.array(z.number()),
    base: z.number(), segmentBytes: z.number(), secondSoi: z.boolean(), mpfSegments: z.number() }),
});

/** Observe download intent while preserving blobs for decoding; no app hooks needed. */
function captureDownloads(): null {
  const entries: { name: string; blob: Blob }[] = [], blobs = new Map<string, Blob>();
  const create = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = (blob) => {
    if (!(blob instanceof Blob)) throw new Error('Expected a download Blob.');
    const url = create.call(URL, blob); blobs.set(url, blob); return url;
  };
  HTMLAnchorElement.prototype.click = function () {
    const blob = blobs.get(this.href); if (blob === undefined) throw new Error('No download Blob.');
    entries.push({ name: this.download, blob });
  };
  window.__stereoDownloads = { entries, restore() {
    URL.createObjectURL = create; HTMLAnchorElement.prototype.click = click;
    for (const url of blobs.keys()) URL.revokeObjectURL(url);
    delete window.__stereoDownloads;
  } };
  return null;
}

/** Decode the button's actual JPEG pair and read MP fields independently of the writer. */
async function exportedPair(): Promise<unknown> {
  const downloads = window.__stereoDownloads?.entries;
  const mpo = downloads?.[0]?.blob, jpg = downloads?.[1]?.blob;
  if (downloads === undefined || mpo === undefined || jpg === undefined) throw new Error('Stereo export did not trigger both downloads.');
  const decode = async (blob: Blob) => {
    const bitmap = await createImageBitmap(blob), canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) { bitmap.close(); throw new Error('No stereo decode context.'); }
    context.drawImage(bitmap, 0, 0); bitmap.close();
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0, count = 0, blackSides = true;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const p = (y * canvas.width + x) * 4, r = data[p] ?? 0, g = data[p + 1] ?? 0, b = data[p + 2] ?? 0;
      if (r > g + 40 && r > b + 40) { sum += x; count++; }
      if ((x < canvas.width / 10 || x >= canvas.width * .9) && Math.max(r, g, b) > 3) blackSides = false;
    }
    return { type: blob.type, width: canvas.width, height: canvas.height, centroid: count === 0 ? 0 : sum / count, count, blackSides, data };
  };
  const [jpgBytes, mpoBytes] = await Promise.all([jpg.arrayBuffer(), mpo.arrayBuffer()]);
  const bytes = new Uint8Array(mpoBytes), view = new DataView(mpoBytes);
  let mpfSegments = 0, base = 0, segmentBytes = 0;
  if (bytes[0] !== 255 || bytes[1] !== 216) throw new Error('The MPO does not start with SOI.');
  for (let p = 2; p < bytes.length;) {
    if (bytes[p] !== 255) throw new Error('The MPO JPEG header is malformed.');
    const marker = bytes[p + 1]; if (marker === 218 || marker === 217) break;
    const length = view.getUint16(p + 2);
    if (length < 2 || p + 2 + length > bytes.length) throw new Error('The MPO APP segment is truncated.');
    if (marker === 226 && String.fromCharCode(...bytes.subarray(p + 4, p + 8)) === 'MPF\0') { mpfSegments++; base = p + 8; segmentBytes = length + 2; }
    p += 2 + length;
  }
  if (mpfSegments !== 1 || view.getUint32(base) !== 0x4d4d002a) throw new Error('The MPO needs one big-endian MP index.');
  const ifd = base + view.getUint32(base + 4), tags = new Map<number, number>();
  for (let i = 0; i < view.getUint16(ifd); i++) {
    const p = ifd + 2 + i * 12; tags.set(view.getUint16(p), view.getUint32(p + 8));
  }
  const list = tags.get(0xb002); if (list === undefined) throw new Error('No MP entries.');
  const attributes: number[] = [], sizes: number[] = [], offsets: number[] = [];
  for (let i = 0; i < 2; i++) {
    const p = base + list + i * 16;
    attributes.push(view.getUint32(p)); sizes.push(view.getUint32(p + 4)); offsets.push(view.getUint32(p + 8));
  }
  const second = base + (offsets[1] ?? 0), version = tags.get(0xb000) ?? 0;
  const insert = base - 8, firstSize = sizes[0] ?? 0;
  const leftBytes = new Uint8Array([...bytes.subarray(0, insert), ...bytes.subarray(insert + segmentBytes, firstSize)]);
  const rightBytes = bytes.slice(second, second + (sizes[1] ?? 0));
  const [left, right] = await Promise.all([decode(new Blob([leftBytes], { type: 'image/jpeg' })), decode(new Blob([rightBytes], { type: 'image/jpeg' }))]);
  const twin = new Uint8Array(jpgBytes);
  return { left: { ...left, data: undefined }, right: { ...right, data: undefined },
    pixelsDiffer: left.data.some((v, i) => i % 4 !== 3 && v !== right.data[i]),
    leftBytes: Array.from(leftBytes), rightBytes: Array.from(rightBytes), mpoBytes: Array.from(bytes),
    downloadNames: downloads.map((entry) => entry.name), downloadTypes: downloads.map((entry) => entry.blob.type),
    twinMatches: twin.length === leftBytes.length && twin.every((value, i) => value === leftBytes[i]),
    index: { count: tags.get(0xb001), version: String.fromCharCode(version >>> 24, version >>> 16 & 255, version >>> 8 & 255, version & 255),
      attributes, sizes, offsets, base, segmentBytes, secondSoi: bytes[second] === 255 && bytes[second + 1] === 216, mpfSegments } };
}

export async function exportThroughSession(t: ScenarioContext) {
  await t.page.evaluate(z.null(), captureDownloads);
  try {
    await t.page.evaluate(z.null(), async () => { await window.__noisyTest!.demo.saveStereo(); return null; });
    await t.page.waitFor('both stereo downloads', z.boolean(), () => (window.__stereoDownloads?.entries.length ?? 0) >= 2, { timeoutMs: 30_000 });
    return await t.page.evaluate(pairSchema, exportedPair);
  } finally {
    await t.page.evaluate(z.null(), () => { window.__stereoDownloads?.restore(); return null; });
  }
}

const stereoScenario: Scenario = {
  id: 'export.stereo', title: 'Stereo JPEGs, disparity, MPO bytes and paired downloads through the session', covers: ['S1'], target: 'dev', timeoutMs: 450_000,
  async run(t) {
    await t.page.goto(t.baseUrl);
    await t.page.waitFor('stereo demo boot', z.boolean(), () => window.__noisyTest?.demo !== undefined);
    await t.page.evaluate(z.null(), () => {
      const button = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Try a sample');
      if (button === undefined) throw new Error('No Try a sample button.');
      button.click(); return null;
    });
    await t.page.waitFor('sample depth and decoder', z.boolean(), () => {
      const demo = window.__noisyTest?.demo; return demo !== undefined && demo.analysis().depth && demo.analysis().decoderReady && !demo.analysis().alive.heavy;
    }, { timeoutMs: 170_000 });
    const sample = await exportThroughSession(t);
    t.equal('sample exports are 640 x 480 JPEGs', [sample.left.type, sample.left.width, sample.left.height, sample.right.type, sample.right.width, sample.right.height], ['image/jpeg', 640, 480, 'image/jpeg', 640, 480]);
    t.ok('sample cameras produce differing decoded pixels', sample.pixelsDiffer);
    t.equal('MP index version, count, types and representative flag', [sample.index.version, sample.index.count, sample.index.attributes, sample.index.mpfSegments], ['0100', 2, [0x20020002, 0x20002], 1]);
    t.equal('MP sizes include the first APP2 insertion', sample.index.sizes, [sample.leftBytes.length + sample.index.segmentBytes, sample.rightBytes.length]);
    t.equal('first offset is zero and second lands at the first image end', [sample.index.offsets[0], sample.index.base + (sample.index.offsets[1] ?? 0), sample.index.secondSoi], [0, sample.index.sizes[0], true]);
    t.equal('MPO length is JPEG sum plus APP2', sample.mpoBytes.length, sample.leftBytes.length + sample.rightBytes.length + sample.index.segmentBytes);
    t.equal('MPO preserves both JPEGs and is deterministic for opaque encoder bytes', new Uint8Array(sample.mpoBytes), encodeMpo(new Uint8Array(sample.leftBytes), new Uint8Array(sample.rightBytes)));
    await t.file('HNI_0001.MPO', new Uint8Array(sample.mpoBytes));
    await t.file('HNI_0001.JPG', new Uint8Array(sample.leftBytes));
    t.equal('saveStereo triggers the two 3DS download names', sample.downloadNames, ['HNI_0001.MPO', 'HNI_0001.JPG']);
    t.equal('download types', sample.downloadTypes, ['image/mpo', 'image/jpeg']);
    t.ok('JPG twin is exactly the left JPEG inside the MPO', sample.twinMatches);

    // Controlled foreground like render.view: the JPEG centroid must move with camera x.
    const plateReadyMs = await t.page.evaluate(z.number(), async () => {
      const demo = window.__noisyTest?.demo; if (demo === undefined) throw new Error('No stereo demo.');
      const canvas = new OffscreenCanvas(4032, 3024), ctx = canvas.getContext('2d');
      if (ctx === null) throw new Error('No centroid fixture context.');
      ctx.fillStyle = '#a0a0a0'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#ed382d'; ctx.fillRect(canvas.width * .375, canvas.height * .375, canvas.width * .25, canvas.height * .25);
      await demo.importFile(new File([await canvas.convertToBlob({ type: 'image/png' })], 'stereo-centroid.png', { type: 'image/png' }));
      const wait = async (ready: () => boolean) => {
        const start = performance.now(); while (!ready()) {
          if (performance.now() - start > 170_000) throw new Error(`Stereo fixture timeout: ${demo.analysis().status}`);
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
      };
      await wait(() => demo.analysis().depth && demo.analysis().decoderReady && !demo.analysis().alive.heavy);
      const size = { width: 128, height: 96 }, mask = new Uint8Array(128 * 96), depth = new Float32Array(mask.length).fill(.25);
      for (let y = 36; y < 60; y++) for (let x = 48; x < 80; x++) { mask[y * 128 + x] = 255; depth[y * 128 + x] = 1; }
      demo.injectMask({ ...size, data: mask }); await wait(() => demo.objects().length === 1);
      demo.injectDepth({ format: 'f32', size, data: depth }); demo.select(null);
      demo.setStyle({ simplify: 0, grain: 0, colorNoise: 0, clipping: 0, crunch: 0, outline: 0, colors: 12, bands: 6, saturation: 1 });
      demo.setSymbols({ enabled: false }); demo.setMotion({ enabled: true, focus: 0, drift: { direction: 'circle', amount: 1 } });
      if (!demo.document()?.motion.enabled) throw new Error('Stereo fixture Motion edit was refused.');
      const plateStart = performance.now();
      await demo.requestPlate(); await wait(() => demo.analysis().plate && !demo.products().plateNeeded);
      const elapsed = performance.now() - plateStart;
      demo.setMotion({ enabled: false }); return elapsed;
    });
    await t.file('plate-ready.json', JSON.stringify({ plateReadyMs }, null, 2));
    const fixture = await exportThroughSession(t);
    t.ok('both JPEGs contain the foreground object', fixture.left.count > 100 && fixture.right.count > 100, { left: fixture.left, right: fixture.right });
    t.ok('foreground centroid shifts horizontally between the two cameras', Math.abs(fixture.left.centroid - fixture.right.centroid) > 1, { left: fixture.left.centroid, right: fixture.right.centroid });
    await t.page.evaluate(z.null(), () => {
      const demo = window.__noisyTest?.demo, id = demo?.objects()[0]?.id;
      if (demo === undefined || id === undefined) throw new Error('Missing stereo selection.');
      demo.select(id); return null;
    });
    const selectedFixture = await exportThroughSession(t);
    t.equal('stereo left JPEG bytes ignore screen selection', selectedFixture.leftBytes, fixture.leftBytes);
    t.equal('stereo right JPEG bytes ignore screen selection', selectedFixture.rightBytes, fixture.rightBytes);
    t.equal('complete MPO bytes ignore screen selection', selectedFixture.mpoBytes, fixture.mpoBytes);
    // A portrait master must stay portrait inside the landscape 3DS file.
    await t.page.evaluate(z.null(), async () => {
      const demo = window.__noisyTest?.demo; if (demo === undefined) throw new Error('No stereo demo.');
      const canvas = new OffscreenCanvas(3024, 4032), ctx = canvas.getContext('2d');
      if (ctx === null) throw new Error('No portrait fixture context.');
      ctx.fillStyle = '#ed382d'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await demo.importFile(new File([await canvas.convertToBlob({ type: 'image/png' })], 'stereo-portrait.png', { type: 'image/png' }));
      demo.setStyle({ simplify: 0, grain: 0, colorNoise: 0, clipping: 0, crunch: 0, outline: 0, colors: 12, bands: 6, saturation: 1 });
      demo.setSymbols({ enabled: false });
      return null;
    });
    const letterbox = await exportThroughSession(t);
    t.ok('aspect mismatch leaves black sides in both JPEGs', letterbox.left.blackSides && letterbox.right.blackSides);
    t.equal('portrait still exports 3DS dimensions', [letterbox.left.width, letterbox.left.height, letterbox.right.width, letterbox.right.height], [640, 480, 640, 480]);
    // JPEG's red rectangle keeps its source 3:4 aspect (360 x 480) and is centered.
    t.ok('portrait content keeps aspect and is centered', Math.abs(letterbox.left.count - 360 * 480) < 480 * 4 && Math.abs(letterbox.left.centroid - 319.5) < 1, letterbox.left);
    await t.file('stereo.json', JSON.stringify({ sample: { left: sample.left, right: sample.right, index: sample.index, downloadNames: sample.downloadNames, downloadTypes: sample.downloadTypes, twinMatches: sample.twinMatches },
      fixture: { left: fixture.left, right: fixture.right }, letterbox: { left: letterbox.left, right: letterbox.right } }, null, 2));
    await t.page.screenshot('stereo');
  },
};

export const scenarios: readonly Scenario[] = [stereoScenario];
