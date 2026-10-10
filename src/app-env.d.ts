// Compile-time constant that tools/build.mjs injects into the app entry and the
// dev pages only, since the workers are built first; tsconfig.worker.json
// leaves it out.

/** Root-relative URLs of the four content-hashed worker bundles, for `new Worker(url, { type: 'module' })`. */
declare const NOISY_WORKER_URLS: {
  readonly sequence: string;
  readonly decode: string;
  readonly gif: string;
  readonly face: string;
};
