// The two facts only a killed page can report, read by the page that loads
// after it: whether a localStorage key written before the kill is still
// stored, and whether the dead page's Web Lock was let go. While a step runs
// the engine keeps an app-shaped marker beside its step marker, the app's
// liveness marker's shape under `noisy.harness.job.<tab>.heavy`, outside
// `noisy.job.`, the prefix the app's own liveness markers and startup sweep
// are to use (not built yet): written at the step's start,
// `hiddenAt` set while the page is hidden and cleared when it is visible
// again, as the app does inside its hidden grace, and removed when the step
// or the run ends and on `pagehide`, which a killed page never runs. Each
// page load holds the tab lock `noisy-tab-<tab>` for its life. A load that
// finds a death `isProcessDeath` names asks `navigator.locks.query()` about
// the dead tab's lock at once, before it waits for the runner lock, which the
// dead page also held (or once it holds that lock, when the run was written
// while it waited, so the holder was alive), and again 2 s and 10 s later;
// holding the runner lock, it reads the dead tab's marker, then removes it. The engine takes all of this as one
// optional dependency, so a page that writes no such marker takes none of it.

import { isSceneId, type BuildId, type SceneId, type TabId } from '../../core/ids.ts';
import type { Clock } from '../../platform/clock.ts';
import { LIVENESS_LATE_MS } from './lines.ts';
import { isProcessDeath, type LoadVerdict } from './load.ts';
import type { PlanState } from './plan.ts';
import type { Stages, Step } from './steps.ts';
import type { HarnessEvent, LockReading } from './rows.ts';

/** The prefix of the app-shaped marker's key, never under `noisy.job.`, which the app's own liveness markers are to use (not built yet). */
export const APP_MARKER_PREFIX = 'noisy.harness.job.';
/** How long a reading of the lock manager waits for `query()` before it reads `failed`. */
export const LOCK_QUERY_MS = 1_000;

/** The key of `tab`'s app-shaped marker. */
export function appMarkerKey(tab: TabId): string {
  return `${APP_MARKER_PREFIX}${tab}.heavy`;
}

/** The Web Lock a page load holds for its life, in the app's form. */
export function tabLockName(tab: TabId): string {
  return `noisy-tab-${tab}`;
}

/** The step's first stage for a sequence step, else the step's kind. */
export type AppMarkerOp = Stages[number] | Exclude<Step['kind'], 'sequence'>;

/** The app's liveness marker's shape: the scene, the operation, the build, the tab, when the step started, and when the page was hidden, by the wall clock. */
export type AppMarker = {
  readonly scene: SceneId;
  readonly op: AppMarkerOp;
  readonly build: BuildId;
  readonly tab: TabId;
  readonly startedAt: number;
  readonly hiddenAt: number | null;
};

/**
 * The run's scene id: the run id, `<yyyymmdd>T<hhmmss>Z-<4 hex>`, written as
 * a UUID v4, so every step of a run names the same scene with nothing more
 * stored. Throws for a string that is not a run id.
 */
export function sceneOf(run: string): SceneId {
  const match = /^(\d{8})T(\d{4})(\d{2})Z-([0-9a-f]{3})([0-9a-f])$/.exec(run);
  const id = match === null ? '' : `${match[1]}-${match[2]}-4${match[3]}0-8${match[4]}-${match[5]}${'0'.repeat(11)}`;
  if (!isSceneId(id)) throw new Error(`"${run}" is not a run id`);
  return id;
}

export function opOf(step: Step): AppMarkerOp {
  switch (step.kind) {
    case 'untouched':
    case 'ballast':
      return step.kind;
    case 'sequence':
      return step.stages[0];
  }
}

type LockInfo = { readonly name?: string };
/** What `navigator.locks.query()` answers, as far as the report reads it. */
export type LockSnapshot = { readonly held?: readonly LockInfo[]; readonly pending?: readonly LockInfo[] };

/** The part of LockManager the tab lock and the report use; `navigator.locks` is one. */
export type LivenessLocks = {
  request(name: string, options: { readonly ifAvailable?: boolean; readonly signal?: AbortSignal }, callback: (lock: unknown) => Promise<void> | undefined): Promise<unknown>;
  query(): Promise<LockSnapshot>;
};

/** The engine's optional liveness dependency: the lock manager, or null without Web Locks, when every reading is `absent` and no tab lock is taken. */
export type LivenessDeps = { readonly locks: LivenessLocks | null };

/** The lock manager's answer as a reading of one tab's lock. */
export type LockLookup = (tab: TabId) => LockReading;

/** The lock manager read when the watch began and at each of LIVENESS_LATE_MS after. */
export type LockWatch = {
  readonly atLoad: Promise<LockLookup>;
  readonly late: readonly { readonly afterMs: LateEvent['afterMs']; readonly reading: Promise<LockLookup> }[];
};

export type LivenessEvent = Extract<HarnessEvent, { readonly type: 'liveness' }>;
export type LateEvent = Extract<HarnessEvent, { readonly type: 'liveness-late' }>;

/** What a load read of a dead page: the fields of its `liveness` row but the kill index, which the plan's write gives. */
export type DeadPage = Omit<LivenessEvent, 'type' | 'killIndex'>;

/**
 * The tab whose app-shaped marker a verdict leaves stored: the step marker's
 * tab, or the plan's in-flight tab when the marker was lost; null for a
 * verdict that names no step.
 */
export function verdictTab(plan: PlanState, verdict: LoadVerdict): TabId | null {
  switch (verdict.kind) {
    case 'fresh':
    case 'stale':
      return null;
    case 'marker-lost':
      return plan.inFlight?.tab ?? null;
    case 'void':
    case 'killed':
    case 'died-after-terminate':
    case 'after-completion':
    case 'applied-earlier':
      return verdict.marker.tab;
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

export interface Liveness {
  /** Requests this page's tab lock, once, and holds it for the page's life. */
  holdTabLock(): void;
  /** Writes this page's marker for a step of `run` starting now; answers why it could not, or null. */
  mark(run: string, step: Step, startedAtWall: number, hidden: boolean): string | null;
  /** Sets `hiddenAt` in this page's marker, if one is stored and holds none, or clears it with null; answers why it could not, or null. */
  setHidden(hiddenAtWall: number | null): string | null;
  /** Removes this page's marker, if it wrote one. */
  clear(): void;
  /** Reads the lock manager now and at each of LIVENESS_LATE_MS from now. */
  watch(): LockWatch;
  /** Reads the dead page a death verdict names: its marker, and its tab lock as `watch` read it at its start; null for a verdict that is not a death. */
  readDeath(plan: PlanState, verdict: LoadVerdict, watch: LockWatch): Promise<DeadPage | null>;
  /** Removes `tab`'s marker. */
  forget(tab: TabId): void;
  /** Hands `post` each of `watch`'s late readings of `tab`'s lock as a `liveness-late` event with its index, once it is read. */
  postLate(tab: TabId, watch: LockWatch, post: (event: LateEvent, index: number) => void): void;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createLiveness(deps: {
  readonly locks: LivenessLocks | null;
  readonly storage: Pick<Storage, 'getItem' | 'removeItem'>;
  /** Writes a key as the engine writes its marker; answers the error, or null. */
  readonly write: (key: string, value: string) => string | null;
  readonly clock: Clock;
  readonly tab: TabId;
  readonly build: BuildId;
}): Liveness {
  const { locks, storage, clock, tab } = deps;
  const key = appMarkerKey(tab);
  let marker: AppMarker | null = null;
  let tabLock = false;

  const store = (next: AppMarker): string | null => {
    const error = deps.write(key, JSON.stringify(next));
    if (error !== null) return `the app-shaped marker could not be written: ${error}`;
    marker = next;
    return null;
  };

  /** One `query()`, as a lookup of any tab's lock; `failed` for every tab when it throws or does not answer within LOCK_QUERY_MS. */
  const readLocks = (): Promise<LockLookup> => {
    if (locks === null) return Promise.resolve(() => ({ kind: 'absent' }));
    const failed = (reason: string): LockLookup => () => ({ kind: 'failed', reason });
    return new Promise((resolve) => {
      const timer = clock.setTimeout(() => resolve(failed(`query() did not answer within ${LOCK_QUERY_MS} ms`)), LOCK_QUERY_MS);
      const settle = (lookup: LockLookup): void => {
        clock.clearTimeout(timer);
        resolve(lookup);
      };
      try {
        locks.query().then(
          (snapshot) =>
            settle((dead) => {
              const name = tabLockName(dead);
              const named = (infos: readonly LockInfo[] | undefined): boolean => (infos ?? []).some((info) => info.name === name);
              return { kind: 'read', held: named(snapshot.held), pending: named(snapshot.pending) };
            }),
          (e: unknown) => settle(failed(errorText(e))),
        );
      } catch (e) {
        settle(failed(errorText(e)));
      }
    });
  };

  return {
    holdTabLock() {
      if (locks === null || tabLock) return;
      tabLock = true;
      try {
        // The callback's promise never settles, so the lock is held until the page dies or is unloaded.
        void locks.request(tabLockName(tab), {}, () => new Promise<void>(() => undefined)).catch(() => undefined);
      } catch {
        // A lock manager that throws holds nothing; the next load's readings say what it holds.
      }
    },

    mark(run, step, startedAtWall, hidden) {
      try {
        return store({ scene: sceneOf(run), op: opOf(step), build: deps.build, tab, startedAt: startedAtWall, hiddenAt: hidden ? startedAtWall : null });
      } catch (e) {
        return `the app-shaped marker could not be made: ${errorText(e)}`;
      }
    },

    setHidden(hiddenAtWall) {
      if (marker === null || (hiddenAtWall === null) === (marker.hiddenAt === null)) return null;
      return store({ ...marker, hiddenAt: hiddenAtWall });
    },

    clear() {
      if (marker === null) return;
      marker = null;
      try {
        storage.removeItem(key);
      } catch {
        // Nothing more can be done; the next load that finds this tab's death removes it.
      }
    },

    watch() {
      return {
        atLoad: readLocks(),
        late: LIVENESS_LATE_MS.map((afterMs) => ({ afterMs, reading: new Promise<LockLookup>((resolve) => clock.setTimeout(() => void readLocks().then(resolve), afterMs)) })),
      };
    },

    async readDeath(plan, verdict, watch) {
      const dead = verdictTab(plan, verdict);
      if (dead === null || !isProcessDeath(verdict)) return null;
      let appMarker: DeadPage['appMarker'];
      try {
        const text = storage.getItem(appMarkerKey(dead));
        let value: unknown = text;
        if (text !== null) {
          try {
            value = JSON.parse(text);
          } catch {
            // Stored, but not JSON: the text is the value.
          }
        }
        appMarker = { survived: text !== null, value };
      } catch (e) {
        appMarker = { survived: false, value: `the marker could not be read: ${errorText(e)}` };
      }
      return { deadTab: dead, appMarker, lockAtLoad: (await watch.atLoad)(dead) };
    },

    forget(dead) {
      try {
        storage.removeItem(appMarkerKey(dead));
      } catch {
        // As in clear.
      }
    },

    postLate(dead, watch, post) {
      watch.late.forEach(({ afterMs, reading }, index) => {
        void reading.then((lookup) => post({ type: 'liveness-late', deadTab: dead, afterMs, lock: lookup(dead) }, index));
      });
    },
  };
}
