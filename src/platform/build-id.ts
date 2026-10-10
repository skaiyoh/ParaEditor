// The build id compiled into this bundle. NOISY_BUILD_ID exists only in a
// build, so no module a node test imports may import this one; the test
// project's type check fails if one does (docs/ARCHITECTURE.md, "Build").

import { isBuildId, type BuildId } from '../core/ids.ts';

export function readBuildId(): BuildId {
  if (!isBuildId(NOISY_BUILD_ID)) throw new Error(`the build injected a malformed build id: "${NOISY_BUILD_ID}"`);
  return NOISY_BUILD_ID;
}
