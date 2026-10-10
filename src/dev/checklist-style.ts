// The checklist's styles. The CSP has no 'unsafe-inline', which blocks a
// <style> element and a style attribute, so the sheet is a constructed
// stylesheet adopted by the document. Chrome applies it under the CSP with no
// violation reported (the checklist.phone browser scenario); Safari has not
// been checked yet.
// Sized for one-handed use on a phone in portrait: large tap targets, nothing
// wider than the viewport, and the system's light or dark scheme.

const CSS = `
:root {
  color-scheme: light dark;
  --bg: light-dark(#f4f4f6, #121214);
  --card: light-dark(#ffffff, #1e1e22);
  --text: light-dark(#151518, #ececf0);
  --muted: light-dark(#5b5b66, #a3a3ae);
  --line: light-dark(#d6d6dd, #3a3a42);
  --accent: light-dark(#0a58ca, #6ea8fe);
  --accent-text: light-dark(#ffffff, #0b1220);
  --ok: light-dark(#146c2e, #75d68f);
  --warn: light-dark(#8a5300, #f0b35a);
  --bad: light-dark(#b42318, #ff8a80);
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 17px/1.45 system-ui, -apple-system, sans-serif;
  overflow-wrap: anywhere;
}
main {
  max-width: 40rem;
  margin: 0 auto;
  padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(32px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
}
h1 { font-size: 1.5rem; line-height: 1.2; margin: 8px 0 4px; }
h2 { font-size: 1.125rem; line-height: 1.3; margin: 0 0 8px; }
p { margin: 0 0 10px; }
a { color: var(--accent); }
code { font: 0.94em ui-monospace, Menlo, monospace; }
.muted { color: var(--muted); font-size: 0.94rem; }
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 16px;
  margin: 16px 0;
}
/*
 * A link inside an action's sentence is a tap target at least 44 px tall:
 * its vertical padding extends the box it is hit in without moving the text,
 * and the taller lines keep that box clear of the next line's words.
 */
.action { font-size: 1.0625rem; line-height: 1.9; }
.action a { font-weight: 600; padding: 12px 2px; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
a.back { display: inline-block; min-height: 44px; min-width: 44px; padding: 12px 16px 12px 0; }
.question { font-weight: 600; }
.choices { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 12px 0 0; }
.entry { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; margin: 12px 0 0; }
.ask { margin: 14px 0 0; }
.ask p { margin: 0 0 6px; }
button, input, textarea { font: inherit; }
button {
  min-height: 52px;
  padding: 10px 18px;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: var(--card);
  color: var(--text);
  font-weight: 600;
  touch-action: manipulation;
}
button[aria-pressed=true], button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
button:disabled { opacity: 0.45; }
button.wide { width: 100%; margin: 16px 0 0; }
input, textarea {
  min-height: 52px;
  width: 100%;
  min-width: 0;
  padding: 10px 14px;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: var(--bg);
  color: var(--text);
}
.status { margin: 12px 0 0; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); }
.status[data-post=idle], .status[data-clear=idle] { display: none; }
.status[data-clear=failed] { border-color: var(--bad); color: var(--bad); }
.status[data-post=posted][data-matches=true] { border-color: var(--ok); }
.status[data-post=posted][data-matches=false] { border-color: var(--warn); }
.status[data-post=refused], .status[data-post=no-reply] { border-color: var(--bad); }
.status strong { display: block; }
.status[data-post=posted][data-matches=true] strong { color: var(--ok); }
.status[data-post=posted][data-matches=false] strong { color: var(--warn); }
.status[data-post=refused] strong, .status[data-post=no-reply] strong { color: var(--bad); }
.sittings { list-style: none; padding: 0; margin: 16px 0; display: grid; gap: 10px; }
.sittings a {
  display: block;
  min-height: 52px;
  padding: 14px 16px;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: var(--card);
  color: var(--text);
  text-decoration: none;
  font-weight: 600;
}
`;

export function adoptStyles(doc: Document): void {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS);
  doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
}
