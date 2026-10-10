// src/dev/harness/ballast.ts: the fill and the page sum against an
// independent recomputation (test/support/ballast-reference.ts), byte for
// byte, at 1 MB and 100 MB chunks and at several chunk indexes, the stand-in's
// among them; the sum's stride; the throwAtMb lever at, just below, and just
// above a total, and an allocation the browser refuses; the heap growing by
// its new chunks only, keeping the buffers it made, truncated, stopped,
// thrown, and released; and the stand-in, whose check reads its buffer again.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BASE_SEED,
  chunkSeed,
  createHeap,
  createStandIn,
  fillChunk,
  leveredAllocator,
  MB,
  PAGE_BYTES,
  pageSum,
  STAND_IN_CHUNK,
  type AllocateChunk,
  type GrowHooks,
} from '../src/dev/harness/ballast.ts';
import { referenceChunk, referenceSum } from './support/ballast-reference.ts';

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

// ---------------------------------------------------------------------------
// the fill and the sum

test('a chunk seed is 0x9E3779B9 xor (index + 1), unsigned, and only a whole index of at least 0 has one', () => {
  assert.equal(BASE_SEED, 0x9e3779b9);
  assert.deepEqual([chunkSeed(0), chunkSeed(1), chunkSeed(7)], [0x9e3779b8, 0x9e3779bb, 0x9e3779b1]);
  assert.equal(chunkSeed(STAND_IN_CHUNK), (0x9e3779b9 ^ 1_000_001) >>> 0);
  for (const bad of [-1, 1.5, Number.NaN]) assert.throws(() => chunkSeed(bad), RangeError, String(bad));
});

test('a 1 MB chunk is filled byte for byte as the reference writes it, at indexes 0, 1, 7, 29, and the stand-in\'s, and its fill answers the page sum of what it wrote', () => {
  for (const index of [0, 1, 7, 29, STAND_IN_CHUNK]) {
    const bytes = new Uint8Array(MB);
    const sum = fillChunk(bytes, index);
    assert.ok(sameBytes(bytes, referenceChunk(index, MB)), `index ${index}: the bytes`);
    assert.equal(sum, referenceSum(index, MB), `index ${index}: the fill's sum`);
    assert.equal(pageSum(bytes), sum, `index ${index}: the sum read back`);
  }
});

test('a 100 MB chunk is filled byte for byte as the reference writes it, at indexes 0 and 39', () => {
  for (const index of [0, 39]) {
    const bytes = new Uint8Array(100 * MB);
    const sum = fillChunk(bytes, index);
    assert.ok(sameBytes(bytes, referenceChunk(index, 100 * MB)), `index ${index}: the bytes`);
    assert.equal(sum, referenceSum(index, 100 * MB), `index ${index}: the fill's sum`);
    assert.equal(pageSum(bytes), sum, `index ${index}: the sum read back`);
  }
});

test('the sums of chunk 0 at 1 MB and 100 MB hold their recorded values', () => {
  const sumOf = (mb: number): number => fillChunk(new Uint8Array(mb * MB), 0);
  assert.deepEqual([sumOf(1), sumOf(100)], [SUM_0_1MB, SUM_0_100MB]);
});

/** Chunk 0's sums, recorded from the reference's output when this suite was written. */
const SUM_0_1MB = 2_756_587_865;
const SUM_0_100MB = 3_639_291_752;

test('the page sum reads the first word of every 16 KB page and no other word', () => {
  const bytes = new Uint8Array(MB);
  const filled = fillChunk(bytes, 3);
  const words = new Uint32Array(bytes.buffer);
  const pageWords = PAGE_BYTES / 4;
  assert.equal(Math.ceil(words.length / pageWords), 62, 'a 1 MB chunk has 62 sampled words');
  words[1] = (words[1] ?? 0) ^ 0xffff_ffff;
  words[pageWords - 1] = 0;
  assert.equal(pageSum(bytes), filled, 'a word inside a page is not read');
  const before = words[3 * pageWords] ?? 0;
  words[3 * pageWords] = (before + 5) >>> 0;
  assert.equal(pageSum(bytes), (filled + 5) >>> 0, 'the first word of page 3 is read, and the sum wraps');
});

test('a buffer that is not whole 32-bit words cannot be filled or summed', () => {
  assert.throws(() => fillChunk(new Uint8Array(10), 0), RangeError);
  assert.throws(() => pageSum(new Uint8Array(new ArrayBuffer(16), 2, 8)), RangeError);
});

// ---------------------------------------------------------------------------
// the allocator

test('the throwAtMb lever refuses the allocation that would bring the total to it or past it, just below it allocates', () => {
  const sizes: number[] = [];
  const allocate = leveredAllocator((bytes) => {
    sizes.push(bytes);
    return new Uint8Array(0);
  }, 12);
  assert.equal(allocate(1, 11).ok, true, 'just below');
  for (const total of [12, 13]) {
    const thrown = allocate(1, total);
    assert.ok(!thrown.ok && thrown.error.atMb === total && thrown.error.message.includes('throwAtMb'), `total ${total}: ${JSON.stringify(thrown)}`);
  }
  assert.deepEqual(sizes, [MB], 'a refused allocation never reaches the browser');
  const hundred = leveredAllocator(() => new Uint8Array(0), 1_199);
  assert.deepEqual([hundred(100, 1_100).ok, hundred(100, 1_200).ok], [true, false], 'at 100 MB chunks, a lever just below a step refuses that step');
  const above = leveredAllocator(() => new Uint8Array(0), 1_201);
  assert.deepEqual([above(100, 1_200).ok, above(100, 1_300).ok], [true, false], 'just above a step, that step allocates and the next is refused');
  assert.equal(leveredAllocator(() => new Uint8Array(0), null)(100, 1_000_000).ok, true, 'with no lever nothing is refused');
});

test('an allocation the browser refuses answers the total it would have reached and the error\'s message', () => {
  const allocate = leveredAllocator(() => {
    throw new RangeError('Array buffer allocation failed');
  }, null);
  assert.deepEqual(allocate(100, 700), { ok: false, error: { atMb: 700, message: 'Array buffer allocation failed' } });
});

// ---------------------------------------------------------------------------
// the heap

/** A heap of `chunkMb` chunks whose every allocation is recorded, over a clock that advances 1 ms per read. */
function heapWorld(chunkMb: number, throwAtMb: number | null = null) {
  const buffers: Uint8Array[] = [];
  const allocate: AllocateChunk = leveredAllocator((bytes) => {
    const made = new Uint8Array(bytes);
    buffers.push(made);
    return made;
  }, throwAtMb);
  let ms = 0;
  let changes = 0;
  const heap = createHeap({ allocate, chunkMb, now: () => (ms += 1), onChange: () => (changes += 1) });
  const fills: number[] = [];
  const hooks = (stopAfter = Number.POSITIVE_INFINITY): GrowHooks => {
    let chunks = 0;
    return { onFill: (mb) => void fills.push(mb), between: async () => (chunks += 1) < stopAfter };
  };
  return { heap, buffers, fills, hooks, changes: () => changes };
}

const expectedPairs = (indexes: readonly number[], mb: number) => indexes.map((chunk) => ({ chunk, fill: referenceSum(chunk, mb * MB), after: referenceSum(chunk, mb * MB) }));

test('the heap grows by allocating and filling only its new chunks, reporting each total first, and keeps the buffers it made', async () => {
  const { heap, buffers, fills, hooks } = heapWorld(1);
  assert.deepEqual(await heap.growTo(3, hooks()), { ok: true, value: { added: 3, fillMs: 3 } });
  assert.deepEqual([fills, buffers.length, heap.mb, heap.chunks], [[1, 2, 3], 3, 3, 3]);
  const held = [...buffers];
  assert.deepEqual(await heap.growTo(4, hooks()), { ok: true, value: { added: 1, fillMs: 1 } });
  assert.deepEqual([fills, buffers.length, heap.mb], [[1, 2, 3, 4], 4, 4], 'the step to 4 allocated one chunk');
  assert.deepEqual(heap.check(), expectedPairs([0, 1, 2, 3], 1));
  assert.deepEqual(await heap.growTo(4, hooks()), { ok: true, value: { added: 0, fillMs: 0 } }, 'a heap at its size adds nothing');
  // The check reads the buffers the heap made, not copies: a word changed in the first one shows in its sum now.
  const first = new Uint32Array((held[0] ?? assert.fail()).buffer);
  first[0] = ((first[0] ?? 0) + 1) >>> 0;
  const pairs = heap.check();
  assert.deepEqual(pairs.map((p) => p.fill === p.after), [false, true, true, true]);
  assert.equal(pairs[0]?.after, ((pairs[0]?.fill ?? 0) + 1) >>> 0);
});

test('a heap of 100 MB chunks grows a chunk at a time, each step allocating 100,000,000 bytes, its sums the reference\'s', async () => {
  const { heap, buffers, hooks } = heapWorld(100);
  await heap.growTo(100, hooks());
  await heap.growTo(200, hooks());
  assert.deepEqual(buffers.map((b) => b.byteLength), [100 * MB, 100 * MB]);
  assert.deepEqual(heap.check(), expectedPairs([0, 1], 100));
  heap.release();
});

test('truncate drops the newest chunks, and growing again refills them with their own indexes', async () => {
  const { heap, buffers, hooks } = heapWorld(1);
  await heap.growTo(5, hooks());
  heap.truncate(2);
  assert.deepEqual([heap.mb, heap.chunks], [2, 2]);
  await heap.growTo(3, hooks());
  assert.equal(buffers.length, 6, 'one new chunk for the third');
  assert.deepEqual(heap.check(), expectedPairs([0, 1, 2], 1));
  heap.truncate(-1);
  assert.deepEqual([heap.mb, heap.chunks, heap.check()], [0, 0, []]);
});

test('a growth stops at the allocation that throws, holding the chunks before it, and when between answers false', async () => {
  const thrown = heapWorld(1, 3);
  const result = await thrown.heap.growTo(5, thrown.hooks());
  assert.deepEqual(result.ok ? null : result.error, { kind: 'throw', atMb: 3, message: 'the throwAtMb lever refuses the allocation that brings the total to 3 MB' });
  assert.deepEqual([thrown.fills, thrown.heap.mb], [[1, 2, 3], 2]);
  const stopped = heapWorld(1);
  assert.deepEqual(await stopped.heap.growTo(5, stopped.hooks(1)), { ok: false, error: { kind: 'stopped' } });
  assert.deepEqual([stopped.fills, stopped.heap.mb], [[1], 1]);
});

test('a growth to a size the chunk does not divide makes its last chunk smaller', async () => {
  const { heap, buffers, fills, hooks } = heapWorld(3);
  await heap.growTo(7, hooks());
  assert.deepEqual([fills, buffers.map((b) => b.byteLength / MB)], [[3, 6, 7], [3, 3, 1]]);
});

test('release drops every chunk and reports the change once; a heap with nothing reports nothing', async () => {
  const { heap, hooks, changes } = heapWorld(1);
  await heap.growTo(2, hooks());
  const before = changes();
  heap.release();
  heap.release();
  assert.deepEqual([heap.mb, heap.chunks, changes() - before], [0, 0, 1]);
  assert.throws(() => createHeap({ allocate: leveredAllocator(() => new Uint8Array(0), null), chunkMb: 0, now: () => 0 }), RangeError);
});

// ---------------------------------------------------------------------------
// the stand-in

test('the stand-in is one filled chunk at its own index, summed when asked, and the throwAtMb lever refuses it like any chunk', () => {
  const made = createStandIn(leveredAllocator((bytes) => new Uint8Array(bytes), null), 1);
  assert.ok(made.ok);
  const sum = referenceSum(STAND_IN_CHUNK, MB);
  assert.deepEqual([made.value.mb, made.value.check()], [1, { chunk: STAND_IN_CHUNK, fill: sum, after: sum }]);
  assert.notEqual(sum, referenceSum(0, MB), 'its words are not ballast chunk 0\'s');
  assert.deepEqual(createStandIn(leveredAllocator((bytes) => new Uint8Array(bytes), 1), 1), { ok: false, error: { atMb: 1, message: 'the throwAtMb lever refuses the allocation that brings the total to 1 MB' } });
});

test('the stand-in\'s check reads its buffer now: a word changed on a later page shows in its sum, and its sum when filled stays', () => {
  const made: Uint8Array[] = [];
  const standIn = createStandIn(
    leveredAllocator((bytes) => {
      const bytesMade = new Uint8Array(bytes);
      made.push(bytesMade);
      return bytesMade;
    }, null),
    1,
  );
  assert.ok(standIn.ok);
  const words = new Uint32Array((made[0] ?? assert.fail()).buffer);
  const sum = referenceSum(STAND_IN_CHUNK, MB);
  // The first word of the third 16 KB page, which only a check that reads the pages again can see.
  const at = 2 * (PAGE_BYTES / 4);
  words[at] = ((words[at] ?? 0) + 5) >>> 0;
  assert.deepEqual(standIn.value.check(), { chunk: STAND_IN_CHUNK, fill: sum, after: (sum + 5) >>> 0 });
});
