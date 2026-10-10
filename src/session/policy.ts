/** Pure foreground demo policy. Times are monotonic milliseconds supplied by the caller. */
export type Stage = 'depth' | 'encode' | 'inpaint';
export const STAGE_TIMEOUT_MS = { depth: 60_000, encode: 120_000, inpaint: 60_000 } satisfies Record<Stage, number>;
export type Policy = {
  readonly generation: number;
  readonly modelsReady: boolean;
  readonly sceneReady: boolean;
  readonly pendingImport: boolean;
  readonly lastStart: number | null;
  readonly sequence: 'idle' | 'import' | 'plate';
  readonly deadline: { readonly stage: Stage; readonly at: number } | null;
  readonly plateQueued: boolean;
};
export type PolicyEvent =
  | { readonly kind: 'import' }
  | { readonly kind: 'models-ready' }
  | { readonly kind: 'scene-ready'; readonly generation: number }
  | { readonly kind: 'import-failed'; readonly generation: number }
  | { readonly kind: 'tick' }
  | { readonly kind: 'phase'; readonly generation: number; readonly stage: Stage; readonly phase: 'session' | 'infer' }
  | { readonly kind: 'product'; readonly generation: number; readonly stage: Stage }
  | { readonly kind: 'failed'; readonly generation: number; readonly stage: Stage; readonly reason: string }
  | { readonly kind: 'done'; readonly generation: number; readonly plateNeeded: boolean }
  | { readonly kind: 'plate-request'; readonly generation: number };
export type PolicyEffect =
  | { readonly kind: 'cancel-heavy' }
  | { readonly kind: 'release-decoder' }
  | { readonly kind: 'drop-products' }
  | { readonly kind: 'start-import' }
  | { readonly kind: 'start-plate' }
  | { readonly kind: 'status'; readonly text: string };

export function initialPolicy(): Policy {
  return { generation: 0, modelsReady: false, sceneReady: false, pendingImport: false, lastStart: null, sequence: 'idle', deadline: null, plateQueued: false };
}

export function nextWake(state: Policy): number | null {
  if (state.deadline !== null) return state.deadline.at;
  if (state.pendingImport && state.modelsReady && state.sceneReady) return state.lastStart === null ? 0 : state.lastStart + 2000;
  return null;
}

export function transition(state: Policy, event: PolicyEvent, now: number): { readonly state: Policy; readonly effects: readonly PolicyEffect[] } {
  if ('generation' in event && event.generation !== state.generation) return { state, effects: [] };
  let next = state;
  const effects: PolicyEffect[] = [];
  switch (event.kind) {
    case 'import':
      next = { ...state, generation: state.generation + 1, sceneReady: false, pendingImport: true, sequence: 'idle', deadline: null, plateQueued: false };
      effects.push({ kind: 'cancel-heavy' }, { kind: 'release-decoder' }, { kind: 'drop-products' });
      break;
    case 'models-ready': next = { ...state, modelsReady: true }; break;
    case 'scene-ready': next = { ...state, sceneReady: true }; break;
    case 'import-failed': next = { ...state, pendingImport: false, sceneReady: false, plateQueued: false }; break;
    case 'tick':
      if (state.deadline !== null && now >= state.deadline.at) {
        next = { ...state, sequence: 'idle', deadline: null, plateQueued: false };
        effects.push({ kind: 'cancel-heavy' }, { kind: 'status', text: `Analysis timed out at ${state.deadline.stage}` });
      }
      break;
    case 'phase':
      if (state.sequence === 'idle') return { state, effects: [] };
      if (event.phase === 'session' && state.deadline?.stage !== event.stage) next = { ...state, deadline: { stage: event.stage, at: now + STAGE_TIMEOUT_MS[event.stage] } };
      effects.push({ kind: 'status', text: event.stage === 'inpaint' || state.plateQueued ? 'preparing' : `Analyzing: ${event.stage === 'encode' ? 'encoder' : event.stage}` });
      break;
    case 'product':
      if (state.deadline?.stage === event.stage) next = { ...state, deadline: null };
      break;
    case 'failed':
      if (state.sequence === 'idle') return { state, effects: [] };
      next = { ...state, sequence: 'idle', deadline: null, plateQueued: false };
      effects.push({ kind: 'cancel-heavy' }, { kind: 'status', text: `Analysis failed at ${event.stage}: ${event.reason}` });
      break;
    case 'done':
      if (state.sequence === 'idle') return { state, effects: [] };
      next = { ...state, sequence: 'idle', deadline: null, plateQueued: event.plateNeeded && (state.plateQueued || state.sequence === 'plate') };
      break;
    case 'plate-request':
      if (state.sequence !== 'plate') next = { ...state, plateQueued: true };
      effects.push({ kind: 'status', text: 'preparing' });
      break;
    default: { const unhandled: never = event; return unhandled; }
  }
  if (next.pendingImport && next.sceneReady && next.modelsReady && next.sequence === 'idle' && (next.lastStart === null || now >= next.lastStart + 2000)) {
    next = { ...next, pendingImport: false, sequence: 'import', lastStart: now };
    effects.push({ kind: 'start-import' });
  } else if (next.plateQueued && !next.pendingImport && next.modelsReady && next.sceneReady && next.sequence === 'idle') {
    next = { ...next, plateQueued: false, sequence: 'plate' };
    effects.push({ kind: 'start-plate' });
  }
  return { state: next, effects };
}
