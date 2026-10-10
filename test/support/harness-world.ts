// A world for the harness engine's node tests: one origin's localStorage, one
// clock the test advances, one Web Locks manager, and one results sink, shared
// by every page the test opens on it, as the tabs and reloads of one phone
// share them. A page has its own timers, visibility, outbox, scripted runner,
// and engine; killing it does what a killed content process does: its timers
// stop, its writes stop landing, its posts never answer, and the lock it held
// is released. The world also records every write a page makes to the
// harness's keys before it first held the runner lock, and every write to the
// plan or the marker while another page holds it; the outbox goes on
// flushing after DONE and Stop without the lock, by design. A page's screen
// wake lock is a fake the test makes grant, refuse, or answer later, or
// leaves out, and releases as a browser does; a page passes the liveness
// dependency when it is opened with it; and a kill may leave named locks
// held, as a browser that does not let a dead page's lock go at once would.

import { isTabId, type TabId } from '../../src/core/ids.ts';
import { createEngine, RUNNER_LOCK, type Engine, type EngineStatus, type Runner } from '../../src/dev/harness/engine.ts';
import type { LivenessLocks } from '../../src/dev/harness/liveness.ts';
import { createOutbox, type Outbox, type Post, type PostResult } from '../../src/dev/harness/outbox.ts';
import { harnessKeys } from '../../src/dev/harness/catalog.ts';
import { parsePlan, type PlanState } from '../../src/dev/harness/plan.ts';
import type { Step } from '../../src/dev/harness/steps.ts';
import { parseMarker, type StepMarker } from '../../src/dev/harness/load.ts';
import { parseHarnessRow, type HarnessRow, type StepOutcome, type WakeLockState } from '../../src/dev/harness/rows.ts';
import type { ScreenWakeLock, ScreenWakeLockSentinel } from '../../src/dev/harness/wake-lock.ts';
import type { Clock } from '../../src/platform/clock.ts';
import type { VisibilitySource } from '../../src/platform/visibility.ts';
import { BUILD, T0 } from '../fixtures/harness.ts';

export const KEYS = harnessKeys('memory');

/** Lets every pending promise chain run: setImmediate runs after the microtask queue drains. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

type Timer = { readonly id: number; readonly at: number; readonly page: Page; readonly fn: () => void };

type Held = { readonly owner: Page; readonly drop: () => void };
type Waiter = { readonly name: string; readonly owner: Page; readonly grant: () => void };

/** Web Locks for one origin: exclusive, granted in request order, `ifAvailable`, an abort while waiting, `query`, and a dead page's locks released. */
class Locks {
  readonly held = new Map<string, Held>();
  private queue: Waiter[] = [];
  /** Requests by name and kind, in order, for the tests to read. */
  readonly requests: { readonly page: string; readonly ifAvailable: boolean; readonly signal: boolean }[] = [];

  view(owner: Page): LivenessLocks {
    return {
      query: () => Promise.resolve({ held: [...this.held.keys()].map((name) => ({ name })), pending: this.queue.map((w) => ({ name: w.name })) }),
      request: (name, options, callback) => {
        this.requests.push({ page: owner.name, ifAvailable: options.ifAvailable === true, signal: options.signal !== undefined });
        return new Promise<unknown>((resolve, reject) => {
          const grant = (): void => {
            let dropped = false;
            const drop = (): void => {
              if (dropped) return;
              dropped = true;
              if (this.held.get(name)?.owner === owner) this.held.delete(name);
              this.grantNext(name);
            };
            this.held.set(name, { owner, drop });
            Promise.resolve(callback({ name, mode: 'exclusive' })).then(
              (value) => {
                drop();
                resolve(value);
              },
              (e: unknown) => {
                drop();
                reject(e);
              },
            );
          };
          if (!this.held.has(name) && !this.queue.some((w) => w.name === name)) {
            queueMicrotask(grant);
            return;
          }
          if (options.ifAvailable === true) {
            queueMicrotask(() => Promise.resolve(callback(null)).then(resolve, reject));
            return;
          }
          const signal = options.signal;
          if (signal?.aborted === true) {
            reject(signal.reason);
            return;
          }
          const waiter: Waiter = { name, owner, grant };
          this.queue.push(waiter);
          signal?.addEventListener(
            'abort',
            () => {
              if (!this.queue.includes(waiter)) return;
              this.queue = this.queue.filter((w) => w !== waiter);
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
    };
  }

  private grantNext(name: string): void {
    if (this.held.has(name)) return;
    const next = this.queue.find((w) => w.name === name);
    if (next === undefined) return;
    this.queue = this.queue.filter((w) => w !== next);
    queueMicrotask(next.grant);
  }

  holder(name: string): Page | null {
    return this.held.get(name)?.owner ?? null;
  }

  /** What the browser does for a dead page: its held locks are released, but those named in `keep`, and its waiting requests dropped. */
  kill(owner: Page, keep: readonly string[] = []): void {
    this.queue = this.queue.filter((w) => w.owner !== owner);
    for (const [name, held] of [...this.held.entries()]) if (held.owner === owner && !keep.includes(name)) held.drop();
  }

  /** Lets go of the lock `name`, as a browser that releases a dead page's lock late does. */
  release(name: string): void {
    this.held.get(name)?.drop();
  }
}

/** One call of the runner: the step, its phase callback and signal, and how the test answers it. */
export type RunnerCall = {
  readonly step: Step;
  readonly phase: (name: string) => void;
  readonly signal: AbortSignal;
  readonly answer: (outcome: StepOutcome) => void;
  /** Rejects the execute, as a runner that throws does. */
  readonly reject: (error: Error) => void;
};

/**
 * A page's `navigator.wakeLock`: each request answers as `answer` says when
 * it is made, or, for `later`, when the test calls `grant` or `refuse` on its
 * entry in `waiting`; `releaseByBrowser` releases every sentinel held, as a
 * browser does when the page is hidden.
 */
export class FakeWakeLock implements ScreenWakeLock {
  answer: 'grant' | 'refuse' | 'later' = 'grant';
  requests = 0;
  /** Sentinels the page released itself. */
  releasedByPage = 0;
  /** The requests made under `later`, in order. */
  readonly waiting: { readonly grant: () => void; readonly refuse: () => void }[] = [];
  /** Each held sentinel's release. */
  private readonly held = new Set<() => void>();

  request(): Promise<ScreenWakeLockSentinel> {
    this.requests += 1;
    if (this.answer === 'later') {
      return new Promise((resolve, reject) => {
        this.waiting.push({ grant: () => resolve(this.sentinel()), refuse: () => reject(refused()) });
      });
    }
    if (this.answer === 'refuse') return Promise.reject(refused());
    return Promise.resolve(this.sentinel());
  }

  private sentinel(): ScreenWakeLockSentinel {
    const listeners: (() => void)[] = [];
    let live = true;
    const fire = (): void => {
      if (!live) return;
      live = false;
      this.held.delete(fire);
      for (const listener of listeners) listener();
    };
    this.held.add(fire);
    return {
      release: () => {
        if (live) this.releasedByPage += 1;
        fire();
        return Promise.resolve();
      },
      addEventListener: (_type, listener) => {
        listeners.push(listener);
      },
    };
  }

  /** Whether a sentinel is held. */
  get holding(): boolean {
    return this.held.size > 0;
  }

  releaseByBrowser(): void {
    for (const fire of [...this.held]) fire();
  }
}

const refused = (): DOMException => new DOMException('The wake lock request was refused.', 'NotAllowedError');

/** A runner the test drives: each execute waits for the test's answer unless `auto` answers it. */
export class ScriptedRunner implements Runner {
  readonly calls: RunnerCall[] = [];
  released = 0;
  auto: ((call: RunnerCall) => void) | null = null;

  execute(step: Step, phase: (name: string) => void, signal: AbortSignal): Promise<StepOutcome> {
    return new Promise((answer, reject) => {
      const call: RunnerCall = { step, phase, signal, answer, reject };
      this.calls.push(call);
      this.auto?.(call);
    });
  }

  release(): void {
    this.released += 1;
  }
}

const tabId = (n: number): TabId => {
  const id = `3f0c1a52-8d4e-4b7a-9c61-${n.toString(16).padStart(12, '0')}`;
  if (!isTabId(id)) throw new Error(`not a tab id: ${id}`);
  return id;
};

export type PageOptions = {
  readonly webLocks?: boolean;
  readonly hidden?: boolean;
  /** Wraps the outbox the engine gets, to count makeRoom calls. */
  readonly wrapOutbox?: (outbox: Outbox) => Outbox;
  /** Passes the liveness dependency, as the memory page does. */
  readonly liveness?: boolean;
  /** Without the wake lock API: every request answers unsupported. */
  readonly noWakeLock?: boolean;
};

/** One page load: its own timers, visibility, outbox, runner, and engine over the world's storage, locks, and sink. */
export class Page {
  alive = true;
  hidden: boolean;
  everHeld = false;
  readonly statuses: EngineStatus[] = [];
  /** Every wake-lock answer the engine told the page, in order. */
  readonly wakeStates: (WakeLockState | null)[] = [];
  readonly wakeLock = new FakeWakeLock();
  readonly runner = new ScriptedRunner();
  readonly outbox: Outbox;
  readonly engine: Engine;
  readonly tab: TabId;
  private readonly changeListeners: ((hidden: boolean) => void)[] = [];
  private readonly pagehideListeners: (() => void)[] = [];
  /** The next setItem calls to `key` that throw, and how many. */
  private readonly faults = new Map<string, number>();
  /** Kills the page right after a write it matches lands. */
  private killAfter: ((key: string, value: string) => boolean) | null = null;

  readonly world: World;
  readonly name: string;

  constructor(world: World, name: string, options: PageOptions) {
    this.world = world;
    this.name = name;
    this.hidden = options.hidden ?? false;
    this.tab = tabId(world.pages.length + 1);
    const storage = {
      getItem: (key: string): string | null => world.items.get(key) ?? null,
      setItem: (key: string, value: string): void => this.write(key, () => world.items.set(key, value), value),
      removeItem: (key: string): void => this.write(key, () => world.items.delete(key), ''),
    };
    const post: Post = (body) => {
      if (!this.alive) return new Promise(() => {});
      return Promise.resolve().then((): Promise<PostResult> | PostResult => {
        if (!this.alive || world.sinkHangs) return new Promise(() => {});
        if (world.sinkStatus !== 200) return { kind: 'failed', reason: `the sink answered ${world.sinkStatus}` };
        const parsed = parseHarnessRow(JSON.parse(body));
        if (!parsed.ok) throw new Error(`the sink got a row that does not parse: ${parsed.error}`);
        world.sink.push(parsed.value);
        return { kind: 'recorded' };
      });
    };
    const outbox = createOutbox({ page: 'memory', storage, post });
    this.outbox = options.wrapOutbox?.(outbox) ?? outbox;
    const clock: Clock = {
      now: () => world.time,
      wallNow: () => world.wall(),
      setTimeout: (fn, ms) => world.addTimer(this, fn, ms),
      clearTimeout: (id) => world.clearTimer(id),
    };
    const page = this;
    const visibility: VisibilitySource = {
      get hidden(): boolean {
        return page.hidden;
      },
      onChange: (listener) => {
        this.changeListeners.push(listener);
        return () => undefined;
      },
      onPageHide: (listener) => {
        this.pagehideListeners.push(listener);
        return () => undefined;
      },
    };
    const locks = options.webLocks === false ? null : world.locks.view(this);
    this.engine = createEngine({
      page: 'memory',
      storage,
      locks,
      clock,
      visibility,
      outbox: this.outbox,
      runner: this.runner,
      build: BUILD,
      tab: this.tab,
      facts: {
        environment: { kind: 'unavailable', reason: 'node' },
        navigatorStandalone: null,
        navigation: 'navigate',
        lockHash: 'a'.repeat(64),
        models: [],
      },
      // Each run id the world mints differs, as real random bytes would.
      random: {
        getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
          world.minted += 1;
          if (array !== null) new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(world.minted);
          return array;
        },
      },
      onStatus: (status) => this.statuses.push(status),
      wakeLock: options.noWakeLock === true ? null : this.wakeLock,
      onWakeLock: (state) => this.wakeStates.push(state),
      ...(options.liveness === true ? { liveness: { locks } } : {}),
    });
  }

  private write(key: string, apply: () => void, value: string): void {
    if (!this.alive) return;
    this.world.writes.push({ page: this.name, key, value });
    if (key.startsWith('noisy.harness.')) {
      const holder = this.world.locks.holder(RUNNER_LOCK);
      if (holder === this) this.everHeld = true;
      else if (this.world.checkLock && (!this.everHeld || (holder !== null && key !== KEYS.outbox))) this.world.violations.push(`${this.name} wrote ${key} without the runner lock`);
    }
    const left = this.faults.get(key) ?? 0;
    if (left > 0) {
      this.faults.set(key, left - 1);
      throw new DOMException(`The quota has been exceeded (writing ${key}).`, 'QuotaExceededError');
    }
    apply();
    if (this.killAfter?.(key, value) === true) this.kill();
  }

  /** The next `count` setItem calls to `key` throw a quota error. */
  failWrites(key: string, count: number): void {
    this.faults.set(key, count);
  }

  /** Kills the page right after the first write `match` matches. */
  killAfterWrite(match: (key: string, value: string) => boolean): void {
    this.killAfter = match;
  }

  /** The process dies: no more timers, writes, posts, or listeners, and its locks are released, but those named in `keep`. */
  kill(keep: readonly string[] = []): void {
    if (!this.alive) return;
    this.alive = false;
    this.world.locks.kill(this, keep);
  }

  /** Sets the page's visibility and, unless `event` is false, fires `visibilitychange`, as a page killed before the event's task runs does not. */
  setHidden(hidden: boolean, event = true): void {
    if (!this.alive || this.hidden === hidden) return;
    this.hidden = hidden;
    if (event) for (const listener of this.changeListeners) listener(hidden);
  }

  pagehide(): void {
    if (!this.alive) return;
    for (const listener of this.pagehideListeners) listener();
  }

  get status(): EngineStatus | undefined {
    return this.statuses.at(-1);
  }
}

export class World {
  time = 0;
  readonly items = new Map<string, string>();
  readonly locks = new Locks();
  readonly sink: HarnessRow[] = [];
  readonly pages: Page[] = [];
  readonly violations: string[] = [];
  /** Every write that reached storage or was attempted on it, by page, in order; a removal is logged with an empty value. */
  readonly writes: { readonly page: string; readonly key: string; readonly value: string }[] = [];
  sinkStatus = 200;
  /** How many run ids pages of this world have minted. */
  minted = 0;
  /** Posts from then on never answer, as over a stalled tailnet. */
  sinkHangs = false;
  checkLock = true;
  private timers: Timer[] = [];
  private nextTimer = 1;

  wall(): number {
    return T0 + this.time;
  }

  open(options: PageOptions = {}): Page {
    const page = new Page(this, `page ${this.pages.length + 1}`, options);
    this.pages.push(page);
    return page;
  }

  addTimer(page: Page, fn: () => void, ms: number): number {
    const id = this.nextTimer;
    this.nextTimer += 1;
    this.timers.push({ id, at: this.time + Math.max(0, ms), page, fn });
    return id;
  }

  clearTimer(id: number): void {
    this.timers = this.timers.filter((t) => t.id !== id);
  }

  /** Moves the clock forward by `ms`, firing every live page's timers due on the way, in order, and letting each settle. */
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      await settle();
      this.timers = this.timers.filter((t) => t.page.alive);
      const due = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.time = due.at;
      due.fn();
    }
    this.time = end;
    await settle();
  }

  plan(): PlanState | null {
    const parsed = parsePlan(this.items.get(KEYS.plan) ?? null);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  }

  marker(): StepMarker | null {
    const parsed = parseMarker(this.items.get(KEYS.step) ?? null);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  }

  /** The rows waiting in the stored outbox. */
  outboxRows(): readonly HarnessRow[] {
    const text = this.items.get(KEYS.outbox);
    if (text === undefined) return [];
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || !('rows' in value) || !Array.isArray(value.rows)) throw new Error('the stored outbox has no rows');
    const rows: readonly unknown[] = value.rows;
    return rows.map((row) => {
      const parsed = parseHarnessRow(row);
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.value;
    });
  }

  /** The harness's keys as stored, to compare before and after. */
  snapshot(): Readonly<Record<string, string | null>> {
    return { plan: this.items.get(KEYS.plan) ?? null, step: this.items.get(KEYS.step) ?? null, outbox: this.items.get(KEYS.outbox) ?? null };
  }
}
