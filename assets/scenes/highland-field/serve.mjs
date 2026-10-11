// Local, dependency-free preview. No application server or shared store is touched.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { port: { type: 'string', default: '8794' }, host: { type: 'string', default: '127.0.0.1' } } });
const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(root, '../../..');
const buildRoot = path.join(repo, 'build/dev');
let trackingConfig = null;
try {
  const manifest = JSON.parse(await readFile(path.join(buildRoot, 'build.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(repo, 'models.lock.json'), 'utf8'));
  trackingConfig = { worker: manifest.workers.face, ortBase: manifest.ort.dir, lock };
} catch {}
const port = Number(values.port);
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Use a port from 0 to 65535.');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.blend': 'application/octet-stream', '.mesh': 'application/octet-stream' };
const sceneFiles = new Set(['/index.html', '/viewer.js', '/viewer.css', '/tracking.js', '/field.json', '/field.mesh', '/highland-field.png', '/highland-field.blend']);
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self' data:; media-src blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
  try {
    if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(405).end('Use GET or HEAD.'); return; }
    const name = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    if (name === '/tracking-config.json') {
      response.setHeader('Content-Type', 'application/json');
      response.writeHead(trackingConfig ? 200 : 503).end(JSON.stringify(trackingConfig ?? { error: 'Run npm run build before using head tracking.' })); return;
    }
    let allowedRoot = root, route = name;
    if (trackingConfig && (name === trackingConfig.worker || name.startsWith(trackingConfig.ortBase))) allowedRoot = buildRoot;
    if (trackingConfig && trackingConfig.lock.models.face.files.some(file => file.served === name)) allowedRoot = repo;
    if (allowedRoot === root && !sceneFiles.has(route === '/' ? '/index.html' : route)) { response.writeHead(404).end('File not found.'); return; }
    const filename = path.resolve(allowedRoot, `.${route === '/' ? '/index.html' : route}`);
    if (!filename.startsWith(allowedRoot + path.sep)) { response.writeHead(403).end('Outside scene directory.'); return; }
    const info = await stat(filename);
    if (!info.isFile()) { response.writeHead(404).end('File not found.'); return; }
    response.setHeader('Content-Type', types[path.extname(filename)] ?? 'application/octet-stream');
    response.setHeader('Content-Length', info.size);
    response.writeHead(200).end(request.method === 'HEAD' ? undefined : await readFile(filename));
  } catch { response.writeHead(404).end('File not found.'); }
});
server.listen(port, values.host, () => {
  const address = server.address();
  console.log(`Highland field: http://${values.host}:${typeof address === 'object' && address ? address.port : port}/`);
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close());
