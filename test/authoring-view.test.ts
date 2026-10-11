import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitAuthoringView, panAuthoringView, reframeAuthoringView, sourceToView, viewToSource, zoomAuthoringView, type AuthoringLayout } from '../src/core/authoring-view.ts';
import { createSelection } from '../src/session/selection.ts';
import { fiveClusterDocument } from './fixtures/documents.ts';

const layout: AuthoringLayout = { source: { width: 400, height: 200 }, viewport: { x: 70, y: 30, width: 600, height: 600 }, dpr: 2 };
function close(actual: { x: number; y: number }, expected: { x: number; y: number }): void {
  assert.ok(Math.abs(actual.x - expected.x) < 1e-9, `x: ${actual.x} != ${expected.x}`);
  assert.ok(Math.abs(actual.y - expected.y) < 1e-9, `y: ${actual.y} != ${expected.y}`);
}

test('Fit inverts letterbox and client offset; DPR only affects backing-store coordinates', () => {
  const view = fitAuthoringView(layout);
  close(sourceToView(view, { x: .5, y: .5 }, 'css'), { x: 70.75, y: 180.75 });
  close(viewToSource(view, { kind: 'css', x: 370, y: 330 }), { x: 200, y: 100 });
  close(viewToSource(view, { kind: 'device', x: 600, y: 600 }), { x: 200, y: 100 });
  close(viewToSource(view, { kind: 'css', x: 70, y: 30 }), { x: 0, y: -100 });
  for (const dpr of [1, 1.25, 2, 3]) {
    const frame = fitAuthoringView({ ...layout, dpr });
    for (const at of [{ x: 0, y: 0 }, { x: .5, y: .5 }, { x: 399.5, y: 199.5 }, { x: -20, y: 500 }]) {
      for (const kind of ['css', 'device'] as const) close(viewToSource(frame, sourceToView(frame, at, kind)), at);
    }
  }
});

test('zoom clamps to 1-8 times Fit and preserves arbitrary pinch/numeric anchors under pan', () => {
  const view = panAuthoringView(fitAuthoringView(layout), { x: -45, y: 28 });
  for (const zoom of [-100, 1, 1.75, 4, 8, 100]) {
    for (const anchor of [{ kind: 'css', x: 221, y: 267 }, { kind: 'device', x: 302, y: 474 }] as const) {
      const next = zoomAuthoringView(view, zoom, anchor);
      close(viewToSource(next, anchor), viewToSource(view, anchor));
      assert.equal(next.zoom, Math.min(8, Math.max(1, zoom)));
      const point = { x: 13.5, y: 140.25 };
      close(viewToSource(next, sourceToView(next, point, 'css')), point);
    }
  }
  assert.throws(() => zoomAuthoringView(view, NaN, { kind: 'css', x: 1, y: 2 }));
  assert.throws(() => panAuthoringView(view, { x: Infinity, y: 2 }));
});

test('rotation layout preserves center source point and relative zoom; new extent resets Fit', () => {
  const landscape = { ...layout, viewport: { x: 0, y: 0, width: 1000, height: 500 } };
  const initial = panAuthoringView(zoomAuthoringView(fitAuthoringView(landscape), 3, { kind: 'css', x: 320, y: 200 }), { x: 25, y: -12 });
  const portrait = { ...layout, viewport: { x: 10, y: 50, width: 500, height: 1000 }, dpr: 3 };
  const next = reframeAuthoringView(initial, portrait);
  close(viewToSource(next, { kind: 'css', x: 260, y: 550 }), viewToSource(initial, { kind: 'css', x: 500, y: 250 }));
  assert.equal(next.zoom, 3);
  close(reframeAuthoringView(next, landscape).pan, initial.pan);
  const replaced = { ...portrait, source: { width: 100, height: 100 } };
  assert.deepEqual(reframeAuthoringView(next, replaced), fitAuthoringView(replaced));
});

test('session pinch, keyboard pan, numeric zoom and Fit leave document and live camera settings untouched', () => {
  const doc = fiveClusterDocument(), before = structuredClone(doc);
  let records = 0;
  const c = createSelection({ readOwner: () => ({ sceneGeneration: 1, editEpoch: 1, ownerGeneration: 1, size: layout.source }),
    record() { records++; return { kind: 'applied' }; }, changed() {} }, layout);
  const from = { kind: 'css', x: 220, y: 270 } as const, to = { kind: 'css', x: 250, y: 310 } as const;
  const anchored = c.navigation.toSource(from);
  assert.equal(c.navigation.pinch({ from, to, factor: 2 }).kind, 'applied');
  close(c.navigation.toSource(to), anchored);
  c.navigation.pan({ x: 10, y: 0 });
  c.navigation.zoom({ zoom: 5, anchor: to });
  const snapshot = c.navigation.snapshot();
  assert.equal(snapshot.zoom, 5);
  c.navigation.fit(); assert.deepEqual(c.navigation.snapshot(), fitAuthoringView(layout));
  assert.equal(c.navigation.pinch({ from, to, factor: 0 }).kind, 'refused');
  assert.equal(c.navigation.layout({ ...layout, dpr: 0 }).kind, 'refused');
  assert.equal(records, 0); assert.deepEqual(doc, before);
});
