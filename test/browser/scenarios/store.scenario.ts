// The store's connection and the scene lock, driven through the store page,
// /dev/store.html, against Chrome's real IndexedDB and Web Locks: healthy
// writes, one and two injected connection errors, a handle closed behind the
// connection's back, a handle Chrome itself closes while a read runs, an
// operation's own ConstraintError, a versionchange from a second connection
// that closes the handle and reloads the page, a database at a newer version,
// and the scene lock held and asked for from the page and from a same-origin
// frame, released by resolving, by rejecting, and by a throw. The connection
// scenarios read the posted writes back from the sink, and all but the newer
// version's read the stored record back through a separate connection of
// their own; store.write also compares the schema. The lock scenarios read
// only the page's report.

import { z } from '../../../src/core/zod.ts';
import type { Scenario, ScenarioContext } from '../scenario.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const StoreErrorShape = z.object({ kind: z.string(), detail: z.string().optional(), version: z.number().optional(), writer: z.string().nullable().optional() });
const WriteResult = z.union([z.object({ ok: z.literal(true) }), z.object({ ok: z.literal(false), error: StoreErrorShape })]);
const Write = z.object({ n: z.number(), kind: z.enum(['write', 'add-duplicate']), result: WriteResult, ms: z.number() });
const Lock = z.object({ action: z.string(), from: z.enum(['page', 'frame']), outcome: z.string(), ms: z.number(), held: z.number(), pending: z.number() });
const Event = z.object({ event: z.string(), cause: z.string(), t: z.number() });

const Report = z.object({
  phase: z.enum(['starting', 'ready', 'failed']),
  detail: z.string().nullable(),
  levers: z.boolean(),
  navigation: z.string(),
  previousVersionChange: z.object({ at: z.string(), reconnects: z.number() }).nullable(),
  injection: z.number(),
  handlesOpened: z.number(),
  versionChanges: z.number(),
  writes: z.array(Write),
  read: z.object({ phase: z.enum(['storing', 'reading', 'done']), attempts: z.number(), result: z.union([z.object({ ok: z.literal(true), value: z.number() }), z.object({ ok: z.literal(false), error: StoreErrorShape })]).nullable() }).nullable(),
  reconnects: z.number(),
  events: z.array(Event),
  upgrade: z.string().nullable(),
  frameReady: z.boolean(),
  locks: z.array(Lock),
  posts: z.object({ posted: z.number(), notPosted: z.number() }),
});
type Report = z.infer<typeof Report>;

const View = z.object({ status: z.string(), reconnects: z.string(), leversHidden: z.boolean(), report: Report });
type View = z.infer<typeof View>;

function readView(): unknown {
  const out = document.querySelector<HTMLElement>('[data-testid=report]');
  if (out === null || out.dataset['phase'] === 'starting' || out.textContent === '') return null;
  return {
    status: document.querySelector('[data-testid=status]')?.textContent ?? '',
    reconnects: document.querySelector('[data-testid=reconnects]')?.textContent ?? '',
    leversHidden: document.querySelector<HTMLElement>('[data-testid=levers]')?.hidden ?? true,
    report: JSON.parse(out.textContent),
  };
}

/** Polls the page until `done` holds for its view; a navigation under way reads as not yet. */
async function until(t: ScenarioContext, description: string, done: (view: View) => boolean, timeoutMs = 10_000): Promise<View> {
  const deadline = Date.now() + timeoutMs;
  let last: View | null = null;
  for (;;) {
    try {
      const view = await t.page.evaluate(View.nullable(), readView);
      if (view !== null) {
        if (view.report.phase === 'failed') throw new Error(`the store page failed: ${view.report.detail ?? ''}`);
        last = view;
        if (done(view)) return view;
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('the store page failed')) throw e;
    }
    if (Date.now() > deadline) throw new Error(`${description}: not within ${timeoutMs} ms; last report ${JSON.stringify(last?.report ?? null)}`);
    await sleep(50);
  }
}

async function open(t: ScenarioContext, levers: boolean): Promise<View> {
  await t.page.goto(levers ? '/dev/store.html?levers=1' : '/dev/store.html');
  return until(t, 'the store page to be ready', (v) => v.report.phase === 'ready' && (!levers || v.report.frameReady));
}

const writes = (v: View): readonly z.infer<typeof Write>[] => v.report.writes.filter((w) => w.kind === 'write');

async function write(t: ScenarioContext, n: number): Promise<View> {
  await t.page.click('[data-testid=write]');
  return until(t, `write ${n} to settle`, (v) => writes(v).length >= n && v.report.posts.posted + v.report.posts.notPosted >= n);
}

async function lever(t: ScenarioContext, name: string): Promise<void> {
  await t.page.click(`[data-testid=${name}]`);
}

/** The database as a separate connection of the page reads it: its version, its stores' key paths and indexes, and the test record. */
const Stored = z.object({
  version: z.number(),
  stores: z.record(z.string(), z.object({ keyPath: z.union([z.string(), z.array(z.string())]).nullable(), indexes: z.array(z.object({ name: z.string(), keyPath: z.union([z.string(), z.array(z.string())]) })) })),
  record: z.object({ write: z.number(), at: z.string() }).nullable(),
  duplicate: z.unknown(),
});

/** The store page's own database; the page never opens the app's. */
const PAGE_DB = 'noisy-dev-store';

function readStored(name: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onerror = () => reject(new Error(String(request.error)));
    request.onsuccess = () => {
      const db = request.result;
      const names = [...db.objectStoreNames];
      if (names.length === 0) {
        db.close();
        resolve({ version: db.version, stores: {}, record: null, duplicate: null });
        return;
      }
      const tx = db.transaction(names, 'readonly');
      const stores: Record<string, unknown> = {};
      for (const name of names) {
        const store = tx.objectStore(name);
        stores[name] = {
          keyPath: store.keyPath,
          indexes: [...store.indexNames].map((index) => ({ name: index, keyPath: store.index(index).keyPath })),
        };
      }
      const hasDevice = names.includes('device');
      const record = hasDevice ? tx.objectStore('device').get('dev-store-write') : null;
      const duplicate = hasDevice ? tx.objectStore('device').get('dev-store-duplicate') : null;
      tx.oncomplete = () => {
        db.close();
        resolve({ version: db.version, stores, record: record?.result ?? null, duplicate: duplicate?.result ?? null });
      };
      tx.onabort = () => reject(new Error(String(tx.error)));
    };
  });
}

async function databaseNames(): Promise<unknown> {
  return (await indexedDB.databases()).map((d) => d.name ?? '').sort();
}

const SCHEMA = {
  assets: { keyPath: ['sceneId', 'assetId'], indexes: [] },
  caches: { keyPath: null, indexes: [] },
  device: { keyPath: null, indexes: [] },
  scenes: { keyPath: 'id', indexes: [{ name: 'updatedAt', keyPath: 'updatedAt' }] },
};

const SinkWrite = z.object({ kind: z.literal('store-write'), buildId: z.string(), write: Write, reconnects: z.number(), events: z.array(Event) });

async function sinkWrites(t: ScenarioContext): Promise<readonly z.infer<typeof SinkWrite>[]> {
  const lines = await t.server.sinkLines();
  return lines.flatMap((line) => ('row' in line ? [SinkWrite.safeParse(line.row)] : [])).flatMap((p) => (p.success ? [p.data] : []));
}

/** Checks that the sink holds one row per write, in order, with the page's build id and its outcomes. */
async function checkSink(t: ScenarioContext, view: View): Promise<void> {
  const rows = await sinkWrites(t);
  t.equal('the sink holds one store-write row per write, with each write\'s number and outcome', rows.map((r) => [r.write.n, r.write.result.ok, r.buildId]), writes(view).map((w) => [w.n, w.result.ok, t.build.buildId]));
  t.equal('every post was accepted', view.report.posts.notPosted, 0);
}

const causes = (v: View): readonly string[] => v.report.events.filter((e) => e.event === 'store.reconnect').map((e) => e.cause);

export const scenarios: readonly Scenario[] = [
  {
    id: 'store.write',
    title: 'the phone page: Write twice says "second write saved" with no store.reconnect, on one handle, and the database has schema version 1',
    target: 'dev',
    covers: ['F14'],
    readsSinkFiles: true,
    async run(t) {
      const ready = await open(t, false);
      t.equal('without ?levers=1 the levers are hidden', ready.leversHidden, true);
      t.equal('before a write the status says so', ready.status, 'No write yet.');
      t.equal('nothing opens before the first operation', ready.report.handlesOpened, 0);
      const first = await write(t, 1);
      t.equal('the first write is saved', first.status, 'first write saved');
      const second = await write(t, 2);
      t.equal('the second write is saved', second.status, 'second write saved');
      t.equal('the page shows no store.reconnect', second.reconnects, 'store.reconnect: 0');
      t.equal('both writes ran on one handle', second.report.handlesOpened, 1);
      const stored = await t.page.evaluate(Stored, readStored, PAGE_DB);
      t.equal('the database is at schema version 1', stored.version, 1);
      t.equal('the schema has the four stores, their keys, and the updatedAt index', stored.stores, SCHEMA);
      t.equal('the stored record is the second write', stored.record?.write, 2);
      t.equal('the page\'s database is the only one, so the app\'s is never opened', await t.page.evaluate(z.array(z.string()), databaseNames), [PAGE_DB]);
      await checkSink(t, second);
      await t.page.screenshot('second-write-saved');
    },
  },
  {
    id: 'store.inject-one',
    title: 'one injected InvalidStateError, at the first operation and at a later one: the write lands on a fresh handle with one store.reconnect each',
    target: 'dev',
    covers: ['F14'],
    readsSinkFiles: true,
    async run(t) {
      await open(t, true);
      await lever(t, 'inject-1');
      const first = await write(t, 1);
      t.equal('an error at the first operation: the write is saved', first.status, 'first write saved');
      t.equal('one store.reconnect, naming the injected InvalidStateError', causes(first), ['InvalidStateError: Injected by the store page: the connection is lost.']);
      t.equal('a second handle was opened for the retry', first.report.handlesOpened, 2);
      const second = await write(t, 2);
      t.equal('a healthy write after it adds no reconnect', [second.status, second.report.reconnects, second.report.handlesOpened], ['second write saved', 1, 2]);
      await lever(t, 'inject-1');
      const third = await write(t, 3);
      t.equal('an error at a later operation: the write is saved', third.status, 'third write saved');
      t.equal('one more store.reconnect, two in all', [third.report.reconnects, third.reconnects], [2, 'store.reconnect: 2']);
      t.equal('a third handle was opened for that retry', third.report.handlesOpened, 3);
      t.equal('the injection was used up', third.report.injection, 0);
      const stored = await t.page.evaluate(Stored, readStored, PAGE_DB);
      t.equal('the stored record is the third write', stored.record?.write, 3);
      await checkSink(t, third);
    },
  },
  {
    id: 'store.inject-two',
    title: 'two injected InvalidStateErrors in one write answer unavailable; with the injection gone the next write lands',
    target: 'dev',
    covers: ['F14'],
    readsSinkFiles: true,
    async run(t) {
      await open(t, true);
      await write(t, 1);
      await lever(t, 'inject-2');
      const failed = await write(t, 2);
      const cause = 'InvalidStateError: Injected by the store page: the connection is lost.';
      t.equal('the write answers unavailable, naming both losses', failed.status, `second write failed: unavailable (connection lost twice: ${cause}; then ${cause})`);
      t.equal('one store.reconnect: the retry\'s fresh handle', causes(failed), [cause]);
      t.equal('the write ran on the first handle and one fresh one, never a third', failed.report.handlesOpened, 2);
      t.equal('both injected errors were used, so the injection is gone', failed.report.injection, 0);
      const stored = await t.page.evaluate(Stored, readStored, PAGE_DB);
      t.equal('the unavailable write stored nothing: the record is still the first write', stored.record?.write, 1);
      const after = await write(t, 3);
      t.equal('the next write tries again from scratch and is saved', after.status, 'third write saved');
      t.equal('its fresh handle logs a second store.reconnect', [after.report.reconnects, after.report.handlesOpened], [2, 3]);
      t.equal('the stored record is the third write', (await t.page.evaluate(Stored, readStored, PAGE_DB)).record?.write, 3);
      await checkSink(t, after);
    },
  },
  {
    id: 'store.close-handle',
    title: 'a handle closed behind the connection\'s back: the next write meets Chrome\'s own InvalidStateError and lands on a fresh handle',
    target: 'dev',
    covers: ['F14'],
    readsSinkFiles: true,
    async run(t) {
      await open(t, true);
      await write(t, 1);
      await lever(t, 'close-handle');
      const after = await write(t, 2);
      t.equal('the write is saved', after.status, 'second write saved');
      const logged = causes(after);
      t.equal('one store.reconnect', logged.length, 1);
      t.ok('its cause is the browser\'s InvalidStateError', logged[0]?.startsWith('InvalidStateError: ') === true && !logged[0].includes('Injected'), { causes: logged });
      t.equal('a fresh handle was opened', after.report.handlesOpened, 2);
      t.equal('the stored record is the second write', (await t.page.evaluate(Stored, readStored, PAGE_DB)).record?.write, 2);
      await checkSink(t, after);
    },
  },
  {
    id: 'store.browser-close',
    title: 'a handle Chrome closes while a read awaits its requests: the transaction\'s UnknownError is retried with one store.reconnect, never answered io, and the next write lands',
    target: 'dev',
    covers: ['F14'],
    readsSinkFiles: true,
    async run(t) {
      await open(t, true);
      await write(t, 1);
      await lever(t, 'read-many');
      await until(t, 'the read to start', (v) => v.report.read?.phase === 'reading' || v.report.read?.phase === 'done');
      await t.page.clearIndexedDb();
      const done = await until(t, 'the read to settle', (v) => v.report.read?.phase === 'done', 15_000);
      const read = done.report.read;
      const logged = causes(done);
      t.ok('the read was still running when Chrome closed the handle', read?.attempts === 1 || read?.attempts === 2, { read });
      t.equal('one store.reconnect', logged.length, 1);
      t.ok('its cause is the transaction\'s UnknownError, not the requests\' AbortError', logged[0]?.startsWith('UnknownError: ') === true, { causes: logged });
      // The retry's open can meet the origin's deletion still under way and fail too; then the read is unavailable, which is a second loss and still not io.
      const result = read?.result;
      t.ok('the read is not answered as its own io: it lands on a fresh handle or is unavailable after two losses', result !== null && result !== undefined && (result.ok || (result.error.kind === 'unavailable' && result.error.detail?.startsWith(`connection lost twice: ${logged[0] ?? ''}; then `) === true)), { result });
      const after = await write(t, 2);
      t.equal('the next write tries again and is saved', after.status, 'second write saved');
      const stored = await t.page.evaluate(Stored, readStored, PAGE_DB);
      t.equal('the deleted database was created again at schema version 1, with the second write', [stored.version, stored.stores, stored.record?.write], [1, SCHEMA, 2]);
      await checkSink(t, after);
    },
  },
  {
    id: 'store.own-error',
    title: 'an operation\'s own ConstraintError answers io once, with no reconnect and the handle kept',
    target: 'dev',
    covers: ['F14'],
    readsSinkFiles: true,
    async run(t) {
      await open(t, true);
      await write(t, 1);
      await lever(t, 'add-duplicate');
      const view = await until(t, 'the duplicate add to settle', (v) => v.report.writes.some((w) => w.kind === 'add-duplicate'));
      const add = view.report.writes.find((w) => w.kind === 'add-duplicate');
      t.equal('the add answers io', add?.result.ok === false ? add.result.error.kind : null, 'io');
      t.ok('its detail is the ConstraintError', add?.result.ok === false && add.result.error.detail?.startsWith('ConstraintError: ') === true, { add });
      t.equal('no store.reconnect, and no fresh handle', [view.report.reconnects, view.report.handlesOpened], [0, 1]);
      const after = await write(t, 2);
      t.equal('the next write is saved on the same handle', [after.status, after.report.handlesOpened, after.report.reconnects], ['second write saved', 1, 0]);
      const stored = await t.page.evaluate(Stored, readStored, PAGE_DB);
      t.equal('the aborted transaction stored no duplicate', stored.duplicate, null);
      await checkSink(t, after);
    },
  },
  {
    id: 'store.versionchange',
    title: 'a versionchange from a second connection closes the handle and reloads the page, which then answers newer-version',
    target: 'dev',
    covers: ['F14', 'F15'],
    readsSinkFiles: true,
    async run(t) {
      const ready = await open(t, true);
      t.equal('the page was loaded by a navigation', ready.report.navigation, 'navigate');
      await write(t, 1);
      await lever(t, 'upgrade');
      const reloaded = await until(t, 'the page to reload', (v) => v.report.navigation === 'reload' && v.report.phase === 'ready' && v.report.frameReady, 15_000);
      t.ok('the page before the reload saw the versionchange', reloaded.report.previousVersionChange !== null, { previous: reloaded.report.previousVersionChange });
      const stored = await t.page.evaluate(Stored, readStored, PAGE_DB);
      t.equal('the second connection\'s upgrade went through, so the handle was closed', stored.version, 2);
      t.equal('the first write is still stored', stored.record?.write, 1);
      const after = await write(t, 1);
      t.equal('a write on the reloaded page answers newer-version', after.status, 'first write failed: newer-version');
      const result = after.report.writes[0]?.result;
      t.equal('with the database\'s version and no writer', result?.ok === false ? [result.error.version, result.error.writer] : null, [2, null]);
      t.equal('no store.reconnect, and no handle held', [after.report.reconnects, after.report.handlesOpened], [0, 0]);
      const rows = await sinkWrites(t);
      t.equal('the sink holds both pages\' writes', rows.map((r) => r.write.result.ok), [true, false]);
    },
  },
  {
    id: 'store.newer-version',
    title: 'a database at a higher schema version answers newer-version on every write, with no retry and no reconnect',
    target: 'dev',
    covers: ['F15'],
    readsSinkFiles: true,
    async run(t) {
      await open(t, true);
      await lever(t, 'upgrade');
      const upgraded = await until(t, 'the upgrade to finish', (v) => v.report.upgrade !== 'opening' && v.report.upgrade !== null);
      t.equal('with no handle open the upgrade is not blocked', upgraded.report.upgrade, 'upgraded');
      t.equal('and no versionchange reaches the page', upgraded.report.versionChanges, 0);
      const first = await write(t, 1);
      t.equal('the write answers newer-version', first.status, 'first write failed: newer-version');
      const result = first.report.writes[0]?.result;
      t.equal('with version 2 and no writer', result?.ok === false ? [result.error.version, result.error.writer] : null, [2, null]);
      const second = await write(t, 2);
      t.equal('the next write opens again and answers the same', second.status, 'second write failed: newer-version');
      t.equal('no store.reconnect, no handle', [second.report.reconnects, second.report.handlesOpened], [0, 0]);
      t.equal('the page is still the one loaded', second.report.navigation, 'navigate');
      await checkSink(t, second);
    },
  },
  {
    id: 'store.lock',
    title: 'a held scene lock is refused at once from the page and from a same-origin frame, nothing queued, and granted to both once released',
    target: 'dev',
    covers: ['F21'],
    async run(t) {
      await open(t, true);
      await lever(t, 'hold');
      const held = await until(t, 'the hold', (v) => v.report.locks.length >= 1);
      t.equal('the hold is granted and held', held.report.locks[0] === undefined ? null : [held.report.locks[0].action, held.report.locks[0].outcome, held.report.locks[0].held], ['hold', 'granted', 1]);
      await lever(t, 'ask-page');
      const page = (await until(t, 'the page\'s ask', (v) => v.report.locks.length >= 2)).report.locks[1];
      t.equal('the page is refused open-elsewhere', page?.outcome, 'open-elsewhere');
      t.ok('in under 500 ms', page !== undefined && page.ms < 500, { ms: page?.ms });
      t.equal('without queueing: the lock is held once and nothing is pending', page === undefined ? null : [page.held, page.pending], [1, 0]);
      await lever(t, 'ask-frame');
      const frame = (await until(t, 'the frame\'s ask', (v) => v.report.locks.length >= 3)).report.locks[2];
      t.equal('the frame is refused open-elsewhere', frame === undefined ? null : [frame.from, frame.outcome], ['frame', 'open-elsewhere']);
      t.ok('in under 500 ms', frame !== undefined && frame.ms < 500, { ms: frame?.ms });
      t.equal('without queueing', frame === undefined ? null : [frame.held, frame.pending], [1, 0]);
      await lever(t, 'release');
      const ended = (await until(t, 'the release', (v) => v.report.locks.length >= 4)).report.locks[3];
      t.equal('the hold ends released, and the lock is free', ended === undefined ? null : [ended.action, ended.outcome, ended.held, ended.pending], ['hold-ended', 'released', 0, 0]);
      await lever(t, 'ask-frame');
      const frameAfter = (await until(t, 'the frame\'s second ask', (v) => v.report.locks.length >= 5)).report.locks[4];
      t.equal('the frame is granted after the release', frameAfter === undefined ? null : [frameAfter.from, frameAfter.outcome], ['frame', 'granted']);
      await lever(t, 'ask-page');
      const pageAfter = (await until(t, 'the page\'s second ask', (v) => v.report.locks.length >= 6)).report.locks[5];
      t.equal('the page is granted after the release', pageAfter === undefined ? null : [pageAfter.from, pageAfter.outcome, pageAfter.held], ['page', 'granted', 0]);
      await t.file('locks.json', JSON.stringify((await until(t, 'the report', () => true)).report.locks, null, 2));
    },
  },
  {
    id: 'store.lock-release',
    title: 'a scene lock is released when its function rejects and when it throws',
    target: 'dev',
    covers: ['F21'],
    async run(t) {
      await open(t, true);
      await lever(t, 'hold');
      await until(t, 'the hold', (v) => v.report.locks.length >= 1);
      await lever(t, 'ask-frame');
      const refused = (await until(t, 'the frame\'s ask', (v) => v.report.locks.length >= 2)).report.locks[1];
      t.equal('while held, the frame is refused', refused?.outcome, 'open-elsewhere');
      await lever(t, 'release-reject');
      const ended = (await until(t, 'the rejection', (v) => v.report.locks.length >= 3)).report.locks[2];
      t.equal('the hold ends with fn\'s rejection, and the lock is free', ended === undefined ? null : [ended.action, ended.outcome, ended.held], ['hold-ended', 'rejected: Error: the holder failed', 0]);
      await lever(t, 'ask-frame');
      const granted = (await until(t, 'the frame\'s second ask', (v) => v.report.locks.length >= 4)).report.locks[3];
      t.equal('the frame is granted after the rejection', granted?.outcome, 'granted');
      await lever(t, 'throw');
      const thrown = (await until(t, 'the throw', (v) => v.report.locks.length >= 5)).report.locks[4];
      t.equal('a throwing fn rejects with its error, and the lock is free', thrown === undefined ? null : [thrown.action, thrown.outcome, thrown.held], ['throw', 'rejected: Error: thrown inside the lock', 0]);
      await lever(t, 'ask-frame');
      const after = (await until(t, 'the frame\'s third ask', (v) => v.report.locks.length >= 6)).report.locks[5];
      t.equal('the frame is granted after the throw', after?.outcome, 'granted');
    },
  },
];
