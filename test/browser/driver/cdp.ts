// A Chrome DevTools Protocol connection over the pipe Chrome opens with
// --remote-debugging-pipe: the driver writes commands to Chrome's fd 3 and
// reads replies and events from its fd 4, each message one JSON text ended by
// a NUL byte. Sessions are flat: a command or event for an attached target
// carries that target's sessionId.

import type { Readable, Writable } from 'node:stream';
import { z } from '../../../src/core/zod.ts';

export type CdpEvent = { readonly method: string; readonly params: unknown; readonly sessionId: string | null };

export type CdpConnection = {
  /** Sends a command and resolves with its `result`, or rejects with the protocol's error. */
  send(method: string, params?: Readonly<Record<string, unknown>>, sessionId?: string | null): Promise<unknown>;
  /** Calls the listener for every event; returns its unsubscribe. */
  onEvent(listener: (event: CdpEvent) => void): () => void;
  /** Calls the listener once when the connection closes, with the reason; returns its unsubscribe. */
  onClose(listener: (reason: string) => void): () => void;
  /** Why the connection closed, or null while it is open. */
  closedReason(): string | null;
  /**
   * Rejects every pending command of one session, such as a page whose
   * renderer crashed: Chrome never answers those. A detached session's
   * commands are rejected the same way without being asked.
   */
  rejectSession(sessionId: string, reason: string): void;
  /** Rejects every pending command; later sends reject at once. */
  close(reason: string): void;
};

const Message = z.union([
  z.object({
    id: z.number(),
    result: z.unknown().optional(),
    error: z.object({ code: z.number(), message: z.string(), data: z.string().optional() }).optional(),
  }),
  z.object({ method: z.string(), params: z.unknown().optional(), sessionId: z.string().optional() }),
]);

const Detached = z.object({ sessionId: z.string() });

export function connectPipe(toChrome: Writable, fromChrome: Readable): CdpConnection {
  let nextId = 0;
  let closedReason: string | null = null;
  const pending = new Map<number, { readonly method: string; readonly sessionId: string | null; resolve(v: unknown): void; reject(e: Error): void }>();
  const listeners = new Set<(event: CdpEvent) => void>();
  const closeListeners = new Set<(reason: string) => void>();
  /** The bytes of a message whose terminating NUL has not arrived yet, chunk by chunk. */
  let partial: Buffer[] = [];

  const dispatch = (text: string): void => {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    const parsed = Message.safeParse(json);
    if (!parsed.success) return;
    const message = parsed.data;
    if ('id' in message) {
      const waiter = pending.get(message.id);
      if (waiter === undefined) return;
      pending.delete(message.id);
      if (message.error !== undefined) waiter.reject(new Error(`${waiter.method}: ${message.error.message}${message.error.data === undefined ? '' : ` (${message.error.data})`}`));
      else waiter.resolve(message.result);
      return;
    }
    const event: CdpEvent = { method: message.method, params: message.params, sessionId: message.sessionId ?? null };
    if (event.method === 'Target.detachedFromTarget') {
      const detached = Detached.safeParse(event.params);
      if (detached.success) connection.rejectSession(detached.data.sessionId, 'the target detached');
    }
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A listener's failure must not stop the stream that feeds every other one.
      }
    }
  };

  // Each chunk is scanned once and each message joined once, so a reply of
  // many megabytes costs time in proportion to its size.
  fromChrome.on('data', (chunk: Buffer) => {
    let start = 0;
    for (let end = chunk.indexOf(0, start); end !== -1; end = chunk.indexOf(0, start)) {
      partial.push(chunk.subarray(start, end));
      const text = Buffer.concat(partial).toString('utf8');
      partial = [];
      start = end + 1;
      dispatch(text);
    }
    if (start < chunk.length) partial.push(chunk.subarray(start));
  });
  fromChrome.on('close', () => connection.close('Chrome closed the DevTools pipe'));
  toChrome.on('error', () => connection.close('the DevTools pipe to Chrome failed'));

  const connection: CdpConnection = {
    send(method, params = {}, sessionId = null) {
      if (closedReason !== null) return Promise.reject(new Error(`${method}: ${closedReason}`));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { method, sessionId, resolve, reject });
        toChrome.write(`${JSON.stringify(sessionId === null ? { id, method, params } : { id, method, params, sessionId })}\0`);
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    closedReason: () => closedReason,
    rejectSession(sessionId, reason) {
      for (const [id, waiter] of pending) {
        if (waiter.sessionId !== sessionId) continue;
        pending.delete(id);
        waiter.reject(new Error(`${waiter.method}: ${reason}`));
      }
    },
    close(reason) {
      if (closedReason !== null) return;
      closedReason = reason;
      for (const [id, waiter] of pending) {
        pending.delete(id);
        waiter.reject(new Error(`${waiter.method}: ${reason}`));
      }
      for (const listener of closeListeners) {
        try {
          listener(reason);
        } catch {
          // One listener's failure must not keep the others from hearing of the close.
        }
      }
      closeListeners.clear();
    },
  };
  return connection;
}
