import { createWindowSource } from '../../../src/session/window.ts';
import { hex, lockHash, modelCacheNames, modelFileUrl, parseLock } from '../../../src/analysis/lock.ts';
import { parseFaceReply } from '../../../src/analysis/protocol.ts';

const IO_TIMEOUT_MS = 15_000;
const PERMISSION_TIMEOUT_MS = 45_000;
const STALE_SAMPLE_MS = 600;

function aborted() { return new DOMException('Camera tracking stopped.', 'AbortError'); }
function assertActive(signal) { if (signal.aborted) throw signal.reason ?? aborted(); }
function describe(error) { return error instanceof Error ? error.message : String(error); }

/** Stop waiting immediately even when a browser operation cannot be cancelled. */
function within(job, signal, milliseconds, message) {
  return new Promise((resolve, reject) => {
    let timer = 0;
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); };
    const cancel = () => { cleanup(); reject(signal.reason ?? aborted()); };
    Promise.resolve(job).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => { cleanup(); reject(new Error(message)); }, milliseconds);
  });
}

function sameOriginPath(value, prefix, directory = false) {
  if (typeof value !== 'string') throw new Error('The tracking configuration has an invalid asset URL.');
  const url = new URL(value, location.origin);
  if (url.origin !== location.origin || url.username || url.password || url.search || url.hash ||
      !url.pathname.startsWith(prefix) || (directory && !url.pathname.endsWith('/'))) {
    throw new Error('Tracking assets must use the configured local server.');
  }
  return url.href;
}

/** Bound both time and allocation while reading the local model/configuration. */
async function fetchBytes(url, limit, signal) {
  assertActive(signal);
  const deadline = new AbortController();
  const cancel = () => deadline.abort(signal.reason ?? aborted());
  signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => deadline.abort(new Error('The camera model download timed out after 15 seconds.')), IO_TIMEOUT_MS);
  let reader;
  try {
    const response = await fetch(url, { signal: deadline.signal, redirect: 'error', cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error(`The tracking asset could not load (HTTP ${response.status}).`);
    const stated = response.headers.get('content-length');
    if (stated !== null && (!/^\d+$/.test(stated) || Number(stated) > limit)) throw new Error('The tracking asset exceeds its expected size.');
    if (response.body === null) throw new Error('The tracking asset has no response body.');
    reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      assertActive(deadline.signal);
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('The tracking asset exceeds its expected size.');
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) {
    if (deadline.signal.aborted) throw deadline.signal.reason ?? error;
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    if (reader !== undefined) { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
}

/** Fill only the face graph entry; never invoke the app's full model loader. */
async function prepareFace(signal) {
  if (crypto.subtle === undefined || globalThis.caches === undefined) throw new Error('Camera tracking requires a secure localhost or HTTPS page with model caching.');
  const bytes = await fetchBytes(new URL('/tracking-config.json', location.origin), 128 * 1024, signal);
  let config;
  try { config = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error('The local tracking configuration could not be read.'); }
  if (config === null || typeof config !== 'object') throw new Error('The local tracking configuration is invalid.');
  const worker = sameOriginPath(config.worker, '/assets/');
  const ortBase = sameOriginPath(config.ortBase, '/vendor/ort/', true);
  const parsed = parseLock(config.lock);
  if (!parsed.ok) throw new Error(parsed.error);
  const files = parsed.value.ops.face.files;
  if (files.length !== 1 || files[0].role !== 'graph') throw new Error('This viewer expects the existing single-file face model.');
  const graph = files[0];
  const hash = await within(lockHash(parsed.value.lock, crypto.subtle), signal, IO_TIMEOUT_MS, 'The tracking model lock could not be hashed.');
  assertActive(signal);
  const cache = await within(caches.open(modelCacheNames(hash).verified), signal, IO_TIMEOUT_MS, 'The tracking model cache could not open.');
  const url = modelFileUrl(graph, location.origin);
  const cached = await within(cache.match(url), signal, IO_TIMEOUT_MS, 'The tracking model cache did not respond.');
  const valid = async data => data.byteLength === graph.bytes &&
    hex(await within(crypto.subtle.digest('SHA-256', data), signal, IO_TIMEOUT_MS, 'The tracking model could not be verified.')) === graph.sha256;
  if (cached !== undefined) {
    const data = await within(cached.arrayBuffer(), signal, IO_TIMEOUT_MS, 'The cached tracking model could not be read.');
    if (await valid(data)) { assertActive(signal); return { worker, ortBase }; }
  }
  const data = await fetchBytes(url, graph.bytes, signal);
  if (!(await valid(data))) throw new Error('The camera model failed its byte-length or SHA-256 integrity check.');
  assertActive(signal);
  await within(cache.put(url, new Response(data, { headers: { 'Content-Type': 'application/octet-stream' } })), signal, IO_TIMEOUT_MS, 'The verified camera model could not be cached.');
  assertActive(signal);
  return { worker, ortBase };
}

/** A single scoped worker, with the same parsed reply protocol as the app. */
function openTracker(prepared, signal) {
  let worker = null, pending = null, nextJobId = 0, readyState = false, error = null, startupTimer = 0;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => undefined);
  const release = (reason = aborted()) => {
    if (error !== null) return;
    error = reason;
    readyState = false;
    clearTimeout(startupTimer);
    signal.removeEventListener('abort', cancel);
    rejectReady(reason);
    if (pending !== null) { clearTimeout(pending.timer); pending.reject(reason); pending = null; }
    if (worker !== null) {
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      worker.terminate(); worker = null;
    }
  };
  const cancel = () => release(signal.reason ?? aborted());
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  void prepared.then(config => {
    if (error !== null || signal.aborted) return;
    try {
      worker = new Worker(config.worker, { type: 'module', name: 'highland-field-face' });
      worker.onmessage = event => {
        if (error !== null) return;
        const parsed = parseFaceReply(event.data);
        if (!parsed.ok) { release(new Error(`The face worker sent an invalid reply: ${parsed.error.detail}`)); return; }
        const reply = parsed.value;
        if (reply.type === 'failed') { release(new Error(reply.message)); return; }
        if (reply.type === 'ready') {
          clearTimeout(startupTimer); readyState = true; resolveReady(); return;
        }
        if (!readyState || pending === null || pending.id !== reply.jobId) {
          release(new Error('The face worker replied to an unexpected frame.')); return;
        }
        const job = pending; pending = null; clearTimeout(job.timer); job.resolve(reply.face);
      };
      worker.onerror = event => { event.preventDefault(); release(new Error(event.message || 'The face worker failed.')); };
      worker.onmessageerror = () => release(new Error('The face worker reply could not be read.'));
      startupTimer = setTimeout(() => release(new Error('Face tracking did not start within 15 seconds.')), IO_TIMEOUT_MS);
      worker.postMessage({ type: 'init', ortBase: config.ortBase });
    } catch (cause) { release(cause instanceof Error ? cause : new Error(describe(cause))); }
  }, cause => release(cause instanceof Error ? cause : new Error(describe(cause))));
  return {
    ready,
    track(frame) {
      if (error !== null || worker === null || !readyState) { frame.close(); return Promise.reject(error ?? new Error('The face worker is not ready.')); }
      if (pending !== null) { frame.close(); return Promise.resolve(null); }
      const id = nextJobId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => release(new Error('The face worker stopped responding for 15 seconds.')), IO_TIMEOUT_MS);
        pending = { id, resolve, reject, timer };
        try { worker.postMessage({ type: 'track', jobId: id, frame }, [frame]); }
        catch (cause) { frame.close(); release(cause instanceof Error ? cause : new Error(describe(cause))); }
      });
    },
    release,
    snapshot: () => ({ workerReady: readyState, workerActive: worker !== null, frameInFlight: pending !== null }),
  };
}

/**
 * Real camera input for the standalone field viewer.
 * The viewer alone applies visual gain to these calibrated [-1, 1] targets.
 * Abort `signal` to cancel a start while the browser's permission prompt is open.
 */
export async function startHeadTracking({ signal, onTarget = () => {}, onState = () => {} } = {}) {
  if (signal?.aborted) throw signal.reason ?? aborted();
  const controller = new AbortController();
  const cleanup = [], recenterActions = [];
  let active = true, request = 0, trackedFrames = 0, tracks = [], tracker = null;
  let lastSample = null, target = { x: 0, y: 0 }, terminalError = null;
  let state = { kind: 'calibrating', message: 'Starting the camera. Look straight at the screen.' };
  const source = createWindowSource({ openTracker: () => { tracker = openTracker(prepared, controller.signal); return tracker; } });
  const remember = () => {
    trackedFrames = Math.max(trackedFrames, source.trackedFrames());
    if (source.tracks().length > 0) tracks = [...source.tracks()];
  };
  const stop = () => {
    if (!active) return;
    remember(); active = false;
    cancelAnimationFrame(request);
    signal?.removeEventListener('abort', cancel);
    window.removeEventListener('pagehide', stop);
    controller.abort(aborted());
    for (const action of cleanup.splice(0).reverse()) action();
    recenterActions.length = 0;
  };
  const say = (kind, message) => {
    if (!active || (state.kind === kind && state.message === message)) return;
    state = { kind, message }; onState({ ...state });
  };
  const fail = (reason, detail) => {
    if (!active) return;
    terminalError = new Error(detail && detail !== reason ? `${reason}: ${detail}` : reason);
    state = { kind: 'failed', message: terminalError.message };
    stop(); onState({ ...state });
  };
  const cancel = () => stop();
  signal?.addEventListener('abort', cancel, { once: true });
  window.addEventListener('pagehide', stop, { once: true });
  const prepared = prepareFace(controller.signal);
  void prepared.catch(error => { if (active) fail('The camera model could not start', describe(error)); });
  try {
    onState({ ...state });
    assertActive(controller.signal);
    // Call the source before yielding, preserving the initiating camera gesture.
    const starting = source.source({
      valid: () => active,
      dispose(action) { if (active) cleanup.push(action); else action(); },
      onRecenter(action) { if (active) recenterActions.push(action); },
      target(center, sample) {
        if (!active) return;
        lastSample = sample ?? null;
        target = { x: Math.max(-1, Math.min(1, (center.x - .5) * 2)), y: Math.max(-1, Math.min(1, (.5 - center.y) * 2)) };
        if (sample?.state === 'tracking') say('tracking', 'Camera tracking. Lean sideways or up and down to look past the foreground stones.');
        else if (sample?.state === 'lost') say('lost', 'Face out of view. Look toward the camera to continue.');
        else say('calibrating', 'Hold still briefly to set your viewing position.');
        if (active) onTarget({ ...target });
      },
      failed: fail,
    });
    const poll = await within(starting, controller.signal, PERMISSION_TIMEOUT_MS, 'Camera permission or startup did not finish within 45 seconds.');
    assertActive(controller.signal);
    remember();
    const tick = now => {
      if (!active) return;
      try {
        poll(now); remember();
        if (lastSample !== null && now - lastSample.capturedAt > STALE_SAMPLE_MS) say('lost', 'The camera has not delivered a recent face position.');
      } catch (error) { fail('Camera tracking failed', describe(error)); return; }
      if (active) request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return {
      stop,
      recenter() {
        if (!active) return;
        lastSample = null;
        for (const action of recenterActions) action();
        say('calibrating', 'Look straight ahead and hold still briefly to recenter.');
      },
      snapshot() {
        if (active) remember();
        const camera = tracks.find(track => track.kind === 'video');
        return {
          active, state: state.kind, message: state.message, trackedFrames,
          cameraReadyState: camera?.readyState ?? 'unavailable', liveTracks: tracks.filter(track => track.readyState === 'live').length,
          sampleSequence: lastSample?.sequence ?? 0, sampleAgeMs: lastSample === null ? null : Math.max(0, performance.now() - lastSample.capturedAt),
          quality: lastSample?.quality ?? null, target: { ...target },
          ...(tracker?.snapshot() ?? { workerReady: false, workerActive: false, frameInFlight: false }),
        };
      },
    };
  } catch (error) {
    if (active) fail('Camera tracking could not start', describe(error));
    throw terminalError ?? error;
  }
}
