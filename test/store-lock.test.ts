// src/store/lock.ts, the scene lock, on Node's own Web Locks implementation
// (navigator.locks): a held scene asked for again from the same context and
// from a worker thread, which shares the process's locks as another tab
// shares the origin's, is refused at once without queueing; the lock is held
// for exactly fn's lifetime and released when fn resolves, rejects, or
// throws. The browser scenarios in test/browser/scenarios/store.scenario.ts
// ask from a page and a same-origin frame in Chrome.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { isSceneId, type SceneId } from '../src/core/ids.ts';
import { err, ok } from '../src/core/result.ts';
import { createSceneLock, sceneLockName, type WithSceneLock } from '../src/store/lock.ts';

function sceneId(text: string): SceneId {
  if (!isSceneId(text)) throw new Error(`not a scene id: ${text}`);
  return text;
}

const SCENE = sceneId('3f0c1a52-8d4e-4b7a-9c61-0e2f5d7a8b90');
const OTHER = sceneId('9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d');

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (e: unknown) => void } {
  let resolve: (value: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const withSceneLock: WithSceneLock = createSceneLock(navigator.locks);

/** The scene's held and pending requests, as the lock manager lists them. */
async function snapshot(id: SceneId): Promise<{ held: number; pending: number }> {
  const state = await navigator.locks.query();
  const name = sceneLockName(id);
  return { held: (state.held ?? []).filter((l) => l.name === name).length, pending: (state.pending ?? []).filter((l) => l.name === name).length };
}

/** Holds the scene's lock until the returned release is called; resolves once fn is running. */
async function hold(id: SceneId): Promise<{ readonly release: () => void; readonly fail: (e: unknown) => void; readonly done: Promise<unknown> }> {
  const entered = deferred<void>();
  const until = deferred<string>();
  const done = withSceneLock(id, () => {
    entered.resolve();
    return until.promise;
  });
  await entered.promise;
  return { release: () => until.resolve('released'), fail: until.reject, done };
}

/** Asks for the scene's lock from a worker thread and answers what it got and how long that took. */
function askFromWorker(id: SceneId): Promise<{ outcome: string; ms: number }> {
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    const started = performance.now();
    navigator.locks.request(workerData.name, { ifAvailable: true }, (lock) => (lock === null ? 'open-elsewhere' : 'granted'))
      .then((outcome) => parentPort.postMessage({ outcome, ms: performance.now() - started }));
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData: { name: sceneLockName(id) } });
    worker.once('message', (m: { outcome: string; ms: number }) => {
      resolve(m);
      void worker.terminate();
    });
    worker.once('error', reject);
  });
}

test('the lock name is noisy-scene-<id>', () => {
  assert.equal(sceneLockName(SCENE), 'noisy-scene-3f0c1a52-8d4e-4b7a-9c61-0e2f5d7a8b90');
});

test('a free scene runs fn under its lock and answers its value; the lock is gone afterwards', async () => {
  let during: { held: number; pending: number } | null = null;
  const result = await withSceneLock(SCENE, async () => {
    during = await snapshot(SCENE);
    return 42;
  });
  assert.deepEqual(result, ok(42));
  assert.deepEqual(during, { held: 1, pending: 0 });
  assert.deepEqual(await snapshot(SCENE), { held: 0, pending: 0 });
});

test('a held scene asked for again from the same context: open-elsewhere at once, fn not run, nothing queued', async () => {
  const holder = await hold(SCENE);
  let ran = false;
  const started = performance.now();
  const second = await withSceneLock(SCENE, async () => {
    ran = true;
    return 'second';
  });
  const ms = performance.now() - started;
  assert.deepEqual(second, err({ kind: 'open-elsewhere' }));
  assert.equal(ran, false);
  assert.ok(ms < 500, `answered in ${ms} ms`);
  assert.deepEqual(await snapshot(SCENE), { held: 1, pending: 0 });
  assert.deepEqual(await withSceneLock(OTHER, async () => 'other'), ok('other'), 'another scene is not held');
  holder.release();
  assert.deepEqual(await holder.done, ok('released'));
  assert.deepEqual(await withSceneLock(SCENE, async () => 'after'), ok('after'), 'granted once released');
});

test('a held scene asked for from another context (a worker thread): open-elsewhere at once, then granted after release', async () => {
  const holder = await hold(SCENE);
  const refused = await askFromWorker(SCENE);
  assert.equal(refused.outcome, 'open-elsewhere');
  assert.ok(refused.ms < 500, `answered in ${refused.ms} ms`);
  assert.deepEqual(await snapshot(SCENE), { held: 1, pending: 0 });
  holder.release();
  await holder.done;
  assert.equal((await askFromWorker(SCENE)).outcome, 'granted');
});

test('the lock is held until fn settles, not until it is called: still held while fn awaits', async () => {
  const holder = await hold(SCENE);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(await withSceneLock(SCENE, async () => 'x'), err({ kind: 'open-elsewhere' }));
  holder.release();
  await holder.done;
});

test('fn rejecting releases the lock and rejects with its error', async () => {
  const holder = await hold(SCENE);
  const failure = new Error('fn failed');
  holder.fail(failure);
  await assert.rejects(holder.done, (e) => e === failure);
  assert.deepEqual(await snapshot(SCENE), { held: 0, pending: 0 });
  assert.deepEqual(await withSceneLock(SCENE, async () => 'after'), ok('after'));
});

test('fn throwing synchronously releases the lock and rejects with its error', async () => {
  const failure = new Error('thrown');
  await assert.rejects(
    withSceneLock(SCENE, () => {
      throw failure;
    }),
    (e) => e === failure,
  );
  assert.deepEqual(await snapshot(SCENE), { held: 0, pending: 0 });
  assert.deepEqual(await withSceneLock(SCENE, async () => 'after'), ok('after'));
});

test('a refusal from inside fn: the holder asking again for its own scene is refused too', async () => {
  const inner = await withSceneLock(SCENE, async () => withSceneLock(SCENE, async () => 'inner'));
  assert.deepEqual(inner, ok(err({ kind: 'open-elsewhere' })));
});
