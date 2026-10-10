// The harness pages' styles: the checklist's sheet (the color scheme, the
// card, and buttons at least 52 px tall), and a second constructed sheet for
// the status, sized to be read from across a room on a phone laid face up (a
// design aim not yet judged on a phone). The CSP blocks <style> and style
// attributes, so both are constructed stylesheets the document adopts.

import { adoptStyles } from '../checklist-style.ts';

const CSS = `
[hidden] { display: none !important; }
.status-view { margin: 16px 0; }
.status-view p { margin: 0 0 12px; }
.status-context { font-size: 1.25rem; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
.status-headline { font-size: 2.25rem; line-height: 1.15; font-weight: 700; }
.status-headline[data-kind=done] { font-size: 4.5rem; line-height: 1; color: var(--ok); }
.status-headline[data-kind=failed], .status-headline[data-kind=page-failed], .status-headline[data-kind=storage-failed] { color: var(--bad); }
.status-headline[data-kind=refused], .status-headline[data-kind=not-executed], .status-headline[data-kind=stale], .status-headline[data-kind=elsewhere] { color: var(--warn); }
.status-step { font-size: 1.75rem; line-height: 1.2; font-weight: 600; }
.status-phase { font-size: 1.5rem; line-height: 1.25; }
.status-counts { font-size: 1.5rem; line-height: 1.25; font-variant-numeric: tabular-nums; }
.status-verdicts { list-style: none; padding: 0; margin: 0 0 12px; font-size: 1.25rem; line-height: 1.35; }
.status-verdicts li { padding: 4px 0; }
.status-pending { font-size: 1.25rem; color: var(--muted); }
.status-levered { display: inline-block; font-size: 1.125rem; font-weight: 700; color: var(--warn); border: 2px solid var(--warn); border-radius: 10px; padding: 6px 10px; }
.status-wake { font-size: 1.25rem; color: var(--muted); }
.wake-tap { display: block; width: 100%; min-height: 96px; margin: 0 0 16px; font-size: 1.75rem; font-weight: 700; }
.controls { display: grid; gap: 12px; margin: 16px 0; }
.controls button { width: 100%; min-height: 64px; font-size: 1.375rem; }
details.report { margin: 24px 0 0; }
details.report summary { min-height: 44px; padding: 10px 0; cursor: pointer; color: var(--muted); }
details.report pre { margin: 0; font: 0.75rem/1.4 ui-monospace, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
`;

export function adoptHarnessStyles(doc: Document): void {
  adoptStyles(doc);
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS);
  doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
}
