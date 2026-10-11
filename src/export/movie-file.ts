import type { StreamTargetChunk } from 'mediabunny';

export const MOVIE_BYTE_LIMIT = 128 * 1024 * 1024;

/** A bounded movie file, including container header rewrites, without a growing ArrayBuffer copy. */
export function createMovieFile(limit = MOVIE_BYTE_LIMIT): {
  readonly stream: WritableStream<StreamTargetChunk>; readonly blob: (type: string) => Blob;
} {
  let contents = new Blob();
  return {
    stream: new WritableStream<StreamTargetChunk>({
      write({ position, data }) {
        const end = position + data.byteLength;
        if (!Number.isSafeInteger(position) || position < 0 || end > limit) {
          throw new Error('This movie needs too much memory; shorten the loop and try again.');
        }
        // Blob slices share their existing bytes; only this write is copied.
        const gap = position > contents.size ? new Uint8Array(position - contents.size) : new Uint8Array(0);
        contents = new Blob([contents.slice(0, position), gap, data, contents.slice(end)]);
      },
      abort() { contents = new Blob(); },
    }),
    blob: type => new Blob([contents], { type }),
  };
}
