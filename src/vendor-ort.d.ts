// The vendored ONNX Runtime Web entry. tools/build.mjs rewrites this specifier
// to an external import of '/vendor/ort/<version>/ort.wasm.min.mjs', the
// pinned package's own file served from noisy's origin; its API is the
// package's, so its types are the package's.

declare module 'noisy:vendor-ort' {
  export * from 'onnxruntime-web';
}
