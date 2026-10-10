import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialPolicy, nextWake, transition, type Policy, type PolicyEvent, type Stage } from '../src/session/policy.ts';
import { createProducts, productAsset } from '../src/session/products.ts';

function rig() {
  let state: Policy = initialPolicy();
  return {
    read: () => state,
    send(event: PolicyEvent, now = 0) { const result = transition(state, event, now); state = result.state; return result.effects; },
    start(now = 0) {
      this.send({ kind: 'models-ready' }, now);
      this.send({ kind: 'import' }, now);
      return this.send({ kind: 'scene-ready', generation: state.generation }, now);
    },
  };
}

test('replacement drops every stale stage, product, failure and done callback', () => {
  const r = rig(); r.start();
  const stale = r.read().generation;
  const replacement = r.send({ kind: 'import' }, 300);
  assert.deepEqual(replacement.map((effect) => effect.kind), ['cancel-heavy', 'release-decoder', 'drop-products']);
  const before = r.read();
  for (const event of [
    { kind: 'phase', stage: 'depth', phase: 'session', generation: stale },
    { kind: 'product', stage: 'depth', generation: stale },
    { kind: 'failed', stage: 'encode', reason: 'old failure', generation: stale },
    { kind: 'done', generation: stale, plateNeeded: true },
    { kind: 'scene-ready', generation: stale },
  ] satisfies PolicyEvent[]) {
    assert.deepEqual(r.send(event, 5000), []); assert.equal(r.read(), before);
  }
});

test('an import within two seconds starts at first start plus 2000 ms, with latest scene only', () => {
  const r = rig(); assert.deepEqual(r.start(100).map((e) => e.kind), ['start-import']);
  r.send({ kind: 'import' }, 300);
  assert.deepEqual(r.send({ kind: 'scene-ready', generation: 2 }, 600), []);
  assert.equal(nextWake(r.read()), 2100);
  assert.deepEqual(r.send({ kind: 'tick' }, 2099), []);
  assert.deepEqual(r.send({ kind: 'tick' }, 2100), [{ kind: 'start-import' }]);
  assert.equal(r.read().lastStart, 2100);
});

test('imports present before models are ready and start only after both prerequisites', () => {
  const r = rig(); r.send({ kind: 'import' });
  assert.deepEqual(r.send({ kind: 'scene-ready', generation: 1 }, 30), []);
  assert.equal(nextWake(r.read()), null);
  assert.deepEqual(r.send({ kind: 'models-ready' }, 4000), [{ kind: 'start-import' }]);
  assert.equal(r.read().lastStart, 4000);
});

test('a refused import clears pending work and cannot start later when models become ready', () => {
  const r = rig(); r.send({ kind: 'import' });
  r.send({ kind: 'import-failed', generation: 1 }, 100);
  assert.equal(r.read().pendingImport, false);
  assert.equal(r.read().sceneReady, false);
  assert.deepEqual(r.send({ kind: 'models-ready' }, 5000), []);
  assert.equal(nextWake(r.read()), null);
  r.send({ kind: 'import' }, 6000);
  assert.deepEqual(r.send({ kind: 'scene-ready', generation: 2 }, 6100), [{ kind: 'start-import' }]);
});

for (const [stage, timeout] of [['depth', 60_000], ['encode', 120_000], ['inpaint', 60_000]] satisfies [Stage, number][]) {
  test(`${stage} expires from session phase, cancels once and names the timed-out stage`, () => {
    const r = rig(); r.start();
    if (stage === 'inpaint') {
      r.send({ kind: 'done', generation: 1, plateNeeded: false });
      r.send({ kind: 'plate-request', generation: 1 });
      assert.equal(r.read().sequence, 'plate');
    }
    r.send({ kind: 'phase', generation: 1, stage, phase: 'session' }, 50);
    r.send({ kind: 'phase', generation: 1, stage, phase: 'session' }, 100);
    r.send({ kind: 'phase', generation: 1, stage, phase: 'infer' }, 200);
    assert.equal(nextWake(r.read()), 50 + timeout);
    assert.deepEqual(r.send({ kind: 'tick' }, 49 + timeout), []);
    assert.deepEqual(r.send({ kind: 'tick' }, 50 + timeout), [{ kind: 'cancel-heavy' }, { kind: 'status', text: `Analysis timed out at ${stage}` }]);
    assert.equal(r.read().sequence, 'idle');
    assert.deepEqual(r.send({ kind: 'done', generation: 1, plateNeeded: false }, timeout + 100), []);
    assert.deepEqual(r.send({ kind: 'tick' }, timeout + 200), []);
  });
}

test('product delivery clears only its own watchdog, and failure reports the real stage', () => {
  const r = rig(); r.start();
  r.send({ kind: 'phase', generation: 1, stage: 'encode', phase: 'session' }, 100);
  r.send({ kind: 'product', generation: 1, stage: 'depth' }, 150);
  assert.equal(nextWake(r.read()), 120100);
  r.send({ kind: 'product', generation: 1, stage: 'encode' }, 1000);
  assert.equal(nextWake(r.read()), null);
  assert.deepEqual(r.send({ kind: 'failed', generation: 1, stage: 'encode', reason: 'missing bytes' }, 1000), [{ kind: 'cancel-heavy' }, { kind: 'status', text: 'Analysis failed at encode: missing bytes' }]);
});

test('plate requests during import wait for done and coalesce; they never cancel analysis', () => {
  const r = rig(); r.start();
  for (let i = 0; i < 2; i++) assert.deepEqual(r.send({ kind: 'plate-request', generation: 1 }, 100 + i), [{ kind: 'status', text: 'preparing' }]);
  assert.equal(r.read().sequence, 'import');
  assert.deepEqual(r.send({ kind: 'done', generation: 1, plateNeeded: true }, 1000), [{ kind: 'start-plate' }]);
  assert.equal(r.read().sequence, 'plate');
  r.send({ kind: 'plate-request', generation: 1 }, 1001);
  assert.deepEqual(r.send({ kind: 'done', generation: 1, plateNeeded: false }, 2000), []);
  assert.equal(r.read().sequence, 'idle');
});

test('a queued plate is discarded if no longer needed; an obsolete plate reruns for the latest masks', () => {
  const r = rig(); r.start(); r.send({ kind: 'plate-request', generation: 1 });
  assert.deepEqual(r.send({ kind: 'done', generation: 1, plateNeeded: false }), []);
  assert.deepEqual(r.send({ kind: 'plate-request', generation: 1 }).map((e) => e.kind), ['status', 'start-plate']);
  assert.deepEqual(r.send({ kind: 'done', generation: 1, plateNeeded: true }), [{ kind: 'start-plate' }]);
});

test('a failed plate waits for an explicit new request before retrying', () => {
  const r = rig(); r.start(); r.send({ kind: 'done', generation: 1, plateNeeded: false });
  r.send({ kind: 'plate-request', generation: 1 });
  r.send({ kind: 'failed', generation: 1, stage: 'inpaint', reason: 'runtime failed' }, 100);
  assert.deepEqual(r.send({ kind: 'tick' }, 5000), []);
  assert.deepEqual(r.send({ kind: 'plate-request', generation: 1 }, 6000).map((e) => e.kind), ['status', 'start-plate']);
});

test('product ids hash actual view bytes and replacement clears every raster map', async () => {
  const backing = new Uint8Array([9, 1, 2, 3, 9]);
  const id = await productAsset(backing.subarray(1, 4));
  assert.equal(id, await productAsset(new Uint8Array([1, 2, 3])));
  assert.notEqual(id, await productAsset(backing));
  const p = createProducts();
  p.putDepth(id, { format: 'f32', size: { width: 1, height: 1 }, data: new Float32Array([0.5]) });
  p.putMask(id, { format: 'u8', size: { width: 1, height: 1 }, data: new Uint8Array([255]) });
  p.putPlate(id, { size: { width: 1, height: 1 }, data: new Uint8Array([1, 2, 3]) });
  const next = await productAsset(new Uint8Array([4, 5, 6]));
  p.putPlate(next, { size: { width: 1, height: 1 }, data: new Uint8Array([4, 5, 6]) });
  assert.equal(p.plates.size, 1); assert.equal(p.plates.has(id), false); assert.equal(p.plates.has(next), true);
  p.clear(); assert.deepEqual([p.depths.size, p.masks.size, p.plates.size], [0, 0, 0]);
});
