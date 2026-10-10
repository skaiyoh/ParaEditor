// The memory harness's catalog: the pages a run is stored for and their
// localStorage keys, every row a run can measure, the plan kinds with the
// page and the rows of each, and the family, the row program, each row
// belongs to. It names things and holds no state.

import { z } from '../../core/zod.ts';

// ---------------------------------------------------------------------------
// pages and their storage

/** A page the harness runs on; each page's run is stored under its own keys. */
export type HarnessPage = 'memory';

/** The localStorage keys of `page`'s persisted plan, step marker, and outbox. */
export function harnessKeys(page: HarnessPage): { readonly plan: string; readonly step: string; readonly outbox: string } {
  return { plan: `noisy.harness.${page}.plan`, step: `noisy.harness.${page}.step`, outbox: `noisy.harness.${page}.outbox` };
}

// ---------------------------------------------------------------------------
// rows and plan kinds

/** Every row, in the full plan's order. */
export const ROW_IDS = [
  'U1.untouched',
  'U1.killpoint',
  'U1.survival.full',
  'U1.survival.low',
  'U1.survival.none',
  'U1.killpoint.after',
  'U1.headroom',
  'U1.migan-probe',
  'U1.exemption',
  'U1.panorama',
  'U1.threads',
  'U2.encode',
  'U2.inpaint',
  'U3.depth',
] as const;
export type RowId = (typeof ROW_IDS)[number];
export const rowIdSchema = z.enum(ROW_IDS);

export const PLAN_KINDS = ['full', 'short'] as const;
/** `full` is Start; `short` is Short run. */
export type PlanKind = (typeof PLAN_KINDS)[number];

/** The page each plan kind runs on, so an engine made for one page can tell which plan kinds are its own. */
export const PLAN_PAGE = { full: 'memory', short: 'memory' } as const satisfies Readonly<Record<PlanKind, HarnessPage>>;
/** The plan kinds that run on page `P`. */
export type PlanKindOf<P extends HarnessPage> = { [K in PlanKind]: (typeof PLAN_PAGE)[K] extends P ? K : never }[PlanKind];

/** The plan kinds that run on `page`, in plan-kind order. */
function planKindsOf<P extends HarnessPage>(page: P): PlanKindOf<P>[] {
  return PLAN_KINDS.filter((kind): kind is PlanKindOf<P> => PLAN_PAGE[kind] === page);
}

/** The memory page's plan kinds, the key of the memory variant of a plan's levers. */
export const memoryPlanKindSchema = z.enum(planKindsOf('memory'));

/** Each plan kind's rows, in plan order; Short run is the kill point, survival under full GL, the kill point again, and the headroom. */
export const PLAN_ROWS = {
  full: ROW_IDS,
  short: ['U1.killpoint', 'U1.survival.full', 'U1.killpoint.after', 'U1.headroom'],
} as const satisfies Readonly<Record<PlanKind, readonly RowId[]>>;

/** The row programs: rows of one family share a program and a RowState variant. */
export type Family = 'untouched' | 'killpoint' | 'runs' | 'headroom' | 'probe' | 'exemption' | 'threads' | 'gaps' | 'cycles';

const FAMILY_OF = {
  'U1.untouched': 'untouched',
  'U1.killpoint': 'killpoint',
  'U1.survival.full': 'runs',
  'U1.survival.low': 'runs',
  'U1.survival.none': 'runs',
  'U1.killpoint.after': 'killpoint',
  'U1.headroom': 'headroom',
  'U1.migan-probe': 'probe',
  'U1.exemption': 'exemption',
  'U1.panorama': 'runs',
  'U1.threads': 'threads',
  'U2.encode': 'gaps',
  'U2.inpaint': 'gaps',
  'U3.depth': 'cycles',
} as const satisfies Readonly<Record<RowId, Family>>;

export function familyOf(row: RowId): Family {
  return FAMILY_OF[row];
}
