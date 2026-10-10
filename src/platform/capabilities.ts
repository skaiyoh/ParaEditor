// What the browser and device report about themselves, read once at boot.
// Reading them never fails and never waits without bound: a fact the browser
// will not give is reported as unknown, so the boot's snapshot always arrives.

import type { Clock } from './clock.ts';

/**
 * 'phone' when the user agent names iPhone or iPad, or the primary pointer is
 * coarse with no hover; Safari exposes no device memory, so this heuristic is
 * what picks the device's policy, and it is recorded so diagnostics show which.
 */
export type DeviceClass = 'phone' | 'desktop';

export type Capabilities = {
  readonly userAgent: string;
  readonly deviceClass: DeviceClass;
  readonly crossOriginIsolated: boolean;
  readonly hardwareConcurrency: number;
  /** Running as an installed web app: display-mode standalone, or iOS Safari's `navigator.standalone`. */
  readonly standalone: boolean;
  /**
   * `quota` is null when the estimate is unavailable, fails, or does not
   * answer within STORAGE_READ_MS; `persisted` is false in those cases too.
   */
  readonly storage: { readonly quota: number | null; readonly persisted: boolean };
};

export type CapabilitySources = {
  readonly navigator: Pick<Navigator, 'userAgent' | 'hardwareConcurrency' | 'storage'>;
  readonly window: Pick<Window, 'crossOriginIsolated' | 'matchMedia'>;
  /** Bounds the storage reads. */
  readonly clock: Pick<Clock, 'setTimeout' | 'clearTimeout'>;
};

/** How long the boot waits for each storage answer before reporting it unknown. */
export const STORAGE_READ_MS = 2000;

const PHONE_USER_AGENT = /\b(?:iPhone|iPad)\b/;

export function deviceClassOf(userAgent: string, coarsePointerWithoutHover: boolean): DeviceClass {
  return PHONE_USER_AGENT.test(userAgent) || coarsePointerWithoutHover ? 'phone' : 'desktop';
}

/** Never rejects; see the module comment. */
export async function readCapabilities({ navigator, window, clock }: CapabilitySources): Promise<Capabilities> {
  const matches = (query: string): boolean => {
    try {
      return window.matchMedia(query).matches;
    } catch {
      return false;
    }
  };
  const iosStandalone = 'standalone' in navigator && navigator.standalone === true;
  return {
    userAgent: navigator.userAgent,
    deviceClass: deviceClassOf(navigator.userAgent, matches('(pointer: coarse) and (hover: none)')),
    crossOriginIsolated: window.crossOriginIsolated,
    hardwareConcurrency: navigator.hardwareConcurrency,
    standalone: matches('(display-mode: standalone)') || iosStandalone,
    storage: await readStorage(navigator, clock),
  };
}

async function readStorage(navigator: CapabilitySources['navigator'], clock: CapabilitySources['clock']): Promise<Capabilities['storage']> {
  // `storage` is typed as always present, but a browser may not expose it, its
  // getter or either call may throw or reject, and either call may never settle.
  const [quota, persisted] = await Promise.all([
    bounded(clock, () => navigator.storage.estimate().then((e) => e?.quota ?? null)),
    bounded(clock, () => navigator.storage.persisted()),
  ]);
  return { quota: quota ?? null, persisted: persisted === true };
}

/** `read()`'s value, or undefined when it throws, rejects, or takes longer than STORAGE_READ_MS. */
function bounded<T>(clock: CapabilitySources['clock'], read: () => Promise<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = clock.setTimeout(() => resolve(undefined), STORAGE_READ_MS);
    const settle = (value: T | undefined): void => {
      clock.clearTimeout(timer);
      resolve(value);
    };
    Promise.resolve()
      .then(read)
      .then(settle, () => settle(undefined));
  });
}
