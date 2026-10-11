#!/usr/bin/env node
// Pack existing Highland-format assets; use the browser parser as the boundary.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseScenePackage } from '../src/app/scene-package.ts';

export async function makeScenePackage({ field, mesh, poster, mediaType, title }) {
  const manifest = Buffer.from(JSON.stringify({ format: 'noisy-scene', version: 1, title, field,
    mesh: { bytes: mesh.byteLength, sha256: createHash('sha256').update(mesh).digest('hex') },
    poster: { mediaType, bytes: poster.byteLength } }), 'utf8');
  const header = Buffer.alloc(8);
  header.write('NSC1'); header.writeUInt32LE(manifest.byteLength, 4);
  const data = Buffer.concat([header, manifest, mesh, poster]);
  const bytes = new Uint8Array(data).buffer;
  const result = await parseScenePackage(bytes);
  if (!result.ok) throw new Error(result.reason);
  return bytes;
}

async function main(args) {
  if (args.length !== 5) throw new Error('Usage: node tools/make-scene-package.mjs field.json field.mesh poster.png output.noisyscene "Scene title"');
  const [fieldPath, meshPath, posterPath, outputPath, title] = args;
  const [fieldJson, mesh, poster] = await Promise.all([readFile(fieldPath, 'utf8'), readFile(meshPath), readFile(posterPath)]);
  const png = poster.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = poster[0] === 255 && poster[1] === 216 && poster[2] === 255;
  if (!png && !jpeg) throw new Error('The poster must be a PNG or JPEG image.');
  const bytes = await makeScenePackage({ field: JSON.parse(fieldJson), mesh, poster, mediaType: png ? 'image/png' : 'image/jpeg', title });
  await writeFile(outputPath, new Uint8Array(bytes), { flag: 'wx' });
  process.stdout.write(`Packed ${bytes.byteLength} bytes into ${outputPath}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
