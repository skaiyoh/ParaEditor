// Messages from the thread probe's worker (threads-worker.ts) to its page
// (threads.ts). The page parses each one with ProbeMessage; the worker only
// imports the type.

// core/zod.ts configures zod as jitless before this module runs, so creating
// these schemas reports no CSP violation into the very count this probe reads.
import { z } from '../core/zod.ts';

export const CspViolation = z.object({
  scope: z.enum(['page', 'worker']),
  directive: z.string(),
  blockedURI: z.string(),
  disposition: z.enum(['enforce', 'report']),
});
export type CspViolation = z.infer<typeof CspViolation>;

export const ProbeMessage = z.discriminatedUnion('kind', [
  /** The worker constructed a nested worker; ORT's pthread workers are named "em-pthread...". */
  z.object({ kind: z.literal('nested-worker'), name: z.string(), pthreadWorkers: z.number() }),
  /** A nested worker fired an error event: it failed to load or threw. */
  z.object({ kind: z.literal('nested-worker-error'), name: z.string(), message: z.string(), pthreadWorkers: z.number() }),
  z.object({ kind: z.literal('csp'), violation: CspViolation }),
  z.object({
    kind: z.literal('completed'),
    numThreads: z.number().nullable(),
    pthreadWorkers: z.number(),
    sessionMs: z.number(),
    runMs: z.number(),
    outputOk: z.boolean(),
  }),
  z.object({ kind: z.literal('failed'), error: z.string(), numThreads: z.number().nullable(), pthreadWorkers: z.number() }),
]);
export type ProbeMessage = z.infer<typeof ProbeMessage>;
