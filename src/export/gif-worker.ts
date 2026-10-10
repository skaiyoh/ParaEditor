// Stub entry for the gif worker; its part replaces it. It answers every
// message with one stub reply, so a page can show the entry loads.
// Worker-global calls (self.postMessage, the message handler, self.close)
// live only in *-worker.ts entries (docs/ARCHITECTURE.md, "Type checking").

self.onmessage = () => {
  self.postMessage({ kind: 'stub', worker: 'gif', buildId: NOISY_BUILD_ID });
};
