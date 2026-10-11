// The owner's phone rows, which /dev/checklist.html lists one sitting at a
// time in the order they appear here. A part that owns a phone row adds it in
// the place where the owner runs it within its sitting. Rows that run on the
// owner's start command, which serves no dev page, are not here.
// docs/ARCHITECTURE.md ("The phone checklist") describes the page.

import type { TestSurface } from '../app/test-surface.ts';

/** The nine sittings the rows are grouped in. */
export const SITTINGS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'] as const;
export type Sitting = (typeof SITTINGS)[number];

export type RowId = `H${number}`;
export type PartId = `P${string}`;

/** A same-origin, root-relative path, which the page links to. */
export type SameOriginPath = `/${string}`;

/**
 * One piece of an action's text. A link's `text` is the words of the action
 * that name the page; `code` sets it as code, as for a path.
 */
export type ActionPart = string | { readonly text: string; readonly href: SameOriginPath; readonly code: boolean };

/** The one answer a manual row takes, with the expected answer where there is one. */
export type AnswerSpec =
  | { readonly kind: 'yes-no'; readonly expected: YesNo | null }
  | { readonly kind: 'number'; readonly expected: number | null }
  /** `expected` describes an observation the Mac judges, so the page never marks a match. */
  | { readonly kind: 'observation'; readonly expected: string | null };

export type YesNo = 'yes' | 'no';

/** An answer as posted; its kind is its row's `AnswerSpec` kind. */
export type Answer =
  | { readonly kind: 'yes-no'; readonly value: YesNo }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'observation'; readonly value: string };

type RowBase = {
  readonly id: RowId;
  readonly part: PartId;
  readonly sitting: Sitting;
  /** The action, word for word as the owner's checklist gives it, a path's backticks dropped. */
  readonly action: readonly ActionPart[];
  readonly question: string;
  /** What is recorded without asking, or null where nothing is. */
  readonly recorded: string | null;
};

/**
 * The owner does the action by hand and gives one answer. `attach:
 * 'screenshot'` marks a row whose evidence includes the picture the owner just
 * took, to be uploaded as a binary capture. The page has no Attach button
 * yet: it says so on such a row, and the first part that adds one builds it.
 */
export type ManualRow = RowBase & { readonly kind: 'manual'; readonly answer: AnswerSpec; readonly attach: 'none' | 'screenshot' };

/** A JSON value a batch posts as a row. */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/**
 * What a batch is to run against, provided by the part that adds the first
 * batch row: an app instance the batch drives through its test surface,
 * hosted by the checklist for the batch's length, and the results sink.
 * That part decides how the instance is hosted (a frame is the likely
 * host); nothing builds one yet.
 */
export type BatchContext = {
  readonly app: TestSurface;
  /** Posts one JSON row to the sink, which the runner tags with the sitting and the row. */
  post(row: { readonly [key: string]: Json }): Promise<void>;
  /** Uploads one binary capture to the sink under `name`. */
  capture(name: string, body: Blob): Promise<void>;
};

export type BatchOutcome = { readonly kind: 'done' } | { readonly kind: 'failed'; readonly reason: string };

/**
 * A row the page is to run by itself after one tap: `run` posts its own rows
 * and captures, and its outcome is to show as DONE or FAILED, a rejection
 * counting as FAILED. The page cannot run one yet and says so on such a row.
 */
export type BatchRow = RowBase & { readonly kind: 'batch'; run(context: BatchContext): Promise<BatchOutcome> };

export type ChecklistRow = ManualRow | BatchRow;

export const CHECKLIST_ROWS: readonly ChecklistRow[] = [
  {
    id: 'H1',
    part: 'P0.1',
    sitting: 'A',
    kind: 'manual',
    action: ['In Safari open ', { text: 'the ParaEditor address', href: '/', code: false }, ' the agent sends.'],
    question: 'Does the page say "isolated: yes"?',
    answer: { kind: 'yes-no', expected: 'yes' },
    attach: 'none',
    recorded: 'environment snapshot, build id',
  },
  {
    id: 'H2',
    part: 'P0.2',
    sitting: 'A',
    kind: 'manual',
    action: ['Open ', { text: '/dev/threads.html', href: '/dev/threads.html', code: true }, ' and tap Run.'],
    question: 'What thread count does it show?',
    answer: { kind: 'number', expected: 2 },
    attach: 'none',
    recorded: 'CSP report count',
  },
  {
    id: 'H8',
    part: 'P2b.1',
    sitting: 'C',
    kind: 'manual',
    action: ['Open ', { text: '/dev/store.html', href: '/dev/store.html', code: true }, ', tap Write, switch to another app for ten minutes, come back, tap Write.'],
    question: 'Does it say "second write saved"?',
    answer: { kind: 'yes-no', expected: 'yes' },
    attach: 'none',
    recorded: 'store.reconnect count',
  },
];
