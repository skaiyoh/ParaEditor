import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { z } from '../../../src/core/zod.ts';
import { decodeRaster, encodeRaster } from '../../../src/core/asset-codec.ts';
import { compositionDocumentSchema } from '../../../src/core/composition-schema.ts';
import { migrateV4ToV5 } from '../../../src/core/composition.ts';
import { parseLegacyDocument } from '../../../src/core/schema.ts';
import { srgbToOklab, type Oklab } from '../../../src/core/color.ts';
import type { SceneDocument } from '../../../src/core/types.ts';
import { maskedDepth } from '../../../src/session/objects.ts';
import { DEPTH_MODEL, legacyFiveClusterDocument, legacyMinimalDocument, minimalDocument } from '../../fixtures/documents.ts';
import type { BrowserPage, RequestLine, Scenario, ScenarioContext } from '../scenario.ts';

const SIZE = { width: 512, height: 342 };
const maskSummary = z.object({ result: z.string(), asset: z.string().nullable(), count: z.number(), sum: z.number(), soft: z.number(), space: z.string() });
const checkpoint = z.object({ transportVersion: z.literal(2), revision: z.number(), document: compositionDocumentSchema });

/** A real, deterministic PNG for HTTP-only fixtures, with no browser products. */
function fixtureColor(x: number, y: number, highlights: boolean): readonly [number, number, number, number] {
  return x >= SIZE.width * 43 / 96 ? highlights ? [220 + (x >> 3) % 2 * 25, 230, 238, 255] : [45, 87 + y % 21, 225, 255] :
    [110 + (x >> 3) % 2 * 45, 145 + (y >> 3) % 2 * 30, 153, 255];
}
function fixturePng(highlights = false): Uint8Array<ArrayBuffer> {
  const rows = new Uint8Array(SIZE.height * (SIZE.width * 4 + 1));
  for (let y = 0; y < SIZE.height; y++) for (let x = 0; x < SIZE.width; x++) {
    const i = y * (SIZE.width * 4 + 1) + 1 + x * 4;
    rows.set(fixtureColor(x, y, highlights), i);
  }
  const chunk = (name: string, payload: Uint8Array): Uint8Array => {
    const bytes = new Uint8Array(payload.length + 12), view = new DataView(bytes.buffer);
    view.setUint32(0, payload.length); bytes.set(new TextEncoder().encode(name), 4); bytes.set(payload, 8);
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(4, bytes.length - 4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
    view.setUint32(bytes.length - 4, (crc ^ 0xffffffff) >>> 0); return bytes;
  };
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, SIZE.width); view.setUint32(4, SIZE.height); header[8] = 8; header[9] = 6;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)), chunk('IEND', new Uint8Array())];
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

async function putFixture(t: ScenarioContext, id: string, resource: string, body: BodyInit, type: string): Promise<void> {
  const response = await fetch(new URL(`/api/projects/${id}/${resource}`, t.baseUrl), {
    method: 'PUT', headers: { 'Content-Type': type }, body,
  });
  if (!response.ok) throw new Error(`Fixture PUT ${resource}: HTTP ${response.status} ${await response.text()}`);
  await response.json();
}

function completeFixture(): { readonly document: SceneDocument; readonly assets: readonly { readonly asset: string; readonly bytes: Uint8Array<ArrayBuffer> }[] } {
  const png = fixturePng(), asset = createHash('sha256').update(png).digest('hex');
  const data = new Uint8Array(SIZE.width * SIZE.height);
  for (let y = 24; y < 310; y++) for (let x = 18; x < 205; x++) data[y * SIZE.width + x] = x < 22 ? 128 : 255;
  const encoded = encodeRaster({ format: 'u8', size: SIZE, data }), mask = createHash('sha256').update(encoded).digest('hex');
  const base = minimalDocument();
  const document = compositionDocumentSchema.parse({ ...base, id: randomUUID(), title: 'C2 fresh HTTP checkpoint', seed: 37,
    frame: { source: { asset, mediaType: 'image/png', byteLength: png.byteLength }, master: { asset, size: SIZE },
      original: { name: 'c2-checkpoint.png', mediaType: 'image/png', size: SIZE } },
    analysis: { ...base.analysis, autoSubject: 'done' }, compositing: 'legacy-order',
    localEffects: [
      { id: randomUUID(), enabled: true, owner: { kind: 'background' },
        scope: { kind: 'mask', mask: { plane: { asset: mask, format: 'u8', size: SIZE }, provenance: { kind: 'manual', operation: 'feather' } } },
        operation: { kind: 'recolor', color: { l: .73, c: .2, h: 35 } } },
      { id: randomUUID(), enabled: true, owner: { kind: 'background' },
        scope: { kind: 'mask', mask: { plane: { asset: mask, format: 'u8', size: SIZE }, provenance: { kind: 'manual', operation: 'feather' } } },
        operation: { kind: 'clipping', amount: .82 } },
    ] });
  return { document, assets: [{ asset, bytes: png }, { asset: mask, bytes: encoded }] };
}

function requestCounts(lines: readonly RequestLine[], after = 0) {
  const requests = lines.filter(line => line.seq > after);
  return { assetPuts: requests.filter(line => line.method === 'PUT' && /\/api\/projects\/[^/]+\/(?:assets\/|photo$)/.test(line.path)).length,
    checkpoints: requests.filter(line => line.method === 'PUT' && /\/api\/projects\/[^/]+\/scene$/.test(line.path)).length,
    repairRequests: requests.filter(line => line.method === 'POST' && /\/(?:inpaint|plate)(?:\/|$)/.test(line.path)).length,
    requests };
}

async function boot(t: ScenarioContext, unavailable: boolean): Promise<void> {
  if (unavailable) {
    t.expectMessage({ because: 'C2 manual/cancel deliberately refuses the GPU health check and model downloads',
      channel: 'log', source: 'network', level: 'error', url: /\/(?:models\/|dev\/gpu\/v1\/health)/, text: /\b50[03]\b/ });
    await t.server.setFaults(['path:/dev/gpu/v1/health:http503', 'path:/models/:http500']);
  }
  await t.page.emulate({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
  await t.page.goto('/');
  await t.page.waitFor('C2 session hooks', z.literal(true), () => window.__noisyTest?.demo.beginSelection === undefined ? null : true);
  if (unavailable) await t.page.waitFor('SAM/model preparation is unavailable', z.literal(true), () =>
    window.__noisyTest?.demo.analysis().status.startsWith('Models unavailable:') ? true : null, { timeoutMs: 60_000 });
}

async function importFixture(page: BrowserPage, bytes: Uint8Array): Promise<string> {
  return page.evaluate(z.string(), async (bytes) => {
    const demo = window.__noisyTest?.demo;
    if (demo === undefined) throw new Error('No C2 session.');
    await demo.importFile(new File([new Uint8Array(bytes)], 'c2-owner-grid.png', { type: 'image/png' }));
    const doc = demo.document();
    if (doc === null) throw new Error(`C2 import failed: ${demo.scene().status}`);
    return doc.id;
  }, Array.from(bytes));
}

async function saved(page: BrowserPage): Promise<void> {
  await page.waitFor('complete committed v5 checkpoint', z.literal(true), () => {
    const projects = window.__noisyTest?.demo.projects();
    return projects?.state === 'saved' && projects.pendingSaves === 0 ? true : null;
  }, { timeoutMs: 60_000 });
}

async function shape(page: BrowserPage, input: { readonly mode: 'replace' | 'add' | 'remove'; readonly tool: 'rectangle' | 'freehand';
  readonly points: readonly { readonly x: number; readonly y: number }[]; readonly layer?: boolean }) {
  return page.evaluate(maskSummary, async (input) => {
    const demo = window.__noisyTest?.demo, first = input.points[0], object = demo?.document()?.objects[0];
    if (demo === undefined || first === undefined || input.layer === true && object === undefined) throw new Error('No selection fixture owner.');
    demo.setSelectionTool(input.tool);
    const space = input.layer === true && object !== undefined ? { kind: 'layer', id: object.id } as const : { kind: 'photo' } as const;
    const begin = demo.beginSelection({ space, pointerId: 71, kind: 'shape', tool: input.tool, mode: input.mode, at: first });
    if (begin.kind !== 'began') throw new Error(begin.reason);
    for (const at of input.points.slice(1)) {
      const result = demo.extendSelection({ token: begin.token, pointerId: 71, kind: 'shape', at });
      if (result.kind === 'refused') throw new Error(result.reason);
    }
    const result = await demo.endSelection({ token: begin.token, pointerId: 71 }), state = demo.selectionState();
    const bytes = state.preview?.bytes ?? [];
    return { result: result.kind, asset: state.selection?.mask.plane.asset ?? null,
      count: bytes.filter(value => value !== 0).length, sum: bytes.reduce((total, value) => total + value, 0),
      soft: bytes.filter(value => value > 0 && value < 255).length, space: state.selection?.space.kind ?? 'none' };
  }, input);
}

async function localSetterChecks(page: BrowserPage) {
  return page.evaluate(z.array(z.object({ name: z.string(), passed: z.boolean(), evidence: z.string() })), () => {
    const demo = window.__noisyTest?.demo;
    if (demo === undefined) throw new Error('No C2 local-operation hooks.');
    const checks: { name: string; passed: boolean; evidence: string }[] = [];
    const check = (name: string, passed: boolean, evidence: unknown): void => { checks.push({ name, passed, evidence: JSON.stringify(evidence) }); };
    const target: { kind: 'selection' } = { kind: 'selection' };
    const red = { l: .72, c: .23, h: 28 }, blue = { l: .61, c: .15, h: 249 };
    const effects = (): string => JSON.stringify(demo.document()?.localEffects);
    const effect = (kind: SceneDocument['localEffects'][number]['operation']['kind']) => demo.document()?.localEffects.findLast(item => item.operation.kind === kind);
    const initial = effects(), initialRecolor = effect('recolor'), initialClipping = effect('clipping');
    const stages = demo.analysisDiagnostics().events.filter(event => event.event === 'stage.start').length;
    if (initialRecolor === undefined || initialClipping === undefined) throw new Error('No starting local operations.');

    const clipDepth = demo.historyState().undoDepth;
    const clipSet = demo.localOperation({ target, operation: { kind: 'clipping', amount: .8 } });
    const atEight = effects(), clippingId = effect('clipping')?.id;
    const clipClear = demo.localOperation({ target, operation: { kind: 'clipping', amount: 0 } });
    const absentClip = effect('clipping') === undefined, clearedClip = effects();
    demo.c2Undo(); const clipUndoClear = effects() === atEight;
    demo.c2Undo(); const clipUndoSet = effects() === initial;
    demo.c2Redo(); const clipRedoSet = effects() === atEight;
    demo.c2Redo(); const clipRedoClear = effects() === clearedClip;
    check('Clipping .8 then 0 replaces and removes one stable effect with exact Undo/Redo',
      clipSet.kind === 'applied' && clipClear.kind === 'applied' && clippingId === initialClipping.id && absentClip &&
      clipUndoClear && clipUndoSet && clipRedoSet && clipRedoClear && demo.historyState().undoDepth === clipDepth + 2,
      { clippingId, absentClip, clipUndoClear, clipUndoSet, clipRedoSet, clipRedoClear, history: demo.historyState() });
    demo.c2Undo();
    demo.localOperation({ target, operation: initialClipping.operation });

    const colorStart = effects(), colorDepth = demo.historyState().undoDepth;
    const redSet = demo.localOperation({ target, operation: { kind: 'recolor', color: red } });
    const blueSet = demo.localOperation({ target, operation: { kind: 'recolor', color: blue } });
    const atBlue = effects(), blueId = effect('recolor')?.id;
    const colorClear = demo.localOperation({ target, operation: { kind: 'recolor', color: null } });
    const absentColor = effect('recolor') === undefined, clearedColor = effects();
    demo.c2Undo(); const colorUndoClear = effects() === atBlue;
    demo.c2Undo(); const colorUndoBlue = effects() === colorStart;
    demo.c2Redo(); const colorRedoBlue = effects() === atBlue;
    demo.c2Redo(); const colorRedoClear = effects() === clearedColor;
    check('Recolor red, blue and clear replace one effect without stacking or rewriting its frozen scope',
      redSet.kind === 'unchanged' && blueSet.kind === 'applied' && colorClear.kind === 'applied' && blueId === initialRecolor.id && absentColor &&
      colorUndoClear && colorUndoBlue && colorRedoBlue && colorRedoClear && demo.historyState().undoDepth === colorDepth + 2,
      { blueId, absentColor, colorUndoClear, colorUndoBlue, colorRedoBlue, colorRedoClear, history: demo.historyState() });
    demo.c2Undo(); demo.localOperation({ target, operation: initialRecolor.operation });

    const fillStart = effects(), fillDepth = demo.historyState().undoDepth;
    const fillRed = demo.localOperation({ target, operation: { kind: 'fill', color: red } });
    const redFill = effects(), fillId = effect('fill')?.id;
    const fillBlue = demo.localOperation({ target, operation: { kind: 'fill', color: blue } });
    const blueFill = effects(), sameFillId = effect('fill')?.id === fillId;
    const fillClear = demo.localOperation({ target, operation: { kind: 'fill', color: null } });
    const absentFill = effect('fill') === undefined;
    demo.c2Undo(); const fillUndoClear = effects() === blueFill;
    demo.c2Undo(); const fillUndoBlue = effects() === redFill;
    demo.c2Undo(); const fillUndoAdd = effects() === fillStart;
    demo.c2Redo(); const fillRedoAdd = effects() === redFill;
    demo.c2Redo(); const fillRedoBlue = effects() === blueFill;
    demo.c2Redo(); const fillRedoClear = effects() === fillStart;
    check('Fill red, blue and clear preserve one ID and restore insertion, replacement and removal',
      fillRed.kind === 'applied' && fillBlue.kind === 'applied' && fillClear.kind === 'applied' && sameFillId && absentFill &&
      fillUndoClear && fillUndoBlue && fillUndoAdd && fillRedoAdd && fillRedoBlue && fillRedoClear && demo.historyState().undoDepth === fillDepth + 3,
      { fillId, sameFillId, absentFill, fillUndoClear, fillUndoBlue, fillUndoAdd, fillRedoAdd, fillRedoBlue, fillRedoClear, history: demo.historyState() });

    const gestureStart = effects(), gestureDepth = demo.historyState().undoDepth, stamp = demo.document()?.updatedAt;
    const gesture = demo.beginGesture({ operation: 'clipping', target });
    if (gesture === null) throw new Error('A local Clipping gesture was refused.');
    let stablePreview = true, committedUnchanged = true;
    for (const amount of [.12, .37, .8, 0, .64]) {
      const update = demo.updateGesture({ token: gesture, value: { kind: 'clipping', amount } });
      const preview = demo.previewDocument()?.localEffects.findLast(item => item.operation.kind === 'clipping');
      stablePreview &&= update.kind === 'applied' && (amount === 0 ? preview === undefined : preview?.id === initialClipping.id);
      committedUnchanged &&= effects() === gestureStart && demo.historyState().undoDepth === gestureDepth && demo.document()?.updatedAt === stamp;
    }
    const committed = demo.commitGesture(gesture), finalGesture = effects();
    const oneGestureStep = demo.historyState().undoDepth === gestureDepth + 1;
    demo.c2Undo(); const gestureUndo = effects() === gestureStart;
    demo.c2Redo(); const gestureRedo = effects() === finalGesture;
    check('one Clipping adjustment gesture previews one stable ID and commits exactly one Undo step',
      stablePreview && committedUnchanged && committed.kind === 'applied' && oneGestureStep && gestureUndo && gestureRedo,
      { stablePreview, committedUnchanged, oneGestureStep, gestureUndo, gestureRedo });
    demo.localOperation({ target, operation: initialClipping.operation });

    const neutralStart = effects(), neutralDepth = demo.historyState().undoDepth;
    const neutral = demo.beginGesture({ operation: 'fill', target });
    if (neutral === null) throw new Error('A local Fill gesture was refused.');
    let newId: string | null = null, stableNewId = true;
    for (const color of [red, blue, null, red]) {
      const result = demo.updateGesture({ token: neutral, value: { kind: 'fill', color } });
      const preview = demo.previewDocument()?.localEffects.findLast(item => item.operation.kind === 'fill');
      if (color !== null) {
        newId ??= preview?.id ?? null;
        stableNewId &&= result.kind === 'applied' && newId !== null && preview?.id === newId;
      } else stableNewId &&= result.kind === 'unchanged' && preview === undefined;
    }
    demo.updateGesture({ token: neutral, value: { kind: 'fill', color: null } });
    const neutralCommit = demo.commitGesture(neutral);
    check('a new local Fill gesture retains its preview ID across clear and records no returned-to-neutral step',
      stableNewId && neutralCommit.kind === 'unchanged' && effects() === neutralStart && demo.historyState().undoDepth === neutralDepth,
      { newId, stableNewId, result: neutralCommit.kind, history: demo.historyState() });

    const neutralColor = demo.localOperation({ target, operation: { kind: 'fill', color: null } });
    const unchangedFill = demo.historyState().undoDepth === neutralDepth && effects() === neutralStart;
    check('clearing an absent Fill is unchanged and all setter/gesture checks leave the original frozen operations without inference',
      neutralColor.kind === 'unchanged' && unchangedFill && effects() === initial &&
      demo.analysisDiagnostics().events.filter(event => event.event === 'stage.start').length === stages,
      { result: neutralColor.kind, unchangedFill, effects: demo.document()?.localEffects, stages });
    return checks;
  });
}

async function cleanup(t: ScenarioContext, ids: readonly string[]): Promise<void> {
  await t.server.clearFaults();
  for (const id of ids) {
    const response = await fetch(new URL(`/api/projects/${id}`, t.baseUrl), { method: 'DELETE' });
    if (!response.ok && response.status !== 404) throw new Error(`C2 fixture cleanup: HTTP ${response.status}`);
    await response.body?.cancel();
  }
}

const manual: Scenario = {
  id: 'creative.c2-manual', title: 'Manual region, explicit target, precision navigation and local edits without SAM',
  target: 'dev', covers: ['C2i-4', 'C2i-5', 'C2i-7'], timeoutMs: 240_000,
  async run(t) {
    const ids: string[] = [];
    try {
      await boot(t, true);
      ids.push(await importFixture(t.page, fixturePng())); await saved(t.page);
      const before = await t.server.requestLog(), mark = before.at(-1)?.seq ?? 0;
      const rectangle = await shape(t.page, { mode: 'replace', tool: 'rectangle', points: [{ x: 32, y: 24 }, { x: 202, y: 310 }] });
      t.equal('one rectangle commits exactly its source-pixel coverage', rectangle.count, 170 * 286, rectangle);
      const added = await shape(t.page, { mode: 'add', tool: 'freehand', points: [{ x: 155, y: 36 }, { x: 285, y: 80 }, { x: 260, y: 235 }, { x: 150, y: 250 }] });
      t.ok('freehand Add extends the existing rectangle', added.count > rectangle.count, added);
      const removed = await shape(t.page, { mode: 'remove', tool: 'rectangle', points: [{ x: 90, y: 90 }, { x: 135, y: 180 }] });
      t.equal('Remove subtracts its fully covered source rectangle', added.count - removed.count, 45 * 90);
      const inversions = await t.page.evaluate(z.object({ applied: z.boolean(), complement: z.boolean(), restored: z.boolean(), soft: z.number(), asset: z.string().nullable() }), async () => {
        const demo = window.__noisyTest?.demo;
        if (demo === undefined) throw new Error('No C2 hooks.');
        const before = demo.selectionState().preview?.bytes ?? [], original = demo.selectionState().selection?.mask.plane.asset;
        const first = await demo.invertSelection(), inverse = demo.selectionState().preview?.bytes ?? [];
        demo.c2Undo(); const restored = demo.selectionState().selection?.mask.plane.asset === original;
        demo.c2Redo(); await demo.invertSelection();
        const feathered = await demo.featherSelection(4), state = demo.selectionState();
        return { applied: first.kind === 'applied' && feathered.kind === 'applied',
          complement: before.length === inverse.length && before.every((value, index) => value + (inverse[index] ?? -1) === 255), restored,
          soft: state.preview?.bytes.filter(value => value > 0 && value < 255).length ?? 0, asset: state.selection?.mask.plane.asset ?? null };
      });
      t.ok('Invert is byte-exact, Undo restores its asset and Feather creates soft coverage', inversions.applied && inversions.complement && inversions.restored && inversions.soft > 0, inversions);
      const navigation = await t.page.evaluate(z.object({ error: z.number(), neutral: z.boolean(), zoom: z.number(), hash: z.string().nullable() }), () => {
        const demo = window.__noisyTest?.demo, stage = document.querySelector('[data-testid=stage]');
        const doc = demo?.document();
        if (demo === undefined || doc == null || !(stage instanceof HTMLCanvasElement)) throw new Error('No authoring stage.');
        const rect = stage.getBoundingClientRect();
        demo.setAuthoringLayout({ source: doc.frame.master.size, viewport: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, dpr: devicePixelRatio });
        const source = { x: 151.25, y: 117.5 }, anchor = demo.selectionToView(source, 'css');
        demo.zoomAuthoring({ zoom: 3, anchor }); demo.panAuthoring({ x: 19, y: -11 });
        const a = demo.selectionToSource(demo.selectionToView(source, 'css')), b = demo.selectionToSource(demo.selectionToView(source, 'device'));
        return { error: Math.max(Math.abs(a.x - source.x), Math.abs(a.y - source.y), Math.abs(b.x - source.x), Math.abs(b.y - source.y)),
          neutral: demo.selectionState().neutral, zoom: demo.selectionState().view.zoom, hash: demo.selectionState().selection?.mask.plane.asset ?? null };
      });
      t.ok('Fit-relative zoom and pan preserve CSS/device source coordinates in neutral authoring', navigation.error < 1e-8 && navigation.neutral && navigation.zoom === 3 && navigation.hash === inversions.asset, navigation);
      await t.page.emulate({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true, colorScheme: 'dark' });
      const portrait = await t.page.evaluate(z.object({ error: z.number(), zoom: z.number(), hash: z.string().nullable(), dpr: z.number(), fit: z.number() }), () => {
        const demo = window.__noisyTest?.demo, doc = demo?.document(), stage = document.querySelector('[data-testid=stage]');
        if (demo === undefined || doc == null || !(stage instanceof HTMLCanvasElement)) throw new Error('No portrait authoring stage.');
        const rect = stage.getBoundingClientRect();
        demo.setAuthoringLayout({ source: doc.frame.master.size, viewport: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, dpr: devicePixelRatio });
        const source = { x: 128.5, y: 94.25 }, from = demo.selectionToView(source, 'css');
        demo.pinchAuthoring({ from, to: { ...from, x: from.x + 5, y: from.y + 8 }, factor: 1.25 });
        const roundtrip = demo.selectionToSource(demo.selectionToView(source, 'device')), zoom = demo.selectionState().view.zoom;
        const hash = demo.selectionState().selection?.mask.plane.asset ?? null;
        demo.fitAuthoring();
        return { error: Math.max(Math.abs(roundtrip.x - source.x), Math.abs(roundtrip.y - source.y)), zoom, hash, dpr: devicePixelRatio, fit: demo.selectionState().view.zoom };
      });
      t.ok('portrait rotation, DPR2 and pinch preserve the stencil and logical coordinates', portrait.error < 1e-8 && portrait.zoom === 3.75 && portrait.hash === inversions.asset && portrait.dpr === 2 && portrait.fit === 1, portrait);
      await t.page.screenshot('c2-portrait-navigation');
      const afterSelection = requestCounts(await t.server.requestLog(), mark);
      t.equal('selection, history and navigation upload no bytes and write no checkpoint', [afterSelection.assetPuts, afterSelection.checkpoints, afterSelection.repairRequests], [0, 0, 0], afterSelection);
      const operations = await t.page.evaluate(z.object({ target: z.string(), applied: z.boolean(), undone: z.number(), redone: z.number(), noRemoval: z.boolean(), label: z.string().nullable(), noSam: z.boolean() }), async () => {
        const demo = window.__noisyTest?.demo;
        if (demo === undefined) throw new Error('No C2 session.');
        const target = demo.setOperationTarget({ kind: 'selection' });
        const a = demo.localOperation({ target: { kind: 'selection' }, operation: { kind: 'recolor', color: { l: .72, c: .23, h: 28 } } });
        const b = demo.localOperation({ target: { kind: 'selection' }, operation: { kind: 'clipping', amount: .86 } });
        demo.c2Undo(); const undone = demo.document()?.localEffects.length ?? -1; demo.c2Redo();
        const doc = demo.document();
        return { target: demo.selectionState().target.kind, applied: target.kind === 'applied' && a.kind === 'applied' && b.kind === 'applied',
          undone, redone: doc?.localEffects.length ?? -1, noRemoval: doc?.objects.length === 0 && doc.removals.length === 0,
          label: demo.overlapPolicy(), noSam: !demo.analysis().decoderReady && !demo.analysis().modelsReady };
      });
      t.ok('Selection is explicit; local Recolor/Clipping survive Undo/Redo without creating a removal', operations.applied && operations.target === 'selection' && operations.undone === 1 && operations.redone === 2 && operations.noRemoval && operations.noSam && operations.label === 'legacy-order', operations);
      const setters = await localSetterChecks(t.page);
      for (const result of setters) t.ok(result.name, result.passed, JSON.parse(result.evidence));
      await t.page.emulate({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
      await t.page.evaluate(z.literal(true), () => { window.__noisyTest?.demo.fitAuthoring(); return true; });
      await t.page.screenshot('c2-selection');
      const cleared = await t.page.evaluate(z.object({ result: z.string(), absent: z.boolean(), effects: z.number(), refused: z.string() }), async () => {
        const demo = window.__noisyTest?.demo;
        if (demo === undefined) throw new Error('No C2 session.');
        const result = await demo.deselect(); await demo.clearSelection();
        const refused = demo.setOperationTarget({ kind: 'selection' });
        return { result: result.kind, absent: demo.selectionState().selection === null, effects: demo.document()?.localEffects.length ?? -1, refused: refused.kind };
      });
      t.ok('Deselect/Clear leave frozen effects and refuse the absent Selection target', cleared.result === 'applied' && cleared.absent && cleared.effects === 2 && cleared.refused === 'refused', cleared);
      await saved(t.page);
      await t.file('c2-manual.json', JSON.stringify({ rectangle, added, removed, inversions, navigation, portrait, operations, setters, cleared, counts: requestCounts(await t.server.requestLog()) }, null, 2));
    } finally { await cleanup(t, ids); }
  },
};

const persistence: Scenario = {
  id: 'creative.c2-persistence', title: 'Fresh-context HTTP v5 open, frozen effects, complete checkpoints and strict failure isolation',
  target: 'dev', covers: ['C2i-1', 'C2i-2', 'C2i-3', 'C2i-5', 'C2i-7'], timeoutMs: 240_000,
  async run(t) {
    const fixture = completeFixture(), initialRevision = 17, ids: string[] = [fixture.document.id];
    try {
      // The runner has created a fresh browser context; provision HTTP before its first navigation.
      for (const asset of fixture.assets) await putFixture(t, fixture.document.id, `assets/${asset.asset}`, new Blob([asset.bytes]), 'application/octet-stream');
      await putFixture(t, fixture.document.id, 'scene', JSON.stringify({ transportVersion: 2, revision: initialRevision, document: fixture.document }), 'application/json');
      await boot(t, true);
      const mark = (await t.server.requestLog()).at(-1)?.seq ?? 0;
      t.ok('a fresh browser context opens a complete v5 checkpoint with SAM unavailable', await t.page.evaluate(z.boolean(), async (id) => {
        const demo = window.__noisyTest?.demo;
        return demo !== undefined && demo.document() === null && await demo.openProject(id);
      }, fixture.document.id));
      const first = await t.page.evaluate(z.object({ document: z.string(), selection: z.boolean(), ready: z.boolean(), stages: z.number(), bytesMatch: z.boolean(), png: z.string(), assets: z.number(), retention: z.unknown() }), async () => {
        const demo = window.__noisyTest?.demo, doc = demo?.document();
        if (demo === undefined || doc == null) throw new Error('No restored v5 document.');
        let bytesMatch = true;
        for (const asset of demo.projectAssets()) {
          const response = await fetch(`/api/projects/${doc.id}/${asset.path}`), bytes = new Uint8Array(await response.arrayBuffer());
          bytesMatch &&= response.ok && bytes.length === asset.bytes.length && bytes.every((value, index) => value === asset.bytes[index]);
        }
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await (await demo.downloadPng()).arrayBuffer()));
        return { document: JSON.stringify(doc), selection: demo.selectionState().selection === null,
          ready: demo.projects().state === 'saved', stages: demo.analysisDiagnostics().events.filter(event => event.event === 'stage.start').length,
          bytesMatch, png: [...digest].map(value => value.toString(16).padStart(2, '0')).join(''), assets: demo.projectAssets().length, retention: demo.assetRetention() };
      });
      t.equal('strict v5 reopen preserves the exact document and starts without a live selection', [first.document, first.selection, first.ready], [JSON.stringify(fixture.document), true, true]);
      t.equal('strict v5 reopen performs no inference and rewrites no stored checkpoint', [first.stages, requestCounts(await t.server.requestLog(), mark).checkpoints], [0, 0]);
      t.ok('every frozen scope/master/original byte restores from immutable HTTP assets', first.bytesMatch && first.assets === fixture.assets.length, first);
      await shape(t.page, { mode: 'replace', tool: 'rectangle', points: [{ x: 238, y: 38 }, { x: 485, y: 300 }] });
      const committed = await t.page.evaluate(z.object({ result: z.array(z.string()), effects: z.string(), png: z.string(), deselected: z.boolean(),
        replacement: z.boolean(), oneGesture: z.boolean(), scopeFrozen: z.boolean() }), async () => {
        const demo = window.__noisyTest?.demo;
        if (demo === undefined) throw new Error('No C2 session.');
        const a = demo.localOperation({ target: { kind: 'selection' }, operation: { kind: 'recolor', color: { l: .67, c: .18, h: 112 } } });
        const recolor = demo.document()?.localEffects.at(-1);
        if (recolor === undefined || recolor.operation.kind !== 'recolor') throw new Error('No new scoped Recolor.');
        const scope = JSON.stringify(recolor.scope);
        const blue = demo.localOperation({ target: { kind: 'selection' }, operation: { kind: 'recolor', color: { l: .58, c: .19, h: 238 } } });
        const replacement = blue.kind === 'applied' && demo.document()?.localEffects.length === 3 && demo.document()?.localEffects.at(-1)?.id === recolor.id;
        const beforeGesture = JSON.stringify(demo.document()?.localEffects), depth = demo.historyState().undoDepth;
        const gesture = demo.beginGesture({ operation: 'color', target: { kind: 'selection' } });
        if (gesture === null) throw new Error('No scoped Recolor gesture.');
        let stablePreview = true;
        for (const color of [{ l: .64, c: .2, h: 37 }, null, recolor.operation.color]) {
          const update = demo.updateGesture({ token: gesture, value: { kind: 'color', color } });
          const preview = demo.previewDocument()?.localEffects.find(item => item.id === recolor.id);
          stablePreview &&= update.kind === 'applied' && (color === null ? preview === undefined : preview?.id === recolor.id && JSON.stringify(preview.scope) === scope);
          stablePreview &&= JSON.stringify(demo.document()?.localEffects) === beforeGesture && demo.historyState().undoDepth === depth;
        }
        const gestureResult = demo.commitGesture(gesture), afterGesture = JSON.stringify(demo.document()?.localEffects);
        const oneStep = demo.historyState().undoDepth === depth + 1;
        demo.c2Undo(); const gestureUndo = JSON.stringify(demo.document()?.localEffects) === beforeGesture;
        demo.c2Redo(); const gestureRedo = JSON.stringify(demo.document()?.localEffects) === afterGesture;
        const oneGesture = stablePreview && gestureResult.kind === 'applied' && oneStep && gestureUndo && gestureRedo;
        const b = demo.localOperation({ target: { kind: 'selection' }, operation: { kind: 'clipping', amount: .73 } });
        const effects = JSON.stringify(demo.document()?.localEffects);
        demo.c2Undo(); demo.c2Redo();
        if (JSON.stringify(demo.document()?.localEffects) !== effects) throw new Error('Undo/Redo changed frozen local operations.');
        await demo.deselect();
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await (await demo.downloadPng()).arrayBuffer()));
        return { result: [a.kind, b.kind], effects, png: [...digest].map(value => value.toString(16).padStart(2, '0')).join(''), deselected: demo.selectionState().selection === null,
          replacement, oneGesture, scopeFrozen: JSON.stringify(demo.document()?.localEffects.find(item => item.id === recolor.id)?.scope) === scope };
      });
      t.ok('a new manual scope and its Recolor/Clipping commit, survive history and deselection, and change output', committed.result.every(value => value === 'applied') && committed.deselected && committed.png !== first.png, committed);
      t.ok('a replaced Recolor and one adjustment gesture preserve the effect ID and frozen scope through deselection before save/reopen',
        committed.replacement && committed.oneGesture && committed.scopeFrozen, committed);
      await saved(t.page);
      const wire = await t.page.evaluate(checkpoint, async (id) => (await fetch(`/api/projects/${id}/scene`)).json(), fixture.document.id);
      t.ok('the active writer checkpoints v2/v5 with both original and new frozen effects', wire.revision > initialRevision && wire.document.version === 5 && wire.document.localEffects.length === 4 && wire.document.compositing === 'legacy-order', { revision: wire.revision, effects: wire.document.localEffects.length });
      await t.file('c2-first-v5-checkpoint.json', JSON.stringify(wire, null, 2));
      const closure = await t.page.evaluate(z.array(z.object({ asset: z.string(), bytes: z.number(), valid: z.boolean() })), async () => {
        const demo = window.__noisyTest?.demo, doc = demo?.document();
        if (demo === undefined || doc == null) throw new Error('No saved composition.');
        return Promise.all(demo.projectAssets().map(async asset => {
          const response = await fetch(`/api/projects/${doc.id}/${asset.path}`), bytes = new Uint8Array(await response.arrayBuffer());
          const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
          return { asset: asset.asset, bytes: bytes.byteLength, valid: response.ok && bytes.length === asset.bytes.length &&
            bytes.every((value, index) => value === asset.bytes[index]) && [...digest].map(value => value.toString(16).padStart(2, '0')).join('') === asset.asset };
        }));
      });
      t.ok('the checkpoint closes over complete digest-verified immutable assets', closure.length === 3 && closure.every(asset => asset.valid), closure);
      await t.page.clearIndexedDb(); await t.page.reload();
      await t.page.waitFor('reloaded C2 hooks', z.literal(true), () => window.__noisyTest?.demo === undefined ? null : true);
      t.ok('save/reopen succeeds with page products and IndexedDB gone', await t.page.evaluate(z.boolean(), async id => await window.__noisyTest?.demo.openProject(id) ?? false, fixture.document.id));
      const reopened = await t.page.evaluate(z.object({ effects: z.string(), png: z.string(), stages: z.number(), selection: z.boolean(), document: z.string() }), async () => {
        const demo = window.__noisyTest?.demo;
        if (demo === undefined) throw new Error('No reopened session.');
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await (await demo.downloadPng()).arrayBuffer()));
        return { effects: JSON.stringify(demo.document()?.localEffects), png: [...digest].map(value => value.toString(16).padStart(2, '0')).join(''),
          stages: demo.analysisDiagnostics().events.filter(event => event.event === 'stage.start').length,
          selection: demo.selectionState().selection === null, document: JSON.stringify(demo.document()) };
      });
      t.equal('save/reopen retains frozen operations and deterministic PNG bytes without inference', [reopened.effects, reopened.png, reopened.stages, reopened.selection], [committed.effects, committed.png, 0, true]);
      const mask = wire.document.localEffects.find(effect => effect.scope.kind === 'mask')?.scope;
      if (mask === undefined || mask.kind !== 'mask') throw new Error('No frozen mask to corrupt.');
      await t.page.intercept([{ method: 'GET', path: `/api/projects/${fixture.document.id}/assets/${mask.mask.plane.asset}`, action: { kind: 'respond', status: 200, body: 'corrupt v5 asset' } }]);
      const rejected = await t.page.evaluate(z.object({ opened: z.boolean(), document: z.string(), stages: z.number(), png: z.string(), status: z.string() }), async id => {
        const demo = window.__noisyTest?.demo;
        if (demo === undefined) throw new Error('No failure-isolation session.');
        const opened = await demo.openProject(id), digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await (await demo.downloadPng()).arrayBuffer()));
        return { opened, document: JSON.stringify(demo.document()), stages: demo.analysisDiagnostics().events.filter(event => event.event === 'stage.start').length,
          png: [...digest].map(value => value.toString(16).padStart(2, '0')).join(''), status: demo.scene().status };
      }, fixture.document.id);
      t.equal('strict v5 asset failure preserves the old working document/output and never infers missing bytes', [rejected.opened, rejected.document, rejected.png, rejected.stages], [false, reopened.document, reopened.png, 0], rejected);
      await t.page.intercept([]);
      const depthId = randomUUID(); ids.push(depthId);
      for (const asset of fixture.assets) await putFixture(t, depthId, `assets/${asset.asset}`, new Blob([asset.bytes]), 'application/octet-stream');
      await putFixture(t, depthId, 'scene', JSON.stringify({ transportVersion: 2, revision: 0, document: { ...fixture.document, id: depthId, compositing: 'scene-depth' } }), 'application/json');
      const unsupported = await t.page.evaluate(z.object({ opened: z.boolean(), document: z.string(), status: z.string() }), async id => {
        const demo = window.__noisyTest?.demo;
        if (demo === undefined) throw new Error('No unsupported-policy session.');
        return { opened: await demo.openProject(id), document: JSON.stringify(demo.document()), status: demo.scene().status };
      }, depthId);
      t.ok('scene-depth is explicitly refused before replacing the working legacy-order scene', !unsupported.opened && unsupported.document === reopened.document && /scene-depth.*C3/i.test(unsupported.status), unsupported);
      const incompleteFixture = protectionFixture(), incompleteId = incompleteFixture.document.id;
      ids.push(incompleteId);
      for (const asset of incompleteFixture.assets) await putFixture(t, incompleteId, `assets/${asset.asset}`, new Blob([asset.bytes]), 'application/octet-stream');
      await putFixture(t, incompleteId, 'scene', JSON.stringify({ transportVersion: 2, revision: 0,
        document: { ...incompleteFixture.document, motion: { ...incompleteFixture.document.motion, enabled: true } } }), 'application/json');
      const incomplete = await t.page.evaluate(z.object({ opened: z.boolean(), document: z.string(), status: z.string(), stages: z.number(), png: z.string() }), async id => {
        const demo = window.__noisyTest?.demo;
        if (demo === undefined) throw new Error('No incomplete-project session.');
        const opened = await demo.openProject(id), digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await (await demo.downloadPng()).arrayBuffer()));
        return { opened, document: JSON.stringify(demo.document()), status: demo.scene().status,
          stages: demo.analysisDiagnostics().events.filter(event => event.event === 'stage.start').length,
          png: [...digest].map(value => value.toString(16).padStart(2, '0')).join('') };
      }, incompleteId);
      t.equal('strict v5 loading refuses required-but-absent repair without replacing the working scene or starting inference',
        [incomplete.opened, incomplete.document, incomplete.png, incomplete.stages], [false, reopened.document, reopened.png, 0], incomplete);
      t.ok('incomplete v5 refusal gives a sentence explaining the required background repair', /incomplete.*required background repair/i.test(incomplete.status), incomplete);
      await t.file('c2-persistence.json', JSON.stringify({ first, initialRevision, committed, revision: wire.revision, closure, reopened, rejected, unsupported, incomplete, counts: requestCounts(await t.server.requestLog()) }, null, 2));
    } finally { await t.page.intercept([]); await cleanup(t, ids); }
  },
};

const cancel: Scenario = {
  id: 'creative.c2-cancel', title: 'Pointer, tool, target, history, owner and import cancellation release stale selection work',
  target: 'dev', covers: ['C2i-2', 'C2i-4', 'C2i-7'], timeoutMs: 240_000,
  async run(t) {
    const ids: string[] = [];
    try {
      await boot(t, true); ids.push(await importFixture(t.page, fixturePng())); await saved(t.page);
      const baseline = await shape(t.page, { mode: 'replace', tool: 'rectangle', points: [{ x: 28, y: 18 }, { x: 175, y: 230 }] });
      const mark = (await t.server.requestLog()).at(-1)?.seq ?? 0;
      const cancellations = await t.page.evaluate(z.object({ rows: z.array(z.object({ name: z.string(), result: z.string(), unchanged: z.boolean() })), retention: z.unknown(), noRemoval: z.boolean(), document: z.boolean() }), async () => {
        const demo = window.__noisyTest?.demo;
        if (demo === undefined) throw new Error('No cancellation hooks.');
        const original = demo.selectionState().selection?.mask.plane.asset, json = JSON.stringify(demo.document()), rows = [];
        const begin = () => {
          const started = demo.beginSelection({ space: { kind: 'photo' }, pointerId: 41, kind: 'shape', tool: 'rectangle', mode: 'add', at: { x: 190, y: 20 } });
          if (started.kind !== 'began') throw new Error(started.reason);
          demo.extendSelection({ token: started.token, pointerId: 41, kind: 'shape', at: { x: 290, y: 120 } }); return started.token;
        };
        for (const name of ['pointer', 'tool', 'target', 'navigation', 'layout'] as const) {
          const token = begin();
          if (name === 'pointer') {
            const wrong = demo.extendSelection({ token, pointerId: 42, kind: 'shape', at: { x: 330, y: 250 } });
            if (wrong.kind !== 'cancelled') throw new Error('Another pointer extended an owned gesture.');
            demo.cancelSelection(token);
          } else if (name === 'tool') demo.setSelectionTool('navigate');
          else if (name === 'target') demo.setOperationTarget({ kind: 'background' });
          else if (name === 'navigation') demo.fitAuthoring();
          else demo.setAuthoringLayout(demo.selectionState().view.layout);
          const ended = await demo.endSelection({ token, pointerId: 41 });
          rows.push({ name, result: ended.kind, unchanged: demo.selectionState().selection?.mask.plane.asset === original });
        }
        const token = begin(), pending = demo.endSelection({ token, pointerId: 41 });
        demo.c2Undo(); const ended = await pending; demo.c2Redo();
        rows.push({ name: 'Undo during asset hashing', result: ended.kind, unchanged: demo.selectionState().selection?.mask.plane.asset === original });
        const cancelToken = begin(), cancelling = demo.endSelection({ token: cancelToken, pointerId: 41 });
        const duplicate = demo.endSelection({ token: cancelToken, pointerId: 41 });
        if (duplicate !== cancelling) throw new Error('Duplicate release must share the owning selection completion.');
        const busy = demo.localOperation({ target: { kind: 'selection' }, operation: { kind: 'clipping', amount: .8 } });
        if (busy.kind !== 'refused') throw new Error('A local operation must wait for its selection hash.');
        demo.cancelSelection(cancelToken);
        const blocked = demo.beginSelection({ space: { kind: 'photo' }, pointerId: 42, kind: 'shape', tool: 'rectangle', mode: 'add', at: { x: 10, y: 10 } });
        const blockedFeather = demo.featherSelection(2), blockedInitialize = demo.initializeSelection({ kind: 'photo' });
        if (blocked.kind !== 'refused' || demo.assetRetention()!.dirtyBytes === 0) throw new Error('Cancelled native hashing must keep its one bounded byte slot until completion.');
        const cancelled = await cancelling;
        if ((await duplicate).kind !== 'cancelled' || (await blockedFeather).kind !== 'refused' || (await blockedInitialize).kind !== 'refused' || demo.assetRetention()!.dirtyBytes !== 0) throw new Error('Hash completion must release its bounded slot and all duplicate releases.');
        rows.push({ name: 'Explicit token cancel during asset hashing', result: cancelled.kind, unchanged: demo.selectionState().selection?.mask.plane.asset === original });
        const state = demo.document();
        return { rows, retention: demo.assetRetention(), noRemoval: state?.removals.length === 0 && state.objects.length === 0,
          document: JSON.stringify(state) === json };
      });
      t.ok('every cancellation refuses late release and preserves committed selection bytes', cancellations.rows.length === 7 && cancellations.rows.every(row => row.result === 'cancelled' && row.unchanged) && cancellations.noRemoval && cancellations.document, cancellations);
      const counts = requestCounts(await t.server.requestLog(), mark);
      t.equal('cancelled previews and cancelled hashing upload no assets, save no document and request no repair', [counts.assetPuts, counts.checkpoints, counts.repairRequests], [0, 0, 0], counts);
      await t.page.evaluate(z.literal(true), () => {
        const demo = window.__noisyTest?.demo;
        if (demo === undefined) throw new Error('No mask fixture session.');
        const data = new Uint8Array(96 * 64);
        for (let y = 0; y < 64; y++) for (let x = 43; x < 96; x++) data[y * 96 + x] = 255;
        demo.injectMask({ width: 96, height: 64, data }); return true;
      });
      await t.page.waitFor('injected owner admitted through the v5 asset path', z.literal(true), () => window.__noisyTest?.demo.objects().length === 1 ? true : null);
      const owner = await t.page.evaluate(z.object({ retainedPhotoSpace: z.boolean(), refusedOtherOwner: z.boolean(), result: z.string(), removedSelection: z.boolean(), noLateEffect: z.boolean() }), async () => {
        const demo = window.__noisyTest?.demo, layer = demo?.document()?.objects[0];
        if (demo === undefined || layer === undefined) throw new Error('No C2 owner.');
        demo.select(layer.id); demo.setOperationTarget({ kind: 'layer', id: layer.id });
        const retainedPhotoSpace = demo.selectionState().selection?.space.kind === 'photo';
        const refused = demo.beginSelection({ space: { kind: 'layer', id: layer.id }, pointerId: 8, kind: 'shape', tool: 'rectangle', mode: 'replace', at: { x: 250, y: 15 } });
        await demo.initializeSelection({ kind: 'layer', id: layer.id });
        const started = demo.beginSelection({ space: { kind: 'layer', id: layer.id }, pointerId: 8, kind: 'shape', tool: 'rectangle', mode: 'replace', at: { x: 250, y: 15 } });
        if (started.kind !== 'began') throw new Error(started.reason);
        demo.extendSelection({ token: started.token, pointerId: 8, kind: 'shape', at: { x: 450, y: 280 } });
        const pending = demo.endSelection({ token: started.token, pointerId: 8 });
        demo.c2DeleteObject(layer.id);
        const ended = await pending;
        const operation = demo.localOperation({ target: { kind: 'layer', id: layer.id }, operation: { kind: 'fill', color: { l: .8, c: .1, h: 90 } } });
        return { retainedPhotoSpace, refusedOtherOwner: refused.kind === 'refused', result: ended.kind,
          removedSelection: demo.selectionState().selection === null, noLateEffect: operation.kind === 'refused' && demo.document()?.localEffects.length === 0 };
      });
      t.ok('row targeting never retargets a stencil; explicit owner selection and owner deletion invalidate late hashes/effects', owner.retainedPhotoSpace && owner.refusedOtherOwner && owner.result === 'cancelled' && owner.removedSelection && owner.noLateEffect, owner);
      const imported = await t.page.evaluate(z.object({ result: z.string(), id: z.string(), empty: z.boolean(), stale: z.string(), dirtyBytes: z.number(), activeBytes: z.number(), historyBytes: z.number() }), async bytes => {
        const demo = window.__noisyTest?.demo;
        if (demo === undefined) throw new Error('No import cancellation session.');
        const started = demo.beginSelection({ space: { kind: 'photo' }, pointerId: 91, kind: 'shape', tool: 'rectangle', mode: 'replace', at: { x: 15, y: 15 } });
        if (started.kind !== 'began') throw new Error(started.reason);
        demo.extendSelection({ token: started.token, pointerId: 91, kind: 'shape', at: { x: 400, y: 300 } });
        const ending = demo.endSelection({ token: started.token, pointerId: 91 });
        const opening = demo.importFile(new File([new Uint8Array(bytes)], 'c2-replacement.png', { type: 'image/png' }));
        const result = await ending; await opening;
        const stale = await demo.endSelection({ token: started.token, pointerId: 91 }), doc = demo.document(), retention = demo.assetRetention();
        if (doc === null || retention === null) throw new Error('Replacement import failed.');
        return { result: result.kind, id: doc.id, empty: demo.selectionState().selection === null && doc.localEffects.length === 0 && doc.removals.length === 0,
          stale: stale.kind, dirtyBytes: retention.dirtyBytes, activeBytes: retention.activeBytes, historyBytes: retention.historyBytes };
      }, Array.from(fixturePng()));
      ids.push(imported.id);
      t.ok('import cancels queued hashing, stale handles stay inert and only the new scene owns active bytes', imported.result === 'cancelled' && imported.stale === 'cancelled' && imported.empty && imported.dirtyBytes === 0 && imported.historyBytes === 0 && imported.activeBytes <= 64 * 1024 * 1024, imported);
      await saved(t.page);
      await t.file('c2-cancel.json', JSON.stringify({ baseline, cancellations, owner, imported, counts: requestCounts(await t.server.requestLog()) }, null, 2));
    } finally { await cleanup(t, ids); }
  },
};

function protectionFixture() {
  const png = fixturePng(true), photo = createHash('sha256').update(png).digest('hex'), size = { width: 96, height: 64 };
  // Clipping changes highlights above its knee. These exact source statistics
  // keep Simplify's palette consistent with the bright foreground fixture.
  const allColors = new Map<string, { readonly lab: Oklab; count: number }>();
  const foregroundColors = new Map<string, { readonly lab: Oklab; count: number }>();
  const lightness: number[] = [];
  for (let y = 0; y < SIZE.height; y++) for (let x = 0; x < SIZE.width; x++) {
    const [r, g, b] = fixtureColor(x, y, true), key = `${r},${g},${b}`, lab = srgbToOklab({ r: r / 255, g: g / 255, b: b / 255 });
    lightness.push(lab.L);
    for (const histogram of x >= SIZE.width * 43 / 96 ? [allColors, foregroundColors] : [allColors]) {
      const entry = histogram.get(key);
      if (entry === undefined) histogram.set(key, { lab, count: 1 }); else entry.count++;
    }
  }
  const clusters = (histogram: typeof allColors) => {
    const entries = [...histogram.values()], total = entries.reduce((sum, entry) => sum + entry.count, 0);
    return entries.sort((a, b) => b.count - a.count).map(entry => ({ lab: entry.lab, weight: entry.count / total }));
  };
  const foreground = clusters(foregroundColors);
  const mean = foreground.reduce((sum, cluster) => ({ L: sum.L + cluster.lab.L * cluster.weight,
    a: sum.a + cluster.lab.a * cluster.weight, b: sum.b + cluster.lab.b * cluster.weight }), { L: 0, a: 0, b: 0 });
  lightness.sort((a, b) => a - b);
  const quantile = (p: number) => lightness[Math.floor(p * (lightness.length - 1))] ?? 0;
  const mask = new Uint8Array(size.width * size.height), depth = new Float32Array(mask.length).fill(.2);
  for (let y = 0; y < size.height; y++) for (let x = 43; x < size.width; x++) { mask[y * size.width + x] = 255; depth[y * size.width + x] = .8; }
  const maskBytes = encodeRaster({ format: 'u8', size, data: mask }), depthBytes = encodeRaster({ format: 'f32', size, data: depth });
  const maskAsset = createHash('sha256').update(maskBytes).digest('hex'), depthAsset = createHash('sha256').update(depthBytes).digest('hex');
  const base = legacyFiveClusterDocument(), object = base.objects[0];
  if (object === undefined) throw new Error('No frozen foreground fixture.');
  const legacy = parseLegacyDocument({ ...base, id: randomUUID(), title: 'C2 protected foreground', seed: 37,
    frame: { source: { asset: photo, byteLength: png.length, mediaType: 'image/png' }, master: { asset: photo, size: SIZE },
      original: { name: 'c2-owner-grid.png', mediaType: 'image/png', size: SIZE } },
    analysis: { ...base.analysis, colors: clusters(allColors),
      tone: { p01: quantile(.01), p05: quantile(.05), p50: quantile(.5), p95: quantile(.95), p99: quantile(.99) },
      autoSubject: 'done', plate: null, depth: { model: DEPTH_MODEL,
      map: { asset: depthAsset, format: 'f32', size }, stats: { p10: .2, median: .5, p90: .8 } } },
    objects: [{ ...object, name: 'Protected foreground', subject: false, recolor: { kind: 'none' }, motion: { kind: 'none' }, symbols: 'never',
      produced: { ...object.produced, color: { mean, clusters: foreground }, mask: { asset: maskAsset, format: 'u8', size },
        bounds: { x: 229, y: 0, width: 283, height: SIZE.height }, depth: { p10: .8, median: .8, p90: .8 } } }], lights: [],
    style: { ...base.style, paletteTargets: [], simplify: .7, crunch: .85, grain: .12, colorNoise: .08, clipping: 0, outline: 0 },
    surface: { enabled: true, pattern: 'bars', relief: 1, refraction: 1, shine: .35, scale: .41 },
    symbols: { ...base.symbols, enabled: false }, motion: { ...base.motion, enabled: false, parallax: 2, loopSeconds: 2, drift: { direction: 'circle', amount: .4 }, focus: .8 },
  });
  if (!legacy.ok) throw new Error(JSON.stringify(legacy.error));
  const migrated = migrateV4ToV5(legacy.value);
  if (!migrated.ok) throw new Error(JSON.stringify(migrated.error));
  return { document: migrated.value, assets: [{ asset: photo, bytes: png }, { asset: maskAsset, bytes: maskBytes }, { asset: depthAsset, bytes: depthBytes }] };
}

const pixelChecks = z.object({ rows: z.array(z.object({ view: z.string(), outside: z.number(), protected: z.number(), changed: z.number(), maxError: z.number(),
  inputExact: z.boolean(), ownerExact: z.boolean(), uvExact: z.boolean(), coverageErrors: z.number(), outputError: z.number(), fractional: z.number(), perspective: z.string() })),
  scopeFrozen: z.boolean(), operations: z.number(), removalCount: z.number(), inferenceBefore: z.number(), inferenceAfter: z.number(), nonidentityUV: z.boolean() });

/** Reads final RGB and exact owner/source lookup from the active session renderer. */
export async function protectedOperation(page: BrowserPage, input: { readonly layer: boolean; readonly operation: 'recolor' | 'fill' | 'clipping'; readonly scoped: boolean }) {
  return page.evaluate(pixelChecks, async input => {
    const demo = window.__noisyTest?.demo, renderer = window.__noisyTest?.session?.renderer(), stage = document.querySelector('[data-testid=stage]');
    const doc = demo?.document(), layer = doc?.objects[0], debug = demo?.render;
    if (demo === undefined || renderer == null || doc == null || layer === undefined || debug?.readLocalEffectPatch === undefined || debug.readLocalCoveragePatch === undefined || !(stage instanceof HTMLCanvasElement)) throw new Error('C2 pixel probes are unavailable.');
    const size = doc.frame.master.size, copy = new OffscreenCanvas(size.width, size.height), context = copy.getContext('2d', { willReadFrequently: true });
    if (context === null) throw new Error('No C2 pixel capture context.');
    const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, index) => value === b[index]);
    const capture = () => { context.drawImage(stage, 0, 0); return context.getImageData(0, 0, size.width, size.height).data; };
    const decode = async (blob: Blob) => {
      const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
      try { context.drawImage(bitmap, 0, 0); return context.getImageData(0, 0, size.width, size.height).data; }
      finally { bitmap.close(); }
    };
    const rect = stage.getBoundingClientRect(), fit = Math.min(rect.width / size.width, rect.height / size.height), width = size.width * fit, height = size.height * fit;
    const geometry = { aperture: { center: { x: (rect.x + rect.width / 2 - innerWidth / 2) / innerWidth,
      y: (innerHeight / 2 - rect.y - rect.height / 2) / innerWidth }, width: width / innerWidth, height: height / innerWidth },
      crop: .02 * doc.motion.parallax, neutralDistance: 1, nearFactor: 1.1, farFactor: 2 };
    const perspective = { geometry, eye: { x: .02, y: 0, z: 1 }, sceneGeneration: demo.products().generation, viewId: 500, frame: 17, showSelection: false };
    const views = ['still', 'motion17', 'surface', 'perspective'] as const;
    const draw = (view: typeof views[number]) => {
      if (view === 'still') renderer.renderStill();
      else if (view === 'motion17') renderer.renderFrame(17);
      else if (view === 'surface') renderer.renderView({ x: .01, y: -.008 }, 17, false);
      else return renderer.renderPerspective(perspective).kind;
      return 'rendered';
    };
    const readPatch = debug.readLocalEffectPatch, readCoverage = debug.readLocalCoveragePatch;
    const baseline = views.map(view => { const kind = draw(view); return { kind, ...readPatch(0, 0, size.width, size.height) }; });
    const inferred = () => demo.analysisDiagnostics().events.filter(event => event.event === 'stage.start').length;
    const inferenceBefore = inferred(), removals = doc.removals.length;
    const owner = input.layer ? { kind: 'layer', id: layer.id } as const : { kind: 'background' } as const;
    const operation = input.operation === 'clipping' ? { kind: 'clipping', amount: .88 } as const :
      { kind: input.operation, color: input.operation === 'fill' ? { l: .76, c: .15, h: 166 } : { l: .67, c: .2, h: 26 } };
    const result = demo.localOperation({ target: input.scoped ? { kind: 'selection' } : owner, operation });
    if (result.kind !== 'applied') throw new Error(`Local ${input.operation}: ${result.kind === 'refused' ? result.reason : result.kind}`);
    const effect = demo.document()?.localEffects.at(-1);
    if (effect === undefined) throw new Error('No committed local effect.');
    const frozen = effect.scope.kind === 'mask' ? effect.scope.mask.plane.asset : null;
    const mask = effect.scope.kind === 'mask' ? demo.projectAssets().find(asset => asset.asset === frozen) : null;
    const maskSize = effect.scope.kind === 'mask' ? effect.scope.mask.plane.size : null;
    await demo.deselect();
    const rows = [];
    for (const [index, view] of views.entries()) {
      const kind = draw(view), after = readPatch(0, 0, size.width, size.height), coverage = readCoverage(effect.id, 0, 0, size.width, size.height);
      const before = baseline[index];
      if (before === undefined) throw new Error('Missing view baseline.');
      let outside = 0, protectedPixels = 0, changed = 0, maxError = 0, coverageErrors = 0, fractional = 0;
      const wanted = input.layer ? 1 : 0;
      for (let i = 0; i < coverage.length; i += 4) {
        const weight = coverage[i] ?? 0, valid = after.owners[i + 3] === 255 && after.owners[i] === wanted;
        let expected = valid ? 255 : 0;
        if (valid && mask !== null && mask !== undefined && maskSize !== null) {
          const x = Math.min(maskSize.width - 1, Math.floor(((after.sourceUV[i] ?? 0) * 256 + (after.sourceUV[i + 1] ?? 0)) / 65535 * maskSize.width));
          const y = Math.min(maskSize.height - 1, Math.floor(((after.sourceUV[i + 2] ?? 0) * 256 + (after.sourceUV[i + 3] ?? 0)) / 65535 * maskSize.height));
          expected = mask.bytes[16 + y * maskSize.width + x] ?? 0;
        }
        if (weight !== expected) coverageErrors++;
        const error = Math.max(...[0, 1, 2].map(channel => Math.abs((after.after[i + channel] ?? 0) - (before.after[i + channel] ?? 0))));
        if (weight === 0) { outside++; maxError = Math.max(maxError, error); if (after.owners[i] === 1) protectedPixels++; }
        else if (error > 1) changed++;
        if (weight > 0 && weight < 255) fractional++;
      }
      let output: Uint8ClampedArray;
      if (view === 'still') output = await decode(await demo.downloadPng());
      else if (view === 'motion17') output = await decode(await demo.exportFrame(17));
      else if (view === 'surface') output = await decode(await renderer.exportView({ x: .01, y: -.008 }, 17));
      else output = capture();
      let outputError = 0;
      for (let i = 0; i < output.length; i++) outputError = Math.max(outputError, Math.abs((output[i] ?? 0) - (after.after[i] ?? 0)));
      rows.push({ view, outside, protected: protectedPixels, changed, maxError, inputExact: same(before.before, after.before), ownerExact: same(before.owners, after.owners),
        uvExact: same(before.sourceUV, after.sourceUV), coverageErrors, outputError, fractional, perspective: kind });
    }
    draw('motion17'); const frame = readPatch(0, 0, size.width, size.height), loop = demo.exportLoopFrame(17, size.width);
    let loopError = 0; for (let i = 0; i < loop.data.length; i++) loopError = Math.max(loopError, Math.abs((loop.data[i] ?? 0) - (frame.after[i] ?? 0)));
    rows.push({ view: 'loop-export17', outside: 0, protected: 0, changed: 1, maxError: 0, inputExact: true, ownerExact: true, uvExact: true,
      coverageErrors: 0, outputError: loopError, fractional: 0, perspective: 'rendered' });
    return { rows, scopeFrozen: frozen === null || JSON.stringify(demo.document()?.localEffects.at(-1)?.scope) === JSON.stringify(effect.scope),
      operations: demo.document()?.localEffects.length ?? 0, removalCount: demo.document()?.removals.length ?? -1,
      inferenceBefore, inferenceAfter: inferred(), nonidentityUV: baseline[0] !== undefined && baseline[1] !== undefined && !same(baseline[0].sourceUV, baseline[1].sourceUV) && removals === (demo.document()?.removals.length ?? -1) };
  }, input);
}

const protection: Scenario = {
  id: 'creative.c2-protection', title: 'Local owner/scoped effects protect final foreground pixels in every render and output path',
  target: 'dev', covers: ['C2i-4', 'C2i-5', 'C2i-6', 'C2i-7'], timeoutMs: 600_000,
  async run(t) {
    const fixture = protectionFixture(), ids = [fixture.document.id], results = [];
    try {
      for (const asset of fixture.assets) await putFixture(t, fixture.document.id, `assets/${asset.asset}`, new Blob([asset.bytes]), 'application/octet-stream');
      await putFixture(t, fixture.document.id, 'scene', JSON.stringify({ transportVersion: 2, revision: 0, document: fixture.document }), 'application/json');
      await boot(t, false);
      t.ok('the session restores a seeded foreground/depth fixture from complete v5 assets', await t.page.evaluate(z.boolean(), async id => await window.__noisyTest?.demo.openProject(id) ?? false, fixture.document.id));
      await t.page.waitFor('healthy models for saved/live repair', z.literal(true), () => window.__noisyTest?.demo.analysis().modelsReady ? true : null, { timeoutMs: 180_000 });
      await t.page.evaluate(z.literal(true), async () => {
        const demo = window.__noisyTest?.demo;
        if (demo === undefined) throw new Error('No protected session.');
        demo.setMotion({ enabled: true, drift: { direction: 'circle', amount: .4 }, loopSeconds: 2, parallax: 2, focus: .8 });
        await demo.requestPlate(); return true;
      });
      for (const input of [
        { layer: false, operation: 'fill', scoped: false }, { layer: false, operation: 'recolor', scoped: true }, { layer: false, operation: 'clipping', scoped: true },
        { layer: true, operation: 'fill', scoped: false }, { layer: true, operation: 'recolor', scoped: true }, { layer: true, operation: 'clipping', scoped: true },
      ] as const) {
        await t.page.evaluate(z.literal(true), async () => {
          const demo = window.__noisyTest?.demo;
          if (demo === undefined) throw new Error('No effect cleanup hooks.');
          await demo.c2SetParallax(false);
          while ((demo.document()?.localEffects.length ?? 0) > 0) demo.c2Undo();
          await demo.clearSelection(); return true;
        });
        if (input.scoped) {
          await shape(t.page, { mode: 'replace', tool: 'rectangle', layer: input.layer, points: [{ x: 22, y: 30 }, { x: 485, y: 311 }] });
          await t.page.evaluate(z.literal(true), async () => {
            const result = await window.__noisyTest?.demo.featherSelection(5);
            if (result?.kind !== 'applied') throw new Error('The fractional scoped fixture could not be feathered.'); return true;
          });
        }
        await t.page.evaluate(z.literal(true), async () => {
          const demo = window.__noisyTest?.demo;
          if (demo === undefined) throw new Error('No perspective preparation hooks.');
          demo.setParallaxSource('tilt'); await demo.c2SetParallax(true);
          demo.injectOrientation({ alpha: 0, beta: 0, gamma: 0 }); return true;
        });
        await t.page.waitFor('fresh matching live repair for the protected perspective', z.literal(true), () =>
          window.__noisyTest?.demo.parallaxDebug().preparation === 'ready' && window.__noisyTest.demo.parallaxDebug().coverage.kind === 'rendered' ? true : null, { timeoutMs: 180_000 });
        const result = await protectedOperation(t.page, input); results.push({ input, result });
        t.ok(`${input.layer ? 'layer' : 'Background'} ${input.operation}: all final outside-scope pixels stay exact in still/Motion/Surface/perspective`,
          result.rows.every(row => row.maxError === 0 && row.coverageErrors === 0 && row.inputExact && row.ownerExact && row.uvExact && row.outputError <= 1 && row.perspective === 'rendered' && row.changed > 0), result);
        t.ok(`${input.operation}: frozen scope, nonidentity source lookup and unchanged removal/repair basis`, result.scopeFrozen && result.nonidentityUV && result.removalCount === fixture.document.removals.length && result.inferenceAfter === result.inferenceBefore, result);
        if (input.scoped) t.ok(`${input.operation}: feather weights survive source lookup in each view`, result.rows.filter(row => row.view !== 'loop-export17').every(row => row.fractional > 0), result.rows);
        if (!input.layer) t.ok(`${input.operation}: the full foreground remains protected`, result.rows.filter(row => row.view !== 'loop-export17').every(row => row.protected > 0), result.rows);
        if (!input.layer && input.operation === 'fill') {
          await t.page.evaluate(z.literal(true), async () => { await window.__noisyTest?.demo.c2SetParallax(false); return true; });
          await t.page.screenshot('c2-protected');
        }
      }
      const released = await t.page.evaluate(z.object({ effects: z.number(), textures: z.number(), retained: z.unknown() }), async () => {
        const demo = window.__noisyTest?.demo;
        if (demo === undefined) throw new Error('No final effect cleanup.');
        await demo.c2SetParallax(false); while ((demo.document()?.localEffects.length ?? 0) > 0) demo.c2Undo();
        await demo.deselect();
        return { effects: demo.document()?.localEffects.length ?? -1, textures: demo.render?.localResources?.().textures ?? -1, retained: demo.assetRetention() };
      });
      t.equal('undoing local effects releases their GPU mask textures while history retains undo bytes', [released.effects, released.textures], [0, 0], released);
      await saved(t.page);
      await t.file('c2-protection.json', JSON.stringify({ fixture: { size: SIZE, logicalMask: [96, 64], foregroundAt: 43, seed: 37, style: fixture.document.style, surface: fixture.document.surface }, results, released, counts: requestCounts(await t.server.requestLog()) }, null, 2));
    } finally { await cleanup(t, ids); }
  },
};

const legacy: Scenario = {
  id: 'creative.c2-legacy', title: 'Isolated v0/v3/v4 Projects hydrate offside and checkpoint complete v5 with legacy ordering',
  target: 'dev', covers: ['C2i-1', 'C2i-3', 'C2i-6', 'C2i-7'], timeoutMs: 600_000,
  async run(t) {
    const ids: string[] = [], results = [];
    try {
      await boot(t, false);
      await t.page.waitFor('healthy legacy hydration models', z.literal(true), () => window.__noisyTest?.demo.analysis().modelsReady ? true : null, { timeoutMs: 180_000 });
      for (const [index, version] of [0, 3, 4].entries()) {
        const png = fixturePng(), photo = createHash('sha256').update(png).digest('hex'), id = randomUUID(), revision = [0, 7, 19][index] ?? 0;
        ids.push(id);
        const base = version === 0 ? legacyMinimalDocument() : legacyFiveClusterDocument();
        const raw = base.objects.map((object, objectIndex) => {
          const bytes = new Uint8Array(96 * 64);
          for (let y = 0; y < 64; y++) for (let x = 0; x < 96; x++) {
            if (objectIndex === 0 ? x >= 43 : x >= 37 && x < 73 && y >= 9 && y < 58) bytes[y * 96 + x] = 255;
          }
          return { object, bytes, asset: createHash('sha256').update(bytes).digest('hex'), encoded: createHash('sha256').update(encodeRaster({ format: 'u8', size: { width: 96, height: 64 }, data: bytes })).digest('hex') };
        });
        const frozen = { ...base, id, title: `C2 legacy version ${version}`, seed: 37,
          frame: { source: { asset: photo, byteLength: png.length, mediaType: 'image/png' }, master: { asset: photo, size: SIZE },
            original: { name: `c2-legacy-${version}.png`, mediaType: 'image/png', size: SIZE } },
          analysis: { ...base.analysis, depth: null, autoSubject: 'done', plate: version === 4 && base.analysis.plate !== null
            ? { ...base.analysis.plate, image: { ...base.analysis.plate.image, size: SIZE }, forMasks: raw.map(mask => mask.asset) } : null },
          objects: raw.map(({ object, asset }) => ({ ...object, produced: { ...object.produced,
            mask: { asset, format: 'u8', size: { width: 96, height: 64 } }, bounds: { x: 0, y: 0, width: SIZE.width, height: SIZE.height } } })),
          motion: { ...base.motion, enabled: false, drift: { direction: 'circle', amount: .31 } },
        };
        const { surface, ...withoutSurface } = frozen;
        const { drift: _drift, parallax, ...withoutDrift } = frozen.motion;
        const historical = version === 4 ? frozen : { ...(version === 0 ? withoutSurface : frozen), version,
          motion: { ...withoutDrift, ...(version === 0 ? {} : { parallax }), orbit: .31 } };
        const parsed = parseLegacyDocument(historical);
        if (!parsed.ok) throw new Error(`Legacy ${version} fixture: ${JSON.stringify(parsed.error)}`);
        await putFixture(t, id, 'photo', new Blob([png]), 'image/png');
        for (const mask of raw) await putFixture(t, id, `masks/${mask.asset}`, new Blob([mask.bytes]), 'application/octet-stream');
        await putFixture(t, id, 'scene', JSON.stringify({ document: historical, masks: Object.fromEntries(raw.map(mask => [mask.asset, { width: 96, height: 64 }])), revision }), 'application/json');
        const mark = (await t.server.requestLog()).at(-1)?.seq ?? 0;
        const opened = await t.page.evaluate(z.object({ opened: z.boolean(), controls: z.string(), layers: z.string(), cache: z.boolean(), policy: z.string().nullable(), version: z.number(), pngBytes: z.number() }), async (id, oldPlate) => {
          const demo = window.__noisyTest?.demo;
          if (demo === undefined) throw new Error('No legacy open session.');
          const opened = await demo.openProject(id), doc = demo.document();
          if (!opened || doc === null) return { opened, controls: '', layers: '', cache: false, policy: demo.overlapPolicy(), version: doc?.version ?? -1, pngBytes: 0 };
          return { opened, controls: JSON.stringify({ style: doc.style, symbols: doc.symbols, surface: doc.surface, motion: doc.motion, lighting: doc.lighting }),
            layers: JSON.stringify(doc.objects.map(object => ({ name: object.name, hidden: object.hidden, subject: object.subject,
              recolor: object.recolor, symbols: object.symbols, motion: object.motion, thickness: object.thickness,
              sampling: object.produced.sampling, provenance: object.produced.provenance.kind, asset: object.produced.mask.asset }))),
            cache: oldPlate === null || doc.analysis.plate?.image.asset !== oldPlate,
            policy: demo.overlapPolicy(), version: doc.version, pngBytes: (await demo.downloadPng()).size };
        }, id, parsed.value.analysis.plate?.image.asset ?? null);
        t.ok(`v${version}: old-envelope hydration installs a renderable v5 scene after real assets are ready`, opened.opened && opened.version === 5 && opened.policy === 'legacy-order' && opened.cache && opened.pngBytes > 100, opened);
        t.equal(`v${version}: every authored control retains its frozen legacy value`, opened.controls, JSON.stringify({ style: parsed.value.style,
          symbols: parsed.value.symbols, surface: parsed.value.surface, motion: parsed.value.motion, lighting: parsed.value.lighting }));
        t.equal(`v${version}: names/visibility/order/color and threshold provenance survive encoded mask hydration`, opened.layers,
          JSON.stringify(parsed.value.objects.map((object, objectIndex) => ({ name: object.name, hidden: object.hidden, subject: object.subject,
            recolor: object.recolor, symbols: object.symbols, motion: object.motion, thickness: object.thickness,
            sampling: 'legacy-threshold', provenance: 'ai', asset: raw[objectIndex]?.encoded }))));
        await saved(t.page);
        const wire = await t.page.evaluate(checkpoint, async id => (await fetch(`/api/projects/${id}/scene`)).json(), id);
        t.equal(`v${version}: the first upgrade is complete transport2/document5 at loaded revision+1`, [wire.transportVersion, wire.document.version, wire.revision], [2, 5, revision + 1]);
        if (raw.length > 0) {
          const product = wire.document.analysis.depth;
          if (product === null) throw new Error('Legacy hydration did not prepare source depth.');
          const response = await fetch(new URL(`/api/projects/${id}/assets/${product.map.asset}`, t.baseUrl));
          if (!response.ok) throw new Error(`Hydrated depth could not load: HTTP ${response.status}`);
          const depth = decodeRaster(new Uint8Array(await response.arrayBuffer()), product.map);
          if (depth.format !== 'f32') throw new Error('Hydrated depth has the wrong format.');
          for (const [objectIndex, before] of parsed.value.objects.entries()) {
            const mask = raw[objectIndex], after = wire.document.objects[objectIndex];
            if (mask === undefined || after === undefined) throw new Error('A hydrated layer disappeared.');
            const expected = before.produced.depth ?? maskedDepth({ format: 'u8', size: { width: 96, height: 64 }, data: mask.bytes }, depth);
            t.ok(`v${version}: layer ${objectIndex + 1} has a nonempty depth summary`, expected !== null && after.produced.depth !== null, after.produced.depth);
            t.equal(`v${version}: layer ${objectIndex + 1} ${before.produced.depth === null ? 'backfills only its missing summary from actual mask/depth' : 'preserves its non-null saved summary exactly'}`,
              after.produced.depth, expected);
          }
          const installedDepths = await t.page.evaluate(z.string(), () => JSON.stringify(window.__noisyTest?.demo.document()?.objects.map(object => object.produced.depth)));
          t.equal(`v${version}: the installed scene and first checkpoint contain the same backfilled summaries`, installedDepths,
            JSON.stringify(wire.document.objects.map(object => object.produced.depth)));
        }
        const durable = await t.page.evaluate(z.object({ all: z.boolean(), assets: z.number(), masks: z.number(), oldEnvelope: z.boolean() }), async () => {
          const demo = window.__noisyTest?.demo, doc = demo?.document();
          if (demo === undefined || doc == null) throw new Error('No upgraded checkpoint.');
          let all = true;
          for (const asset of demo.projectAssets()) {
            const response = await fetch(`/api/projects/${doc.id}/${asset.path}`), bytes = new Uint8Array(await response.arrayBuffer());
            const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
            all &&= response.ok && bytes.length === asset.bytes.length && bytes.every((value, index) => value === asset.bytes[index]) &&
              [...digest].map(value => value.toString(16).padStart(2, '0')).join('') === asset.asset;
          }
          const envelope: unknown = await (await fetch(`/api/projects/${doc.id}/scene`)).json();
          return { all, assets: demo.projectAssets().length, masks: demo.projectMasks().length,
            oldEnvelope: typeof envelope === 'object' && envelope !== null && 'masks' in envelope };
        });
        t.ok(`v${version}: all durable assets precede its new checkpoint and the old mask-only envelope is gone`, durable.all && durable.assets >= 2 + raw.length && durable.masks === raw.length && !durable.oldEnvelope, durable);
        const counts = requestCounts(await t.server.requestLog(), mark), saves = counts.requests.filter(line => line.method === 'PUT' && line.path === `/api/projects/${id}/scene`);
        t.equal(`v${version}: one first upgrade checkpoint is committed after all immutable uploads`, saves.length, 1, counts);
        const firstSave = saves[0];
        if (firstSave !== undefined) t.ok(`v${version}: no immutable asset upload comes after the first upgrade checkpoint`, counts.requests.filter(line => line.method === 'PUT' && /\/(?:assets\/|photo$)/.test(line.path)).every(line => line.seq < firstSave.seq), counts);
        if (version === 4) await t.page.screenshot('c2-legacy');
        results.push({ sourceVersion: version, loadedRevision: revision, firstRevision: wire.revision, opened, durable, counts });
        await t.file(`c2-legacy-v${version}-checkpoint.json`, JSON.stringify(wire, null, 2));
      }
      await t.file('c2-legacy.json', JSON.stringify(results, null, 2));
    } finally { await cleanup(t, ids); }
  },
};

export const scenarios: readonly Scenario[] = [manual, protection, persistence, cancel, legacy];

