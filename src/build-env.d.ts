// Compile-time constants that tools/build.mjs injects with esbuild's `define`
// into every entry, the dev pages and dev workers included; docs/ARCHITECTURE.md
// ("Build") documents them.
// tsconfig.test.json leaves this file out on purpose: node tests run sources
// without a build, so a module a node test reaches must not read these, and
// the test project's type check fails if one does.

/** '<commit>-<yyyymmdd>', or 'nocommit-<yyyymmdd>' for a tree with no commit. */
declare const NOISY_BUILD_ID: string;
/** True in a dev build, false in a production build. */
declare const NOISY_DEV: boolean;
/** URL directory of the vendored ONNX Runtime Web files, '/vendor/ort/<version>/', for `env.wasm.wasmPaths`. */
declare const NOISY_ORT_DIR: string;
/** models.lock.json as the build read it, unparsed; analysis/bundled-lock.ts parses it. */
declare const NOISY_MODEL_LOCK: unknown;
