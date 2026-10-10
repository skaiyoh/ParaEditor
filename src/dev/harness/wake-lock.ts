// The screen wake lock a harness page holds while a run is wanted, so the
// phone's screen stays on and the page stays visible. A grant, a refusal while
// no lock is held, and a release the browser makes on its own are each
// answered as a WakeLockState, which the engine records; a request that
// answers while a lock is held changes nothing and answers `held`, so the
// state is `held` exactly while a lock is held. The page's own release (at
// DONE, at Stop, and when a run or a Start fails) is no answer: it clears the
// state, which the listener hears as null. A request is made before
// `request` returns, so a call from a tap's handler carries the tap's
// activation, which a browser may require of a wake-lock request.

import type { WakeLockState } from './rows.ts';

/** How long a load or Start gives its own wake-lock request to answer before it makes its `load` row. */
export const WAKE_ANSWER_MS = 1_000;

/** The part of WakeLockSentinel the holder uses. */
export type ScreenWakeLockSentinel = {
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
};

/** The part of `navigator.wakeLock` the holder uses. */
export type ScreenWakeLock = { request(type: 'screen'): Promise<ScreenWakeLockSentinel> };

export interface WakeLockHolder {
  /** The latest answer; null before the first and after `release`. */
  readonly state: WakeLockState | null;
  /** Requests the lock unless it is held, and answers the result; `unsupported` without the API. Never rejects. */
  request(): Promise<WakeLockState>;
  /** Releases the lock and forgets the state; a grant still on its way is released when it comes. */
  release(): void;
}

function refusal(e: unknown): WakeLockState {
  if (typeof DOMException !== 'undefined' && e instanceof DOMException) return { kind: 'refused', name: e.name };
  return { kind: 'refused', name: e instanceof Error ? e.name : String(e) };
}

/**
 * Makes the holder over `api` (null when the browser has none); `onAnswer`
 * hears each answer, and null when `release` clears the state.
 */
export function createWakeLock(api: ScreenWakeLock | null, onAnswer: (state: WakeLockState | null) => void): WakeLockHolder {
  let state: WakeLockState | null = null;
  let sentinel: ScreenWakeLockSentinel | null = null;
  /** Raised by every release, so an answer to a request made before it is not taken as the current state. */
  let epoch = 0;

  const answer = (next: WakeLockState): WakeLockState => {
    state = next;
    try {
      onAnswer(next);
    } catch {
      // The listener's failure is not the lock's.
    }
    return next;
  };

  const request = (): Promise<WakeLockState> => {
    if (sentinel !== null) return Promise.resolve({ kind: 'held' });
    if (api === null) return Promise.resolve(answer({ kind: 'unsupported' }));
    const asked = epoch;
    let call: Promise<ScreenWakeLockSentinel>;
    try {
      call = api.request('screen');
    } catch (e) {
      return Promise.resolve(answer(refusal(e)));
    }
    return call.then(
      (granted): WakeLockState => {
        // Released since it was asked for, or held already by an earlier request's grant: this one is given back.
        if (asked !== epoch || sentinel !== null) {
          void granted.release().catch(() => undefined);
          return asked !== epoch ? { kind: 'released' } : { kind: 'held' };
        }
        sentinel = granted;
        granted.addEventListener('release', () => {
          if (sentinel !== granted) return;
          sentinel = null;
          answer({ kind: 'released' });
        });
        return answer({ kind: 'held' });
      },
      (e: unknown): WakeLockState => {
        // Released since it was asked for, or held already by another request's grant: the refusal changes nothing.
        if (asked !== epoch) return refusal(e);
        if (sentinel !== null) return { kind: 'held' };
        return answer(refusal(e));
      },
    );
  };

  return {
    get state() {
      return state;
    },
    request,
    release() {
      epoch += 1;
      const held = sentinel;
      sentinel = null;
      if (held !== null) void held.release().catch(() => undefined);
      if (state === null) return;
      state = null;
      try {
        onAnswer(null);
      } catch {
        // As above.
      }
    },
  };
}
