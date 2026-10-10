// The composition root's diagnostic vocabulary: the union of the events every
// module logs, plus the root's own. A module declares its own part and takes a
// DiagnosticSink of only that part; when it lands, its part joins
// DiagnosticEvent here, and the page's one Diagnostics<DiagnosticEvent> is
// accepted wherever any part's sink is taken.

import type { AnalysisEvent } from '../analysis/service.ts';
import type { BuildId } from '../core/ids.ts';
import type { Capabilities } from '../platform/capabilities.ts';
import type { StoreEvent } from '../store/connection.ts';

/** What the page reported about itself at boot; logged once as the `env` event. */
export type EnvironmentSnapshot = Capabilities & { readonly build: BuildId };

/**
 * A `securitypolicyviolation` the page saw: the effective directive, the
 * blocked URI, and whether the enforced policy or a report-only copy saw it.
 */
export type CspViolationEvent = {
  readonly event: 'csp.violation';
  readonly directive: string;
  readonly blocked: string;
  readonly disposition: SecurityPolicyViolationEventDisposition;
};
export type EnvEvent = { readonly event: 'env'; readonly snapshot: EnvironmentSnapshot };

export type DiagnosticEvent = CspViolationEvent | EnvEvent | AnalysisEvent | StoreEvent;
