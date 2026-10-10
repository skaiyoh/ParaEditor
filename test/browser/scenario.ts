// The scenario API. A scenario is data plus one async function: it names the
// target it runs against (the server and the build), the verification rows it
// covers, and drives the page through `t.page` and the server through
// `t.server`, recording each check with `t.equal` or `t.ok`. The runner adds
// the invariant checks of every scenario (same-origin requests, no CSP
// violation, no console noise from the app) after `run` returns.
// docs/ARCHITECTURE.md ("Browser driver") says how to add one.

import type { BrowserPage, MessagePattern } from './driver/browser.ts';
import type { BuildInfo, ServerLevers, TargetName } from './driver/server.ts';

export type { BrowserPage, ConsoleEntry, Json, MessagePattern } from './driver/browser.ts';
export type { BuildInfo, RequestLine, ServerLevers, SinkLine, TargetName } from './driver/server.ts';

export type ScenarioContext = {
  readonly page: BrowserPage;
  /** The server's levers; once the scenario has timed out, each rejects without reaching the server. */
  readonly server: ServerLevers;
  /** The served build's build.json. */
  readonly build: BuildInfo;
  /** The server's origin with a trailing slash. */
  readonly baseUrl: string;
  /** This scenario's output directory; screenshots and files land here. */
  readonly dir: string;
  /** Records a check that passes when `actual` deep-equals `expected`; returns whether it passed. */
  equal(check: string, actual: unknown, expected: unknown, evidence?: unknown): boolean;
  /** Records a check that passes when `condition` holds; returns it. */
  ok(check: string, condition: boolean, evidence?: unknown): boolean;
  /** Declares a console message, log entry, or exception this scenario provokes on purpose. */
  expectMessage(pattern: MessagePattern): void;
  /** Writes a file into the scenario's directory and returns its absolute path. */
  file(name: string, data: string | Uint8Array): Promise<string>;
};

export type Scenario = {
  /** Lowercase words joined by dots or hyphens, unique across the suite: `shell.isolated`. */
  readonly id: string;
  readonly title: string;
  readonly target: TargetName;
  /** The verification rows this scenario checks, by id, printed with every check it records. */
  readonly covers: readonly string[];
  /** How long `run` may take before the scenario fails; default 60000 ms. */
  readonly timeoutMs?: number;
  /**
   * Set when `run` reads `t.server.sinkLines()`: the sink is read from the
   * files of a server this run started, so a run attached with --base-url
   * skips the scenario and says so.
   */
  readonly readsSinkFiles?: boolean;
  run(t: ScenarioContext): Promise<void>;
};
