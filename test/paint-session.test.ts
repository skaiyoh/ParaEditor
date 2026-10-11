import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beginPaintStroke, solidPaintCoverage, type PaintAttachment, type PaintCapture, type PaintCoverageSource,
  type PaintDrawBrush, type PaintEraseTarget, type PaintPatch, type PaintStrokeResult } from '../src/core/paint.ts';
import { createMathPresets } from '../src/core/math-graph.ts';
import type { Result } from '../src/core/result.ts';
import { compileBrushCoverage, evaluateBrushCoverage } from '../src/render/math-program.ts';
import type { CommandResult } from '../src/session/authoring.ts';
import { BRUSH_PREVIEW, createPaintSession, type BrushPreviewFrame, type PaintCommitGuard, type PaintGenerations,
  type PaintInterruption, type PaintSessionHost, type PaintStrokePlane, type PointerSample, type SessionBrush,
  type StrokeStart } from '../src/session/paint.ts';

function value<T, E>(result: Result<T, E>): T { assert.ok(result.ok, JSON.stringify(result)); return result.value; }
const brush: PaintDrawBrush = { operation: 'draw', diameter: 8, opacity: .6, pressure: 'size', color: { l: .7, c: .15, h: 20 } };
const sample = (x: number, y: number, pressure: number | null = null): PointerSample => ({ at: { x, y }, pressure });
const start = (overrides: Partial<StrokeStart> = {}): StrokeStart => ({ surface: 'scene', pointer: 'pen', sample: sample(16, 16, .8), ...overrides });
function bytes(patches: readonly PaintPatch[]): unknown {
  return patches.map(patch => patch.tiles.map(tile => ({ x: tile.x, y: tile.y, size: tile.raster.size, bytes: tile.raster.copyBytes() })));
}
function after(result: PaintStrokeResult): PaintPatch[] {
  return result.changes.flatMap(change => change.after === null ? [] : [change.after]);
}
function harness() {
  const state: {
    generations: { scene: number; view: number; owner: number }; settings: SessionBrush;
    scene: ReturnType<PaintSessionHost['sceneSurface']>;
    attachment: PaintAttachment | null; plane: PaintStrokePlane; source: PaintCoverageSource;
    targets: readonly PaintEraseTarget[]; count: number; defer: boolean; seed: number;
  } = {
    generations: { scene: 1, view: 2, owner: 3 } satisfies PaintGenerations,
    settings: { brush, brushRevision: 'brush@1', functionRevision: 'texture@1' },
    scene: { owner: 'paint-owner', depthAvailable: true },
    attachment: { disparity: .4, depthSample: { x: 4, y: 5 } },
    plane: { size: { width: 256, height: 128 }, texture: { origin: { x: .5, y: .5 }, pixelScale: 1 },
      toPlane: (at: PointerSample['at']) => ({ ...at }) } satisfies PaintStrokePlane,
    source: solidPaintCoverage,
    targets: [],
    count: 0, defer: false, seed: BRUSH_PREVIEW.seed,
  };
  const calls: { result: PaintStrokeResult; guard: PaintCommitGuard }[] = [], admitted: PaintStrokeResult[] = [];
  const waits: (() => void)[] = [], frames: BrushPreviewFrame[] = [], depths: PointerSample['at'][] = [];
  const refs: { brushRevision: string; functionRevision: string }[] = [], eraseCaptures: PaintCapture[] = [];
  let sequence = 0, planeReads = 0, writes = 0;
  const host: PaintSessionHost = {
    sceneSurface: () => state.scene, generations: () => state.generations,
    depthAt: at => { depths.push(at); return state.attachment; },
    capturePlane: () => { planeReads++; return state.plane; },
    readBrush: () => state.settings,
    writeBrush: next => { writes++; state.settings = { ...state.settings, brush: next, brushRevision: `brush@${writes + 1}` }; return { kind: 'applied' }; },
    brushCoverage: ref => { refs.push(ref); return state.source; },
    nextStroke: () => ({ id: `stroke-${++sequence}`, seed: state.seed }),
    projectPatchCount: () => state.count,
    activePatches: capture => { eraseCaptures.push(capture); return state.targets; },
    commit: async (result, guard) => {
      calls.push({ result, guard });
      if (state.defer) await new Promise<void>(resolve => { waits.push(resolve); });
      if (guard.signal.aborted || !guard.isCurrent()) return { kind: 'cancelled' };
      if (result.kind === 'draw' && state.count >= 64) return { kind: 'refused', reason: 'The project is full.' };
      admitted.push(result); if (result.kind === 'draw') state.count++;
      return { kind: 'applied' };
    },
  };
  const session = createPaintSession(host);
  session.attachBrushPreview(frame => { frames.push(frame); });
  return { state, host, session, calls, admitted, waits, frames, depths, refs, eraseCaptures,
    planeReads: () => planeReads, writes: () => writes,
    frame: (): BrushPreviewFrame => { const frame = frames.at(-1); assert.ok(frame); return frame; },
    release: (): void => { for (const release of waits.splice(0)) release(); },
  };
}
type Harness = ReturnType<typeof harness>;
async function draw(h: Harness, input = start(), rest: readonly PointerSample[] = []): Promise<PaintStrokeResult> {
  const token = value(h.session.beginStroke(input));
  assert.equal(h.session.extendStroke(token, rest).kind, 'applied');
  assert.equal((await h.session.endStroke(token)).kind, 'applied');
  const result = h.calls.at(-1)?.result; assert.ok(result); return result;
}

test('start captures depth, revisions, seed and a single mapping; every later sample stays on that plane', async () => {
  const h = harness();
  h.state.plane = { ...h.state.plane, toPlane: at => ({ x: at.x / 2, y: at.y / 2 }) };
  const input = start(), token = value(h.session.beginStroke(input));
  h.state.attachment = { disparity: .9, depthSample: { x: 99, y: 100 } };
  h.state.plane = { ...h.state.plane, toPlane: at => ({ x: at.x * 10, y: at.y * 10 }) };
  h.state.settings = { brush: { ...brush, opacity: .1 }, brushRevision: 'brush@9', functionRevision: 'texture@9' };
  h.state.seed = 6; h.state.source = () => 0;
  assert.equal(h.session.extendStroke(token, [sample(40, 40, 1)]).kind, 'applied');
  assert.equal((await h.session.endStroke(token)).kind, 'applied');
  const result = h.calls[0]?.result; assert.ok(result);
  assert.deepEqual(result.capture, { owner: 'paint-owner', sceneGeneration: 1, viewGeneration: 2,
    brushRevision: 'brush@1', functionRevision: 'texture@1', seed: BRUSH_PREVIEW.seed,
    start: { x: 8, y: 8, pressure: .8 }, attachment: { disparity: .4, depthSample: { x: 4, y: 5 } }, plane: BRUSH_PREVIEW.plane });
  assert.equal(h.depths.length, 1); assert.equal(h.planeReads(), 1); assert.equal(h.refs.length, 1);
  assert.deepEqual(after(result)[0]?.brush, brush);
  const direct = value(beginPaintStroke({ kind: 'draw', id: 'reference', size: BRUSH_PREVIEW.size, capture: result.capture,
    brush, coverageSource: solidPaintCoverage, projectPatchCount: 0 }));
  value(direct.extend([{ x: 20, y: 20, pressure: 1 }]));
  const expected = value(direct.finish()); assert.ok(expected);
  assert.deepEqual(bytes(after(result)), bytes(after(expected)));
});

test('pen draws, finger defaults to navigation and draws only while explicitly enabled', async () => {
  const h = harness(), finger = start({ pointer: 'finger' });
  assert.deepEqual(h.session.beginStroke(finger), { ok: false, error: 'Turn on finger Draw to paint with a finger.' });
  assert.equal(h.depths.length, 0);
  await draw(h);
  h.session.setFingerDraw(true); await draw(h, finger);
  const token = value(h.session.beginStroke(finger)); h.session.setFingerDraw(false);
  assert.equal((await h.session.endStroke(token)).kind, 'cancelled');
  assert.equal(h.calls.length, 2);
});

test('finger pressure always uses full size; only pen pressure changes the diameter', async () => {
  const finger = harness(), pen = harness(), fallback = harness(); finger.session.setFingerDraw(true);
  const points = [sample(20, 16, .2), sample(30, 20, .5)];
  const fingerResult = await draw(finger, start({ pointer: 'finger', sample: sample(16, 16, .1) }), points);
  const penResult = await draw(pen, start({ sample: sample(16, 16, .1) }), points);
  const fallbackResult = await draw(fallback, start({ sample: sample(16, 16) }), points.map(point => ({ ...point, pressure: null })));
  assert.deepEqual(bytes(after(fingerResult)), bytes(after(fallbackResult)));
  assert.notDeepEqual(bytes(after(fingerResult)), bytes(after(penResult)));
});

test('availability and begin return identical real refusals for missing photo, unready depth and capture refusal', () => {
  for (const change of [
    (h: Harness) => { h.state.scene = null; },
    (h: Harness) => { h.state.scene = { owner: 'paint-owner', depthAvailable: false }; },
    (h: Harness) => { h.state.attachment = null; },
  ]) {
    const h = harness(); change(h);
    const availability = h.session.drawingAvailability(start()); assert.equal(availability.kind, 'unavailable');
    if (availability.kind !== 'unavailable') assert.fail();
    assert.deepEqual(h.session.beginStroke(start()), { ok: false, error: availability.reason });
    assert.equal('action' in availability, false);
    assert.equal(h.calls.length, 0);
  }
  assert.deepEqual(harness().session.drawingAvailability(), { kind: 'available' });
  const h = harness(), session = createPaintSession({ ...h.host,
    depthAt: () => { throw new Error('The captured view is not ready.'); } });
  assert.deepEqual(session.drawingAvailability(start()), { kind: 'unavailable', reason: 'The captured view is not ready.' });
  assert.deepEqual(session.beginStroke(start()), { ok: false, error: 'The captured view is not ready.' });
  assert.equal(h.calls.length, 0);
});

test('all batch partitions have identical immutable bytes, including pauses and pressure changes', async () => {
  const rest = [sample(20.4, 18.8, .3), sample(20.4, 18.8, .3), sample(35, 22, 1), sample(42, 29, null)];
  let reference: unknown;
  for (let partition = 0; partition < 8; partition++) {
    const h = harness(); h.state.source = (x, y, seed) => ((Math.floor(x) + Math.floor(y) + seed % 11) % 7) / 6;
    const token = value(h.session.beginStroke(start()));
    let batch: PointerSample[] = [];
    for (let i = 0; i < rest.length; i++) {
      const at = rest[i]; assert.ok(at); batch.push(at);
      if ((partition & (1 << i)) !== 0 || i === rest.length - 1) {
        assert.equal(h.session.extendStroke(token, batch).kind, 'applied'); batch = [];
        assert.equal(h.session.extendStroke(token, []).kind, 'applied');
      }
    }
    assert.equal((await h.session.endStroke(token)).kind, 'applied');
    const result = h.calls[0]?.result; assert.ok(result);
    if (partition === 0) reference = bytes(after(result)); else assert.deepEqual(bytes(after(result)), reference);
    assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.capture)); assert.ok(Object.isFrozen(result.changes));
    assert.equal((await h.session.endStroke(token)).kind, 'cancelled');
    assert.equal(h.session.extendStroke(token, [sample(80, 80)]).kind, 'cancelled');
    assert.equal(h.calls.length, 1);
  }
});

test('two rapid releases submit distinct immutable results once, even while the first commit waits', async () => {
  const h = harness(); h.state.defer = true;
  const first = value(h.session.beginStroke(start())), one = h.session.endStroke(first);
  const second = value(h.session.beginStroke(start({ sample: sample(50, 50) }))), two = h.session.endStroke(second);
  assert.equal(h.calls.length, 2); assert.notEqual(h.calls[0]?.result, h.calls[1]?.result);
  assert.notEqual(h.calls[0]?.result.changes[0]?.patchId, h.calls[1]?.result.changes[0]?.patchId);
  assert.ok(h.calls.every(call => call.guard.isCurrent()));
  assert.equal((await h.session.endStroke(first)).kind, 'cancelled');
  h.release(); assert.deepEqual(await Promise.all([one, two]), [{ kind: 'applied' }, { kind: 'applied' }]);
  assert.equal(h.admitted.length, 2);
});

const interruptions: readonly PaintInterruption[] = ['second-touch', 'lost-capture', 'context-loss', 'generation-change', 'tool-change'];
test('explicit cancellation and every interruption discard live work and reject every late token', async () => {
  for (const reason of [null, ...interruptions]) {
    const h = harness(), token = value(h.session.beginStroke(start()));
    h.session.extendStroke(token, [sample(40, 40)]);
    if (reason === null) h.session.cancelStroke(token);
    else h.session.interrupt(reason);
    assert.equal(h.session.extendStroke(token, [sample(80, 80)]).kind, 'cancelled');
    assert.equal((await h.session.endStroke(token)).kind, 'cancelled');
    assert.equal(h.calls.length, 0);
    const next = value(h.session.beginStroke(start()));
    h.session.cancelStroke(token); assert.equal(h.session.extendStroke(token, []).kind, 'cancelled');
    assert.equal((await h.session.endStroke(next)).kind, 'applied');
  }
});

test('cancellation invalidates pending commits, including isolated cancellation of one rapid stroke', async () => {
  for (const reason of interruptions) {
    const h = harness(); h.state.defer = true;
    const token = value(h.session.beginStroke(start())), ending = h.session.endStroke(token);
    h.session.interrupt(reason);
    assert.equal(h.calls[0]?.guard.signal.aborted, true);
    h.release(); assert.equal((await ending).kind, 'cancelled'); assert.equal(h.admitted.length, 0);
  }
  const h = harness(); h.state.defer = true;
  const first = value(h.session.beginStroke(start())), one = h.session.endStroke(first);
  const second = value(h.session.beginStroke(start())), two = h.session.endStroke(second);
  h.session.cancelStroke(first); h.release();
  assert.deepEqual(await Promise.all([one, two]), [{ kind: 'cancelled' }, { kind: 'applied' }]);
  assert.equal(h.admitted.length, 1);
});

test('scene, view and owner/tool epoch changes cancel without notification, including pending admission', async () => {
  for (const field of ['scene', 'view', 'owner'] satisfies (keyof PaintGenerations)[]) {
    for (const phase of ['extend', 'end', 'pending']) {
      const h = harness(); h.state.defer = true;
      const token = value(h.session.beginStroke(start()));
      const ending = phase === 'pending' ? h.session.endStroke(token) : null;
      h.state.generations[field]++;
      if (phase === 'extend') assert.equal(h.session.extendStroke(token, [sample(40, 40)]).kind, 'cancelled');
      h.release();
      assert.equal((await (ending ?? h.session.endStroke(token))).kind, 'cancelled');
      assert.equal(h.admitted.length, 0);
    }
  }
});

test('a second contact cancels the first stroke even when finger drawing is disabled', async () => {
  const h = harness(), token = value(h.session.beginStroke(start()));
  assert.equal(h.session.beginStroke(start({ pointer: 'finger' })).ok, false);
  assert.equal((await h.session.endStroke(token)).kind, 'cancelled'); assert.equal(h.calls.length, 0);
});

test('canonical pad uses real MRX1 texture and MRX2 pixels identical to scene playback', async () => {
  const h = harness(), presets = value(createMathPresets());
  const program = value(compileBrushCoverage(presets.texture, { grainSize: 3 }));
  const source: PaintCoverageSource = (x, y, seed) => value(evaluateBrushCoverage(program,
    { position: [x, y], seed, hold: 0, time: 0, pressure: 1, roundTip: 1, opacity: 1, ink: [1, 1, 1] })).texture;
  h.state.source = source; h.state.settings = { ...h.state.settings, brush: { ...brush, diameter: 4, pressure: 'off' } };
  assert.equal((await h.session.replayBrushPreview()).kind, 'applied');
  const pad = h.frame(); assert.equal(pad.patches.length, 1); assert.equal(h.calls.length, 0);
  const path = BRUSH_PREVIEW.path.map(at => sample(at.at.x * BRUSH_PREVIEW.size.width, at.at.y * BRUSH_PREVIEW.size.height, at.pressure));
  const [first, ...rest] = path; assert.ok(first);
  const result = await draw(h, start({ sample: first }), rest);
  assert.deepEqual(bytes(pad.patches), bytes(after(result)));
  assert.equal(pad.patches[0]?.capture.seed, result.capture.seed);
  assert.deepEqual(pad.patches[0]?.capture.plane, result.capture.plane);
  assert.ok(pad.patches.every(patch => patch.tiles.every(tile => tile.raster.format === 'rgba8-srgb-straight')));
  h.session.resetBrushPreview(); assert.equal(h.frame().patches.length, 0);
  assert.equal((await h.session.replayBrushPreview()).kind, 'applied');
  assert.deepEqual(bytes(h.frame().patches), bytes(pad.patches));
  assert.equal(h.calls.length, 1);
});

test('drawable pad is normalized, resettable and independent of scene depth and owner', async () => {
  const h = harness(); h.state.scene = null; h.state.attachment = null;
  const token = value(h.session.beginStroke(start({ surface: 'pad', sample: sample(.25, .5) })));
  assert.equal(h.session.extendStroke(token, [sample(.75, .5)]).kind, 'applied');
  assert.equal((await h.session.endStroke(token)).kind, 'applied');
  assert.equal(h.frame().patches[0]?.capture.start.x, 64);
  assert.equal(h.frame().patches[0]?.capture.start.y, 64);
  assert.equal(h.depths.length, 0); assert.equal(h.calls.length, 0);
  const next = value(h.session.beginStroke(start({ surface: 'pad', sample: sample(.5, .5) })));
  h.session.resetBrushPreview(); assert.equal((await h.session.endStroke(next)).kind, 'cancelled');
  assert.equal(h.frame().patches.length, 0);
  assert.equal(h.session.beginStroke(start({ surface: 'pad', sample: sample(1.01, .5) })).ok, false);
  assert.equal((await h.session.replayBrushPreview()).kind, 'applied'); assert.equal(h.frame().patches.length, 1);
  const frames = h.frames.length; h.session.attachBrushPreview(null); h.session.resetBrushPreview();
  assert.equal(h.frames.length, frames);
});

test('brush edits synchronously replay the pad as project state while live and completed scene ink stays pinned', async () => {
  const h = harness(), completed = await draw(h), old = bytes(after(completed));
  const token = value(h.session.beginStroke(start()));
  const change = h.session.setBrush({ ...brush, color: { l: .5, c: .1, h: 200 }, opacity: .2 });
  assert.equal(h.frame().patches[0]?.brush.opacity, .2); // Before awaiting setBrush.
  assert.equal((await change).kind, 'applied'); assert.equal(h.writes(), 1); assert.equal(h.calls.length, 1);
  assert.equal((await h.session.endStroke(token)).kind, 'applied');
  const captured = h.calls[1]?.result; assert.ok(captured);
  assert.deepEqual(after(captured)[0]?.brush, brush);
  assert.deepEqual(bytes(after(completed)), old);
  const future = await draw(h); assert.equal(after(future)[0]?.brush.opacity, .2);
});

test('function revision replay uses the new coverage without changing a captured scene stroke', async () => {
  const h = harness(), token = value(h.session.beginStroke(start()));
  h.state.source = () => .2; h.state.settings = { ...h.state.settings, functionRevision: 'texture@2' };
  await h.session.replayBrushPreview();
  assert.equal(h.frame().patches[0]?.capture.functionRevision, 'texture@2');
  assert.equal((await h.session.endStroke(token)).kind, 'applied');
  assert.equal(h.calls[0]?.result.capture.functionRevision, 'texture@1');
});

test('setBrush reports applied project state while preview failures remain separately inspectable', async () => {
  for (const brokenSink of [false, true]) {
    const h = harness();
    if (brokenSink) {
      let calls = 0;
      h.session.attachBrushPreview(() => { if (calls++ > 0) throw new Error('The pad canvas is unavailable.'); });
    } else h.state.source = () => NaN;
    assert.equal((await h.session.setBrush({ ...brush, opacity: .2 })).kind, 'applied');
    assert.equal(h.state.settings.brush.opacity, .2);
    assert.equal(h.session.brushPreviewStatus().kind, 'refused');
    assert.equal((await h.session.replayBrushPreview()).kind, 'refused');
    assert.equal(h.calls.length, 0);
  }
});

test('erasure captures plane maps and all active targets, producing one combined immutable commit', async () => {
  const h = harness(), first = await draw(h), second = await draw(h);
  const patches = [...after(first), ...after(second)], before = bytes(patches);
  h.state.targets = patches.map((patch, index) => ({ patch, toPatch: { offset: { x: index * 2, y: 0 }, scale: 1 } }));
  h.state.settings = { ...h.state.settings, brush: { operation: 'erase', diameter: 8, opacity: .5, pressure: 'off' } };
  const token = value(h.session.beginStroke(start()));
  h.state.targets = []; h.session.extendStroke(token, [sample(20, 16)]);
  assert.equal((await h.session.endStroke(token)).kind, 'applied');
  const erased = h.calls[2]?.result; assert.ok(erased);
  assert.equal(erased.kind, 'erase'); assert.equal(erased.changes.length, 2);
  assert.deepEqual(h.eraseCaptures[0], erased.capture);
  assert.deepEqual(bytes(patches), before);
  assert.ok(erased.changes.every(change => change.before?.capture.attachment.disparity === change.after?.capture.attachment.disparity));
});

test('canonical eraser replays against deterministic MRX2 backing, matching scene erasure exactly', async () => {
  const h = harness(); h.state.settings = { ...h.state.settings, brush: { operation: 'erase', diameter: 12, opacity: .7, pressure: 'off' } };
  await h.session.replayBrushPreview();
  const pad = h.frame(); assert.equal(pad.patches.length, 1); assert.equal(h.calls.length, 0);
  const backing = h.frames.find(frame => frame.patches[0]?.id === 'pad-backing'); assert.ok(backing?.patches[0]);
  const scene = harness(); scene.state.scene = { owner: 'brush-preview', depthAvailable: true };
  scene.state.count = 1; scene.state.targets = [{ patch: backing.patches[0], toPatch: { offset: { x: 0, y: 0 }, scale: 1 } }];
  scene.state.settings = h.state.settings;
  const [first, ...rest] = BRUSH_PREVIEW.path.map(at => sample(at.at.x * 256, at.at.y * 128, at.pressure)); assert.ok(first);
  const result = await draw(scene, start({ sample: first }), rest);
  assert.deepEqual(bytes(pad.patches), bytes(after(result)));
  await h.session.replayBrushPreview(); assert.deepEqual(bytes(h.frame().patches), bytes(pad.patches));
  h.session.resetBrushPreview(); assert.equal(h.frame().patches.length, 0);
});

test('tool changes, malformed samples, invalid textures, no-op strokes and patch caps do not leak commits', async () => {
  const h = harness();
  let token = value(h.session.beginStroke(start()));
  assert.equal(h.session.extendStroke(token, [sample(NaN, 20)]).kind, 'refused');
  assert.equal((await h.session.endStroke(token)).kind, 'cancelled');
  h.state.source = () => NaN; assert.equal(h.session.beginStroke(start()).ok, false);
  h.state.source = () => 0; token = value(h.session.beginStroke(start()));
  assert.equal((await h.session.endStroke(token)).kind, 'unchanged'); assert.equal(h.calls.length, 0);
  h.state.source = solidPaintCoverage; token = value(h.session.beginStroke(start()));
  h.state.count = 64; assert.equal((await h.session.endStroke(token)).kind, 'refused'); assert.equal(h.calls.length, 0);
  assert.equal(h.session.beginStroke(start()).ok, false);
  h.state.count = 0; token = value(h.session.beginStroke(start()));
  await h.session.setBrush({ operation: 'erase', diameter: 8, opacity: .5, pressure: 'off' });
  assert.equal((await h.session.endStroke(token)).kind, 'cancelled'); assert.equal(h.calls.length, 0);
});

test('async host refusal and rejection do not permit retrying a finished token', async () => {
  for (const commit of [
    async (): Promise<CommandResult> => ({ kind: 'refused', reason: 'Storage is full.' }),
    async (): Promise<CommandResult> => { throw new Error('Storage failed.'); },
  ]) {
    const h = harness(), session = createPaintSession({ ...h.host, commit });
    const token = value(session.beginStroke(start()));
    assert.equal((await session.endStroke(token)).kind, 'refused');
    assert.equal((await session.endStroke(token)).kind, 'cancelled');
  }
});

test('abort-aware asset work may reject without turning cancellation into a paint failure', async () => {
  const h = harness(), session = createPaintSession({ ...h.host, commit: (_result, guard) => new Promise((_resolve, reject) => {
    guard.signal.addEventListener('abort', () => { reject(new Error('Asset work was aborted.')); }, { once: true });
  }) });
  const token = value(session.beginStroke(start())), ending = session.endStroke(token);
  session.cancelStroke(token);
  assert.equal((await ending).kind, 'cancelled');
});
