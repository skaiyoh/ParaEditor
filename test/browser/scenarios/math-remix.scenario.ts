import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { encodeRaster } from '../../../src/core/asset-codec.ts';
import { isAssetId, isSceneId } from '../../../src/core/ids.ts';
import { compositionDocumentSchema } from '../../../src/core/composition-schema.ts';
import { minimalDocument, DEPTH_MODEL } from '../../fixtures/documents.ts';
import { z } from '../../../src/core/zod.ts';
import type { Scenario, ScenarioContext } from '../scenario.ts';

const rows = z.array(z.object({ name: z.string(), pass: z.boolean(), evidence: z.string() }));
const SIZE = { width: 192, height: 128 };
const VALID = 'fn custom(n: coverage) -> coverage { return coverage(value(n) * value(n)); }';
function png(): Uint8Array {
  const scanlines = new Uint8Array(SIZE.height * (SIZE.width * 4 + 1));
  for (let y = 0; y < SIZE.height; y++) for (let x = 0; x < SIZE.width; x++) scanlines.set([
    25 + (x * 17 + y * 11) % 205, 30 + (x * 3 + y * 7) % 200, 35 + (x * 13 + y * 5) % 195, 255,
  ], y * (SIZE.width * 4 + 1) + 1 + x * 4);
  const chunk = (name: string, payload: Uint8Array): Uint8Array => {
    const bytes = new Uint8Array(payload.length + 12), view = new DataView(bytes.buffer);
    view.setUint32(0, payload.length); bytes.set(new TextEncoder().encode(name), 4); bytes.set(payload, 8);
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(4, -4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ ((crc & 1) ? 0xedb88320 : 0); }
    view.setUint32(bytes.length - 4, (crc ^ 0xffffffff) >>> 0); return bytes;
  };
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, SIZE.width); view.setUint32(4, SIZE.height); header[8] = 8; header[9] = 6;
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...chunk('IHDR', header),
    ...chunk('IDAT', deflateSync(scanlines)), ...chunk('IEND', new Uint8Array())]);
}
function fixture() {
  const master = png(), depth = encodeRaster({ format: 'f32', size: SIZE, data: new Float32Array(SIZE.width * SIZE.height).fill(.5) });
  const digest = (bytes: Uint8Array) => {
    const value = createHash('sha256').update(bytes).digest('hex'); if (!isAssetId(value)) throw new Error('Invalid fixture digest.'); return value;
  };
  const id = randomUUID(); if (!isSceneId(id)) throw new Error('Invalid fixture id.');
  const base = minimalDocument(), masterId = digest(master), depthId = digest(depth);
  const document = compositionDocumentSchema.parse({ ...base, id, title: 'Math remix seeded fixture', seed: 123456789,
    frame: { source: { asset: masterId, mediaType: 'image/png', byteLength: master.byteLength }, master: { asset: masterId, size: SIZE },
      original: { name: 'math-remix-fixture.png', mediaType: 'image/png', size: SIZE } },
    analysis: { ...base.analysis, autoSubject: 'done', depth: { model: DEPTH_MODEL, map: { asset: depthId, format: 'f32', size: SIZE },
      stats: { p10: .5, median: .5, p90: .5 } } },
    style: { ...base.style, grain: .52, colorNoise: .32, grainSize: 3, grainHold: 2, simplify: 0, outline: 0, clipping: .22, crunch: .18 },
    motion: { ...base.motion, enabled: false }, symbols: { ...base.symbols, enabled: false },
  });
  return { document, master: Array.from(master), depth: Array.from(depth) };
}
async function boot(t: ScenarioContext): Promise<string> {
  await t.page.emulate({ width: 1024, height: 768, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
  await t.page.goto('/');
  await t.page.waitFor('photo Remix session', z.literal(true), () => window.__noisyTest?.demo.remix === undefined ? null : true);
  return t.page.evaluate(z.string(), async input => {
    const demo = window.__noisyTest?.demo; if (!demo) throw new Error('No session.');
    const id = input.document.id;
    const put = async (resource: string, body: BodyInit, mediaType: string, headers: Record<string, string> = {}) => {
      const response = await fetch(`/api/projects/${id}/${resource}`, { method: 'PUT', headers: { 'Content-Type': mediaType, ...headers }, body });
      if (!response.ok) throw new Error(`Fixture ${resource}: ${response.status} ${await response.text()}`);
    };
    const master = new Blob([new Uint8Array(input.master)], { type: 'image/png' });
    await put('photo', master, 'image/png', { 'X-Project-Asset': input.document.frame.master.asset });
    await put(`assets/${input.document.frame.master.asset}`, master, 'application/octet-stream');
    const depth = input.document.analysis.depth;
    if (!depth) throw new Error('Missing fixture depth.');
    await put(`assets/${depth.map.asset}`, new Blob([new Uint8Array(input.depth)]), 'application/octet-stream');
    await put('scene', JSON.stringify({ transportVersion: 2, revision: 0, document: input.document }), 'application/json');
    const canvas = document.createElement('canvas'); canvas.width = 192; canvas.height = 128;
    const bitmap = await createImageBitmap(master); canvas.getContext('2d')?.drawImage(bitmap, 0, 0); bitmap.close();
    const jpeg = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('No thumbnail.')), 'image/jpeg', .7));
    await put('thumbnail', jpeg, 'image/jpeg');
    if (!await demo.openProject(id)) throw new Error(`Fixture open: ${demo.scene().status}`);
    return id;
  }, fixture());
}
async function saved(t: ScenarioContext): Promise<void> {
  await t.page.waitFor('newest complete math checkpoint acknowledged', z.literal(true), () =>
    window.__noisyTest?.demo.remix.snapshot().status.kind === 'Saved' && window.__noisyTest.demo.projects().pendingSaves === 0 ? true : null,
  { timeoutMs: 60_000 });
}
function report(t: ScenarioContext, checks: z.infer<typeof rows>): void {
  for (const check of checks) t.ok(check.name, check.pass, check.evidence);
}

const photo: Scenario = {
  id: 'math-remix.photo', title: 'Real session Grain parity, Threshold, order and Undo', target: 'dev', covers: [], timeoutMs: 180_000,
  async run(t) {
    await boot(t);
    report(t, await t.page.evaluate(rows, async () => {
      const demo = window.__noisyTest?.demo, canvas = document.querySelector<HTMLCanvasElement>('[data-testid="stage"]');
      if (!demo || !canvas) throw new Error('No session stage.');
      const remix = demo.remix, gl = canvas.getContext('webgl2'); if (!gl) throw new Error('No WebGL2.');
      const checks: { name: string; pass: boolean; evidence: string }[] = [];
      const check = (name: string, pass: boolean, evidence: unknown = '') => checks.push({ name, pass, evidence: JSON.stringify(evidence) });
      const read = async () => {
        await demo.renderFrameAt(14); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        const bytes = new Uint8Array(canvas.width * canvas.height * 4); gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
        if (gl.getError() !== gl.NO_ERROR) throw new Error('Session readback failed.'); return bytes;
      };
      const delta = (a: Uint8Array, b: Uint8Array) => {
        let changed = 0, max = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs((a[i] ?? 0) - (b[i] ?? 0)); if (d) changed++; max = Math.max(max, d); }
        return { changed, max, channels: a.length };
      };
      const board = document.createElement('div'); board.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#151515;color:#fff;display:flex;flex-wrap:wrap;gap:20px;padding:24px;align-content:flex-start;font:15px monospace'; document.body.append(board);
      const picture = (name: string) => {
        const figure = document.createElement('figure'), copy = document.createElement('canvas'), label = document.createElement('figcaption');
        figure.style.margin = '0'; copy.width = canvas.width; copy.height = canvas.height; copy.style.cssText = 'width:384px;height:256px;image-rendering:pixelated';
        copy.getContext('2d')?.drawImage(canvas, 0, 0); label.textContent = name; figure.append(copy, label); board.append(figure);
      };
      const legacy = await read(); picture('Legacy Grain');
      // Owning an unused function admits v6 without changing the seeded rack.
      // Reapplying the legacy parameter would be unchanged and keep v5.
      const migrated = await remix.forkFunction({ from: { id: 'grain-threshold', revision: 1 }, name: 'Parity fixture' });
      const authored = await read(); picture('Authored Grain - same seed');
      check('unchanged v6 Grain has exact legacy RGBA bytes through the real session', migrated.ok && remix.snapshot().document?.version === 6 && delta(legacy, authored).max === 0, delta(legacy, authored));
      const start = demo.historyState().undoDepth;
      const threshold = await remix.perform({ expected: remix.snapshot().appliedRevision, target: 'photo', operation: {
        kind: 'replace', at: { kind: 'function', instance: 'photo-grain', node: 'remap' }, replacement: { id: 'grain-threshold', revision: 1 } } });
      const replaced = await read(); picture('Threshold replacement');
      check('Threshold visibly changes pixels and is exactly one action', threshold.kind === 'applied' && delta(authored, replaced).changed > 100 && demo.historyState().undoDepth === start + 1, delta(authored, replaced));
      check('copying Grain reports the copy notice', remix.snapshot().copied !== null);
      demo.c2Undo(); check('one Undo restores the authored Grain pixels', delta(authored, await read()).max === 0);
      check('Undo clears the Grain copy notice', remix.snapshot().copied === null);
      await remix.perform({ expected: remix.snapshot().appliedRevision, target: 'photo', operation: { kind: 'add', block: { id: 'authored-contrast', revision: 1 }, index: 1 } });
      const forward = await read(), depth = demo.historyState().undoDepth;
      const reorder = await remix.perform({ expected: remix.snapshot().appliedRevision, target: 'photo', operation: { kind: 'reorder', at: { kind: 'block', instance: 'photo-grain' }, index: 1 } });
      const reverse = await read(); picture('Contrast then Grain');
      check('block reorder changes pixels and is exactly one action', reorder.kind === 'applied' && delta(forward, reverse).changed > 100 && demo.historyState().undoDepth === depth + 1, delta(forward, reverse));
      demo.c2Undo(); check('one Undo restores the rack order and every pixel', delta(forward, await read()).max === 0);
      const valid = 'fn custom(n: coverage) -> coverage { return coverage(value(n) * value(n)); }';
      for (const action of ['undo', 'cancel']) {
        const edit = remix.beginSourceEdit({ kind: 'function', instance: 'photo-grain', node: 'remap' });
        if (!edit.ok) throw new Error(edit.error.message);
        remix.writeSource({ ...edit.value, expected: remix.snapshot().draftRevision, source: valid });
        check(`${action}: an unapplied checking candidate reports last-valid`, remix.snapshot().preview === 'last-valid');
        await new Promise(resolve => setTimeout(resolve, 450));
        check(`${action}: valid source applies to the real renderer`, remix.snapshot().preview === 'current' && delta(forward, await read()).changed > 100);
        if (action === 'undo') { await remix.commitGesture(edit.value.gesture); demo.c2Undo(); }
        else remix.cancelGesture(edit.value.gesture);
        const snapshot = remix.snapshot();
        check(`${action}: kept valid text has no stale notices and original pixels return`, snapshot.preview === 'current' && snapshot.copied === null
          && snapshot.editing === null && snapshot.drafts.some(draft => draft.source === valid && draft.phase === 'valid') && delta(forward, await read()).max === 0);
      }
      return checks;
    }));
    await t.page.screenshot('photo-parity-threshold-order');
  },
};
const functions: Scenario = {
  id: 'math-remix.functions', title: 'Fork, package, grouped borrow, insert, rename and parameters', target: 'dev', covers: [], timeoutMs: 180_000,
  async run(t) {
    await boot(t);
    report(t, await t.page.evaluate(rows, async () => {
      const demo = window.__noisyTest?.demo; if (!demo) throw new Error('No session.'); const remix = demo.remix;
      const checks: { name: string; pass: boolean; evidence: string }[] = [];
      const check = (name: string, pass: boolean, evidence: unknown = '') => checks.push({ name, pass, evidence: JSON.stringify(evidence) });
      const fork = await remix.forkFunction({ from: { id: 'grain-threshold', revision: 1 }, name: 'My threshold' });
      const block = await remix.forkBlock({ from: { id: 'authored-grain', revision: 1 }, name: 'My grain' });
      if (!fork.ok || !block.ok) throw new Error('Fork refused.');
      check('explicit function/block forks enter the owned library', remix.snapshot().document?.remix.ownership.some(value => value.label === 'My threshold') === true && remix.snapshot().document?.remix.ownership.some(value => value.label === 'My grain') === true);
      await remix.perform({ expected: remix.snapshot().appliedRevision, target: 'photo', operation: { kind: 'add', block: block.value, index: 1 } });
      const added = remix.snapshot().instances.filter(value => value.target === 'photo')[1]; if (!added) throw new Error('No added block.');
      check('owned rename uses the core action', (await remix.perform({ expected: remix.snapshot().appliedRevision, target: 'photo', operation: { kind: 'rename', instance: added.id, name: 'Renamed grain' } })).kind === 'applied');
      const grouped = await remix.perform({ expected: remix.snapshot().appliedRevision, target: 'photo', operation: { kind: 'replace', at: { kind: 'function', instance: added.id, node: 'remap' }, replacement: fork.value } });
      const source = remix.snapshot().instances.find(value => value.id === added.id); if (!source) throw new Error('No source.');
      const pinned = remix.snapshot().blocks.find(value => value.id === source.block.id && value.revision === source.block.revision);
      check('one grouped replacement rewires all three channels', grouped.kind === 'applied' && pinned?.nodes.filter(value => /^remap[012]$/.test(value.id)).every(value => value.function.id === fork.value.id) === true);
      const count = demo.historyState().undoDepth;
      check('borrow pins that grouped closure in one action', (await remix.borrowFunction({ from: source.block, node: 'remap', into: { kind: 'function', instance: 'photo-grain', node: 'remap' } })).kind === 'applied' && demo.historyState().undoDepth === count + 1);
      const packaged = await remix.packageBlock({ instance: 'photo-grain', name: 'Packaged threshold' });
      check('package adds to library and swaps the instance atomically', packaged.ok && remix.snapshot().instances[0]?.block.id === packaged.value.id);
      await remix.perform({ expected: remix.snapshot().appliedRevision, target: 'photo', operation: { kind: 'add', block: { id: 'authored-contrast', revision: 1 }, index: 2 } });
      const contrast = remix.snapshot().instances.filter(value => value.target === 'photo')[2]; if (!contrast) throw new Error('No Contrast.');
      const created = remix.newFunctionAt({ instance: contrast.id, slot: 'after-contrast' });
      if (!created.ok) throw new Error(created.error.message);
      const beforeDone = demo.historyState().undoDepth; await remix.commitGesture(created.value.gesture);
      check('working example insertion and its editor commit make one action', demo.historyState().undoDepth === beforeDone + 1);
      const token = demo.beginGesture({ operation: 'remix-parameter', target: { kind: 'scene' } }); if (!token) throw new Error('No parameter gesture.');
      const beforeDrag = demo.historyState().undoDepth;
      for (const value of [1.1, 1.4, 1.9]) demo.updateGesture({ token, value: { kind: 'remix-parameter', target: 'photo', instance: contrast.id, name: 'strength', value } });
      check('GestureRange parameter drag is one Undo', demo.commitGesture(token).kind === 'applied' && demo.historyState().undoDepth === beforeDrag + 1);
      const photoBefore = JSON.stringify(remix.snapshot().instances.filter(value => value.target === 'photo'));
      check('Use in Brush borrows an admitted normalized texture without changing photo', (await remix.useInBrush('photo-grain')).kind === 'applied' && photoBefore === JSON.stringify(remix.snapshot().instances.filter(value => value.target === 'photo')));
      return checks;
    }));
    await t.page.screenshot('functions-session');
  },
};
const source: Scenario = {
  id: 'math-remix.source', title: 'Source settling, diagnostics, cancellation, GPU refusal and history', target: 'dev', covers: [], timeoutMs: 180_000,
  async run(t) {
    await boot(t);
    report(t, await t.page.evaluate(rows, async valid => {
      const demo = window.__noisyTest?.demo; if (!demo) throw new Error('No session.'); const remix = demo.remix;
      const checks: { name: string; pass: boolean; evidence: string }[] = [];
      const check = (name: string, pass: boolean, evidence: unknown = '') => checks.push({ name, pass, evidence: JSON.stringify(evidence) });
      const open = remix.beginSourceEdit({ kind: 'function', instance: 'photo-grain', node: 'remap' }); if (!open.ok) throw new Error(open.error.message);
      const before = demo.historyState().undoDepth;
      const write = (text: string) => remix.writeSource({ ...open.value, expected: remix.snapshot().draftRevision, source: text });
      write(valid); await new Promise(resolve => setTimeout(resolve, 450));
      check('settled valid change applies and checkpoints while Edit remains open', remix.snapshot().appliedRevision === 1 && remix.snapshot().editing !== null && demo.historyState().undoDepth === before);
      write('fn custom(n: coverage) -> coverage { return coverage(step(0.4, value(n))); }');
      await new Promise(resolve => setTimeout(resolve, 450));
      await remix.commitGesture(open.value.gesture);
      check('two valid settles form one Edit-to-Done Undo', demo.historyState().undoDepth === before + 1 && remix.snapshot().preview === 'current');
      const last = remix.snapshot().instances[0]?.block;
      const invalid = remix.beginSourceEdit({ kind: 'function', instance: 'photo-grain', node: 'remap' }); if (!invalid.ok) throw new Error(invalid.error.message);
      remix.writeSource({ ...invalid.value, expected: remix.snapshot().draftRevision, source: 'fn broken(' });
      await remix.commitGesture(invalid.value.gesture);
      const draft = remix.snapshot().drafts.find(value => value.id === invalid.value.draft);
      check('invalid text stays a diagnostic draft and last-valid preview', draft?.phase === 'invalid' && draft.diagnostics[0]?.span.line === 1 && remix.snapshot().preview === 'last-valid' && JSON.stringify(last) === JSON.stringify(remix.snapshot().instances[0]?.block), draft);
      const corrected = remix.beginSourceEdit({ kind: 'function', instance: 'photo-grain', node: 'remap' }); if (!corrected.ok) throw new Error(corrected.error.message);
      remix.writeSource({ ...corrected.value, expected: remix.snapshot().draftRevision, source: valid }); await remix.commitGesture(corrected.value.gesture);
      check('correction executes the owned source and clears last-valid labeling', remix.snapshot().preview === 'current');
      const pending = remix.perform({ expected: remix.snapshot().appliedRevision, target: 'photo', operation: { kind: 'parameter', instance: 'photo-grain', name: 'amount', value: .1 } });
      demo.c2Undo(); check('Undo discards a pending newer operation', (await pending).kind === 'cancelled');
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="stage"]'), gl = canvas?.getContext('webgl2'); if (!gl) throw new Error('No GL.');
      const beforeFailure = JSON.stringify(remix.snapshot().instances), shaderSource = gl.shaderSource.bind(gl);
      gl.shaderSource = (shader, text) => shaderSource(shader, text.includes('m_block(') ? text.replace('  vec3 m_n', '  MRX4b_failure m_n') : text);
      try {
        const failed = await remix.perform({ expected: remix.snapshot().appliedRevision, target: 'photo', operation: { kind: 'parameter', instance: 'photo-grain', name: 'amount', value: .33 } });
        check('actual shader failure leaves the applied rack and reports its mapped diagnostic', failed.kind === 'refused' && remix.snapshot().diagnostics.some(value => value.message.includes('MRX4b_failure')) && JSON.stringify(remix.snapshot().instances) === beforeFailure, failed);
      } finally { gl.shaderSource = shaderSource; }
      const gesture = remix.beginGesture('photo'), initial = demo.document()?.style.grain;
      await remix.updateGesture(gesture, { kind: 'parameter', instance: 'photo-grain', name: 'amount', value: .19 });
      remix.cancelGesture(gesture);
      check('canceled gesture restores the applied parameter', demo.document()?.style.grain === initial && (await remix.updateGesture(gesture, { kind: 'parameter', instance: 'photo-grain', name: 'amount', value: .4 })).kind === 'cancelled');
      return checks;
    }, VALID));
    await t.page.screenshot('source-last-valid');
  },
};
const projects: Scenario = {
  id: 'math-remix.projects', title: 'Invalid and corrected definition checkpoints survive reload/reopen', target: 'dev', covers: [], timeoutMs: 180_000,
  async run(t) {
    const id = await boot(t);
    await t.page.evaluate(z.literal(true), async () => {
      const remix = window.__noisyTest?.demo.remix; if (!remix) throw new Error('No session.');
      const edit = remix.beginSourceEdit({ kind: 'function', instance: 'photo-grain', node: 'remap' }); if (!edit.ok) throw new Error(edit.error.message);
      remix.writeSource({ ...edit.value, expected: remix.snapshot().draftRevision, source: 'fn broken(' }); await remix.commitGesture(edit.value.gesture); return true;
    });
    await saved(t);
    t.ok('durable checkpoint contains invalid text beside the original executable closure', await t.page.evaluate(z.boolean(), async () => {
      const remix = window.__noisyTest?.demo.remix, doc = remix?.snapshot().document; if (!doc) throw new Error('No document.');
      const saved: unknown = await (await fetch(`/api/projects/${doc.id}/scene`)).json();
      return JSON.stringify(saved).includes('fn broken(') && !doc.remix.functions.some(value => value.source === 'fn broken(') && remix?.snapshot().status.kind === 'Saved';
    }));
    await t.page.reload();
    await t.page.waitFor('reloaded Remix session', z.literal(true), () => window.__noisyTest?.demo.remix ? true : null);
    t.ok('invalid draft reopens with a last-valid preview', await t.page.evaluate(z.boolean(), async id => {
      const demo = window.__noisyTest?.demo; if (!demo || !await demo.openProject(id)) return false;
      const snapshot = demo.remix.snapshot(); return snapshot.preview === 'last-valid' && snapshot.drafts.some(value => value.source === 'fn broken(' && value.phase === 'invalid') && snapshot.appliedRevision === 0;
    }, id));
    await t.page.screenshot('projects-invalid-reopen');
    await t.page.evaluate(z.literal(true), async valid => {
      const remix = window.__noisyTest?.demo.remix; if (!remix) throw new Error('No session.');
      const edit = remix.beginSourceEdit({ kind: 'function', instance: 'photo-grain', node: 'remap' }); if (!edit.ok) throw new Error(edit.error.message);
      remix.writeSource({ ...edit.value, expected: remix.snapshot().draftRevision, source: valid }); await remix.commitGesture(edit.value.gesture); return true;
    }, VALID);
    await saved(t);
    const expected = await t.page.evaluate(z.string(), () => JSON.stringify(window.__noisyTest?.demo.remix.snapshot().instances));
    await t.page.reload(); await t.page.waitFor('second reloaded Remix session', z.literal(true), () => window.__noisyTest?.demo.remix ? true : null);
    t.ok('corrected owned definition and recipe reopen without reprocessing', await t.page.evaluate(z.boolean(), async input => {
      const demo = window.__noisyTest?.demo; if (!demo) throw new Error('No session.');
      const before = demo.analysisDiagnostics().events.filter(value => value.event === 'stage.start').length;
      if (!await demo.openProject(input.id)) return false;
      const snapshot = demo.remix.snapshot(); return snapshot.preview === 'current' && JSON.stringify(snapshot.instances) === input.expected && snapshot.functions.some(value => value.source === input.valid) && demo.analysisDiagnostics().events.filter(value => value.event === 'stage.start').length === before;
    }, { id, expected, valid: VALID }));
    await t.page.screenshot('projects-corrected-reopen');
  },
};
const recovery: Scenario = {
  id: 'math-remix.recovery', title: 'Failed checkpoint retains drafts and applied work, then retry saves', target: 'dev', covers: [], timeoutMs: 180_000,
  async run(t) {
    const id = await boot(t);
    t.expectMessage({ because: 'the recovery proof deliberately refuses a checkpoint PUT', channel: 'log', source: 'network', level: 'error', url: new RegExp(`/api/projects/${id}/scene`) });
    await t.server.setFaults([`path:/api/projects/${id}/scene:http500:method=PUT`]);
    await t.page.evaluate(z.literal(true), async () => {
      const remix = window.__noisyTest?.demo.remix; if (!remix) throw new Error('No session.');
      await remix.perform({ expected: remix.snapshot().appliedRevision, target: 'photo', operation: { kind: 'parameter', instance: 'photo-grain', name: 'amount', value: .77 } });
      const edit = remix.beginSourceEdit({ kind: 'function', instance: 'photo-grain', node: 'remap' }); if (!edit.ok) throw new Error(edit.error.message);
      remix.writeSource({ ...edit.value, expected: remix.snapshot().draftRevision, source: 'fn broken(' }); await remix.commitGesture(edit.value.gesture); return true;
    });
    await t.page.waitFor('Save failed for complete recipe checkpoint', z.literal(true), () => window.__noisyTest?.demo.remix.snapshot().status.kind === 'Save failed' ? true : null, { timeoutMs: 60_000 });
    t.ok('failed save keeps the applied parameter and invalid draft', await t.page.evaluate(z.boolean(), () => {
      const demo = window.__noisyTest?.demo; return demo?.document()?.style.grain === .77 && demo.remix.snapshot().drafts.some(value => value.source === 'fn broken(') && demo.remix.snapshot().preview === 'last-valid';
    }));
    await t.page.screenshot('recovery-save-failed');
    await t.server.clearFaults();
    t.equal('retry succeeds without another edit', await t.page.evaluate(z.string(), async () => (await window.__noisyTest?.demo.remix.retrySave())?.kind ?? 'missing'), 'applied');
    await saved(t);
    t.ok('retry acknowledges the newest draft and applied checkpoint', await t.page.evaluate(z.boolean(), async () => {
      const demo = window.__noisyTest?.demo, doc = demo?.document(); if (!demo || !doc) return false;
      const saved: unknown = await (await fetch(`/api/projects/${doc.id}/scene`)).json();
      return JSON.stringify(saved).includes('fn broken(') && demo.remix.snapshot().status.kind === 'Saved' && doc.style.grain === .77;
    }));
    await t.page.screenshot('recovery-saved');
  },
};
export const scenarios: readonly Scenario[] = [photo, functions, source, projects, recovery];
