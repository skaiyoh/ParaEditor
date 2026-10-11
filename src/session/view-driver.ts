import { parallaxClamp } from '../core/derive.ts';
import { frameCount, type Vec2 } from '../core/motion.ts';
import type { PerspectiveEye } from '../core/perspective.ts';
import type { SceneDocument } from '../core/types.ts';
import { LOOP_FPS } from '../render/loop.ts';

const SMOOTH_MS = 35;
const HOLD_MS = 250;
const HANDOFF_MS = 200;
export type ViewObservation = {
  readonly capturedAt: number;
  readonly sequence: number;
  readonly state: 'tracking' | 'lost' | 'calibrating';
  readonly quality?: number;
};
export type SourceMode = 'auto' | 'camera' | 'tilt';
const CENTER: Vec2 = { x: .5, y: .5 };
export type ViewSubmission = { readonly eye: PerspectiveEye; readonly viewId: number; readonly limitation: string | null };
export type ViewHost = {
  read(): SceneDocument | null;
  generation(): number;
  draw(camera: Vec2, frame: number): ViewSubmission | void;
  changed(): void;
  failed(status: string): void;
};
export type ViewAttempt = {
  valid(): boolean;
  dispose(action: () => void): void;
  target(center: Vec2, observation?: ViewObservation): void;
  onRecenter?(action: () => void): void;
  failed(status: string, detail?: string): void;
};
export type ViewSource = (attempt: ViewAttempt) => Promise<(now: number) => void>;
export type SourceName = 'camera' | 'tilt';
type SourceState =
  | { kind: 'pending' }
  | { kind: 'running'; poll(now: number): void }
  | { kind: 'unavailable'; status: string };

/** Sources own observations; this clock alone selects, filters and submits views. */
export function createViewDriver(host: ViewHost, sources: Readonly<Record<SourceName, ViewSource>>) {
  // The latest ordered event can differ from a tracking observation retained during loss hold.
  type ReceivedEvent = ViewObservation & { readonly receivedAt: number };
  type Input = { state: SourceState; target: Vec2; raw: Vec2; observation: ViewObservation | null; receivedAt: number; receivedSequence: number; receivedEvent: ReceivedEvent | null; dispose: (() => void)[]; recenter: (() => void)[] };
  type Attempt = { generation: number; inputs: Record<SourceName, Input>; request: number; cleanup: (() => void)[] };
  type Trace = { decisionAt: number; completedAt: number; cameraEvent: ReceivedEvent | null; tiltEvent: ReceivedEvent | null; handoffStartedAt: number; blend: number; now: number; drawStartedAt: number; submittedAt: number; generation: number; source: SourceName | 'none'; cameraAge: number | null; tiltAge: number | null; target: Vec2; center: Vec2; camera: Vec2; frameInterval: number; sampleSequence: number | null; rawCamera: Vec2; rawTilt: Vec2; cameraSample: ViewObservation | null; tiltSample: ViewObservation | null; submission: ViewSubmission | null };
  let attempt: Attempt | null = null;
  let center: Vec2 = CENTER, camera: Vec2 = { x: 0, y: 0 }, frame = 0;
  let mode: SourceMode = 'auto', selected: SourceName | 'none' = 'none';
  let transitionAt = 0, lastDecisionAt = 0, transitionFrom: Vec2 = CENTER, transitionTarget: Vec2 = CENTER;
  let status = 'Ready';
  type Failure = Readonly<{ reason: string; detail: string }>;
  let failures: Record<SourceName, Failure | null> = { camera: null, tilt: null };
  const failureSnapshot = () => ({ camera: failures.camera === null ? null : { ...failures.camera }, tilt: failures.tilt === null ? null : { ...failures.tilt } });
  let trace: Trace[] = [], lastTrace = -Infinity;
  const names: readonly SourceName[] = ['camera', 'tilt'];
  const dispose = (input: Input): void => {
    for (const action of input.dispose.splice(0).toReversed()) action();
    input.target = CENTER; input.observation = null; input.recenter = [];
  };
  function stop(): void {
    const previous = attempt; attempt = null;
    if (previous !== null) { cancelAnimationFrame(previous.request); previous.cleanup.forEach((action) => action()); names.forEach((name) => dispose(previous.inputs[name])); }
    center = CENTER; camera = { x: 0, y: 0 }; frame = 0; selected = 'none'; status = 'Ready';
    transitionFrom = CENTER; transitionTarget = CENTER; transitionAt = 0; lastDecisionAt = 0;
  }
  function recenter(): void {
    if (attempt === null) return;
    for (const name of names) {
      const input = attempt.inputs[name];
      input.target = CENTER; input.observation = null;
      for (const action of input.recenter) action();
    }
    selected = 'none'; transitionFrom = center; transitionTarget = CENTER;
    transitionAt = performance.now(); lastDecisionAt = transitionAt;
    status = 'Parallax: calibrating'; host.changed();
  }
  const fresh = (input: Input, now: number): boolean => input.state.kind !== 'unavailable'
    && input.observation?.state === 'tracking' && now - input.observation.capturedAt <= HOLD_MS;
  const cameraReason = (now: number): string => {
    const input = attempt?.inputs.camera;
    if (input === undefined) return failures.camera === null ? 'Parallax is off' : `Parallax is off; last camera attempt: ${failures.camera.reason}`;
    if (input.state.kind === 'unavailable') return input.state.status;
    if (input.state.kind === 'pending') return 'Camera and face tracking are starting';
    if (input.observation === null) return 'Camera is waiting for its first frame';
    if (now - input.observation.capturedAt > HOLD_MS) return 'Camera tracking is too slow or has stalled';
    if (input.observation.state === 'calibrating') return 'Hold still to calibrate the camera';
    if (input.observation.state === 'lost') return 'No clear face is in view, or the scene is too dark';
    return 'Camera is tracking your face';
  };
  async function start(): Promise<void> {
    if (attempt !== null || host.read() === null) return;
    const input = (): Input => ({ state: { kind: 'pending' }, target: CENTER, raw: CENTER, observation: null, receivedAt: -Infinity, receivedSequence: -1, receivedEvent: null, dispose: [], recenter: [] });
    const current: Attempt = { generation: host.generation(), inputs: { camera: input(), tilt: input() }, request: 0, cleanup: [] };
    attempt = current; trace = []; lastTrace = -Infinity; failures = { camera: null, tilt: null };
    const valid = (): boolean => attempt === current && host.generation() === current.generation;
    const changed = (): void => {
      if (!valid()) return;
      if (names.every((name) => current.inputs[name].state.kind === 'unavailable')) {
        const details = names.map((name) => {
          const state = current.inputs[name].state;
          return state.kind === 'unavailable' ? state.status : '';
        }).join('; ');
        stop(); host.failed(details); return;
      }
      host.changed();
    };
    if (typeof document !== 'undefined') {
      const hidden = (): void => {
        if (document.visibilityState === 'hidden' && attempt === current) { stop(); host.changed(); }
      };
      document.addEventListener('visibilitychange', hidden);
      current.cleanup.push(() => document.removeEventListener('visibilitychange', hidden));
      if (document.visibilityState === 'hidden') { stop(); host.changed(); return; }
    }
    status = 'Parallax: calibrating'; host.changed();
    if (!valid()) return;
    lastDecisionAt = performance.now();
    let motionOrigin: number | null = null;
    const tick = (now: number): void => {
      if (!valid()) { if (attempt === current) stop(); return; }
      const doc = host.read(); if (doc === null) { stop(); host.changed(); return; }
      try {
        // Capture before drawing; sources never start a second animation clock.
        const pollAt = performance.now();
        for (const name of names) {
          const state = current.inputs[name].state;
          if (state.kind === 'running') state.poll(pollAt);
        }
        const decisionAt = performance.now();
        const cameraFresh = mode !== 'tilt' && fresh(current.inputs.camera, decisionAt);
        const tiltFresh = mode !== 'camera' && fresh(current.inputs.tilt, decisionAt);
        const next: SourceName | 'none' = cameraFresh ? 'camera' : tiltFresh ? 'tilt' : 'none';
        const sourceTarget = next === 'none' ? CENTER : current.inputs[next].target;
        if (next === selected) transitionTarget = sourceTarget;
        // Advance the old trajectory before retargeting. Otherwise source changes on
        // consecutive frames discard every elapsed interval and can freeze the view.
        let blend = Math.max(0, Math.min(1, (decisionAt - transitionAt) / HANDOFF_MS));
        const eased = blend * blend * (3 - 2 * blend);
        const target = { x: transitionFrom.x + (transitionTarget.x - transitionFrom.x) * eased,
          y: transitionFrom.y + (transitionTarget.y - transitionFrom.y) * eased };
        const dt = Math.max(0, decisionAt - lastDecisionAt), alpha = 1 - Math.exp(-dt / SMOOTH_MS); lastDecisionAt = decisionAt;
        center = { x: center.x + (target.x - center.x) * alpha, y: center.y + (target.y - center.y) * alpha };
        if (next !== selected) {
          transitionFrom = center; transitionTarget = sourceTarget; transitionAt = decisionAt; selected = next; blend = 0;
        }
        const gain = 2 * parallaxClamp(doc);
        camera = { x: -(center.x - .5) * gain, y: -(center.y - .5) * gain };
        if (doc.motion.enabled) {
          motionOrigin ??= decisionAt;
          frame = Math.floor((decisionAt - motionOrigin) * LOOP_FPS / 1000) % frameCount(doc.motion, LOOP_FPS);
        } else { motionOrigin = null; frame = 0; }
        const drawStartedAt = performance.now();
        const submission = host.draw(camera, frame) ?? null;
        const submittedAt = performance.now();
        const nextStatus = selected === 'camera' ? 'Parallax: tracking face'
          : selected === 'tilt' ? mode === 'tilt' ? 'Parallax: using tilt by choice.' : `Parallax: ${cameraReason(decisionAt)}; using tilt.`
          : mode !== 'tilt' ? `Parallax: ${cameraReason(decisionAt)}.` : 'Parallax: waiting for tilt.';
        if (nextStatus !== status) { status = nextStatus; host.changed(); }
        if (decisionAt - lastTrace >= 50) {
          const age = (name: SourceName): number | null => {
            const sample = current.inputs[name].observation;
            return sample === null ? null : Math.max(0, decisionAt - sample.capturedAt);
          };
          trace.push({ now, decisionAt, completedAt: performance.now(),
            cameraEvent: current.inputs.camera.receivedEvent, tiltEvent: current.inputs.tilt.receivedEvent,
            handoffStartedAt: transitionAt, blend, drawStartedAt, submittedAt, generation: current.generation, source: selected, cameraAge: age('camera'), tiltAge: age('tilt'),
            target: sourceTarget, center: { ...center }, camera: { ...camera }, frameInterval: dt,
            sampleSequence: selected === 'none' ? null : current.inputs[selected].observation?.sequence ?? null,
            rawCamera: { ...current.inputs.camera.raw }, rawTilt: { ...current.inputs.tilt.raw },
            cameraSample: current.inputs.camera.observation, tiltSample: current.inputs.tilt.observation, submission });
          if (trace.length > 1200) trace.shift(); lastTrace = decisionAt;
        }
      } catch (error) { stop(); host.failed(error instanceof Error ? error.message : String(error)); return; }
      if (valid()) current.request = requestAnimationFrame(tick);
    };
    current.request = requestAnimationFrame(tick);
    // Both permission requests run before yielding from the initiating click.
    await Promise.all(names.map(async (name) => {
      const input = current.inputs[name];
      const sourceValid = (): boolean => valid() && input.state.kind !== 'unavailable';
      const failed = (message: string, detail = message): void => {
        if (!sourceValid()) return;
        failures[name] = { reason: message, detail };
        input.state = { kind: 'unavailable', status: message }; dispose(input); changed();
      };
      const context: ViewAttempt = {
        valid: sourceValid, failed,
        dispose(action) { if (sourceValid()) input.dispose.push(action); else action(); },
        onRecenter(action) { if (sourceValid()) input.recenter.push(action); },
        target(next, supplied) {
          if (!sourceValid() || ![next.x, next.y].every(Number.isFinite)) return;
          const now = performance.now();
          const sample = supplied ?? { capturedAt: now, sequence: input.receivedSequence + 1, state: 'tracking' };
          if (!Number.isFinite(sample.capturedAt) || sample.capturedAt > now + 1 || !Number.isSafeInteger(sample.sequence)
            || sample.sequence <= input.receivedSequence || sample.capturedAt < input.receivedAt) return;
          input.receivedSequence = sample.sequence; input.receivedAt = sample.capturedAt; input.receivedEvent = { ...sample, receivedAt: now };
          // A reported miss holds the last accepted tracking sample until its age expires.
          if (sample.state === 'lost' && input.observation?.state === 'tracking' && now - input.observation.capturedAt <= HOLD_MS) return;
          input.raw = { ...next };
          input.target = { x: Math.max(0, Math.min(1, next.x)), y: Math.max(0, Math.min(1, next.y)) };
          input.observation = { ...sample };
        },
      };
      try {
        const poll = await sources[name](context);
        if (sourceValid()) { input.state = { kind: 'running', poll }; changed(); }
      } catch (error) { failed(error instanceof Error ? error.message : String(error)); }
    }));
  }
  return {
    start, stop, recenter,
    setSourceMode(next: SourceMode): void { mode = next; },
    enabled: (): boolean => attempt !== null,
    ready: (name: SourceName): boolean => attempt?.inputs[name].state.kind === 'running',
    status: (): string => status,
    targets: () => ({ faceTarget: attempt?.inputs.camera.target ?? CENTER, tilt: attempt?.inputs.tilt.target ?? CENTER }),
    diagnostics: () => ({ source: selected, sourceMode: mode, center: { ...center }, failures: failureSnapshot(), cameraStatus: `${cameraReason(performance.now())}.`,
      cameraState: attempt === null ? 'Off' : attempt.inputs.camera.state.kind === 'unavailable' ? 'Failed'
        : attempt.inputs.camera.state.kind === 'pending' ? 'Starting'
        : attempt.inputs.camera.observation?.state ?? 'Waiting for frame', samples: {
      camera: attempt?.inputs.camera.observation ?? null, tilt: attempt?.inputs.tilt.observation ?? null }, latest: trace.at(-1) ?? null }),
    trace: () => ({ version: 1, smoothingMs: SMOOTH_MS, holdMs: HOLD_MS, handoffMs: HANDOFF_MS, failures: failureSnapshot(), samples: trace.map((sample) => ({ ...sample })) }),
    camera: (): Vec2 => camera,
    frame: (): number => host.read()?.motion.enabled === true ? frame : 0,
  };
}
