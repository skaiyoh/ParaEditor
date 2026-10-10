// The harness page's status, in large text meant to be read from across a
// room (not yet judged on a phone): the context the page runs in, the
// headline, the row and step in flight in the page's own words, the run's
// loads, kills, and voids, each ended row's verdict, the rows still waiting
// to post, a banner on a levered run, and the screen wake lock's latest
// answer, with a large "Tap to keep the screen on" target while the lock is
// refused, whose tap the page answers by requesting the lock again. It
// renders what it is given and holds no state of its own, so a harness page
// renders it with its own step descriptions.
// Plain DOM text: the CSP blocks inline styles, and the page adopts the
// stylesheet.

import { statusText, type EngineStatus, type StepView } from './engine.ts';
import type { RowId } from './catalog.ts';
import { inFlightStep, type PlanState } from './plan.ts';
import { rowVerdict } from './registry.ts';
import { verdictText } from './states.ts';
import type { Step } from './steps.ts';
import type { WakeLockState } from './rows.ts';

/** What the page shows beside the engine's statuses: before the engine exists, a page that cannot run, and Start refused by the page. */
export type ViewStatus =
  | EngineStatus
  | { readonly kind: 'starting' }
  | { readonly kind: 'page-failed'; readonly reason: string }
  | { readonly kind: 'not-executed'; readonly rows: readonly RowId[] };

/** A step in the page's words: the row and step line, and the phase line. */
export type StepWords = { readonly step: string; readonly phase: string };

/** Describes the step in flight; `step` is null when the plan no longer names it. */
export type DescribeStep = (step: Step | null, view: StepView) => StepWords;

/** The context a harness page reports, in the owner's words. */
export type PageContext = 'Safari tab' | 'Home Screen app';

export function pageContext(standalone: boolean): PageContext {
  return standalone ? 'Home Screen app' : 'Safari tab';
}

/** A row id in words: `U1.untouched` reads `U1 untouched`. */
export function rowName(row: RowId): string {
  return row.replaceAll('.', ' ');
}

/** The wake lock's answer in words; null before any. */
export function wakeText(state: WakeLockState | null): string | null {
  if (state === null) return null;
  switch (state.kind) {
    case 'held':
      return 'Screen kept on';
    case 'refused':
      return `The screen may sleep: the wake lock was refused (${state.name})`;
    case 'unsupported':
      return 'The screen may sleep: this browser has no wake lock';
    case 'released':
      return 'The screen may sleep: the browser released the wake lock';
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

/** The status's headline: DONE at the end, the page's own refusals and failures, and the engine's headline otherwise. */
export function headline(status: ViewStatus): string {
  switch (status.kind) {
    case 'starting':
      return 'Starting';
    case 'page-failed':
      return status.reason;
    case 'not-executed':
      return `Start refused (no executor): ${status.rows.join(', ')}`;
    case 'done':
      return 'DONE';
    default:
      return statusText(status);
  }
}

/** `N rows waiting to post`, or that every row posted; null for a status with no outbox count. */
export function pendingText(status: ViewStatus): string | null {
  switch (status.kind) {
    case 'running':
    case 'done':
    case 'stopped':
    case 'failed':
      return status.pending === 0 ? 'Every row posted' : `${status.pending} ${status.pending === 1 ? 'row' : 'rows'} waiting to post`;
    default:
      return null;
  }
}

/** The plan of a status that has one. */
function planOf(status: ViewStatus): PlanState | null {
  return status.kind === 'running' || status.kind === 'done' ? status.plan : null;
}

/** Each ended row's verdict, in plan order. */
function verdictLines(plan: PlanState): string[] {
  return plan.rows.slice(0, plan.cursor).map((row) => {
    try {
      return `${rowName(row.state.row)}: ${verdictText(rowVerdict(row))}`;
    } catch {
      return `${rowName(row.state.row)}: no verdict`;
    }
  });
}

function stepWords(status: ViewStatus, describe: DescribeStep): StepWords | null {
  if (status.kind !== 'running') return null;
  if (status.step === null) return status.waitingForVisible ? null : { step: 'Starting the next step', phase: '' };
  let planned: Step | null;
  try {
    planned = inFlightStep(status.plan)?.step ?? null;
  } catch {
    planned = null;
  }
  return describe(planned, status.step);
}

export type StatusView = {
  /** Shows `status`; `levered` adds the banner; `wake` is the wake lock's latest answer. */
  render(status: ViewStatus, levered: boolean, wake: WakeLockState | null): void;
};

/** Builds the view's elements inside `root`, emptying it first; `onWakeTap` hears a tap on the wake lock's target, inside the tap. */
export function createStatusView(
  root: HTMLElement,
  options: { readonly context: PageContext; readonly describeStep: DescribeStep; readonly onWakeTap: () => void },
): StatusView {
  const doc = root.ownerDocument;
  const line = (className: string, testid: string, tag: 'p' | 'ul' = 'p'): HTMLElement => {
    const el = doc.createElement(tag);
    el.className = className;
    el.dataset['testid'] = testid;
    return el;
  };
  const context = line('status-context', 'context');
  const head = line('status-headline', 'headline');
  const step = line('status-step', 'step');
  const phase = line('status-phase', 'phase');
  const counts = line('status-counts', 'counts');
  const verdicts = line('status-verdicts', 'verdicts', 'ul');
  const pending = line('status-pending', 'pending');
  const levered = line('status-levered', 'levered');
  levered.textContent = 'Levered: not a phone reading';
  const wake = line('status-wake', 'wake');
  const wakeTap = doc.createElement('button');
  wakeTap.type = 'button';
  wakeTap.className = 'wake-tap';
  wakeTap.dataset['testid'] = 'wake-tap';
  wakeTap.textContent = 'Tap to keep the screen on';
  wakeTap.hidden = true;
  wakeTap.addEventListener('click', () => options.onWakeTap());
  context.textContent = options.context;
  root.replaceChildren(context, head, wakeTap, step, phase, counts, verdicts, pending, wake, levered);

  const show = (el: HTMLElement, text: string | null): void => {
    el.textContent = text ?? '';
    el.hidden = text === null || text === '';
  };

  return {
    render(status, isLevered, wakeLock) {
      head.textContent = headline(status);
      head.dataset['kind'] = status.kind;
      const words = stepWords(status, options.describeStep);
      show(step, words?.step ?? null);
      show(phase, words?.phase ?? null);
      const plan = planOf(status);
      show(counts, plan === null ? null : `Loads ${plan.loads}, kills ${plan.kills}, voids ${plan.voids}`);
      const lines = plan === null ? [] : verdictLines(plan);
      verdicts.replaceChildren(
        ...lines.map((text) => {
          const item = doc.createElement('li');
          item.textContent = text;
          return item;
        }),
      );
      verdicts.hidden = lines.length === 0;
      show(pending, pendingText(status));
      show(wake, wakeText(wakeLock));
      wakeTap.hidden = wakeLock?.kind !== 'refused';
      levered.hidden = !isLevered;
    },
  };
}
