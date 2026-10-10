// The memory harness's inputs: the synth scene's master, read as raw RGBA
// bytes from the dev server's synth route rather than painted in the page,
// so every engine runs on the bytes node paints; a fresh bitmap of a master
// each time a run's stage asks for one; and the holes the inpainting model
// is handed (holes.ts). A master is fetched the first time its size is asked
// for and kept until it is released; a fetch that fails keeps nothing, so the
// next attempt fetches again. No browser global is read here: the fetch and
// the bitmap maker arrive in the deps.

import type { Plane, Size } from '../../core/raster.ts';
import { err, ok, type Result } from '../../core/result.ts';
import type { Clock } from '../../platform/clock.ts';
import { holePlane, type HoleShape } from './holes.ts';

/** A master fetch that has not answered by then fails, so a stalled server leaves the step blocked rather than hanging. */
export const INPUT_TIMEOUT_MS = 60_000;

/** The part of a response the inputs read; the browser's Response is one. */
export type InputResponse = { readonly ok: boolean; readonly status: number; arrayBuffer(): Promise<ArrayBuffer> };

/** The page's fetch, called unbound; `window.fetch` is one. */
export type InputFetch = (url: string, init: { readonly signal: AbortSignal; readonly cache: 'no-store' }) => Promise<InputResponse>;

/** Makes a bitmap of `rgba`, four bytes a pixel at `size`; the page's is `createImageBitmap(new ImageData(rgba, width, height))`. */
export type MakeBitmap = (rgba: Uint8ClampedArray<ArrayBuffer>, size: Size) => Promise<ImageBitmap>;

/** A master the page holds: its size, and a fresh bitmap of it for each call. */
export type Master = { readonly size: Size; readonly bitmap: () => Promise<ImageBitmap> };

export interface Inputs {
  /** The master at `size`, fetched the first time it is asked for and kept until `release()`; or why it did not arrive. */
  master(size: Size, signal: AbortSignal): Promise<Result<Master, string>>;
  /** The hole of `shape` at `size`, made the first time it is asked for and kept. */
  hole(shape: HoleShape, size: Size): Plane<'u8'>;
  /** The bytes of every master and hole kept. */
  readonly bytes: number;
  /** Drops every master and hole kept. */
  release(): void;
}

export type InputsDeps = {
  readonly fetch: InputFetch;
  readonly makeBitmap: MakeBitmap;
  readonly clock: Pick<Clock, 'setTimeout' | 'clearTimeout'>;
};

/** The synth route's URL for the master at `size`. */
export function masterUrl(size: Size): string {
  return `/dev/synth/master?width=${size.width}&height=${size.height}`;
}

const sizeKey = (size: Size): string => `${size.width}x${size.height}`;
const errorText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

export function createInputs(deps: InputsDeps): Inputs {
  const masters = new Map<string, Uint8ClampedArray<ArrayBuffer>>();
  const holes = new Map<string, Plane<'u8'>>();

  const masterOf = (size: Size, rgba: Uint8ClampedArray<ArrayBuffer>): Master => ({ size, bitmap: () => deps.makeBitmap(rgba, size) });

  /** The route's bytes for `size`, checked to be the master's length; the fetch is aborted by `signal` or after the timeout. */
  const fetchMaster = async (size: Size, signal: AbortSignal): Promise<Result<Uint8ClampedArray<ArrayBuffer>, string>> => {
    const what = `the ${size.width} x ${size.height} master`;
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    if (signal.aborted) return err(`${what} was not fetched: the step was stopped`);
    signal.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = deps.clock.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, INPUT_TIMEOUT_MS);
    try {
      const response = await deps.fetch(masterUrl(size), { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) return err(`${what} could not be fetched: the server answered ${response.status}`);
      const buffer = await response.arrayBuffer();
      const expected = size.width * size.height * 4;
      if (buffer.byteLength !== expected) return err(`${what} could not be fetched: it held ${buffer.byteLength} bytes, not ${expected}`);
      return ok(new Uint8ClampedArray(buffer));
    } catch (e) {
      if (timedOut) return err(`${what} could not be fetched: no answer within ${INPUT_TIMEOUT_MS} ms`);
      return err(`${what} could not be fetched: ${errorText(e)}`);
    } finally {
      deps.clock.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  };

  return {
    async master(size, signal) {
      const key = sizeKey(size);
      const kept = masters.get(key);
      if (kept !== undefined) return ok(masterOf(size, kept));
      const fetched = await fetchMaster(size, signal);
      if (!fetched.ok) return fetched;
      masters.set(key, fetched.value);
      return ok(masterOf(size, fetched.value));
    },

    hole(shape, size) {
      const key = `${shape} ${sizeKey(size)}`;
      const kept = holes.get(key);
      if (kept !== undefined) return kept;
      const plane = holePlane(shape, size);
      holes.set(key, plane);
      return plane;
    },

    get bytes() {
      let total = 0;
      for (const rgba of masters.values()) total += rgba.byteLength;
      for (const plane of holes.values()) total += plane.data.byteLength;
      return total;
    },

    release() {
      masters.clear();
      holes.clear();
    },
  };
}
