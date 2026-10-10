// What the checklist page records about its own browser context: its
// environment snapshot, read once as the page loads by the same platform
// functions the app's composition root uses, and every CSP violation the page
// has seen. The snapshot is the checklist's own, not one taken from the app:
// it describes the context the checklist is opened in, which is the app's
// Safari when both are Safari tabs, but not the noisy Home Screen app's, since
// nothing in the app leads to the checklist.
// The entry module imports this one first, so its listener is in place before
// the rest of the page's script runs.

import type { CspViolationEvent, EnvironmentSnapshot } from '../app/events.ts';
import { readBuildId } from '../platform/build-id.ts';
import { readCapabilities } from '../platform/capabilities.ts';
import { createBrowserClock } from '../platform/clock.ts';

/** A `securitypolicyviolation` the page saw, as the app's `csp.violation` event records one. */
export type CspViolation = Omit<CspViolationEvent, 'event'>;

/** The snapshot, or why it could not be read. */
export type EnvironmentRead = { readonly kind: 'read'; readonly snapshot: EnvironmentSnapshot } | { readonly kind: 'unavailable'; readonly reason: string };

const violations: CspViolation[] = [];
document.addEventListener('securitypolicyviolation', (e) => {
  violations.push({ directive: e.effectiveDirective, blocked: e.blockedURI, disposition: e.disposition });
});

/** Every CSP violation seen so far, oldest first. */
export function cspViolations(): readonly CspViolation[] {
  return [...violations];
}

/** `readCapabilities` never rejects; `readBuildId` throws on a malformed build id, which becomes the reason. */
async function readEnvironment(): Promise<EnvironmentRead> {
  try {
    const build = readBuildId();
    const capabilities = await readCapabilities({ navigator, window, clock: createBrowserClock(window) });
    return { kind: 'read', snapshot: { ...capabilities, build } };
  } catch (e) {
    return { kind: 'unavailable', reason: e instanceof Error ? e.message : String(e) };
  }
}

let settled: EnvironmentRead | null = null;

/** The page's environment, read once as the page loads; never rejects. */
export const environment: Promise<EnvironmentRead> = readEnvironment().then((read) => {
  settled = read;
  return read;
});

/** The environment if it has been read by now, or null while the read is under way. */
export function environmentNow(): EnvironmentRead | null {
  return settled;
}
