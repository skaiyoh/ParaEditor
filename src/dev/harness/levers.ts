// The memory page's levers: query parameters a Mac scenario sets to make a
// run small or fast, parsed once at load into the plan's `Levers`. A lever
// the page cannot use (an unknown name, a name given twice, or a value that
// does not parse) fails the page at load, naming it, so a typo never runs the
// defaults unnoticed. A run with any lever away from its default is levered,
// and its `plan` row says so, so a Mac run is never read as a phone run.

import { sameValue } from '../../core/equal.ts';
import { err, ok, type Result } from '../../core/result.ts';
import { z } from '../../core/zod.ts';
import { LEVER_DEFAULTS } from './lines.ts';
import { rowIdSchema } from './catalog.ts';
import { leversSchema, type Levers } from './context.ts';
import type { LeverChoice } from './engine.ts';

/** Why the page cannot use its levers: the lever named and what is wrong with it. */
export type LeverError = { readonly lever: string; readonly reason: string };

const wholeText = z
  .string()
  .regex(/^\d+$/, 'expected a whole number in plain digits')
  .transform((text) => Number(text));
const numberText = z
  .string()
  .regex(/^(?:\d+(?:\.\d+)?|\.\d+)$/, 'expected a number in plain digits')
  .transform((text) => Number(text));
const listText = z.string().transform((text) => text.split(','));

/** Each lever's text, parsed to the value the plan holds; the ranges are the plan's own, checked again below. */
const leverTextSchema = z.strictObject({
  rows: listText
    .pipe(z.array(rowIdSchema).min(1))
    .refine((rows) => new Set(rows).size === rows.length, 'a row is named twice'),
  runs: wholeText.pipe(z.int().min(1)),
  chunkMb: wholeText.pipe(z.int().min(1)),
  untouchedMb: wholeText.pipe(z.int().min(1)),
  ceilingMb: wholeText.pipe(z.int().min(1)),
  startMb: wholeText.pipe(z.int().min(0)),
  gaps: listText.pipe(z.array(numberText.pipe(z.number().min(0))).min(1).max(16)),
  cycles: wholeText.pipe(z.int().min(1)),
  defaultsScale: numberText.pipe(z.number().positive()),
  throwAtMb: wholeText.pipe(z.int().min(1)),
  timeoutS: numberText.pipe(z.number().positive()),
}).partial();

/** The first issue's lever, from its path or the unknown key it names. */
function issueError(issue: z.core.$ZodIssue): LeverError {
  if (issue.code === 'unrecognized_keys') return { lever: issue.keys[0] ?? '?', reason: 'no such lever' };
  const [lever] = issue.path;
  return { lever: typeof lever === 'string' ? lever : '?', reason: issue.message };
}

/**
 * The levers `search` (a URL's query, `?` included or not) sets, over the
 * defaults, and whether any is away from its default. A `rows` lever is
 * levered whenever it is given, since the default is the plan kind's rows,
 * which Start and Short run choose after the levers are read.
 */
export function parseLevers(search: string): Result<LeverChoice, LeverError> {
  const params = new URLSearchParams(search);
  const texts: Record<string, string> = {};
  for (const name of new Set(params.keys())) {
    const values = params.getAll(name);
    if (values.length > 1) return err({ lever: name, reason: `given ${values.length} times` });
    texts[name] = values[0] ?? '';
  }
  const parsed = leverTextSchema.safeParse(texts);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    return err(issue === undefined ? { lever: '?', reason: 'does not parse' } : issueError(issue));
  }
  const given = Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined));
  const levers = leversSchema.safeParse({ ...LEVER_DEFAULTS, ...given });
  if (!levers.success) {
    const [issue] = levers.error.issues;
    return err(issue === undefined ? { lever: '?', reason: 'does not parse' } : issueError(issue));
  }
  return ok({ levers: levers.data, levered: isLevered(levers.data) });
}

/** Whether any lever is away from its default. */
export function isLevered(levers: Levers): boolean {
  return !sameValue(levers, LEVER_DEFAULTS);
}

/** The error as the page shows it: `The lever <name> cannot be used: <reason>`. */
export function leverErrorText(error: LeverError): string {
  return `The lever ${error.lever} cannot be used: ${error.reason}`;
}
