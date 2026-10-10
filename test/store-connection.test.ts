// src/store/connection.ts, the store's connection, driven with a scripted
// opener whose handles the test closes, fails, and fires events on: healthy
// operations, one and two connection errors at the first and at a later
// operation, a handle the browser closes while idle and while an operation
// runs, a versionchange, a database at a newer version, failed opens, an
// operation's own errors, and concurrent operations during a reopen. The
// browser scenarios in test/browser/scenarios/store.scenario.ts drive the
// same connection on the real IndexedDB.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { err, ok, type Result } from '../src/core/result.ts';
import type { Clock } from '../src/platform/clock.ts';
import { createDiagnostics } from '../src/platform/diagnostics.ts';
import {
  createStoreConnection,
  describeError,
  isConnectionError,
  type HandleListeners,
  type OpenedHandle,
  type OpenFailure,
  type StoreConnection,
  type StoreError,
  type StoreEvent,
  type StoreOperation,
} from '../src/store/connection.ts';

/** A scripted database handle: an operation on a closed one throws InvalidStateError, as IndexedDB's transaction() does. */
type FakeDb = { readonly id: number; closed: boolean; closeCalls: number; listeners: HandleListeners };

type OpenAnswer = 'ok' | OpenFailure | { readonly kind: 'throw'; readonly error: unknown } | { readonly kind: 'reject'; readonly error: unknown };

type Harness = {
  readonly connection: StoreConnection<FakeDb>;
  /** Every handle opened, in order. */
  readonly handles: FakeDb[];
  /** How many times the opener was called. */
  opens: number;
  /** Answers for the next opens, first first; an empty list answers 'ok'. */
  readonly answers: OpenAnswer[];
  /** While set, opens wait until it is called. */
  gate: Promise<void> | null;
  versionChanges: number;
  events(): readonly StoreEvent[];
};

const clock: Clock = { now: () => 0, wallNow: () => 0, setTimeout: () => 0, clearTimeout: () => undefined };

function harness(): Harness {
  const diag = createDiagnostics<StoreEvent>(clock);
  const h: Harness = {
    connection: createStoreConnection<FakeDb>({
      open: (listeners) => {
        h.opens += 1;
        const answer = h.answers.shift() ?? 'ok';
        if (typeof answer === 'object' && answer.kind === 'throw') throw answer.error;
        if (typeof answer === 'object' && answer.kind === 'reject') return Promise.reject(answer.error);
        const gate = h.gate;
        const settle = (): Result<OpenedHandle<FakeDb>, OpenFailure> => {
          if (answer !== 'ok') return err(answer);
          const db: FakeDb = { id: h.handles.length + 1, closed: false, closeCalls: 0, listeners };
          h.handles.push(db);
          return ok({
            db,
            close: () => {
              db.closed = true;
              db.closeCalls += 1;
            },
          });
        };
        return gate === null ? Promise.resolve(settle()) : gate.then(settle);
      },
      diag,
      onVersionChange: () => {
        h.versionChanges += 1;
      },
    }),
    handles: [],
    opens: 0,
    answers: [],
    gate: null,
    versionChanges: 0,
    events: () => diag.events.map(({ event, cause }) => ({ event, cause })),
  };
  return h;
}

const invalidState = (): DOMException => new DOMException('The database connection is closing.', 'InvalidStateError');
const unknownError = (): DOMException => new DOMException('Connection to Indexed Database server lost. Refresh the page to try again', 'UnknownError');

/** An operation that answers the id of the handle it ran on, failing as a closed handle does. */
const whichHandle: StoreOperation<FakeDb, number> = async (db) => {
  if (db.closed) throw invalidState();
  return ok(db.id);
};

/** An operation that throws the scripted errors in turn, once each, then answers the handle's id; it records each handle it ran on. */
function failing(errors: readonly unknown[]): StoreOperation<FakeDb, number> & { readonly ranOn: number[] } {
  const queue = [...errors];
  const ranOn: number[] = [];
  const op = async (db: FakeDb): Promise<Result<number, StoreError>> => {
    ranOn.push(db.id);
    if (queue.length > 0) throw queue.shift();
    if (db.closed) throw invalidState();
    return ok(db.id);
  };
  return Object.assign(op, { ranOn });
}

/** A promise and the function that resolves it. */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const reconnect = (cause: string): StoreEvent => ({ event: 'store.reconnect', cause });

// ---------------------------------------------------------------- the error classes

test('InvalidStateError and UnknownError are connection errors; ConstraintError, QuotaExceededError, AbortError, and non-errors are not', () => {
  assert.equal(isConnectionError(invalidState()), true);
  assert.equal(isConnectionError(unknownError()), true);
  for (const name of ['ConstraintError', 'QuotaExceededError', 'AbortError', 'DataError', 'TransactionInactiveError', 'TypeError']) {
    assert.equal(isConnectionError(new DOMException('x', name)), false, name);
  }
  assert.equal(isConnectionError(new TypeError('x')), false);
  assert.equal(isConnectionError('InvalidStateError'), false);
  assert.equal(isConnectionError(null), false);
  assert.equal(describeError(invalidState()), 'InvalidStateError: The database connection is closing.');
  assert.equal(describeError(new DOMException('', 'UnknownError')), 'UnknownError');
  assert.equal(describeError(42), '42');
});

// ---------------------------------------------------------------- healthy

test('healthy operations open one handle on the first operation and share it; nothing is logged', async () => {
  const h = harness();
  assert.equal(h.opens, 0, 'nothing opens before the first operation');
  assert.deepEqual(await h.connection.run(whichHandle), ok(1));
  assert.deepEqual(await Promise.all([h.connection.run(whichHandle), h.connection.run(whichHandle)]), [ok(1), ok(1)]);
  assert.equal(h.opens, 1);
  assert.deepEqual(h.events(), []);
});

test('operations started together before the first open settles share that one open', async () => {
  const h = harness();
  const gate = deferred();
  h.gate = gate.promise;
  const runs = [h.connection.run(whichHandle), h.connection.run(whichHandle), h.connection.run(whichHandle)];
  gate.resolve();
  assert.deepEqual(await Promise.all(runs), [ok(1), ok(1), ok(1)]);
  assert.equal(h.opens, 1);
});

// ---------------------------------------------------------------- connection errors

for (const [label, make] of [['InvalidStateError', invalidState], ['UnknownError', unknownError]] as const) {
  for (const before of [0, 2]) {
    test(`one ${label} at operation ${before + 1}: retried once on a fresh handle, the old one closed, one store.reconnect with its cause`, async () => {
      const h = harness();
      for (let i = 0; i < before; i += 1) assert.deepEqual(await h.connection.run(whichHandle), ok(1));
      const op = failing([make()]);
      assert.deepEqual(await h.connection.run(op), ok(2));
      assert.deepEqual(op.ranOn, [1, 2], 'the operation ran on the first handle, then once on a fresh one');
      assert.equal(h.handles[0]?.closeCalls, 1, 'the lost handle is closed');
      assert.deepEqual(h.events(), [reconnect(describeError(make()))]);
      assert.deepEqual(await h.connection.run(whichHandle), ok(2), 'later operations use the fresh handle');
      assert.equal(h.opens, 2);
    });

    test(`two ${label}s at operation ${before + 1}: unavailable naming both causes; the next operation tries again from scratch`, async () => {
      const h = harness();
      for (let i = 0; i < before; i += 1) assert.deepEqual(await h.connection.run(whichHandle), ok(1));
      const op = failing([make(), make()]);
      const cause = describeError(make());
      assert.deepEqual(await h.connection.run(op), err({ kind: 'unavailable', detail: `connection lost twice: ${cause}; then ${cause}` }));
      assert.deepEqual(op.ranOn, [1, 2], 'two attempts, never a third');
      assert.deepEqual([h.handles[0]?.closed, h.handles[1]?.closed], [true, true], 'both handles are dropped');
      assert.deepEqual(h.events(), [reconnect(cause)], 'one reopen so far');
      assert.deepEqual(await h.connection.run(whichHandle), ok(3), 'the next operation opens a fresh handle and succeeds');
      assert.deepEqual(h.events(), [reconnect(cause), reconnect(cause)]);
    });
  }
}

test('a connection error, then the operation\'s own error on the fresh handle: the own error, not unavailable', async () => {
  const h = harness();
  const op = failing([invalidState(), new DOMException('Key already exists in the object store.', 'ConstraintError')]);
  assert.deepEqual(await h.connection.run(op), err({ kind: 'io', detail: 'ConstraintError: Key already exists in the object store.' }));
  assert.deepEqual(op.ranOn, [1, 2]);
  assert.deepEqual(await h.connection.run(whichHandle), ok(2), 'the own error kept the fresh handle');
});

// ---------------------------------------------------------------- the browser closes the handle

test('a handle the browser closes while idle: the next operation opens a fresh one and logs store.reconnect with cause close', async () => {
  const h = harness();
  assert.deepEqual(await h.connection.run(whichHandle), ok(1));
  const first = h.handles[0];
  assert.ok(first !== undefined);
  first.closed = true;
  first.listeners.onClose();
  first.listeners.onClose();
  assert.deepEqual(h.events(), [], 'nothing is logged until a fresh handle is opened');
  assert.deepEqual(await h.connection.run(whichHandle), ok(2));
  assert.deepEqual(h.events(), [reconnect('close')]);
  assert.equal(h.opens, 2);
});

test('a handle the browser closes during an operation: whatever the operation then throws is a connection error, retried once', async () => {
  const h = harness();
  assert.deepEqual(await h.connection.run(whichHandle), ok(1));
  const inFlight = deferred();
  let calls = 0;
  const op: StoreOperation<FakeDb, number> = async (db) => {
    calls += 1;
    if (calls === 1) {
      await inFlight.promise;
      throw new DOMException('The transaction was aborted, so the request cannot be fulfilled.', 'AbortError');
    }
    return ok(db.id);
  };
  const run = h.connection.run(op);
  await Promise.resolve();
  h.handles[0]?.listeners.onClose();
  inFlight.resolve();
  assert.deepEqual(await run, ok(2));
  assert.equal(calls, 2);
  assert.deepEqual(h.events(), [reconnect('close')], 'one reconnect for the one lost handle');
});

test('a handle the browser closes during an operation, then a connection error on the fresh one: unavailable naming the close and the error', async () => {
  const h = harness();
  assert.deepEqual(await h.connection.run(whichHandle), ok(1));
  const inFlight = deferred();
  let calls = 0;
  const op: StoreOperation<FakeDb, number> = async () => {
    calls += 1;
    if (calls === 1) {
      await inFlight.promise;
      throw new DOMException('The transaction was aborted, so the request cannot be fulfilled.', 'AbortError');
    }
    throw invalidState();
  };
  const run = h.connection.run(op);
  await Promise.resolve();
  h.handles[0]?.listeners.onClose();
  inFlight.resolve();
  assert.deepEqual(
    await run,
    err({ kind: 'unavailable', detail: `connection lost twice: close: AbortError: The transaction was aborted, so the request cannot be fulfilled.; then ${describeError(invalidState())}` }),
  );
  assert.deepEqual(h.events(), [reconnect('close')], 'the logged cause is the close event\'s');
});

test('a logged cause is logged once: an open after a reconnect and a later versionchange or newer-version answer logs nothing more', async () => {
  const h = harness();
  assert.deepEqual(await h.connection.run(failing([invalidState()])), ok(2));
  assert.deepEqual(h.events(), [reconnect(describeError(invalidState()))]);
  h.handles[1]?.listeners.onVersionChange();
  assert.deepEqual(await h.connection.run(whichHandle), ok(3), 'the open after the versionchange');
  h.handles[2]?.listeners.onVersionChange();
  h.answers.push({ kind: 'newer-version', version: 2 });
  assert.deepEqual(await h.connection.run(whichHandle), err({ kind: 'newer-version', version: 2, writer: null }));
  assert.deepEqual(await h.connection.run(whichHandle), ok(4), 'the open after the newer-version answer');
  assert.equal(h.opens, 5, 'two for the reconnect, then one each after the versionchange, for the newer-version answer, and after it');
  assert.deepEqual(h.events(), [reconnect(describeError(invalidState()))], 'still the one store.reconnect');
});

// ---------------------------------------------------------------- versionchange and newer versions

test('versionchange closes the handle and calls onVersionChange once; the next operation opens a fresh handle without a reconnect', async () => {
  const h = harness();
  assert.deepEqual(await h.connection.run(whichHandle), ok(1));
  const first = h.handles[0];
  assert.ok(first !== undefined);
  first.listeners.onVersionChange();
  first.listeners.onVersionChange();
  assert.equal(first.closeCalls, 1, 'closed once');
  assert.equal(h.versionChanges, 1, 'onVersionChange once');
  assert.deepEqual(await h.connection.run(whichHandle), ok(2));
  assert.deepEqual(h.events(), [], 'a versionchange is not a lost connection');
});

test('a versionchange during an operation closes the handle at once; an operation that does not touch the handle again finishes with its own result', async () => {
  const h = harness();
  const inFlight = deferred();
  const op: StoreOperation<FakeDb, string> = async (db) => {
    await inFlight.promise;
    return ok(`ran on ${db.id}`);
  };
  const run = h.connection.run(op);
  await new Promise((r) => setImmediate(r));
  const first = h.handles[0];
  assert.ok(first !== undefined);
  first.listeners.onVersionChange();
  assert.deepEqual([first.closed, first.closeCalls], [true, 1], 'the connection closed the handle before the operation finished');
  inFlight.resolve();
  assert.deepEqual(await run, ok('ran on 1'));
  assert.equal(h.versionChanges, 1);
  assert.equal(h.opens, 1, 'the operation was not run again');
});

test('an InvalidStateError on a handle closed for a versionchange is retried once on a fresh handle and logs no store.reconnect', async () => {
  const h = harness();
  const inFlight = deferred();
  const ranOn: number[] = [];
  const op: StoreOperation<FakeDb, number> = async (db) => {
    ranOn.push(db.id);
    if (ranOn.length === 1) await inFlight.promise;
    if (db.closed) throw invalidState();
    return ok(db.id);
  };
  const run = h.connection.run(op);
  await new Promise((r) => setImmediate(r));
  h.handles[0]?.listeners.onVersionChange();
  inFlight.resolve();
  assert.deepEqual(await run, ok(2));
  assert.deepEqual(ranOn, [1, 2]);
  assert.equal(h.versionChanges, 1);
  assert.deepEqual(h.events(), [], 'the connection closed the handle itself, so nothing was lost');
});

test('a database at a newer version answers newer-version without running the operation or retrying; the next operation opens again', async () => {
  const h = harness();
  h.answers.push({ kind: 'newer-version', version: 2 }, { kind: 'newer-version', version: 2 });
  let ran = 0;
  const op: StoreOperation<FakeDb, null> = async () => {
    ran += 1;
    return ok(null);
  };
  assert.deepEqual(await h.connection.run(op), err({ kind: 'newer-version', version: 2, writer: null }));
  assert.equal(h.opens, 1, 'one open, no retry');
  assert.deepEqual(await h.connection.run(op), err({ kind: 'newer-version', version: 2, writer: null }));
  assert.equal(h.opens, 2, 'the next operation tries to open again');
  assert.equal(ran, 0);
  assert.deepEqual(h.events(), []);
});

test('a connection error, then newer-version on the reopen: newer-version', async () => {
  const h = harness();
  assert.deepEqual(await h.connection.run(whichHandle), ok(1));
  h.answers.push({ kind: 'newer-version', version: 3 });
  assert.deepEqual(await h.connection.run(failing([invalidState()])), err({ kind: 'newer-version', version: 3, writer: null }));
  assert.deepEqual(h.events(), [reconnect(describeError(invalidState()))]);
});

// ---------------------------------------------------------------- failed opens

test('a failed open is a connection error: retried once with a reconnect; twice answers unavailable', async () => {
  const once = harness();
  once.answers.push({ kind: 'failed', cause: 'UnknownError: Internal error opening backing store' });
  assert.deepEqual(await once.connection.run(whichHandle), ok(1));
  assert.deepEqual(once.events(), [reconnect('open: UnknownError: Internal error opening backing store')]);

  const twice = harness();
  twice.answers.push({ kind: 'failed', cause: 'UnknownError: a' }, { kind: 'failed', cause: 'UnknownError: b' });
  assert.deepEqual(await twice.connection.run(whichHandle), err({ kind: 'unavailable', detail: 'connection lost twice: open: UnknownError: a; then open: UnknownError: b' }));
  assert.equal(twice.opens, 2);
  assert.deepEqual(await twice.connection.run(whichHandle), ok(1), 'the next operation opens again from scratch');
});

test('an opener that throws or rejects instead of answering fails the open, which is retried', async () => {
  const h = harness();
  h.answers.push({ kind: 'throw', error: new TypeError('no indexedDB') }, { kind: 'reject', error: new DOMException('x', 'UnknownError') });
  assert.deepEqual(await h.connection.run(whichHandle), err({ kind: 'unavailable', detail: 'connection lost twice: open: TypeError: no indexedDB; then open: UnknownError: x' }));
  assert.deepEqual(await h.connection.run(whichHandle), ok(1));
});

// ---------------------------------------------------------------- an operation's own errors

test('an operation\'s own errors are returned once, never retried, never unavailable, and keep the handle', async () => {
  const cases: readonly (readonly [string, unknown, StoreError])[] = [
    ['a constraint error', new DOMException('Key already exists in the object store.', 'ConstraintError'), { kind: 'io', detail: 'ConstraintError: Key already exists in the object store.' }],
    ['a quota error', new DOMException('The quota has been exceeded.', 'QuotaExceededError'), { kind: 'quota' }],
    ['an AbortError on a handle still open', new DOMException('The transaction was aborted.', 'AbortError'), { kind: 'io', detail: 'AbortError: The transaction was aborted.' }],
    ['a TypeError', new TypeError('bad key'), { kind: 'io', detail: 'TypeError: bad key' }],
    ['a thrown string', 'oops', { kind: 'io', detail: 'oops' }],
  ];
  for (const [label, thrown, expected] of cases) {
    const h = harness();
    const op = failing([thrown]);
    assert.deepEqual(await h.connection.run(op), err(expected), label);
    assert.deepEqual(op.ranOn, [1], `${label}: run once`);
    assert.deepEqual(await h.connection.run(whichHandle), ok(1), `${label}: the handle is kept`);
    assert.deepEqual([h.opens, h.events()], [1, []], `${label}: no reopen, nothing logged`);
  }
});

test('an operation\'s own err result is passed through as it is', async () => {
  const h = harness();
  const op: StoreOperation<FakeDb, never> = async () => err({ kind: 'missing' });
  assert.deepEqual(await h.connection.run(op), err({ kind: 'missing' }));
  assert.equal(h.opens, 1);
});

test('an operation that throws synchronously is classified like one that rejects', async () => {
  const h = harness();
  let calls = 0;
  const op: StoreOperation<FakeDb, number> = (db) => {
    calls += 1;
    if (calls === 1) throw invalidState();
    return Promise.resolve(ok(db.id));
  };
  assert.deepEqual(await h.connection.run(op), ok(2));
  assert.equal(calls, 2);
});

// ---------------------------------------------------------------- concurrency

test('concurrent operations failing on one lost handle share one reopen and one reconnect', async () => {
  const h = harness();
  assert.deepEqual(await h.connection.run(whichHandle), ok(1));
  const gate = deferred();
  h.gate = gate.promise;
  const ops = [failing([invalidState()]), failing([invalidState()]), failing([unknownError()])];
  const runs = ops.map((op) => h.connection.run(op));
  await new Promise((r) => setImmediate(r));
  assert.equal(h.opens, 2, 'the reopen is under way');
  // A further operation starts while the reopen is still under way.
  const late = h.connection.run(whichHandle);
  gate.resolve();
  const results = await Promise.all([...runs, late]);
  assert.equal(h.opens, 2, 'one reopen');
  assert.deepEqual(results, [ok(2), ok(2), ok(2), ok(2)]);
  assert.deepEqual(h.events(), [reconnect(describeError(invalidState()))], 'one reconnect, with the first cause');
});

test('an operation that starts while a reopen is pending waits for it and opens nothing of its own', async () => {
  const h = harness();
  assert.deepEqual(await h.connection.run(whichHandle), ok(1));
  const gate = deferred();
  h.gate = gate.promise;
  const failed = h.connection.run(failing([invalidState()]));
  await new Promise((r) => setImmediate(r));
  assert.equal(h.opens, 2, 'the reopen is under way');
  const waiting = [h.connection.run(whichHandle), h.connection.run(whichHandle)];
  gate.resolve();
  assert.deepEqual(await Promise.all([failed, ...waiting]), [ok(2), ok(2), ok(2)]);
  assert.equal(h.opens, 2);
});

test('a second operation failing on a handle already replaced retries on the replacement and logs nothing more', async () => {
  const h = harness();
  assert.deepEqual(await h.connection.run(whichHandle), ok(1));
  const slow = deferred();
  let slowCalls = 0;
  const slowOp: StoreOperation<FakeDb, number> = async (db) => {
    slowCalls += 1;
    if (slowCalls === 1) {
      await slow.promise;
      throw invalidState();
    }
    return ok(db.id);
  };
  const slowRun = h.connection.run(slowOp);
  assert.deepEqual(await h.connection.run(failing([invalidState()])), ok(2));
  slow.resolve();
  assert.deepEqual(await slowRun, ok(2));
  assert.equal(h.opens, 2);
  assert.deepEqual(h.events(), [reconnect(describeError(invalidState()))]);
});
