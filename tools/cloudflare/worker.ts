import { handleProjects, type ProjectsEnv } from './projects.ts';
import { handleGallery, type GalleryEnv } from './gallery.ts';
import { isGalleryId } from '../../src/core/gallery.ts';

type HeaderMap = Readonly<Record<string, string>>;
type Route =
  | { readonly kind: 'asset'; readonly headers: HeaderMap }
  | { readonly kind: 'model'; readonly key: string; readonly bytes: number; readonly headers: HeaderMap };
export type HostingConfig = {
  readonly routes: Readonly<Record<string, Route>>;
  readonly errors: HeaderMap;
};
type ObjectInfo = { readonly size: number; readonly httpEtag: string; readonly uploaded: Date };
export type HostingEnv = Partial<ProjectsEnv> & Partial<GalleryEnv> & {
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
  readonly MODELS: {
    head(key: string): Promise<ObjectInfo | null>;
    get(key: string, options?: { range: { offset: number; length: number } }): Promise<(ObjectInfo & { readonly body: ReadableStream<Uint8Array> }) | null>;
  };
};
type ByteRange = { readonly offset: number; readonly length: number };
type RangeResult = { readonly kind: 'full' } | { readonly kind: 'unsatisfiable' } | { readonly kind: 'range'; readonly range: ByteRange };

function byteRange(value: string | null, size: number): RangeResult {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value ?? '');
  if (match === null || (match[1] === '' && match[2] === '')) return { kind: 'full' };
  const first = Number(match[1]);
  const last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return { kind: 'full' };
  if (match[1] === '') {
    if (last === 0 || size === 0) return { kind: 'unsatisfiable' };
    const length = Math.min(size, last);
    return { kind: 'range', range: { offset: size - length, length } };
  }
  const end = match[2] === '' ? size - 1 : Math.min(last, size - 1);
  if (first >= size || first > end) return { kind: 'unsatisfiable' };
  return { kind: 'range', range: { offset: first, length: end - first + 1 } };
}

// The edge cache revalidates with the stored ETag, and ASSETS answers 304 for unchanged
// bytes, so a header-policy change would never reach the cached copy. Folding a tag of
// the route's header map into the validator makes a changed policy a different validator.
function policyTag(headers: HeaderMap): string {
  const canonical = Object.entries(headers).map(([name, value]) => `${name.toLowerCase()}:${value}`).sort().join('\n');
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(canonical)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, '0');
}

const ENTITY_TAG = /(W\/)?"([^"]*)"/g;

function tagETag(etag: string, tag: string): string {
  const match = /^(W\/)?"([^"]*)"$/.exec(etag);
  return match === null ? etag : `${match[1] ?? ''}"${match[2]}-${tag}"`;
}

// Keeps the entity tags that carry `tag`, with the tag removed; null when none remain.
function untagETags(value: string, tag: string): string | null {
  const suffix = `-${tag}`;
  const kept: string[] = [];
  for (const match of value.matchAll(ENTITY_TAG)) {
    const opaque = match[2] ?? '';
    if (opaque.endsWith(suffix)) kept.push(`${match[1] ?? ''}"${opaque.slice(0, -suffix.length)}"`);
  }
  return kept.length === 0 ? null : kept.join(', ');
}

// Rewrites the conditional headers of an asset request into the validators ASSETS knows.
function untagConditions(request: Request, tag: string): void {
  const conditions = request.headers;
  conditions.delete('If-Modified-Since');
  const none = conditions.get('If-None-Match');
  if (none !== null && none.trim() !== '*') {
    const kept = untagETags(none, tag);
    if (kept === null) conditions.delete('If-None-Match'); else conditions.set('If-None-Match', kept);
  }
  const ifRange = conditions.get('If-Range');
  if (ifRange !== null) {
    const kept = untagETags(ifRange, tag);
    if (kept !== null) conditions.set('If-Range', kept);
  }
}

export function createHandler(config: HostingConfig): { fetch(request: Request, env: HostingEnv): Promise<Response> } {
  const routes = new Map(Object.entries(config.routes));
  const tags = new Map(Object.values(config.routes).flatMap((route) => route.kind === 'asset' ? [[route, policyTag(route.headers)] as const] : []));
  function error(request: Request, status: number, message: string, extra: HeaderMap = {}): Response {
    return new Response(request.method === 'HEAD' ? null : `${message}\n`, {
      status,
      headers: { ...config.errors, ...extra },
    });
  }
  return {
    async fetch(request, env) {
      let pathname: string;
      try { pathname = decodeURIComponent(new URL(request.url).pathname); }
      catch {
        if (new URL(request.url).pathname.startsWith('/api/gallery')) return error(request, 400, JSON.stringify({ error: 'The gallery path is invalid.' }), { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        return error(request, 400, 'Invalid request path.');
      }
      if (pathname === '/api/gallery' || pathname.startsWith('/api/gallery/')) {
        if (env.PROJECTS === undefined) return error(request, 502, JSON.stringify({ error: 'The gallery store is unavailable.' }), { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        return handleGallery(request, pathname, { PROJECTS: env.PROJECTS,
          ...(env.GALLERY_ADMIN_KEY === undefined ? {} : { GALLERY_ADMIN_KEY: env.GALLERY_ADMIN_KEY }) }, config.routes['/']?.headers ?? config.errors);
      }
      if (pathname === '/api/projects' || pathname.startsWith('/api/projects/')) {
        const apiError = (status: number, sentence: string): Response => error(request, status, JSON.stringify({ error: sentence }), { 'Content-Type': 'application/json' });
        if (env.PROJECTS === undefined || env.NEON_DATABASE_URL === undefined) return apiError(502, 'The project store is unavailable.');
        const headers = config.routes['/']?.headers ?? config.errors;
        return handleProjects(request, pathname, { PROJECTS: env.PROJECTS, NEON_DATABASE_URL: env.NEON_DATABASE_URL }, headers, apiError);
      }
      const galleryAlias = pathname === '/gallery' || (pathname.startsWith('/gallery/') && isGalleryId(pathname.slice('/gallery/'.length)));
      // Pages redirects /scenes.html to /scenes, as it does /gallery.html to /gallery.
      const scenesAlias = pathname === '/scenes' && routes.has('/scenes.html');
      const route = routes.get(galleryAlias ? '/gallery.html' : scenesAlias ? '/scenes.html' : pathname);
      if (route === undefined) return error(request, 404, 'Not found.');
      if (request.method !== 'GET' && request.method !== 'HEAD') return error(request, 405, 'Use GET or HEAD.', { Allow: 'GET, HEAD' });
      try {
        if (route.kind === 'asset') {
          // Pages redirects /index.html; the local production contract serves it directly.
          const url = new URL(request.url);
          if (galleryAlias || pathname === '/gallery.html') url.pathname = '/gallery';
          if (scenesAlias || pathname === '/scenes.html') url.pathname = '/scenes';
          if (pathname === '/index.html') url.pathname = '/';
          const tag = tags.get(route) ?? policyTag(route.headers);
          const forwarded = new Request(url, request);
          untagConditions(forwarded, tag);
          const asset = await env.ASSETS.fetch(forwarded);
          if (asset.status >= 400) {
            await asset.body?.cancel();
            return error(request, asset.status, 'Asset unavailable.');
          }
          const headers = new Headers(asset.headers);
          for (const [name, value] of Object.entries(route.headers)) headers.set(name, value);
          const etag = headers.get('ETag');
          if (etag !== null) headers.set('ETag', tagETag(etag, tag));
          return new Response(request.method === 'HEAD' ? null : asset.body, { status: asset.status, headers });
        }
        const info = await env.MODELS.head(route.key);
        if (info === null) return error(request, 404, 'Model unavailable.');
        if (info.size !== route.bytes) return error(request, 503, 'Model storage does not match the lock.');
        const headers = new Headers(route.headers);
        headers.set('Accept-Ranges', 'bytes');
        headers.set('ETag', info.httpEtag);
        headers.set('Last-Modified', info.uploaded.toUTCString());
        let range = request.method === 'GET' ? byteRange(request.headers.get('Range'), info.size) : { kind: 'full' } satisfies RangeResult;
        const ifRange = request.headers.get('If-Range');
        const modifiedSecond = Math.floor(info.uploaded.getTime() / 1000) * 1000;
        if (ifRange !== null && ifRange !== info.httpEtag && Date.parse(ifRange) !== modifiedSecond) range = { kind: 'full' };
        if (range.kind === 'unsatisfiable') return error(request, 416, 'Requested range is outside this model.', {
          'Content-Range': `bytes */${info.size}`, 'Accept-Ranges': 'bytes',
        });
        const partial = range.kind === 'range' ? range.range : undefined;
        headers.set('Content-Length', String(partial?.length ?? info.size));
        if (partial !== undefined) headers.set('Content-Range', `bytes ${partial.offset}-${partial.offset + partial.length - 1}/${info.size}`);
        if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
        const object = await env.MODELS.get(route.key, partial === undefined ? undefined : { range: partial });
        if (object === null) return error(request, 404, 'Model unavailable.');
        if (object.size !== info.size || object.httpEtag !== info.httpEtag) {
          await object.body.cancel();
          return error(request, 503, 'Model storage changed during the request.');
        }
        return new Response(object.body, { status: partial === undefined ? 200 : 206, headers });
      } catch {
        return error(request, 503, 'Storage is temporarily unavailable.');
      }
    },
  };
}
