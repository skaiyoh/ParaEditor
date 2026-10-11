import { createShowcaseCamera } from './showcase/camera.ts';
import { isSceneId, openPreparedView, type PreparedView, type SceneId } from './showcase/catalog.ts';
import { createSceneGallery } from './showcase/gallery.ts';
import { advanceSpring, headTarget, type Spring } from './showcase/motion.ts';
import type { Eye } from './showcase/scene.ts';

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const value = document.getElementById(id);
  if (!(value instanceof type)) throw new Error(`The scene viewer is missing its ${id} control.`);
  return value;
}
const canvas = element('stage', HTMLCanvasElement), frame = element('frame', HTMLDivElement);
const select = element('scene-choice', HTMLSelectElement), poster = element('poster', HTMLImageElement);
const cameraButton = element('camera', HTMLButtonElement), recenterButton = element('recenter', HTMLButtonElement);
const tiltButton = element('tilt', HTMLButtonElement), autoButton = element('auto', HTMLButtonElement), fullscreen = element('fullscreen', HTMLButtonElement);
const gain = element('gain', HTMLInputElement), gainValue = element('gain-value', HTMLOutputElement);
const status = element('status', HTMLParagraphElement), loading = element('loading', HTMLDivElement), retry = element('retry', HTMLButtonElement);
const sourceImage = element('source-image', HTMLAnchorElement), lifetime = new AbortController();
const fullscreenExit = element('fullscreen-exit', HTMLButtonElement);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const center: Eye = { x: 0, y: 0 }, clamp = (value: number) => Math.max(-1, Math.min(1, value));
const requestedScene = new URLSearchParams(location.search).get('scene') ?? 'highland-field';
let selected: SceneId = isSceneId(requestedScene) ? requestedScene : 'highland-field';
let view: PreparedView | null = null, pending: AbortController | null = null, generation = 0, disposed = false;
let target: Eye = center, spring: Spring = { position: center, velocity: center }, source: 'pointer' | 'keyboard' | 'camera' | 'tilt' | 'auto' = 'pointer';
let gainAmount = 2, cameraReady = false, cameraFailed = false, cameraMessage = 'Camera off. Move your pointer or drag to look around.';
let auto = false, tilt = false, tiltBase: readonly [number, number] | null = null, inputGeneration = 0;
let drawNeeded = true, request = 0, previous = performance.now(), failure: string | null = null;
const intervals: number[] = [];
const gallery = createSceneGallery(choose, lifetime.signal);
const physicalEye = (): Eye => view === null ? center : { x: spring.position.x * view.travel.x, y: spring.position.y * view.travel.y };
const profile = () => {
  const value = gallery.items().find(scene => scene.id === selected);
  if (value === undefined) throw new Error('The selected scene is unavailable.');
  return value;
};
const camera = createShowcaseCamera(message => {
  if (cameraFailed) return;
  cameraMessage = message;
  cameraButton.textContent = camera.active() ? 'Stop tracking' : 'Head tracking';
  cameraButton.setAttribute('aria-pressed', String(camera.active()));
  if (failure === null && pending === null && (source === 'camera' || source === 'pointer')) status.textContent = message;
});
const faceReady = camera.prepare(lifetime.signal).then(() => {
  if (disposed) return;
  cameraReady = true; cameraButton.disabled = false;
}).catch(error => {
  if (disposed) return;
  cameraFailed = true;
  cameraMessage = `${error instanceof Error ? error.message : String(error)} Use the pointer, touch or tilt.`;
  if (pending === null && failure === null) status.textContent = cameraMessage;
});
void faceReady;

function fit(): void {
  const box = frame.getBoundingClientRect();
  if (view?.aspect !== null && view !== null) {
    const width = Math.min(box.width, box.height * view.aspect);
    canvas.style.width = `${width}px`; canvas.style.height = `${width / view.aspect}px`;
  } else { canvas.style.width = '100%'; canvas.style.height = '100%'; }
  drawNeeded = true;
}
const observer = new ResizeObserver(fit); observer.observe(frame);
function move(x: number, y: number): void {
  if (Number.isFinite(x) && Number.isFinite(y)) target = { x: clamp(x), y: clamp(y) };
}
function stopInputs(): void {
  inputGeneration++; auto = false; tilt = false; tiltBase = null;
  autoButton.setAttribute('aria-pressed', 'false'); tiltButton.setAttribute('aria-pressed', 'false');
  camera.stop(); source = 'pointer';
}
function recenter(): void {
  auto = false; autoButton.setAttribute('aria-pressed', 'false'); tiltBase = null;
  camera.recenter(); target = center; spring = { position: center, velocity: center }; drawNeeded = true;
  if (pending === null && failure === null) status.textContent = cameraFailed ? cameraMessage : camera.active() ? 'Look straight ahead and hold still briefly to recenter.' : 'Centered. Lean or move to look past the foreground.';
}
function showFailure(error: unknown): void {
  failure = error instanceof Error ? error.message : String(error);
  view?.dispose(); view = null; canvas.hidden = true; poster.hidden = false; loading.hidden = false;
  loading.textContent = 'The 3D scene could not load.'; status.textContent = `${failure} Retry the scene to continue.`;
  retry.hidden = false; drawNeeded = false;
}
async function choose(id: SceneId): Promise<void> {
  selected = id; gallery.mark(id); gallery.close(); frame.dataset.scene = id; const item = profile();
  const run = ++generation; pending?.abort(); const controller = new AbortController(); pending = controller;
  view?.dispose(); view = null; failure = null; retry.hidden = true;
  canvas.hidden = true; poster.hidden = false; poster.src = item.poster;
  poster.alt = item.id === 'highland-field' ? 'An open alpine meadow with foreground stones and enormous mountain ridges.' : item.id === 'lantern-court' ? 'Blue stone arches, warm lanterns and a garden pavilion.' : `${item.title} scene preview.`;
  sourceImage.href = item.poster; loading.hidden = false; loading.textContent = `Opening ${item.title}.`;
  document.title = `${item.title} - Noisy 3D scenes`; status.textContent = 'Preparing the 3D scene.';
  const url = new URL(location.href); url.searchParams.set('scene', id); history.replaceState(null, '', url.pathname + url.search);
  try {
    const next = await openPreparedView(id, canvas, controller.signal);
    if (disposed || controller.signal.aborted || run !== generation) { next.dispose(); return; }
    view = next; pending = null; canvas.hidden = false; fit(); next.draw(physicalEye()); drawNeeded = false;
    loading.hidden = true; poster.hidden = true;
    status.textContent = camera.active() || cameraFailed ? cameraMessage : `${item.description} Start Head tracking for camera control.`;
  } catch (error) {
    if (!controller.signal.aborted && !disposed && run === generation) { pending = null; showFailure(error); }
  }
}
select.addEventListener('change', () => { if (isSceneId(select.value) && gallery.items().some(item => item.id === select.value)) void choose(select.value); }, { signal: lifetime.signal });
retry.addEventListener('click', () => {
  if (canvas.getContext('webgl2')?.isContextLost()) location.reload(); else void choose(selected);
}, { signal: lifetime.signal });
recenterButton.addEventListener('click', recenter, { signal: lifetime.signal });
cameraButton.addEventListener('click', () => {
  if (!cameraReady) return;
  if (camera.active()) { stopInputs(); target = center; status.textContent = 'Head tracking stopped. The camera is off.'; }
  else { stopInputs(); source = 'camera'; target = center; camera.start(); }
}, { signal: lifetime.signal });
autoButton.addEventListener('click', () => {
  const next = !auto; stopInputs(); auto = next; source = next ? 'auto' : 'pointer';
  autoButton.setAttribute('aria-pressed', String(auto)); status.textContent = auto ? 'Automatic perspective preview. Move over the scene to take control.' : 'Automatic movement stopped.';
}, { signal: lifetime.signal });
gain.addEventListener('input', () => { gainAmount = Math.max(1, Math.min(6, gain.valueAsNumber || 2)); gainValue.value = `${gainAmount.toFixed(1)}×`; }, { signal: lifetime.signal });
let drag: { id: number; x: number; y: number; start: Eye } | null = null;
canvas.addEventListener('pointerdown', event => {
  if (view === null) return;
  stopInputs(); canvas.focus({ preventScroll: true });
  if (event.pointerType !== 'mouse') { drag = { id: event.pointerId, x: event.clientX, y: event.clientY, start: target }; canvas.setPointerCapture(event.pointerId); }
}, { signal: lifetime.signal });
canvas.addEventListener('pointermove', event => {
  if (view === null || camera.active() || tilt) return;
  const box = canvas.getBoundingClientRect();
  if (event.pointerType === 'mouse') {
    if (auto) stopInputs(); source = 'pointer'; move((event.clientX - box.x) / box.width * 2 - 1, 1 - (event.clientY - box.y) / box.height * 2);
  } else if (drag?.id === event.pointerId) move(drag.start.x + (event.clientX - drag.x) / box.width * 2, drag.start.y - (event.clientY - drag.y) / box.height * 2);
}, { signal: lifetime.signal });
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(type, () => { drag = null; }, { signal: lifetime.signal });
canvas.addEventListener('keydown', event => {
  if (event.key === 'Home') { event.preventDefault(); recenter(); return; }
  const step = event.key === 'ArrowLeft' ? { x: -.15, y: 0 } : event.key === 'ArrowRight' ? { x: .15, y: 0 }
    : event.key === 'ArrowUp' ? { x: 0, y: .15 } : event.key === 'ArrowDown' ? { x: 0, y: -.15 } : null;
  if (step !== null) { event.preventDefault(); stopInputs(); source = 'keyboard'; move(target.x + step.x, target.y + step.y); }
}, { signal: lifetime.signal });
window.addEventListener('deviceorientation', event => {
  if (!tilt || event.beta === null || event.gamma === null) return;
  const angle = (screen.orientation?.angle ?? ('orientation' in window && typeof window.orientation === 'number' ? window.orientation : 0)) * Math.PI / 180;
  const next: readonly [number, number] = [event.gamma * Math.cos(angle) + event.beta * Math.sin(angle), event.beta * Math.cos(angle) - event.gamma * Math.sin(angle)];
  if (tiltBase === null) { tiltBase = next; status.textContent = 'Tilt is on. Recenter sets a new resting position.'; }
  move((next[0] - tiltBase[0]) / 16, -(next[1] - tiltBase[1]) / 16);
}, { signal: lifetime.signal });
screen.orientation?.addEventListener('change', () => { tiltBase = null; }, { signal: lifetime.signal });
tiltButton.addEventListener('click', () => {
  if (tilt) { stopInputs(); target = center; status.textContent = 'Tilt stopped. Drag the scene to look around.'; return; }
  stopInputs(); const run = inputGeneration;
  void (async () => {
    if (typeof DeviceOrientationEvent === 'undefined') throw new Error('Tilt is unavailable in this browser.');
    if ('requestPermission' in DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') {
      const permission: unknown = await DeviceOrientationEvent.requestPermission();
      if (permission !== 'granted') throw new Error('Tilt permission was denied.');
    }
    if (disposed || run !== inputGeneration || document.hidden) return;
    tilt = true; source = 'tilt'; tiltButton.setAttribute('aria-pressed', 'true'); status.textContent = 'Tilt is on. Hold still to set the resting position.';
  })().catch(error => { if (!disposed && run === inputGeneration) status.textContent = `${error instanceof Error ? error.message : String(error)} Drag the scene or use arrow keys.`; });
}, { signal: lifetime.signal });
function syncFullscreen(): void {
  const active = document.fullscreenElement === frame || document.body.classList.contains('expanded');
  fullscreen.textContent = active ? 'Exit full screen' : 'Full screen'; fullscreen.setAttribute('aria-pressed', String(active));
  fullscreenExit.hidden = !active; fit();
}
async function exitFullscreen(): Promise<void> {
  if (document.fullscreenElement !== null) {
    try { await document.exitFullscreen(); } catch { status.textContent = 'Press Escape to leave full screen.'; return; }
  }
  document.body.classList.remove('expanded'); syncFullscreen(); fullscreen.focus({ preventScroll: true });
}
fullscreen.addEventListener('click', () => {
  if (document.fullscreenElement !== null || document.body.classList.contains('expanded')) { void exitFullscreen(); return; }
  gallery.close();
  void (async () => {
    if (typeof frame.requestFullscreen === 'function') {
      try { await frame.requestFullscreen(); syncFullscreen(); canvas.focus({ preventScroll: true }); return; } catch { /* Use the viewport fallback when native fullscreen is refused. */ }
    }
    document.body.classList.add('expanded'); syncFullscreen(); canvas.focus({ preventScroll: true });
  })();
}, { signal: lifetime.signal });
fullscreenExit.addEventListener('click', () => { void exitFullscreen(); }, { signal: lifetime.signal });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && document.body.classList.contains('expanded')) void exitFullscreen(); }, { signal: lifetime.signal });
document.addEventListener('fullscreenchange', () => { syncFullscreen(); if (document.fullscreenElement === null) fullscreen.focus({ preventScroll: true }); }, { signal: lifetime.signal });
canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); stopInputs(); showFailure(new Error('The graphics context stopped. Reload the scene to recover.')); }, { signal: lifetime.signal });

function tick(now: number): void {
  request = 0; if (disposed || document.hidden) return;
  const dt = now - previous; previous = now;
  // WindowSource polling must continue while a scene loads and while motion is settled.
  const face = camera.tick(now);
  if (camera.active() && face !== null) { source = 'camera'; target = headTarget(face, gainAmount); }
  else if (source === 'camera') { source = 'pointer'; target = center; }
  if (auto) target = { x: Math.sin(now * .00045) * .94, y: Math.sin(now * .00031) * .45 };
  const old = spring.position; spring = advanceSpring(spring, target, dt, camera.active(), reducedMotion.matches);
  if (view !== null && (drawNeeded || old.x !== spring.position.x || old.y !== spring.position.y)) {
    try { view.draw(physicalEye()); drawNeeded = false; } catch (error) { stopInputs(); showFailure(error); }
  }
  if (dt > 0 && dt < 250) { intervals.push(dt); if (intervals.length > 180) intervals.shift(); }
  request = requestAnimationFrame(tick);
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopInputs(); target = center; cancelAnimationFrame(request); request = 0; }
  else if (request === 0) { previous = performance.now(); drawNeeded = true; request = requestAnimationFrame(tick); }
}, { signal: lifetime.signal });
window.addEventListener('pagehide', () => {
  disposed = true; generation++; pending?.abort(); stopInputs(); cancelAnimationFrame(request); observer.disconnect(); view?.dispose(); view = null;
  delete window.__noisyShowcase; lifetime.abort();
}, { once: true });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });

function snapshot() {
  const eye = physicalEye(), diagnostics = view?.inspect(eye);
  return { ready: view !== null, scene: selected, source, loading: pending !== null, error: failure, gain: gainAmount,
    auto, tilt, target, current: spring.position, eye, camera: camera.snapshot(), renderer: view?.metrics() ?? null,
    frameMedianMs: [...intervals].sort((a, b) => a - b)[Math.floor(intervals.length / 2)] ?? 0,
    window: diagnostics?.window ?? null, landmarks: diagnostics?.landmarks ?? null };
}
declare global {
  interface Window { __noisyShowcase?: { snapshot: typeof snapshot; visibility: () => readonly { id: number; name: string; pixels: number }[] } }
}
if (NOISY_DEV) window.__noisyShowcase = { snapshot, visibility: () => view?.visibility?.(physicalEye()) ?? [] };
request = requestAnimationFrame(tick);
void (async () => {
  await gallery.prepare(); if (disposed) return;
  if (!gallery.items().some(item => item.id === selected)) selected = 'highland-field';
  await choose(selected);
})();
