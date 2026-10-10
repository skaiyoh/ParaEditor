// GitHub main -> verified Pages preview -> production -> verified custom domain.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DOMAIN, ROOT, STATE, prepare } from './prepare.mjs';

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'This entry point requires GitHub Actions.');
assert.equal(process.env.GITHUB_REPOSITORY, 'skaiyoh/noisy-demo');
assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'Only main can deploy.');
assert.ok(['push', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME), 'This event cannot deploy.');
assert.match(process.env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/);
assert.ok(process.env.GITHUB_TOKEN, 'A read-only GitHub token is required to check main.');

async function isCurrentMain() {
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/git/ref/heads/main`, {
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200, 'Could not check the current main commit.');
  const current = await response.json();
  assert.match(current.object?.sha ?? '', /^[a-f0-9]{40}$/);
  if (current.object.sha === process.env.GITHUB_SHA) return true;
  const message = `Skipped superseded commit ${process.env.GITHUB_SHA}; main is ${current.object.sha}.`;
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
  return false;
}

async function run(script, ...args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: ROOT, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${script}: ${signal ?? `exit ${code}`}`)));
  });
}

async function verify(url) {
  // A completed Pages upload can precede propagation of its routing worker.
  // Repeat the full contract, never relax an assertion or promote on failure.
  const delays = [5_000, 10_000, 20_000, 30_000, 30_000];
  for (let attempt = 0; ; attempt++) {
    try {
      await run('tools/cloudflare/verify.mjs', url);
      return;
    } catch (error) {
      if (attempt === delays.length) throw error;
      console.log(`Verification attempt ${attempt + 1} failed for ${url}; retrying the full check in ${delays[attempt] / 1000}s.`);
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

if (!await isCurrentMain()) process.exit(0);
await prepare();
const prepared = JSON.parse(await readFile(path.join(STATE, 'prepared.json'), 'utf8'));
assert.ok(prepared.buildId.startsWith(`${process.env.GITHUB_SHA.slice(0, 12)}-`), 'Build must come from this GitHub commit.');
const deployments = {};
for (const environment of ['preview', 'production']) {
  if (environment === 'production' && !await isCurrentMain()) process.exit(0);
  await run('tools/cloudflare/deploy.mjs', environment);
  const deployment = JSON.parse(await readFile(path.join(STATE, `${environment}.json`), 'utf8'));
  await verify(deployment.url);
  deployments[environment] = deployment.url;
}
await verify(`https://${DOMAIN}/`);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, [
    `Deployed and verified **${prepared.buildId}**.`,
    '',
    `- [Live editor](https://${DOMAIN}/)`,
    `- [Verified preview](${deployments.preview})`,
    `- [Verified production](${deployments.production})`,
    '',
    'Asset hashes, all seven model hashes, isolation headers, byte ranges, and blocked routes passed over HTTP.',
    '',
  ].join('\n'));
}
