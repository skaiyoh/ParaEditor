import test from 'node:test';
import assert from 'node:assert/strict';
import { loopTapPoint } from '../src/session/loop.ts';
import { loopZoom, parallaxMargin } from '../src/core/motion.ts';
import { frameAtElapsed, wrapFrame } from '../src/render/loop.ts';
import { createMovieFile } from '../src/export/movie-file.ts';

test('movie file applies container rewrites and refuses bytes beyond its memory limit', async () => {
  const file = createMovieFile(8), writer = file.stream.getWriter();
  const write = (position: number, bytes: number[]) => writer.write({ type: 'write', position, data: new Uint8Array(bytes) });
  await write(0, [1, 2, 3]);
  await write(5, [6, 7, 8]);
  await write(1, [9, 10]);
  const before = file.blob('video/webm');
  assert.equal(before.type, 'video/webm');
  assert.deepEqual([...new Uint8Array(await before.arrayBuffer())], [1, 9, 10, 0, 0, 6, 7, 8]);
  await assert.rejects(write(8, [9]), /too much memory/);
  assert.equal(file.blob('video/webm').size, 8);
});

test('canceling a movie file releases retained movie bytes', async () => {
  const file = createMovieFile(), writer = file.stream.getWriter();
  await writer.write({ type: 'write', position: 0, data: new Uint8Array([1, 2, 3]) });
  await writer.abort();
  assert.equal(file.blob('video/webm').size, 0);
});

test('30 fps frame stepper boundaries, skipped callbacks and exact wrap', () => {
  assert.equal(frameAtElapsed(0, 30), 0);
  assert.equal(frameAtElapsed(34, 30), 1);
  assert.equal(frameAtElapsed(999, 30), 29);
  assert.equal(frameAtElapsed(1000, 30), 0);
  assert.ok(frameAtElapsed(240, 30) - frameAtElapsed(34, 30) > 1);
  assert.equal(frameAtElapsed(3000, 90), 0);
  assert.equal(wrapFrame(90, 90), 0);
  assert.equal(wrapFrame(-1, 90), 89);
  assert.throws(() => frameAtElapsed(-1, 30), RangeError);
  assert.throws(() => wrapFrame(1, 0), RangeError);
});

test('loop taps undo center zoom for the center and both corners', () => {
  for (const parallax of [.5, 1, 2, 3]) {
    const zoom = loopZoom(parallax), margin = parallaxMargin(parallax);
    assert.deepEqual(loopTapPoint({ x: .5, y: .5 }, zoom), { x: .5, y: .5 });
    const near = loopTapPoint({ x: 0, y: 0 }, zoom), far = loopTapPoint({ x: 1, y: 1 }, zoom);
    for (const value of [near.x, near.y]) assert.ok(Math.abs(value - margin) < 1e-12);
    for (const value of [far.x, far.y]) assert.ok(Math.abs(value - (1 - margin)) < 1e-12);
    // A stored corner projects outward by the document's zoom; its inverse lands back
    // on the corner. A screen corner instead samples the cropped frame inset.
    const projectedCorner = .5 - .5 * zoom;
    assert.deepEqual(loopTapPoint({ x: projectedCorner, y: projectedCorner }, zoom), { x: 0, y: 0 });
  }
});
