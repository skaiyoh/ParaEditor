// What the checklist posts to the results sink, and the posting itself. Each
// answer is one JSON row; answering again posts another, and of a sitting's
// rows for one checklist row the one with the latest `answeredAt` counts.
// Posts go out one at a time in the order the owner answered, but the sink's
// order is not the answers' order: a post with no reply can still land after
// a later one, and posts sent as the page is hidden or left go out at once.

import { cspViolations, environment, environmentNow, type CspViolation, type EnvironmentRead } from './checklist-environment.ts';
import type { Answer, ManualRow, PartId, RowId, Sitting, YesNo } from './checklist-rows.ts';

/** A post the sink has not answered by then is reported as having no reply. */
const POST_TIMEOUT_MS = 10_000;

/** The `environment` of a post sent as the page is hidden or left before the page's environment was read. */
const UNREAD_ENVIRONMENT: EnvironmentRead = { kind: 'unavailable', reason: 'the checklist page was hidden or left before its environment was read' };

export type Conditions = {
  readonly onCharger: YesNo;
  readonly lowPowerMode: YesNo;
  readonly otherSafariTabsClosed: YesNo;
};

type Common = {
  readonly sitting: Sitting;
  /** The checklist page's own build id. */
  readonly buildId: string;
  /** When the owner answered, by the phone's clock. */
  readonly answeredAt: string;
  /** The checklist page's own environment snapshot (checklist-environment.ts). */
  readonly environment: EnvironmentRead;
  /** Every CSP violation the checklist page has seen by the time of the post. */
  readonly cspViolations: readonly CspViolation[];
};

export type AnswerRow = Common & {
  readonly kind: 'checklist-answer';
  readonly row: RowId;
  readonly part: PartId;
  readonly answer: Answer;
  readonly expected: Answer['value'] | null;
  /** Whether the answer is the expected one; null where nothing is expected or the Mac judges it. */
  readonly matches: boolean | null;
};

export type ConditionsRow = Common & { readonly kind: 'checklist-conditions'; readonly conditions: Conditions };

/** What the poster adds to a row: what the page recorded by itself. */
type Recorded = Pick<Common, 'environment' | 'cspViolations'>;

/** What a card builds. */
export type RowDraft = Omit<AnswerRow, keyof Recorded> | Omit<ConditionsRow, keyof Recorded>;

/**
 * `recorded`: the sink answered 2xx, so the row is in it. `refused`: the sink
 * answered with an error status, which it sends before appending anything.
 * `no-reply`: no answer arrived (a network error or the timeout), so the row
 * may or may not have been recorded.
 */
export type Posted =
  | { readonly kind: 'recorded' }
  | { readonly kind: 'refused'; readonly status: number }
  | { readonly kind: 'no-reply'; readonly reason: string };

export type PostResult = { readonly posted: Posted; readonly environment: EnvironmentRead };

/** Whether `answer` is what `row` expects; null when the page cannot tell. */
export function matchOf(row: ManualRow, answer: Answer): { readonly expected: Answer['value'] | null; readonly matches: boolean | null } {
  const spec = row.answer;
  switch (spec.kind) {
    case 'yes-no':
    case 'number':
      if (spec.expected === null) return { expected: null, matches: null };
      return { expected: spec.expected, matches: answer.kind === spec.kind && answer.value === spec.expected };
    case 'observation':
      return { expected: spec.expected, matches: null };
    default: {
      const exhaustive: never = spec;
      return exhaustive;
    }
  }
}

/**
 * The Fetch Standard caps the bodies of keepalive requests in flight at 64
 * KiB (INFERRED: not measured here); a row of at most this size is sent with
 * keepalive, so the request outlives the page.
 */
const KEEPALIVE_MAX_BYTES = 60_000;

/** Posts `draft` with `env` and the CSP violations seen so far; never rejects. */
async function send(draft: RowDraft, env: EnvironmentRead): Promise<PostResult> {
  const row: AnswerRow | ConditionsRow = { ...draft, environment: env, cspViolations: cspViolations() };
  try {
    const body = JSON.stringify(row);
    const res = await fetch('/api/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: new TextEncoder().encode(body).byteLength <= KEEPALIVE_MAX_BYTES,
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    return { posted: res.ok ? { kind: 'recorded' } : { kind: 'refused', status: res.status }, environment: env };
  } catch (e) {
    return { posted: { kind: 'no-reply', reason: e instanceof Error ? e.message : String(e) }, environment: env };
  }
}

/** A post not yet sent; `early` is set when it was sent as the page was hidden or left. */
type Pending = { readonly draft: RowDraft; early: Promise<PostResult> | null };

const pending = new Set<Pending>();
let queue: Promise<unknown> = Promise.resolve();

/**
 * Sends every post still waiting, behind a slow earlier post or the first
 * read of the environment, at once. A post already being sent outlives the
 * page when it went with keepalive (above).
 */
function sendWaiting(): void {
  const env = environmentNow() ?? UNREAD_ENVIRONMENT;
  for (const entry of pending) {
    if (entry.early === null) entry.early = send(entry.draft, env);
  }
}

// A waiting post would be lost with the page. `pagehide` covers a reload, a
// navigation, and a closed tab. A hidden page (another tab, such as one a
// row's link opened, or another app) may be discarded later with no event,
// so waiting posts go out as it is hidden. Sending them early can put them in
// the sink before a post still in flight; `answeredAt` orders them.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') sendWaiting();
});
window.addEventListener('pagehide', sendWaiting);

/**
 * Posts `draft` with the page's environment and CSP violations, after every
 * earlier post has settled and the environment has been read. Never rejects.
 */
export function post(draft: RowDraft): Promise<PostResult> {
  const entry: Pending = { draft, early: null };
  pending.add(entry);
  const next = queue.then(async (): Promise<PostResult> => {
    try {
      const env = await environment;
      if (entry.early !== null) return await entry.early;
      // Out of `pending` before it is sent, so hiding or leaving the page does not send it twice.
      pending.delete(entry);
      return await send(draft, env);
    } finally {
      pending.delete(entry);
    }
  });
  // Nothing above rejects; if it did, the catch keeps later posts running.
  queue = next.catch(() => undefined);
  return next;
}
