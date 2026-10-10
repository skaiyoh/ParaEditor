// The tab id: a UUID v4 minted once per page load.

import { isTabId, type TabId } from '../core/ids.ts';

export function mintTabId(random: Pick<Crypto, 'randomUUID'>): TabId {
  // Typed as always present, but browsers expose randomUUID only in a secure context.
  if (typeof random.randomUUID !== 'function') throw new Error('crypto.randomUUID is unavailable: the page is not a secure context');
  const id = random.randomUUID();
  if (!isTabId(id)) throw new Error(`randomUUID returned "${id}", which is not a lowercase UUID v4`);
  return id;
}
