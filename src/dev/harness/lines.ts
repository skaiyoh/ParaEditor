// The memory harness's constants: the pass lines its readers judge by and the
// plan's shared figures, in one module both the page and the readers take
// them from, so a reading and the run that produced it cannot disagree on one
// of these numbers; the runs program keeps its master sizes, and the runner
// its hold and retry times. Pure: no browser global, no build constant.

/** Runs per survival row, per headroom step, and transitions per U2 gap: a row passes at this many of this many. */
export const RUNS = 10;

/** The headroom line: the encoder passes U1 when a filled ballast of at least this many MB (10^6 bytes) survives beside it. */
export const HEADROOM_LINE_MB = 300;

/** One ballast chunk, one ladder step, and the main-thread stand-in, in MB. */
export const CHUNK_MB = 100;

/** U2's gaps in seconds, run longest first; the chosen cooldown is one step up this ladder from the smallest passing gap. */
export const GAPS_S: readonly number[] = [20, 10, 5, 2, 0.5];

/** U3's cycles of `[depth]`. */
export const CYCLES = 20;

/** U3 passes when cycle 20's depth time is at most this many times cycle 1's. */
export const LEAK_RATIO = 1.2;

/** The panorama passes when every depth high-water is at most this many times the same context's largest 4:3 depth high-water. */
export const PANORAMA_RATIO = 1.2;

/** The depth high-water band at 4:3 that the browser scenarios hold Chrome on the Mac to, in MB; to be printed beside the phone's panorama verdict and asserted only in Chrome (nothing reads it yet). */
export const MAC_DEPTH_BAND_MB = { low: 277, high: 348 } as const;

/** The cooldown defaults the app is specified to wait after a heavy worker's termination, keyed by the largest stage it ran, in ms; the harness waits them between the steps a row does not measure. */
export const COOLDOWN_MS = { depth: 5_000, encode: 20_000, inpaint: 5_000 } as const;

/** How long the app is specified to let a hidden tab keep its heavy job, in ms; a step hidden longer than this ran a condition the app would not run. */
export const HIDDEN_GRACE_MS = 4_000;

/** A step voided this many times ends its row `no-reading`. */
export const VOID_CAP = 5;

/** The outbox's largest serialized size in UTF-16 code units; past it the oldest rows are dropped. */
export const OUTBOX_CAP_UNITS = 500_000;

/** The serialized plan's budget in UTF-16 code units: the full plan's largest state must serialize under it (test/harness-plan.test.ts prints the length), and the outbox's makeRoom drops rows until at least this much is freed, or none is left, for a plan or marker write that threw. */
export const PLAN_MAX_UNITS = 16_000;

/** RGBA8 2048 x 1536 textures each GL condition holds beside the canvas's back buffer. */
export const GL_TEXTURES = { full: 18, low: 5, none: 0 } as const;

/** The levers' defaults (`rows`: the plan kind's rows); a lever away from its default marks the run levered. */
export const LEVER_DEFAULTS = {
  rows: null,
  runs: RUNS,
  chunkMb: CHUNK_MB,
  untouchedMb: 1_500,
  ceilingMb: 4_000,
  startMb: HEADROOM_LINE_MB,
  gaps: GAPS_S,
  cycles: CYCLES,
  defaultsScale: 1,
  throwAtMb: null,
  timeoutS: 180,
} as const;

/** A post body of at most this many bytes is sent with keepalive, under the 64 KiB the Fetch Standard allows keepalive request bodies in flight (INFERRED: not measured here). */
export const KEEPALIVE_MAX_BYTES = 60_000;

/** A post the sink has not answered by then counts as failed. */
export const POST_TIMEOUT_MS = 10_000;

/** After a load that found a dead page, the dead page's tab lock is read again this many ms after the load, each reading a `liveness-late` row. */
export const LIVENESS_LATE_MS = [2_000, 10_000] as const;
