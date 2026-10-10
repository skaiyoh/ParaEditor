// The diagnostic vocabulary is typed per part and joined at the composition
// root. Mostly a type test: tsconfig.test.json checks this file, so a line
// that stops compiling, or a @ts-expect-error line that starts compiling,
// fails `npm run typecheck`. Each module whose part joins DiagnosticEvent
// adds a line to `acceptsEveryPart` and a @ts-expect-error line below.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AnalysisEvent } from '../src/analysis/service.ts';
import type { CspViolationEvent, DiagnosticEvent, EnvEvent } from '../src/app/events.ts';
import { isBuildId, type BuildId } from '../src/core/ids.ts';
import type { Clock } from '../src/platform/clock.ts';
import { createDiagnostics, type DiagnosticSink, type Diagnostics } from '../src/platform/diagnostics.ts';
import type { StoreEvent } from '../src/store/connection.ts';

/** Stand-ins for functions that take a sink of one part. */
const logsCsp = (sink: DiagnosticSink<CspViolationEvent>): void => sink.log({ event: 'csp.violation', directive: 'script-src-elem', blocked: 'eval', disposition: 'enforce' });
const logsEnv = (sink: DiagnosticSink<EnvEvent>): void => sink.log({ event: 'env', snapshot: SNAPSHOT });
const logsAnalysis = (sink: DiagnosticSink<AnalysisEvent>): void => sink.log({ event: 'worker.spawn', worker: 'sequence', reason: 'depth' });
const logsStore = (sink: DiagnosticSink<StoreEvent>): void => sink.log({ event: 'store.reconnect', cause: 'close' });

function buildId(text: string): BuildId {
  if (!isBuildId(text)) throw new Error(`not a build id: ${text}`);
  return text;
}

const SNAPSHOT: EnvEvent['snapshot'] = {
  userAgent: 'test',
  build: buildId('nocommit-20261001'),
  deviceClass: 'desktop',
  crossOriginIsolated: true,
  hardwareConcurrency: 8,
  standalone: false,
  storage: { quota: null, persisted: false },
};

const clock: Clock = { now: () => 1, wallNow: () => 1, setTimeout: () => 0, clearTimeout: () => undefined };

/** The root's one buffer is accepted wherever any part's sink is taken. */
function acceptsEveryPart(root: Diagnostics<DiagnosticEvent>): void {
  logsCsp(root);
  logsEnv(root);
  logsAnalysis(root);
  logsStore(root);
}

function rejectsOtherParts(envSink: DiagnosticSink<EnvEvent>, cspSink: DiagnosticSink<CspViolationEvent>, analysisSink: DiagnosticSink<AnalysisEvent>, storeSink: DiagnosticSink<StoreEvent>): void {
  // A sink typed for one part does not take another part's event.
  // @ts-expect-error: csp.violation is not an EnvEvent
  envSink.log({ event: 'csp.violation', directive: 'script-src', blocked: 'eval', disposition: 'enforce' });
  // @ts-expect-error: env is not an AnalysisEvent
  analysisSink.log({ event: 'env', snapshot: SNAPSHOT });
  // @ts-expect-error: worker.spawn is not a StoreEvent
  storeSink.log({ event: 'worker.spawn', worker: 'sequence', reason: 'depth' });
  // A sink of one part does not stand in where the whole vocabulary is logged.
  // @ts-expect-error: DiagnosticSink<CspViolationEvent> cannot log every DiagnosticEvent
  const whole: DiagnosticSink<DiagnosticEvent> = cspSink;
  void whole;
}

test('one root buffer collects every part logged through the narrower sinks', () => {
  const root = createDiagnostics<DiagnosticEvent>(clock);
  acceptsEveryPart(root);
  assert.deepEqual(
    root.events.map((e) => e.event),
    ['csp.violation', 'env', 'worker.spawn', 'store.reconnect'],
  );
  assert.equal(typeof rejectsOtherParts, 'function');
});
