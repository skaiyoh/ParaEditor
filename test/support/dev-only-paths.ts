// The requests production mode must answer 404: every dev-only route and dev
// page, each under the spellings that reach the same file on macOS's
// case-insensitive file system or after decoding, and the sink to a POST as
// well as a GET. test/serve-production.test.ts and the production browser
// scenarios send them raw, so no client normalizes a path before the server
// sees it.

import http from 'node:http';
import https from 'node:https';

export type RawRequest = { readonly method: 'GET' | 'HEAD' | 'POST'; readonly path: string };

const SPELLINGS: readonly string[] = [
  '/dev',
  '/dev/',
  '/dev/fault',
  '/dev/checklist.html',
  '/dev/csp-report',
  '/dev/requests',
  '/dev/threads.html',
  '/dev/models.html',
  '/dev/sequence.html',
  '/dev/service.html',
  '/dev/decoder.html',
  '/dev/store.html',
  '/dev/harness/memory.html',
  '/dev/synth/master',
  '/dev/synth/master?width=2048&height=1536',
  '//dev/synth/master?width=2048&height=1536',
  '/%2Fdev/synth/master?width=2&height=2',
  '/DEV/Synth/Master?width=2&height=2',
  '/%64ev/synth/master?width=2&height=2',
  '/./dev/synth/master?width=2&height=2',
  '/assets/../dev/synth/master?width=2&height=2',
  '//dev/fault',
  '///dev/checklist.html',
  '/%2Fdev/fault',
  '/%2fdev/checklist.html',
  '/DEV/fault',
  '/Dev/Checklist.html',
  '/%64ev/fault',
  '/%44EV/requests',
  '/./dev/fault',
  '/assets/../dev/fault',
  '/models/../dev/csp-report',
  '/dev?x=1',
  '/\\dev/checklist.html',
  '/%5Cdev/checklist.html',
  '/assets/..%5cdev/checklist.html',
  '/dev%00/checklist.html',
  '/api',
  '/api/',
  '/api/log',
  '//api/log',
  '/%2Fapi/log',
  '/API/log',
  '/Api/Log',
  '/%61pi/log',
  '/./api/log',
];

export const DEV_ONLY_REQUESTS: readonly RawRequest[] = [
  ...SPELLINGS.map((path) => ({ method: 'GET' as const, path })),
  ...['/dev/fault', '/dev/csp-report', '/api/log', '//api/log', '/%2Fapi/log', '/API/log'].map((path) => ({ method: 'POST' as const, path })),
  ...['/dev/synth/master?width=2&height=2'].map((path) => ({ method: 'POST' as const, path })),
  ...['/dev/fault', '/api/log', '/dev/synth/master?width=2&height=2'].map((path) => ({ method: 'HEAD' as const, path })),
];

export type RawResponse = { readonly status: number; readonly headers: http.IncomingHttpHeaders; readonly body: Buffer };

/**
 * Sends one request with its path exactly as written (fetch would resolve dot
 * segments and a leading //), over http or https as the base URL says.
 */
export function rawRequest(baseUrl: string, request: RawRequest, headers: Readonly<Record<string, string>> = {}): Promise<RawResponse> {
  const base = new URL(baseUrl);
  const client = base.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      { protocol: base.protocol, hostname: base.hostname, port: base.port, method: request.method, path: request.path, headers: { ...headers }, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(request.method === 'POST' ? '{"probe":true}' : undefined);
  });
}
