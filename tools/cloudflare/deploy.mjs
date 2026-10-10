// Run in order: upload, preview, verify.mjs <preview>, production,
// verify.mjs <production>, connect, verify.mjs https://nathan.fish/.
// Build and prepare first. ci.mjs orchestrates the GitHub deployment path.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from '../../src/core/zod.ts';
import { credentials, wrangler } from './cli.mjs';
import { ROOT, STATE, OUTPUT, PROJECT, BUCKET, DOMAIN, verifiedModels, lockedFiles, inventory } from './prepare.mjs';

const auth = await credentials();
const account = `/accounts/${auth.CLOUDFLARE_ACCOUNT_ID}`;
const projectPath = `${account}/pages/projects/${PROJECT}`;
const Envelope = z.object({ success: z.boolean(), result: z.unknown().optional(), errors: z.array(z.object({ code: z.number(), message: z.string() })).default([]) });
class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
async function api(endpoint, method = 'GET', body, extraHeaders = {}) {
  const raw = body instanceof Uint8Array;
  const response = await fetch(`https://api.cloudflare.com/client/v4${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${auth.CLOUDFLARE_API_TOKEN}`, ...(body === undefined ? {} : { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' }), ...extraHeaders },
    ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
    signal: AbortSignal.timeout(raw ? 180_000 : 30_000),
  });
  const parsed = Envelope.parse(await response.json());
  if (!response.ok || !parsed.success) throw new ApiError(`${method} ${endpoint.replace(auth.CLOUDFLARE_ACCOUNT_ID, '[account]')}: HTTP ${response.status}: ${JSON.stringify(parsed.errors)}`, response.status);
  return parsed.result;
}
const EnvConfig = z.object({ fail_open: z.literal(false), r2_buckets: z.object({ MODELS: z.object({ name: z.literal(BUCKET) }) }) });
const Project = z.object({ name: z.literal(PROJECT), subdomain: z.string(), production_branch: z.literal('demo'), deployment_configs: z.object({ preview: EnvConfig, production: EnvConfig }) });
const Deployment = z.object({ id: z.string(), url: z.url(), environment: z.enum(['preview', 'production']), latest_stage: z.object({ status: z.string() }) });
const Prepared = z.object({ buildId: z.string(), files: z.record(z.string(), z.string()) });
const Verification = z.object({ baseUrl: z.url(), prepared: Prepared, ok: z.literal(true) });
const Record = z.object({ id: z.string(), name: z.string(), type: z.string(), content: z.string(), ttl: z.number(), proxied: z.boolean().optional() }).passthrough();

async function save(name, value, options = {}) {
  await mkdir(STATE, { recursive: true, mode: 0o700 });
  await writeFile(path.join(STATE, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, ...options });
}
async function read(name, schema) { return schema.parse(JSON.parse(await readFile(path.join(STATE, name), 'utf8'))); }
async function assertPrepared() {
  const prepared = await read('prepared.json', Prepared);
  const names = await inventory(OUTPUT);
  if (JSON.stringify(names) !== JSON.stringify(Object.keys(prepared.files).sort())) throw new Error('Prepared deployment inventory changed; run prepare.mjs again.');
  for (const [name, expected] of Object.entries(prepared.files)) {
    if (createHash('sha256').update(await readFile(path.join(OUTPUT, name))).digest('hex') !== expected) throw new Error(`Prepared file changed: ${name}`);
  }
  return prepared;
}
async function verifiedDeployment(environment) {
  const deployment = await read(`${environment}.json`, Deployment);
  const verification = await read(`verified-${environment}.json`, Verification);
  if (verification.baseUrl !== `${deployment.url.replace(/\/$/, '')}/` || JSON.stringify(verification.prepared) !== JSON.stringify(await assertPrepared())) throw new Error(`Verify the current ${environment} deployment first.`);
  return deployment;
}
async function configureProject() {
  const projects = z.array(z.object({ name: z.string() })).parse(await api(`${account}/pages/projects`));
  if (!projects.some((project) => project.name === PROJECT)) await api(`${account}/pages/projects`, 'POST', { name: PROJECT, production_branch: 'demo' });
  const environment = { fail_open: false, compatibility_date: '2026-10-01', r2_buckets: { MODELS: { name: BUCKET } } };
  await api(projectPath, 'PATCH', { deployment_configs: { preview: environment, production: environment } });
  return Project.parse(await api(projectPath));
}

async function upload() {
  const files = await verifiedModels();
  console.log(`Verified ${files.length} local model files against the lock before upload.`);
  const buckets = z.object({ buckets: z.array(z.object({ name: z.string(), storage_class: z.string() })) }).parse(await api(`${account}/r2/buckets?name_contains=${BUCKET}`));
  const bucket = buckets.buckets.find((item) => item.name === BUCKET);
  if (bucket === undefined) await api(`${account}/r2/buckets`, 'POST', { name: BUCKET, storage_class: 'Standard' });
  else if (bucket.storage_class !== 'Standard') throw new Error('Existing model bucket is not Standard storage.');
  if (bucket !== undefined) await remoteModels(false);
  for (const file of files) {
    const result = z.object({ key: z.string(), size: z.string(), storage_class: z.literal('Standard') }).parse(await api(
      `${account}/r2/buckets/${BUCKET}/objects/${path.basename(file.served)}`, 'PUT',
      await readFile(path.join(ROOT, file.served.slice(1))), { 'cf-r2-storage-class': 'Standard' },
    ));
    if (result.key !== path.basename(file.served) || Number(result.size) !== file.bytes) throw new Error(`Upload metadata differs: ${file.served}`);
    console.log(`Uploaded ${file.served}: ${file.bytes} bytes, Standard.`);
  }
  await save('uploaded.json', { files: files.map(({ served, bytes, sha256 }) => ({ served, bytes, sha256 })) });
  await remoteModels(true);
}

async function remoteModels(complete) {
  const files = await lockedFiles();
  const objects = z.array(z.object({ key: z.string(), size: z.number(), storage_class: z.literal('Standard') })).parse(await api(`${account}/r2/buckets/${BUCKET}/objects?per_page=1000`));
  const allowed = new Map(files.map((file) => [path.basename(file.served), file.bytes]));
  for (const object of objects) {
    if (!allowed.has(object.key)) throw new Error(`Model bucket contains an unexpected key: ${object.key}; refusing to alter it.`);
    if (complete && allowed.get(object.key) !== object.size) throw new Error(`Model bucket size differs: ${object.key}`);
  }
  if (complete && objects.length !== files.length) throw new Error('Model bucket inventory does not match the lock.');
  if (complete) console.log(`Confirmed R2 contains exactly ${objects.length} locked objects in Standard storage.`);
}

async function deploy(environment) {
  await assertPrepared();
  await remoteModels(true);
  if (environment === 'production') await verifiedDeployment('preview');
  await configureProject();
  const branch = environment === 'production' ? 'demo' : 'hosting-preview';
  const commit = process.env.GITHUB_ACTIONS === 'true' ? process.env.GITHUB_SHA : undefined;
  if (commit !== undefined && !/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid GitHub commit SHA.');
  const metadata = commit === undefined ? ['--commit-dirty=true'] : ['--commit-dirty=false', '--commit-hash', commit, '--commit-message', `Deploy main at ${commit}`];
  const output = await wrangler(['pages', 'deploy', OUTPUT, '--project-name', PROJECT, '--branch', branch, ...metadata]);
  const urls = output.match(/https:\/\/[a-z0-9-]+\.noisy-demo(?:-[a-z0-9]+)?\.pages\.dev/g) ?? [];
  const deployments = z.array(Deployment).parse(await api(`${projectPath}/deployments`));
  const deployed = deployments.find((item) => item.environment === environment && urls.includes(item.url));
  if (deployed === undefined || deployed.latest_stage.status !== 'success') throw new Error('Could not confirm the newly uploaded successful deployment.');
  await configureProject();
  await save(`${environment}.json`, deployed);
  console.log(`${environment}: ${deployed.url}`);
}

async function zoneAndRecords() {
  const zones = z.array(z.object({ id: z.string(), name: z.literal(DOMAIN), status: z.literal('active') })).parse(await api(`/zones?name=${DOMAIN}&account.id=${auth.CLOUDFLARE_ACCOUNT_ID}`));
  if (zones.length !== 1 || zones[0] === undefined) throw new Error('Expected exactly one active nathan.fish zone.');
  const zone = zones[0];
  const records = z.array(Record).parse(await api(`/zones/${zone.id}/dns_records?name=${DOMAIN}&per_page=100`));
  return { zone, records };
}

async function connect() {
  await verifiedDeployment('production');
  const project = Project.parse(await api(projectPath));
  const before = await zoneAndRecords();
  // Must happen before custom-domain association, which may itself change DNS.
  try { await save('dns-before.json', { capturedAt: new Date().toISOString(), ...before }, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const domains = z.array(z.object({ name: z.string() })).parse(await api(`${projectPath}/domains`));
  if (!domains.some((domain) => domain.name === DOMAIN)) await api(`${projectPath}/domains`, 'POST', { name: DOMAIN });
  const current = await zoneAndRecords();
  const addresses = current.records.filter((record) => ['A', 'AAAA', 'CNAME'].includes(record.type));
  if (!(addresses.length === 1 && addresses[0]?.type === 'CNAME' && addresses[0].content === project.subdomain && addresses[0].proxied)) {
    await api(`/zones/${current.zone.id}/dns_records/batch`, 'POST', {
      deletes: addresses.map(({ id }) => ({ id })),
      posts: [{ name: DOMAIN, type: 'CNAME', content: project.subdomain, ttl: 1, proxied: true }],
    });
  }
  const after = await zoneAndRecords();
  const keep = (records) => records.filter((record) => !['A', 'AAAA', 'CNAME'].includes(record.type)).map(({ id, type, content }) => ({ id, type, content })).sort((a, b) => a.id.localeCompare(b.id));
  if (JSON.stringify(keep(before.records)) !== JSON.stringify(keep(after.records))) throw new Error('Non-address apex records changed; inspect DNS backup.');
  await save('dns-after.json', after);
  console.log(`${DOMAIN} points to ${project.subdomain}; other apex records preserved.`);
  console.log(JSON.stringify(await api(`${projectPath}/domains/${DOMAIN}`)));
}

// Requires the separately granted Zone / Cache Rules / Edit permission.
// Appends one hostname-specific rule; never replaces another rule or ruleset.
async function cacheRule() {
  const { zone } = await zoneAndRecords();
  const root = `/zones/${zone.id}/rulesets`;
  const policy = JSON.parse(await readFile(path.join(ROOT, 'tools/cloudflare/cache-rule.json'), 'utf8'));
  const Rule = z.object({ id: z.string(), description: z.string().optional(), expression: z.string(), action: z.string(), action_parameters: z.object({ browser_ttl: z.object({ mode: z.string() }).optional() }).passthrough(), enabled: z.boolean().optional() }).passthrough();
  const Ruleset = z.object({ id: z.string(), rules: z.array(Rule) });
  let existing = null;
  let original = null;
  try {
    original = await api(`${root}/phases/http_request_cache_settings/entrypoint`);
    existing = Ruleset.parse(original);
  }
  catch (error) { if (!(error instanceof ApiError) || error.status !== 404) throw error; }
  try { await save('cache-rules-before.json', original, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (existing === null) {
    await api(root, 'POST', { name: 'nathan.fish cache settings', kind: 'zone', phase: 'http_request_cache_settings', rules: [policy] });
  } else {
    const owned = existing.rules.find((rule) => rule.description === policy.description);
    if (owned === undefined) await api(`${root}/${existing.id}/rules`, 'POST', policy);
    else if (owned.expression !== policy.expression || owned.action !== policy.action || owned.enabled === false || owned.action_parameters.browser_ttl?.mode !== 'respect_origin') throw new Error('The existing editor cache rule differs; refusing to replace it.');
  }
  const after = Ruleset.parse(await api(`${root}/phases/http_request_cache_settings/entrypoint`));
  const rule = after.rules.find((item) => item.description === policy.description && item.expression === policy.expression);
  if (rule?.action_parameters.browser_ttl?.mode !== 'respect_origin' || rule.enabled === false) throw new Error('Could not confirm the hostname-specific browser cache rule.');
  await save('cache-rules-after.json', after);
  console.log('nathan.fish browser cache now respects origin headers; other hostnames and rules preserved.');
}

const command = process.argv[2];
try {
  switch (command) {
    case 'upload': await upload(); break;
    case 'inventory': await remoteModels(true); break;
    case 'preview': await deploy('preview'); break;
    case 'production': await deploy('production'); break;
    case 'connect': await connect(); break;
    case 'cache-rule': await cacheRule(); break;
    case 'cache-status': {
      const { zone } = await zoneAndRecords();
      console.log(JSON.stringify(await api(`/zones/${zone.id}/rulesets/phases/http_request_cache_settings/entrypoint`), null, 2));
      break;
    }
    case 'status': console.log(JSON.stringify({ project: Project.parse(await api(projectPath)), domain: await api(`${projectPath}/domains/${DOMAIN}`) }, null, 2)); break;
    default: throw new Error('Choose upload, inventory, preview, production, connect, cache-rule, or status.');
  }
} catch (error) {
  console.error(String(error).replaceAll(auth.CLOUDFLARE_API_TOKEN, '[redacted]'));
  process.exitCode = 1;
}
