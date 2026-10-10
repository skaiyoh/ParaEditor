// src/platform's generic modules under node, each driven through the narrow
// browser interface it takes: the diagnostics ring, the clock, the
// visibility source, the device facts, and the tab id.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTabId } from '../src/core/ids.ts';
import { z } from '../src/core/zod.ts';
import { deviceClassOf, readCapabilities, STORAGE_READ_MS, type CapabilitySources } from '../src/platform/capabilities.ts';
import { createBrowserClock, type Clock } from '../src/platform/clock.ts';
import { createDiagnostics, DEFAULT_CAPACITY } from '../src/platform/diagnostics.ts';
import { mintTabId } from '../src/platform/tab-id.ts';
import { createVisibilitySource } from '../src/platform/visibility.ts';

type Ping = { readonly event: 'ping'; readonly n: number };

/** A clock that reads what the test sets; its timers wait until `fire()` runs every pending one. */
function fixedClock(): Clock & { at: number; fire(): void } {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    at: 0,
    now() {
      return this.at;
    },
    wallNow: () => 0,
    setTimeout: (callback) => {
      pending.set(next, callback);
      next += 1;
      return next - 1;
    },
    clearTimeout: (handle) => {
      pending.delete(handle);
    },
    fire() {
      const due = [...pending.values()];
      pending.clear();
      for (const callback of due) callback();
    },
  };
}

test('the diagnostics ring stamps each event with clock.now() and keeps them oldest first', () => {
  const clock = fixedClock();
  const diagnostics = createDiagnostics<Ping>(clock);
  clock.at = 5;
  diagnostics.log({ event: 'ping', n: 1 });
  clock.at = 7.5;
  diagnostics.log({ event: 'ping', n: 2 });
  assert.deepEqual(diagnostics.events, [
    { event: 'ping', n: 1, t: 5 },
    { event: 'ping', n: 2, t: 7.5 },
  ]);
  assert.deepEqual(JSON.parse(diagnostics.export()), { capacity: DEFAULT_CAPACITY, dropped: 0, events: diagnostics.events });
});

test('a full ring overwrites its oldest events and never throws', () => {
  const clock = fixedClock();
  const diagnostics = createDiagnostics<Ping>(clock);
  for (let n = 0; n < DEFAULT_CAPACITY + 123; n += 1) {
    clock.at = n;
    diagnostics.log({ event: 'ping', n });
  }
  const events = diagnostics.events;
  assert.equal(events.length, DEFAULT_CAPACITY);
  assert.deepEqual(events[0], { event: 'ping', n: 123, t: 123 });
  assert.deepEqual(events.at(-1), { event: 'ping', n: DEFAULT_CAPACITY + 122, t: DEFAULT_CAPACITY + 122 });
  assert.ok(events.every((e, i) => e.n === 123 + i), 'in logging order');
  const exported: unknown = JSON.parse(diagnostics.export());
  assert.deepEqual(exported, { capacity: DEFAULT_CAPACITY, dropped: 123, events });

  const small = createDiagnostics<Ping>(clock, 3);
  for (let n = 0; n < 8; n += 1) small.log({ event: 'ping', n });
  assert.deepEqual(small.events.map((e) => e.n), [5, 6, 7]);
  for (const capacity of [0, -1, 2.5, Number.NaN]) assert.throws(() => createDiagnostics<Ping>(clock, capacity), RangeError, String(capacity));
});

test('export never throws: an Error exports its name and message, a bigint its text, and a cycle is marked', () => {
  type Odd = { readonly event: 'odd'; readonly value: unknown };
  const clock = fixedClock();
  const diagnostics = createDiagnostics<Odd>(clock);
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  diagnostics.log({ event: 'odd', value: new TypeError('boom') });
  diagnostics.log({ event: 'odd', value: 12n });
  diagnostics.log({ event: 'odd', value: cyclic });
  diagnostics.log({ event: 'odd', value: [1, 'two'] });
  const exported = z
    .object({ capacity: z.number(), dropped: z.number(), events: z.array(z.record(z.string(), z.unknown())) })
    .parse(JSON.parse(diagnostics.export()));
  const [error, big, cycle, plain] = exported.events;
  assert.deepEqual(error, { event: 'odd', value: { name: 'TypeError', message: 'boom' }, t: 0 });
  assert.deepEqual(big, { event: 'odd', value: '12', t: 0 });
  assert.deepEqual(Object.keys(cycle ?? {}), ['event', 't', 'unserializable']);
  assert.match(String(cycle?.['unserializable']), /circular/i);
  assert.deepEqual(plain, { event: 'odd', value: [1, 'two'], t: 0 });
  assert.equal(exported.events.length, 4);
});

test('the browser clock calls the window it is given', () => {
  const calls: string[] = [];
  const clock = createBrowserClock({
    performance: { ...performance, now: () => 12.5 },
    setTimeout: (handler: TimerHandler, ms?: number) => {
      calls.push(`set ${ms}`);
      if (typeof handler === 'function') handler();
      return 41;
    },
    clearTimeout: (handle?: number) => {
      calls.push(`clear ${handle}`);
    },
  });
  assert.equal(clock.now(), 12.5);
  const before = Date.now();
  const wall = clock.wallNow();
  assert.ok(wall >= before && wall <= Date.now());
  let fired = false;
  const handle = clock.setTimeout(() => (fired = true), 250);
  clock.clearTimeout(handle);
  assert.ok(fired);
  assert.deepEqual(calls, ['set 250', 'clear 41']);
});

test('the visibility source follows visibilitychange and pagehide, and unsubscribes', () => {
  const state: { visibilityState: DocumentVisibilityState } = { visibilityState: 'visible' };
  const doc = Object.assign(new EventTarget(), state);
  const win = new EventTarget();
  const source = createVisibilitySource({ document: doc, window: win });
  const seen: string[] = [];
  const offChange = source.onChange((hidden) => seen.push(`change ${hidden}`));
  const offHide = source.onPageHide(() => seen.push('pagehide'));
  assert.equal(source.hidden, false);
  doc.visibilityState = 'hidden';
  assert.equal(source.hidden, true);
  doc.dispatchEvent(new Event('visibilitychange'));
  win.dispatchEvent(new Event('pagehide'));
  offChange();
  offHide();
  doc.dispatchEvent(new Event('visibilitychange'));
  win.dispatchEvent(new Event('pagehide'));
  assert.deepEqual(seen, ['change true', 'pagehide']);
});

test('deviceClassOf: phone for an iPhone or iPad user agent, or a coarse pointer without hover', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
  const ipad = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
  assert.equal(deviceClassOf(iphone, false), 'phone');
  assert.equal(deviceClassOf(ipad, false), 'phone');
  assert.equal(deviceClassOf(mac, true), 'phone', 'an iPad asking for the desktop site reports a Mac user agent');
  assert.equal(deviceClassOf(mac, false), 'desktop');
});

function sources(options: {
  readonly userAgent?: string;
  readonly media?: readonly string[];
  readonly storage?: StorageManager;
  readonly standalone?: boolean;
  readonly clock?: Clock;
}): CapabilitySources {
  const media = new Set(options.media ?? []);
  const navigator = {
    userAgent: options.userAgent ?? 'Mozilla/5.0 (Macintosh)',
    hardwareConcurrency: 8,
    storage: options.storage ?? { estimate: async () => ({ quota: 1000, usage: 1 }), persisted: async () => true, persist: async () => true, getDirectory: async () => { throw new Error('unused'); } },
    ...(options.standalone === undefined ? {} : { standalone: options.standalone }),
  };
  return {
    navigator,
    window: {
      crossOriginIsolated: true,
      matchMedia: (query: string) =>
        Object.assign(new EventTarget(), { matches: media.has(query), media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined }),
    },
    clock: options.clock ?? fixedClock(),
  };
}

test('readCapabilities reports the device facts the environment snapshot carries', async () => {
  assert.deepEqual(await readCapabilities(sources({})), {
    userAgent: 'Mozilla/5.0 (Macintosh)',
    deviceClass: 'desktop',
    crossOriginIsolated: true,
    hardwareConcurrency: 8,
    standalone: false,
    storage: { quota: 1000, persisted: true },
  });
  const phone = await readCapabilities(sources({ media: ['(pointer: coarse) and (hover: none)', '(display-mode: standalone)'] }));
  assert.equal(phone.deviceClass, 'phone');
  assert.equal(phone.standalone, true);
  assert.equal((await readCapabilities(sources({ standalone: true }))).standalone, true, "iOS Safari's navigator.standalone");
});

test('readCapabilities degrades a storage API that throws or rejects to null quota and not persisted', async () => {
  const broken: StorageManager = {
    estimate: () => Promise.reject(new Error('no estimate')),
    persisted: () => {
      throw new Error('no persisted');
    },
    persist: async () => false,
    getDirectory: async () => {
      throw new Error('unused');
    },
  };
  assert.deepEqual((await readCapabilities(sources({ storage: broken }))).storage, { quota: null, persisted: false });
  const noQuota: StorageManager = { ...broken, estimate: async () => ({}), persisted: async () => false };
  assert.deepEqual((await readCapabilities(sources({ storage: noQuota }))).storage, { quota: null, persisted: false });
  // A WebKit-style estimate that resolves to nothing.
  const undefinedEstimate = Object.assign({}, broken, { estimate: () => Promise.resolve(undefined) });
  assert.deepEqual((await readCapabilities({ ...sources({}), navigator: { ...sources({}).navigator, storage: undefinedEstimate } })).storage, { quota: null, persisted: false });
});

test('readCapabilities never rejects: no matchMedia, a throwing matchMedia, a throwing storage getter', async () => {
  const base = sources({});
  // A window without matchMedia: the property is removed at run time, as a browser that lacks it would.
  const bare = { crossOriginIsolated: true, matchMedia: base.window.matchMedia };
  Reflect.deleteProperty(bare, 'matchMedia');
  const noMatchMedia: CapabilitySources = { ...base, window: bare };
  const throwingMatchMedia: CapabilitySources = {
    ...base,
    window: {
      crossOriginIsolated: true,
      matchMedia: () => {
        throw new Error('mm');
      },
    },
  };
  const throwingStorage: CapabilitySources = {
    ...base,
    navigator: {
      userAgent: 'Mozilla/5.0 (Macintosh)',
      hardwareConcurrency: 8,
      get storage(): StorageManager {
        throw new Error('getter');
      },
    },
  };
  for (const [label, s] of [['no matchMedia', noMatchMedia], ['matchMedia throws', throwingMatchMedia]] as const) {
    const read = await readCapabilities(s);
    assert.equal(read.deviceClass, 'desktop', label);
    assert.equal(read.standalone, false, label);
  }
  assert.deepEqual((await readCapabilities(throwingStorage)).storage, { quota: null, persisted: false });
});

test(`a storage read that never settles is reported unknown after ${STORAGE_READ_MS} ms`, async () => {
  const clock = fixedClock();
  const hanging: StorageManager = {
    estimate: () => new Promise(() => undefined),
    persisted: async () => true,
    persist: async () => false,
    getDirectory: async () => {
      throw new Error('unused');
    },
  };
  let settled = false;
  const reading = readCapabilities(sources({ storage: hanging, clock })).then((c) => {
    settled = true;
    return c;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'still waiting for the estimate');
  clock.fire();
  assert.deepEqual((await reading).storage, { quota: null, persisted: true });
});

test('mintTabId brands randomUUID and refuses anything that is not a UUID v4', () => {
  const id = mintTabId(crypto);
  assert.ok(isTabId(id));
  assert.notEqual(mintTabId(crypto), id);
  assert.throws(() => mintTabId({ randomUUID: () => '00000000-0000-0000-0000-000000000000' }), /not a lowercase UUID v4/);
  // A crypto without randomUUID, as an origin that is not a secure context gives.
  const insecure = { randomUUID: crypto.randomUUID.bind(crypto) };
  Reflect.deleteProperty(insecure, 'randomUUID');
  assert.throws(() => mintTabId(insecure), /not a secure context/);
});
