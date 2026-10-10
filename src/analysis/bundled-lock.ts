// The model lock this build carries. tools/build.mjs injects the lock its
// --lock flag names, models.lock.json by default, as the compile-time
// constant NOISY_MODEL_LOCK; it is parsed here, at
// startup, by the one schema node tooling also reads (analysis/lock.ts). A
// node test cannot import this module, since only a build defines the
// constant.

import type { Result } from '../core/result.ts';
import { parseLock, type ParsedLock } from './lock.ts';

/** The build's lock, parsed; an error names what the lock got wrong. */
export function bundledLock(): Result<ParsedLock, string> {
  return parseLock(NOISY_MODEL_LOCK);
}
