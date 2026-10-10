import { spawn } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ROOT, STATE } from './prepare.mjs';

export async function neonConnection() {
  const file = path.join(ROOT, '.local/cloudflare.env');
  if (((await stat(file)).mode & 0o777) !== 0o600) throw new Error('The local Cloudflare credentials file must have mode 600.');
  const value = parseEnv(await readFile(file, 'utf8')).NEON_DATABASE_URL;
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password) throw new Error();
  } catch { throw new Error('The local Neon connection string is missing or invalid.'); }
  return value;
}

export async function credentials({ env = process.env, file = path.join(ROOT, '.local/cloudflare.env') } = {}) {
  // Never combine a partial CI environment with credentials from another account.
  const fromEnvironment = Object.hasOwn(env, 'CLOUDFLARE_ACCOUNT_ID') || Object.hasOwn(env, 'CLOUDFLARE_API_TOKEN');
  const values = fromEnvironment ? env : parseEnv(await readFile(file, 'utf8'));
  if (!/^[a-f0-9]{32}$/.test(values.CLOUDFLARE_ACCOUNT_ID ?? '') || !values.CLOUDFLARE_API_TOKEN || /\s/.test(values.CLOUDFLARE_API_TOKEN) || values.CLOUDFLARE_API_TOKEN.includes('your_')) throw new Error('Cloudflare credentials are incomplete.');
  return { CLOUDFLARE_ACCOUNT_ID: values.CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN: values.CLOUDFLARE_API_TOKEN };
}

export async function wrangler(args, { authenticated = true } = {}) {
  await mkdir(STATE, { recursive: true, mode: 0o700 });
  const auth = authenticated ? await credentials() : {};
  const redact = (value) => auth.CLOUDFLARE_API_TOKEN ? value.replaceAll(auth.CLOUDFLARE_API_TOKEN, '[redacted]') : value;
  return await new Promise((resolve, reject) => {
    const child = spawn('npm', ['--cache', path.join(STATE, 'npm-cache'), 'exec', '--yes', '--package=wrangler@4.149.0', '--', 'wrangler', ...args], {
      // Pages only accepts wrangler.json discovered in its working directory.
      cwd: path.join(ROOT, 'tools/cloudflare'),
      env: { ...process.env, ...auth, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: path.join(STATE, 'wrangler.log'), WRANGLER_CACHE_DIR: path.join(STATE, 'wrangler-cache'), CI: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      const safe = redact(output);
      if (code !== 0) reject(new Error(`Wrangler exited ${code}:\n${safe}`));
      else { console.log(safe.trim()); resolve(safe); }
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== '--version') throw new Error('Use deploy.mjs for deployments; cli.mjs only bootstraps the pinned CLI.');
  await wrangler(args, { authenticated: false });
}
