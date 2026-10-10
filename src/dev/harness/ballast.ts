// The memory harness's ballast: buffers on the page's main thread, each
// allocated once through the allocator below and filled in place with seeded
// xorshift32 words, so its content is incompressible and its checksum is a
// pure function of its chunk index and size that node recomputes. The
// checksum is the 32-bit wrapping sum of the first word of every 16 KB page:
// taking it reads one word per 16 KB, which touches every page of a host whose pages are
// 16 KB, so a sum that still matches after a run shows those pages were
// touched after the run and still held what was written.
//
// A heap is the kill-point ladder's ballast: it grows by allocating and
// filling only its new chunks, keeps every chunk it made as it was made, and
// never copies one. The stand-in is one filled chunk a model row holds
// beside its runs. Every allocation goes through `leveredAllocator`, the one
// place the throwAtMb lever acts. No browser global is read here.

import { err, ok, type Result } from '../../core/result.ts';
import type { ChecksumPair } from './rows.ts';

/** MB in the harness is 10^6 bytes. */
export const MB = 1_000_000;

/** The page size the checksum samples at: one word per 16 KB. */
export const PAGE_BYTES = 16_384;
const PAGE_WORDS = PAGE_BYTES / Uint32Array.BYTES_PER_ELEMENT;

/** The fill's base seed; chunk `i` starts from `BASE_SEED ^ (i + 1)`. */
export const BASE_SEED = 0x9e3779b9;

/** The stand-in's chunk index, so its words differ from every ballast chunk's: no ladder reaches a million chunks. */
export const STAND_IN_CHUNK = 1_000_000;

/** The seed chunk `chunkIndex` is filled from, as an unsigned 32-bit number. */
export function chunkSeed(chunkIndex: number): number {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) throw new RangeError(`a chunk index is a whole number of at least 0, not ${chunkIndex}`);
  return (BASE_SEED ^ (chunkIndex + 1)) >>> 0;
}

/** `bytes` as 32-bit words; a buffer that is not whole words cannot be filled or summed. */
function wordsOf(bytes: Uint8Array): Uint32Array {
  if (bytes.byteLength % 4 !== 0 || bytes.byteOffset % 4 !== 0) {
    throw new RangeError(`a chunk is whole 32-bit words: ${bytes.byteLength} bytes at offset ${bytes.byteOffset}`);
  }
  return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/**
 * Fills `bytes` in place with chunk `chunkIndex`'s words, each the next
 * xorshift32 state (`x ^= x << 13; x ^= x >>> 17; x ^= x << 5`, unsigned)
 * from the chunk's seed, and answers the page sum of what it wrote.
 */
export function fillChunk(bytes: Uint8Array, chunkIndex: number): number {
  const words = wordsOf(bytes);
  let x = chunkSeed(chunkIndex);
  let sum = 0;
  for (let page = 0; page < words.length; page += PAGE_WORDS) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    words[page] = x;
    sum = (sum + x) >>> 0;
    const end = Math.min(page + PAGE_WORDS, words.length);
    for (let i = page + 1; i < end; i += 1) {
      x ^= x << 13;
      x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      words[i] = x;
    }
  }
  return sum;
}

/** The 32-bit wrapping sum of the first word of every 16 KB page of `bytes`. */
export function pageSum(bytes: Uint8Array): number {
  const words = wordsOf(bytes);
  let sum = 0;
  for (let i = 0; i < words.length; i += PAGE_WORDS) sum = (sum + (words[i] ?? 0)) >>> 0;
  return sum;
}

// ---------------------------------------------------------------------------
// the allocator

/** Allocates a zeroed buffer of `bytes`; the page's is `(bytes) => new Uint8Array(bytes)`. */
export type Allocate = (bytes: number) => Uint8Array;

/** An allocation that threw: the total it would have brought its ballast to, and the error's message. */
export type Thrown = { readonly atMb: number; readonly message: string };

/** Allocates a buffer of `mb` that brings its ballast to `totalMb`, or answers why it threw. */
export type AllocateChunk = (mb: number, totalMb: number) => Result<Uint8Array, Thrown>;

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The allocator every buffer the runner holds is made through: `allocate`, except
 * that with the throwAtMb lever set, the allocation that would bring its
 * ballast to that total or past it throws first, as an allocation the
 * browser refuses does. Either throw answers the total it would have reached.
 */
export function leveredAllocator(allocate: Allocate, throwAtMb: number | null): AllocateChunk {
  return (mb, totalMb) => {
    try {
      if (throwAtMb !== null && totalMb >= throwAtMb) {
        throw new RangeError(`the throwAtMb lever refuses the allocation that brings the total to ${totalMb} MB`);
      }
      return ok(allocate(mb * MB));
    } catch (e) {
      return err({ atMb: totalMb, message: errorText(e) });
    }
  };
}

// ---------------------------------------------------------------------------
// the heap

/** One chunk the heap holds: its index, its buffer, its size, and its page sum when filled. */
type Chunk = { readonly index: number; readonly bytes: Uint8Array; readonly mb: number; readonly fill: number };

/** What a growth added: its new chunks, and the time allocating and filling them took. */
export type Grown = { readonly added: number; readonly fillMs: number };

/** Why a growth stopped short: an allocation threw, or `between` answered false. */
export type GrowStop = ({ readonly kind: 'throw' } & Thrown) | { readonly kind: 'stopped' };

export type GrowHooks = {
  /** Called before each new chunk is allocated, with the total that chunk brings the heap to. */
  readonly onFill: (totalMb: number) => void;
  /** Awaited after each new chunk, so the page's other tasks run; false stops the growth there. */
  readonly between: () => Promise<boolean>;
};

export interface BallastHeap {
  /** The size of each chunk; the last one made by a growth is smaller when the chunk size does not divide its target. */
  readonly chunkMb: number;
  readonly mb: number;
  readonly chunks: number;
  /**
   * Allocates and fills new chunks, each with the next index, until the heap
   * holds `mb`; the chunks it holds already are left as they are. A heap
   * holding `mb` or more adds nothing.
   */
  growTo(mb: number, hooks: GrowHooks): Promise<Result<Grown, GrowStop>>;
  /** Drops the newest chunks until the heap holds at most `mb`. */
  truncate(mb: number): void;
  /** Sums every chunk now: each one's index, its sum when filled, and its sum now. */
  check(): readonly ChecksumPair[];
  /** Drops every chunk. */
  release(): void;
}

export type HeapDeps = {
  readonly allocate: AllocateChunk;
  readonly chunkMb: number;
  /** A monotonic clock in ms, for the fill time. */
  readonly now: () => number;
  /** Called whenever what the heap holds changes. */
  readonly onChange?: () => void;
};

export function createHeap(deps: HeapDeps): BallastHeap {
  const { allocate, chunkMb, now } = deps;
  if (!Number.isSafeInteger(chunkMb) || chunkMb < 1) throw new RangeError(`a chunk is a whole number of MB of at least 1, not ${chunkMb}`);
  let chunks: Chunk[] = [];
  let total = 0;
  const changed = (): void => {
    try {
      deps.onChange?.();
    } catch {
      // A listener's failure is not the heap's.
    }
  };

  return {
    chunkMb,
    get mb() {
      return total;
    },
    get chunks() {
      return chunks.length;
    },

    async growTo(mb, hooks) {
      let added = 0;
      let fillMs = 0;
      while (total < mb) {
        const size = Math.min(chunkMb, mb - total);
        hooks.onFill(total + size);
        const started = now();
        const made = allocate(size, total + size);
        if (!made.ok) return err({ kind: 'throw', ...made.error });
        const index = chunks.length;
        const fill = fillChunk(made.value, index);
        fillMs += now() - started;
        chunks.push({ index, bytes: made.value, mb: size, fill });
        total += size;
        added += 1;
        changed();
        if (!(await hooks.between())) return err({ kind: 'stopped' });
      }
      return ok({ added, fillMs });
    },

    truncate(mb) {
      const before = chunks.length;
      while (total > mb) {
        const last = chunks.pop();
        if (last === undefined) break;
        total -= last.mb;
      }
      if (chunks.length !== before) changed();
    },

    check() {
      return chunks.map((chunk) => ({ chunk: chunk.index, fill: chunk.fill, after: pageSum(chunk.bytes) }));
    },

    release() {
      if (chunks.length === 0) return;
      chunks = [];
      total = 0;
      changed();
    },
  };
}

// ---------------------------------------------------------------------------
// the stand-in

/** One filled chunk a model row holds beside its runs, summed after each; dropping it releases it. */
export type StandIn = {
  readonly mb: number;
  /** Its index, its sum when filled, and its sum now. */
  check(): ChecksumPair;
};

/** Allocates and fills the stand-in of `mb`, chunk `STAND_IN_CHUNK`, through `allocate`, which may throw. */
export function createStandIn(allocate: AllocateChunk, mb: number): Result<StandIn, Thrown> {
  const made = allocate(mb, mb);
  if (!made.ok) return made;
  const bytes = made.value;
  const fill = fillChunk(bytes, STAND_IN_CHUNK);
  return ok({ mb, check: () => ({ chunk: STAND_IN_CHUNK, fill, after: pageSum(bytes) }) });
}
