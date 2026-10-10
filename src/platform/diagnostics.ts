// The diagnostics ring buffer, generic over the event type: platform/ names no
// domain event. Each module declares the events it logs and takes a sink of
// only those; the composition root declares their union, creates the page's
// one buffer, and hands it to each module, whose narrower sink accepts it.

import type { Clock } from './clock.ts';

type AnyEvent = { readonly event: string };

export interface DiagnosticSink<E extends AnyEvent> {
  // A property, not a method: method parameters are bivariant in TypeScript,
  // which would let a sink of one module's events stand in for a sink of the
  // whole union.
  readonly log: (e: E) => void;
}

export interface Diagnostics<E extends AnyEvent> extends DiagnosticSink<E> {
  /** The retained events, oldest first; `t` is `clock.now()` when the event was logged. */
  readonly events: readonly (E & { readonly t: number })[];
  /**
   * JSON: `{ "capacity", "dropped", "events" }`, where `dropped` counts events
   * the ring overwrote. Never throws: an Error field exports as its name and
   * message, a bigint as its decimal text, and an event JSON cannot hold (a
   * cycle) as its `event` and `t` with an `unserializable` reason.
   */
  export(): string;
}

export const DEFAULT_CAPACITY = 500;

/** A ring of `capacity` events: logging into a full ring overwrites the oldest event. */
export function createDiagnostics<E extends AnyEvent>(clock: Clock, capacity: number = DEFAULT_CAPACITY): Diagnostics<E> {
  if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`capacity must be a whole number of at least 1, not ${capacity}`);
  const ring: (E & { readonly t: number })[] = [];
  let next = 0;
  let dropped = 0;
  const ordered = (): readonly (E & { readonly t: number })[] => [...ring.slice(next), ...ring.slice(0, next)];
  return {
    log: (e) => {
      const entry = { ...e, t: clock.now() };
      if (ring.length < capacity) {
        ring.push(entry);
        return;
      }
      ring[next] = entry;
      next = (next + 1) % capacity;
      dropped += 1;
    },
    get events() {
      return ordered();
    },
    export: () => `{"capacity":${capacity},"dropped":${dropped},"events":[${ordered().map(encode).join(',')}]}`,
  };
}

const replacer = (_key: string, value: unknown): unknown => {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === 'bigint') return value.toString();
  return value;
};

function encode(entry: AnyEvent & { readonly t: number }): string {
  try {
    return JSON.stringify(entry, replacer);
  } catch (e) {
    return JSON.stringify({ event: entry.event, t: entry.t, unserializable: e instanceof Error ? e.message : String(e) });
  }
}
