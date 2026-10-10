// Whether the page is hidden, and the moment it is being put away, as a source
// a test harness can script in place of the document.

export interface VisibilitySource {
  readonly hidden: boolean;
  /** Called on every `visibilitychange` with the new state; returns the unsubscribe. */
  onChange(listener: (hidden: boolean) => void): () => void;
  /** Called on `pagehide`; returns the unsubscribe. */
  onPageHide(listener: () => void): () => void;
}

export type VisibilityTargets = {
  readonly document: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  readonly window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
};

export function createVisibilitySource({ document, window }: VisibilityTargets): VisibilitySource {
  const hidden = (): boolean => document.visibilityState === 'hidden';
  return {
    get hidden() {
      return hidden();
    },
    onChange(listener) {
      const handler = (): void => listener(hidden());
      document.addEventListener('visibilitychange', handler);
      return () => document.removeEventListener('visibilitychange', handler);
    },
    onPageHide(listener) {
      const handler = (): void => listener();
      window.addEventListener('pagehide', handler);
      return () => window.removeEventListener('pagehide', handler);
    },
  };
}
