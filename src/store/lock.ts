// The scene lock: one holder per scene across every tab and frame of the
// origin, through the Web Locks API. A request asks only if the lock is
// available, so a held scene is refused at once and nothing ever waits on it.

import type { SceneId } from '../core/ids.ts';
import { err, ok, type Result } from '../core/result.ts';

export type SceneLockRefusal = { readonly kind: 'open-elsewhere' };

/**
 * Runs `fn` holding scene `id`'s lock, and releases it when `fn`'s promise
 * settles. Answers `open-elsewhere` without running `fn` when another holder,
 * in this page or any other context of the origin, has the lock. A rejection
 * or a throw from `fn` releases the lock and rejects with the same error.
 */
export type WithSceneLock = <T>(id: SceneId, fn: () => Promise<T>) => Promise<Result<T, SceneLockRefusal>>;

/** The part of `LockManager` the scene lock uses. */
export type SceneLockManager = Pick<LockManager, 'request'>;

export function sceneLockName(id: SceneId): string {
  return `noisy-scene-${id}`;
}

/** The scene lock over a lock manager, `navigator.locks` in the browser. */
export function createSceneLock(locks: SceneLockManager): WithSceneLock {
  return <T>(id: SceneId, fn: () => Promise<T>): Promise<Result<T, SceneLockRefusal>> =>
    locks.request(sceneLockName(id), { ifAvailable: true }, async (lock): Promise<Result<T, SceneLockRefusal>> => {
      if (lock === null) return err({ kind: 'open-elsewhere' });
      return ok(await fn());
    });
}
