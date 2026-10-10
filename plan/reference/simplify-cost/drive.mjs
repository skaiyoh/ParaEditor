// Throwaway: launches headless Chrome on the spike page (file://), polls its text over CDP until DONE or timeout,
// saves any images the page left in window.__images to out/, prints the text, then kills Chrome.
// Usage: node drive.mjs <profile dir> '<query string>' [port] [timeout ms]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const [profile, query, port, timeoutMs] = [process.argv[2], process.argv[3] || '', process.argv[4] || '9391', Number(process.argv[5] || 120000)];
const url = `file://${here}/index.html?${query}`;
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--no-first-run', '--disable-extensions', '--allow-file-access-from-files', url], { stdio: 'ignore' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let text = 'NO RESULT';
try {
  let target;
  for (let i = 0; i < 30 && !target; i++) { await wait(500); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch {} }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.onopen = r);
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const call = (method, params) => Promise.race([new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); }), wait(20000).then(() => null)]);
  const evaluate = async (expression) => (await call('Runtime.evaluate', { expression, returnByValue: true }))?.result?.result?.value;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await wait(1500);
    const v = (await evaluate("document.getElementById('o')?.textContent || ''")) || '';
    if (v) text = v;
    if (v.includes('DONE')) break;
  }
  const names = JSON.parse((await evaluate('JSON.stringify(Object.keys(window.__images || {}))')) || '[]');
  if (names.length) mkdirSync(join(here, 'out'), { recursive: true });
  for (const name of names) {
    const dataUrl = await evaluate(`window.__images[${JSON.stringify(name)}]`);
    if (dataUrl) writeFileSync(join(here, 'out', `${name}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
  }
  if (names.length) text += `\nsaved: ${names.join(', ')}`;
  ws.close();
} finally { chrome.kill('SIGKILL'); }
console.log(text);
process.exit(0);
