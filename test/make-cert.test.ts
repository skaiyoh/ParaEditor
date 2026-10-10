import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { runTool, tempDir } from './support/cli.ts';

const openssl = promisify(execFile);

test('make-cert creates a trusted 825-day TLS leaf with current SANs and retains the CA on refresh', async (t) => {
  const scratch = await tempDir('make-cert');
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const outdir = path.join(scratch, 'tls with spaces');
  const run = await runTool('tools/make-cert.mjs', ['--outdir', outdir]);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const caBytes = await readFile(path.join(outdir, 'ca.pem'));
  const caKey = await readFile(path.join(outdir, 'ca-key.pem'));
  const leafBytes = await readFile(path.join(outdir, 'server.pem'));
  const leafKey = await readFile(path.join(outdir, 'server-key.pem'));
  const ca = new X509Certificate(caBytes), leaf = new X509Certificate(leafBytes);
  assert.equal(ca.ca, true);
  assert.equal(leaf.ca, false);
  assert.equal(leaf.verify(ca.publicKey), true);
  assert.equal(leaf.checkHost('Nathans-MacBook-Air.local'), 'Nathans-MacBook-Air.local');
  assert.equal(leaf.checkHost('localhost'), 'localhost');
  assert.equal(leaf.checkIP('127.0.0.1'), '127.0.0.1');
  for (const entries of Object.values(networkInterfaces())) for (const entry of entries ?? []) {
    if (entry.family === 'IPv4') assert.equal(leaf.checkIP(entry.address), entry.address);
  }
  assert.equal(Date.parse(leaf.validTo) - Date.parse(leaf.validFrom), 825 * 86400 * 1000);
  assert.deepEqual(
    createPublicKey(createPrivateKey(leafKey)).export({ type: 'spki', format: 'pem' }),
    leaf.publicKey.export({ type: 'spki', format: 'pem' }),
  );
  const verified = await openssl('openssl', ['verify', '-purpose', 'sslserver', '-CAfile', path.join(outdir, 'ca.pem'), path.join(outdir, 'server.pem')]);
  assert.match(verified.stdout, /: OK/);
  const extensions = await openssl('openssl', ['x509', '-in', path.join(outdir, 'server.pem'), '-noout', '-text']);
  assert.match(extensions.stdout, /TLS Web Server Authentication/);
  assert.match(extensions.stdout, /ecdsa-with-SHA256/);
  assert.equal((await stat(path.join(outdir, 'ca-key.pem'))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(outdir, 'server-key.pem'))).mode & 0o777, 0o600);
  assert.match(run.stdout, /1\. AirDrop/);
  assert.match(run.stdout, /2\. Install/);
  assert.match(run.stdout, /3\. Enable full trust/);
  assert.ok(run.stdout.includes(path.join(outdir, 'ca.pem')));
  const refreshed = await runTool('tools/make-cert.mjs', ['--outdir', outdir]);
  assert.equal(refreshed.code, 0, refreshed.stdout + refreshed.stderr);
  assert.deepEqual(await readFile(path.join(outdir, 'ca.pem')), caBytes);
  assert.deepEqual(await readFile(path.join(outdir, 'ca-key.pem')), caKey);
  assert.notDeepEqual(await readFile(path.join(outdir, 'server.pem')), leafBytes);
  assert.notDeepEqual(await readFile(path.join(outdir, 'server-key.pem')), leafKey);
  const newLeaf = new X509Certificate(await readFile(path.join(outdir, 'server.pem')));
  assert.equal(newLeaf.verify(ca.publicKey), true);
  assert.equal((await readdir(outdir)).some((file) => file.startsWith('.cert-')), false);
});

test('make-cert refuses a partial CA without replacing the installed trust anchor', async (t) => {
  const outdir = await tempDir('make-cert-partial');
  t.after(() => rm(outdir, { recursive: true, force: true }));
  const sentinel = 'installed CA sentinel';
  await writeFile(path.join(outdir, 'ca.pem'), sentinel);
  const run = await runTool('tools/make-cert.mjs', ['--outdir', outdir]);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /Incomplete local CA/);
  assert.equal(await readFile(path.join(outdir, 'ca.pem'), 'utf8'), sentinel);
  assert.deepEqual(await readdir(outdir), ['ca.pem']);
});
