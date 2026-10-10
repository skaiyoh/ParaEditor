// Compile-time constant that tools/build.mjs injects into the app entry and
// the dev pages; a production build defines it as an empty object.

/** Root-relative URLs of the dev workers, keyed by name: src/dev/<name>-worker.ts. */
declare const NOISY_DEV_WORKER_URLS: Readonly<Record<string, string>>;
