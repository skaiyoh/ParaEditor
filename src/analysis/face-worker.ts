import type { InferenceSession } from 'noisy:vendor-ort';
import { bundledLock } from './bundled-lock.ts';
import { checkFaceKnownAnswer, decodeFace, faceInput, FACE_SIZE } from './face-check.ts';
import { describeThrown, loadOrt, modelStore, observeSession, runSession, type OrtRuntime } from './ort-runtime.ts';
import { modelFileUrl } from './lock.ts';
import { oneLine, parseFaceRequest, type FaceReply, type FaceRequest } from './protocol.ts';

type State =
  | { kind: 'waiting' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; runtime: OrtRuntime; session: InferenceSession; canvas: OffscreenCanvas; context: OffscreenCanvasRenderingContext2D };
let state: State = { kind: 'waiting' };
const queue: FaceRequest[] = [];
let draining = false;
const post = (reply: FaceReply): void => self.postMessage(reply);
const fail = (jobId: number | null, message: string): void => post({ type: 'failed', jobId, message: oneLine(message) });

async function init(ortBase: string): Promise<void> {
  if (state.kind !== 'waiting') return;
  try {
    const lock = bundledLock(); if (!lock.ok) throw new Error(lock.error);
    const store = await modelStore({ lock: lock.value, subtle: crypto.subtle, caches, origin: self.location.origin });
    const runtime = await loadOrt({ ortBase, threads: 1, worker: 'face' }); if (!runtime.ok) throw new Error(runtime.error);
    // This old exporter lists weights as inputs, which ORT warns about.
    // They are valid initializers; keep graph warnings out of the page console.
    // env.logLevel does not suppress the native graph warnings. This single
    // graph needs a session log level that the shared createSession omits.
    const graph = lock.value.ops.face.files.find((file) => file.role === 'graph');
    if (graph === undefined) throw new Error('UltraFace graph missing from the lock.');
    const response = await store.caches.match(modelFileUrl(graph, store.origin), { cacheName: store.cacheName });
    if (response === undefined) throw new Error('UltraFace missing from the verified model cache.');
    const session = await runtime.value.ort.InferenceSession.create(new Uint8Array(await response.arrayBuffer()), {
      executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3,
    });
    observeSession(session);
    if (session.inputNames.join(',') !== 'input' || session.outputNames.join(',') !== 'scores,boxes') throw new Error('Unexpected UltraFace input/output names.');
    const warm = await runSession(session, { input: new runtime.value.ort.Tensor('float32', new Float32Array(3 * 240 * 320), [1, 3, 240, 320]) });
    if (!warm.ok) throw new Error(warm.error);
    const checked = checkFaceKnownAnswer(warm.value.outputs);
    if (!checked.ok || !checked.value.pass) throw new Error(checked.ok ? 'UltraFace known-answer check failed.' : checked.error);
    const canvas = new OffscreenCanvas(FACE_SIZE.width, FACE_SIZE.height);
    const context = canvas.getContext('2d', { willReadFrequently: true }); if (context === null) throw new Error('Face canvas unavailable.');
    state = { kind: 'ready', runtime: runtime.value, session, canvas, context };
    post({ type: 'ready' });
  } catch (error) { state = { kind: 'failed', message: describeThrown(error) }; fail(null, state.message); }
}

async function track(request: Extract<FaceRequest, { type: 'track' }>): Promise<void> {
  try {
    if (state.kind !== 'ready') throw new Error(state.kind === 'failed' ? state.message : 'Face tracker has not opened.');
    const { context, session, runtime } = state;
    context.drawImage(request.frame, 0, 0, FACE_SIZE.width, FACE_SIZE.height);
    const input = faceInput(context.getImageData(0, 0, FACE_SIZE.width, FACE_SIZE.height).data);
    const ran = await runSession(session, { input: new runtime.ort.Tensor('float32', input, [1, 3, 240, 320]) });
    if (!ran.ok) throw new Error(ran.error);
    const decoded = decodeFace(ran.value.outputs); if (!decoded.ok) throw new Error(decoded.error);
    post({ type: 'tracked', jobId: request.jobId, face: decoded.value });
  } catch (error) { fail(request.jobId, describeThrown(error)); }
  finally { request.frame.close(); }
}

async function drain(): Promise<void> {
  draining = true;
  try {
    for (let request = queue.shift(); request !== undefined; request = queue.shift()) {
      switch (request.type) {
        case 'init': await init(request.ortBase); break;
        case 'track': await track(request); break;
        default: { const exhaustive: never = request; return exhaustive; }
      }
    }
  } finally { draining = false; }
}
self.onmessage = (event: MessageEvent<unknown>) => {
  const parsed = parseFaceRequest(event.data);
  if (!parsed.ok) throw new Error(`The face worker cannot read a request: ${parsed.error.detail}`);
  queue.push(parsed.value); if (!draining) void drain();
};
self.onmessageerror = () => { throw new Error('The face worker could not deserialize a request.'); };
