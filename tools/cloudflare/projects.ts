import { z } from '../../src/core/zod.ts';
import { deserializeProjectEnvelope, serializeDocument, PROJECTS_TRANSPORT_VERSION } from '../../src/projects/serialize.ts';

import { compositionAssetLimit, compositionAssetPath, readAssetBody, validateCompositionAssets, validateGenericAsset, MAX_ASSET_BYTES } from '../../src/projects/assets.ts';
import { isAssetId } from '../../src/core/ids.ts';

type ObjectInfo = { readonly size: number };
export type ProjectsEnv = {
  readonly NEON_DATABASE_URL: string;
  readonly PROJECTS: {
    head(key: string): Promise<ObjectInfo | null>;
    get(key: string): Promise<(ObjectInfo & { readonly body: ReadableStream<Uint8Array>; readonly httpMetadata?: { readonly contentType?: string } }) | null>;
    put(key: string, value: ArrayBuffer, options: { httpMetadata: { contentType: string } }): Promise<unknown>;
    list(options: { prefix: string; cursor?: string }): Promise<{ objects: readonly { key: string }[]; truncated: boolean; cursor?: string }>;
    delete(keys: string | string[]): Promise<void>;
  };
};
type Query = { readonly query: string; readonly params: readonly (string | number)[] };
const resultSchema = z.object({ rows: z.array(z.unknown()) });

// The sole SQL transport, shared with the one-time migration. Never expose upstream errors.
export async function neonSql(connection: string, statement: Query | readonly Query[]): Promise<readonly unknown[]> {
  try {
    const batch = Array.isArray(statement);
    const response = await fetch(`https://${new URL(connection).hostname}/sql`, {
      method: 'POST',
      headers: { 'Neon-Connection-String': connection, 'Content-Type': 'application/json',
        ...(batch ? { 'Neon-Batch-Isolation-Level': 'ReadCommitted' } : {}) },
      body: JSON.stringify(batch ? { queries: statement } : statement),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(); }
    const raw: unknown = await response.json();
    if (!batch) return resultSchema.parse(raw).rows;
    const results = z.object({ results: z.array(resultSchema) }).parse(raw).results;
    if (results.length !== statement.length) throw new Error();
    return results.at(-1)?.rows ?? [];
  } catch { throw new Error('The project database is unavailable.'); }
}

const projectId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const assetId = /^[a-f0-9]{64}$/;
const revisionSchema = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const rowSchema = z.object({ scene: z.unknown(), masks: z.unknown(), revision: revisionSchema });
const stateSchema = z.object({ deleted: z.boolean(), revision: revisionSchema.nullable(), masks: z.record(z.string(), z.object({ width: z.number().int().min(1).max(4096), height: z.number().int().min(1).max(4096) })).nullable() });
const statusSchema = z.object({ status: z.enum(['saved', 'conflict', 'deleted']) });
// Lock in its own statement: the following READ COMMITTED statement gets a fresh
// snapshot after any concurrent deletion/save has committed, even after waiting.
const lock = (id: string): Query => ({ query: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', params: [id] });
const state = (id: string): Query => ({ query: `SELECT EXISTS(SELECT 1 FROM tombstones WHERE id = $1) AS deleted,
  (SELECT masks FROM projects WHERE id = $1) AS masks,
  (SELECT revision::text FROM projects WHERE id = $1) AS revision`, params: [id] });
const upsert = (id: string, name: string, scene: string, masks: string, revision: number): Query => ({
  query: `WITH saved AS (
    INSERT INTO projects (id, name, updated_at, scene, masks, revision)
    SELECT $1, $2, clock_timestamp(), $3::jsonb, $4::jsonb, $5::bigint
    WHERE NOT EXISTS (SELECT 1 FROM tombstones WHERE id = $1)
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at,
      scene = EXCLUDED.scene, masks = EXCLUDED.masks, revision = EXCLUDED.revision
    WHERE projects.revision < EXCLUDED.revision RETURNING id
  ) SELECT CASE WHEN EXISTS(SELECT 1 FROM tombstones WHERE id = $1) THEN 'deleted'
    WHEN EXISTS(SELECT 1 FROM saved) THEN 'saved' ELSE 'conflict' END AS status`,
  params: [id, name, scene, masks, revision],
});
const touch = (id: string): Query => ({ query: `UPDATE projects SET updated_at = clock_timestamp()
  WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM tombstones WHERE id = $1)`, params: [id] });

async function cleanup(bucket: ProjectsEnv['PROJECTS'], prefix: string): Promise<number> {
  let cursor: string | undefined;
  let removed = 0;
  do {
    const page = await bucket.list({ prefix, ...(cursor === undefined ? {} : { cursor }) });
    if (page.objects.length > 0) await bucket.delete(page.objects.map(({ key }) => key));
    removed += page.objects.length;
    if (!page.truncated) return removed;
    if (!page.cursor || page.cursor === cursor) throw new Error('Project storage pagination failed.');
    cursor = page.cursor;
  } while (true);
}

async function readBody(request: Request, limit: number): Promise<ArrayBuffer | null> {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && Number(declared) > limit) { await request.body?.cancel(); return null; }
  if (request.body === null) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) { await reader.cancel(); return null; }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

export async function handleProjects(request: Request, pathname: string, env: ProjectsEnv,
  headers: Readonly<Record<string, string>>, error: (status: number, sentence: string) => Response): Promise<Response> {
  const reply = (value: unknown): Response => new Response(`${JSON.stringify(value)}\n`, { headers: { ...headers, 'Content-Type': 'application/json' } });
  const missing = (): Response => error(404, 'The project was not found.');
  const deleted = (): Response => error(410, 'The project was deleted.');
  const bad = (sentence: string): Response => error(400, sentence);
  const method = (): Response => new Response('method not allowed\n', { status: 405, headers: { ...headers, 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' } });
  const [, , , id, resource, asset, extra] = pathname.split('/');
  if (pathname !== '/api/projects' && (id === undefined || !projectId.test(id) || extra !== undefined ||
    (['masks', 'assets'].includes(resource ?? '') ? !assetId.test(asset ?? '') : asset !== undefined) ||
    (resource !== undefined && !['scene', 'photo', 'thumbnail', 'masks', 'assets'].includes(resource)))) return bad('The project path is invalid.');
  try {
    if (pathname === '/api/projects') {
      if (request.method !== 'GET') return method();
      const rows = z.array(z.object({ id: z.string().regex(projectId), name: z.string(), updated_at: z.string() }))
        .parse(await neonSql(env.NEON_DATABASE_URL, { query: 'SELECT id, name, updated_at::text FROM projects ORDER BY updated_at DESC, id ASC', params: [] }));
      return reply({ projects: rows.map((row) => ({ id: row.id, name: row.name, updatedAt: new Date(row.updated_at).toISOString(), thumbnail: `/api/projects/${row.id}/thumbnail` })) });
    }
    if (id === undefined) return bad('The project path is invalid.');
    const prefix = `projects/${id}/`;
    if (resource === undefined) {
      if (request.method !== 'DELETE') return method();
      const removed = await neonSql(env.NEON_DATABASE_URL, [lock(id),
        { query: 'INSERT INTO tombstones (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', params: [id] },
        { query: 'DELETE FROM projects WHERE id = $1 RETURNING id', params: [id] }]);
      const objects = await cleanup(env.PROJECTS, prefix);
      return removed.length > 0 || objects > 0 ? reply({ ok: true }) : missing();
    }
    if (request.method !== 'GET' && request.method !== 'PUT') return method();
    const current = stateSchema.parse((await neonSql(env.NEON_DATABASE_URL, state(id)))[0]);
    if (current.deleted) return request.method === 'PUT' ? deleted() : missing();
    const originalAsset = request.headers.get('X-Project-Asset');
    if (originalAsset !== null && (resource !== 'photo' || !isAssetId(originalAsset))) return bad('The original asset id is invalid.');
    const key = originalAsset !== null && request.method === 'PUT' ? `${prefix}assets/${originalAsset}` : `${prefix}${['masks', 'assets'].includes(resource) ? `${resource}/${asset}` : resource}`;
    if (request.method === 'GET') {
      if (resource === 'scene') {
        const rows = await neonSql(env.NEON_DATABASE_URL, { query: 'SELECT scene, masks, revision::text FROM projects WHERE id = $1', params: [id] });
        if (rows.length === 0) return missing();
        const row = rowSchema.parse(rows[0]);
        const composition = typeof row.scene === 'object' && row.scene !== null && 'version' in row.scene && (row.scene.version === 5 || row.scene.version === 6);
        return reply(composition ? { transportVersion: PROJECTS_TRANSPORT_VERSION, document: row.scene, revision: row.revision } : { document: row.scene, masks: row.masks, revision: row.revision });
      }
      const object = await env.PROJECTS.get(key);
      if (object === null) return missing();
      return new Response(object.body, { headers: { ...headers, 'Content-Length': String(object.size),
        'Content-Type': resource === 'thumbnail' ? 'image/jpeg' : ['masks', 'assets'].includes(resource) ? 'application/octet-stream' : object.httpMetadata?.contentType ?? 'application/octet-stream' } });
    }
    const limit = resource === 'scene' ? 1024 * 1024 : resource === 'thumbnail' ? 59_999 : resource === 'masks' ? 16 * 1024 * 1024 : resource === 'assets' ? MAX_ASSET_BYTES : 24 * 1024 * 1024;
    const buffer = await readBody(request, limit);
    if (buffer === null) return error(413, 'The project body is too large.');
    if (buffer.byteLength === 0) return bad('The project body is empty or too large.');
    const bytes = new Uint8Array(buffer);
    const type = (request.headers.get('Content-Type') ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
    if (resource === 'scene') {
      if (type !== 'application/json') return bad('The project scene must be JSON.');
      let envelope;
      try { envelope = deserializeProjectEnvelope(JSON.parse(new TextDecoder().decode(bytes))); }
      catch { return bad('The project scene or its mask metadata is invalid.'); }
      const scene = envelope.scene;
      if (scene.document.id !== id) return bad('The project document id must match its path.');
      if (current.revision !== null && scene.revision <= current.revision) return error(409, 'The project scene revision must increase.');
      if (envelope.kind === 'composition') {
        try {
          await validateCompositionAssets(envelope.scene.document, async (asset, refs) => {
            const object = await env.PROJECTS.get(`${prefix}${compositionAssetPath(asset, refs)}`);
            if (object === null) return null;
            if (object.size > compositionAssetLimit(refs)) { await object.body.cancel(); throw new Error('Asset exceeds its byte limit.'); }
            return readAssetBody(object.body, compositionAssetLimit(refs));
          });
        } catch { return bad('The project assets are missing or invalid.'); }
      }
      const masks = envelope.kind === 'legacy' ? envelope.scene.masks : {};
      for (const [mask, size] of Object.entries(masks)) {
        const info = await env.PROJECTS.head(`${prefix}masks/${mask}`);
        if (info !== null && info.size !== size.width * size.height) return bad('The project mask size does not match its bytes.');
      }
      const result = statusSchema.parse((await neonSql(env.NEON_DATABASE_URL, [lock(id),
        upsert(id, scene.document.title, JSON.stringify(envelope.kind === 'composition' ? serializeDocument(envelope.scene.document) : scene.document), JSON.stringify(masks), scene.revision)]))[0]);
      return result.status === 'deleted' ? deleted() : result.status === 'conflict' ? error(409, 'The project scene revision must increase.') : reply({ ok: true });
    }
    if (resource === 'assets') {
      if (type !== 'application/octet-stream' || asset === undefined || !isAssetId(asset)) return bad('The project asset must be raw bytes.');
      try { await validateGenericAsset(bytes, asset); }
      catch { return bad('The project asset bytes are invalid.'); }
    } else if (resource === 'thumbnail') {
      if (type !== 'image/jpeg' || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return bad('The project thumbnail must be a JPEG under 60 KB.');
    } else if (resource === 'masks') {
      if (type !== 'application/octet-stream') return bad('The project mask must be raw bytes.');
      const size = current.masks?.[asset ?? ''];
      if (size !== undefined && bytes.length !== size.width * size.height) return bad('The project mask size does not match its bytes.');
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
      if ([...hash].map((value) => value.toString(16).padStart(2, '0')).join('') !== asset) return bad('The project mask bytes do not match their asset id.');
    } else if (!/^(image\/[a-z0-9.+-]+|application\/octet-stream)$/.test(type)) return bad('The project photo must carry its original content type.');
    if (originalAsset !== null) {
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
      if ([...hash].map((value) => value.toString(16).padStart(2, '0')).join('') !== originalAsset) return bad('The project asset bytes are invalid.');
    }
    // Recheck after receiving bytes: the client may have timed out while uploading.
    if (stateSchema.parse((await neonSql(env.NEON_DATABASE_URL, state(id)))[0]).deleted) return deleted();
    await env.PROJECTS.put(key, buffer, { httpMetadata: { contentType: type } });
    const after = stateSchema.parse((await neonSql(env.NEON_DATABASE_URL, [lock(id), touch(id), state(id)]))[0]);
    // R2 and Neon cannot share a transaction. A DELETE racing an in-flight R2
    // write wins logically via its tombstone; the late writer removes its bytes.
    if (after.deleted) { await cleanup(env.PROJECTS, prefix); return deleted(); }
    if (resource === 'masks') {
      const size = after.masks?.[asset ?? ''];
      if (size !== undefined && bytes.length !== size.width * size.height) {
        await env.PROJECTS.delete(key);
        return bad('The project mask size does not match its bytes.');
      }
    }
    return reply({ ok: true });
  } catch { return error(502, 'The project store is unavailable.'); }
}
