// What the driver starts, and how it is stopped. Every child runs in its own
// process group (spawned detached), so a Ctrl-C in the terminal reaches only
// the driver, which then stops each group itself: Chrome's helper processes
// and the server go with their leader. Every resource registers a disposer
// with the run's Cleanup, which runs on success, failure, and interruption.

import type { ChildProcess } from 'node:child_process';

/** Something outside the scenarios is missing or broken: Chrome, a build, the server. The CLI exits 3 on it. */
export class EnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentError';
  }
}

/** How long one disposer may run before the cleanup reports it and moves on to the next. */
const DISPOSE_TIMEOUT_MS = 20_000;

export type Cleanup = {
  /**
   * Registers a disposer, and optionally `force`, a synchronous last resort
   * (SIGKILL a process group, delete a directory) for a forced stop; returns
   * the unregister.
   */
  add(label: string, dispose: () => Promise<void>, force?: () => void): () => void;
  /**
   * Runs the disposers newest first, each for at most 20 seconds; idempotent,
   * never throws; resolves with what could not be stopped.
   */
  run(): Promise<readonly string[]>;
  /** Runs `force` of everything not yet disposed, newest first, synchronously; returns what failed. */
  force(): readonly string[];
};

type CleanupEntry = { readonly label: string; readonly dispose: () => Promise<void>; readonly force: (() => void) | null; started: boolean };

export function createCleanup(): Cleanup {
  const entries: CleanupEntry[] = [];
  let running: Promise<readonly string[]> | null = null;
  const remove = (entry: CleanupEntry): void => {
    const at = entries.indexOf(entry);
    if (at !== -1) entries.splice(at, 1);
  };
  return {
    add(label, dispose, force) {
      const entry: CleanupEntry = { label, dispose, force: force ?? null, started: false };
      entries.push(entry);
      return () => remove(entry);
    },
    run() {
      running ??= (async () => {
        const failures: string[] = [];
        for (let entry = entries.findLast((e) => !e.started); entry !== undefined; entry = entries.findLast((e) => !e.started)) {
          entry.started = true;
          let timer: NodeJS.Timeout | undefined;
          const timeout = new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), DISPOSE_TIMEOUT_MS);
          });
          try {
            const result = await Promise.race([entry.dispose().then(() => 'done' as const), timeout]);
            if (result === 'timeout') failures.push(`${entry.label}: did not stop within ${DISPOSE_TIMEOUT_MS / 1000} s`);
            else remove(entry);
          } catch (e) {
            failures.push(`${entry.label}: ${e instanceof Error ? e.message : String(e)}`);
          } finally {
            clearTimeout(timer);
          }
        }
        return failures;
      })();
      return running;
    },
    force() {
      const failures: string[] = [];
      for (const entry of [...entries].reverse()) {
        if (entry.force === null) continue;
        try {
          entry.force();
        } catch (e) {
          failures.push(`${entry.label}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return failures;
    },
  };
}

export function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

/** Sends `signal` to the child's process group; a group that is already gone is not an error. */
export function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group is already gone.
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends `signal` to the child's process group, waits up to `graceMs` for the
 * leader to exit, then SIGKILLs the group, which also takes any helper the
 * leader left behind.
 */
export async function stopGroup(child: ChildProcess, signal: NodeJS.Signals | null, graceMs: number): Promise<void> {
  if (signal !== null) killGroup(child, signal);
  await Promise.race([exited(child), sleep(graceMs)]);
  killGroup(child, 'SIGKILL');
  await Promise.race([exited(child), sleep(graceMs)]);
}
