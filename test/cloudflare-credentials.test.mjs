import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { credentials } from '../tools/cloudflare/cli.mjs';

const account = 'a'.repeat(32);
const token = 'test-token-never-a-real-credential';

test('CI credentials work without a local credential file', async () => {
  assert.deepEqual(await credentials({ env: { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token }, file: '/missing/cloudflare.env' }), {
    CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token,
  });
});

test('local credentials remain available, but never fill a partial environment', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'noisy-credentials-'));
  const file = path.join(dir, 'cloudflare.env');
  try {
    await writeFile(file, `CLOUDFLARE_ACCOUNT_ID=${account}\nCLOUDFLARE_API_TOKEN=${token}\n`, { mode: 0o600 });
    assert.deepEqual(await credentials({ env: {}, file }), { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token });
    for (const env of [{ CLOUDFLARE_ACCOUNT_ID: account }, { CLOUDFLARE_API_TOKEN: token }, { CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_API_TOKEN: '' }]) {
      await assert.rejects(credentials({ env, file }), { message: 'Cloudflare credentials are incomplete.' });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('invalid credentials fail without including their values in errors', async () => {
  for (const env of [
    { CLOUDFLARE_ACCOUNT_ID: 'invalid-account', CLOUDFLARE_API_TOKEN: token },
    { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: 'your_token' },
    { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: 'token with spaces' },
  ]) await assert.rejects(credentials({ env, file: '/missing/cloudflare.env' }), { message: 'Cloudflare credentials are incomplete.' });
});
