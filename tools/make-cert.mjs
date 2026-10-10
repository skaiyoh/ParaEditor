#!/usr/bin/env node
// Local phone trust: retain the CA, refresh the leaf with this network's IPv4 SANs.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const openssl = promisify(execFile);
const HOSTNAME = 'Nathans-MacBook-Air.local';
const DAYS = '825';

async function exists(file) {
  try { await access(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function makeCertificates(outdir) {
  await mkdir(outdir, { recursive: true, mode: 0o700 });
  await chmod(outdir, 0o700);
  const ca = path.join(outdir, 'ca.pem'), caKey = path.join(outdir, 'ca-key.pem');
  const [hasCa, hasKey] = await Promise.all([exists(ca), exists(caKey)]);
  if (hasCa !== hasKey) throw new Error('Incomplete local CA: restore both ca.pem and ca-key.pem before retrying.');
  const scratch = await mkdtemp(path.join(outdir, '.cert-'));
  const staged = (name) => path.join(scratch, name);
  try {
    if (!hasCa) {
      await openssl('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-noenc',
        '-sha256', '-days', '3650', '-subj', '/CN=noisy local phone CA',
        '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
        '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
        '-keyout', staged('ca-key.pem'), '-out', staged('ca.pem')]);
    }
    const signingCa = hasCa ? ca : staged('ca.pem'), signingKey = hasCa ? caKey : staged('ca-key.pem');
    await chmod(signingKey, 0o600);
    const [certPublic, keyPublic] = await Promise.all([
      openssl('openssl', ['x509', '-in', signingCa, '-pubkey', '-noout']),
      openssl('openssl', ['pkey', '-in', signingKey, '-pubout']),
    ]);
    if (certPublic.stdout !== keyPublic.stdout) throw new Error('The local CA certificate and key do not match.');
    await openssl('openssl', ['x509', '-in', signingCa, '-checkend', String(825 * 86400), '-noout']);
    const addresses = new Set(['127.0.0.1']);
    for (const entries of Object.values(networkInterfaces())) for (const entry of entries ?? []) {
      if (entry.family === 'IPv4') addresses.add(entry.address);
    }
    const sans = [`DNS:${HOSTNAME}`, 'DNS:localhost', ...[...addresses].sort().map((address) => `IP:${address}`)];
    await writeFile(staged('extensions.cnf'), [
      'basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature', 'extendedKeyUsage=serverAuth',
      'subjectKeyIdentifier=hash', 'authorityKeyIdentifier=keyid,issuer', `subjectAltName=${sans.join(',')}`, '',
    ].join('\n'));
    await openssl('openssl', ['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-noenc',
      '-sha256', '-subj', `/CN=${HOSTNAME}`, '-keyout', staged('server-key.pem'), '-out', staged('server.csr')]);
    await chmod(staged('server-key.pem'), 0o600);
    await openssl('openssl', ['x509', '-req', '-in', staged('server.csr'), '-CA', signingCa, '-CAkey', signingKey,
      '-set_serial', `0x${randomBytes(16).toString('hex')}`, '-sha256', '-days', DAYS,
      '-extfile', staged('extensions.cnf'), '-out', staged('server.pem')]);
    await openssl('openssl', ['verify', '-purpose', 'sslserver', '-CAfile', signingCa, staged('server.pem')]);
    if (!hasCa) {
      await rename(staged('ca-key.pem'), caKey);
      await rename(staged('ca.pem'), ca);
    }
    await rename(staged('server-key.pem'), path.join(outdir, 'server-key.pem'));
    await rename(staged('server.pem'), path.join(outdir, 'server.pem'));
    process.stdout.write(`make-cert: ${hasCa ? 'kept' : 'created'} CA ${ca}\n`);
    process.stdout.write(`make-cert: refreshed server.pem and server-key.pem (${DAYS} days)\nSANs: ${sans.join(', ')}\n`);
    process.stdout.write(`1. AirDrop ${ca} to the iPhone.\n2. Install the downloaded certificate profile in Settings > General > VPN & Device Management.\n3. Enable full trust for noisy local phone CA in Settings > General > About > Certificate Trust Settings.\n`);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

try {
  const { values } = parseArgs({ options: { outdir: { type: 'string', default: path.join(REPO, '.local/tls') }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) process.stdout.write('usage: node tools/make-cert.mjs [--outdir .local/tls]\nKeeps the CA and refreshes the server certificate for the current network.\n');
  else await makeCertificates(path.resolve(values.outdir));
} catch (error) {
  process.stderr.write(`make-cert: ${error.message}\n`); process.exitCode = 1;
}
