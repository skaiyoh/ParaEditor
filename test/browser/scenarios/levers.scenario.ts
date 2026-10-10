// The dev server's levers, each driven from a real page once: a fault on the
// vendored runtime, a binary capture into the sink, the header contract of
// everything the served build loads, and the synth master route.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseLock } from '../../../src/analysis/lock.ts';
import { z } from '../../../src/core/zod.ts';
import { REPO } from '../driver/server.ts';
import type { Scenario } from '../scenario.ts';
import { runTool } from '../../support/cli.ts';

function fetchStatus(url: string): Promise<unknown> {
  return fetch(url, { cache: 'no-store' }).then(
    (res) => ({ status: res.status }),
    (e: unknown) => ({ error: String(e) }),
  );
}

/** Posts `size` random bytes to the sink as a binary capture and returns their SHA-256 and the sink's reply. */
async function postCapture(size: number, name: string): Promise<unknown> {
  const bytes = new Uint8Array(size);
  for (let at = 0; at < size; at += 65536) crypto.getRandomValues(bytes.subarray(at, Math.min(at + 65536, size)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const sha256 = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  const res = await fetch(`/api/log?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes });
  return { sha256, status: res.status, reply: await res.json() };
}

const CaptureReply = z.object({
  sha256: z.string(),
  status: z.number(),
  reply: z.object({ ok: z.literal(true), file: z.string(), bytes: z.number(), sha256: z.string(), name: z.string() }),
});

/** Fetches the synth master route at `query` and returns its status, type, and the SHA-256 and length of its body. */
async function fetchMaster(query: string): Promise<unknown> {
  const res = await fetch(`/dev/synth/master?${query}`);
  const body = new Uint8Array(await res.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
  return { status: res.status, type: res.headers.get('content-type'), bytes: body.length, sha256: Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('') };
}

const MasterReply = z.object({ status: z.number(), type: z.string().nullable(), bytes: z.number(), sha256: z.string() });

/** The SHA-256 test/synth.test.ts pins for synth's 2048 x 1536 master as RGBA bytes. */
const SYNTH_MASTER_SHA256 = '5da94341047ce46637c583ee480520a910dd28cb9391400397c3ce172b31d1bf';

const HeaderLine = z.object({ path: z.string(), status: z.number(), ok: z.boolean(), mismatches: z.array(z.unknown()) });

export const scenarios: readonly Scenario[] = [
  {
    id: 'levers.vendor-fault',
    title: 'a fault on /vendor/ort/ fails the page\'s fetch of the runtime with a 500, and clearing it serves the file',
    target: 'dev',
    covers: [],
    async run(t) {
      await t.page.goto('/');
      const runtime = `${t.build.ort.dir}ort.wasm.min.mjs`;
      const rule = 'path:/vendor/ort/:http500';
      t.expectMessage({ because: 'the fault answers the runtime with a 500', channel: 'log', source: 'network', level: 'error', url: /\/vendor\/ort\// });
      // Rows after this one are this scenario's, even on a server that has served others.
      const since = Math.max(0, ...(await t.server.requestLog()).map((r) => r.seq));
      await t.server.setFaults([rule]);
      t.equal('the faulted fetch answers 500', await t.page.evaluate(z.unknown(), fetchStatus, runtime), { status: 500 });
      const logged = (await t.server.requestLog()).filter((r) => r.seq > since && r.path === runtime);
      t.equal('the request log shows the fault applied', logged.map((r) => ({ status: r.status, fault: r.fault })), [{ status: 500, fault: rule }]);
      await t.server.clearFaults();
      t.equal('after clearing the fault the fetch answers 200', await t.page.evaluate(z.unknown(), fetchStatus, runtime), { status: 200 });
    },
  },
  {
    id: 'levers.sink-capture',
    title: 'a binary capture posted from the page lands in the sink byte for byte',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    async run(t) {
      await t.page.goto('/');
      const size = 200_000;
      const posted = await t.page.evaluate(CaptureReply, postCapture, size, 'driver-capture.bin');
      const onDisk = createHash('sha256').update(await readFile(posted.reply.file)).digest('hex');
      t.equal('the sink answered 200', posted.status, 200);
      t.equal('the sink stored every byte', posted.reply.bytes, size);
      t.equal('the page, the sink\'s reply, and the file on disk have one SHA-256', { reply: posted.reply.sha256, disk: onDisk }, { reply: posted.sha256, disk: posted.sha256 });
      const lines = await t.server.sinkLines();
      const recorded = lines.flatMap((line) => ('capture' in line ? [line.capture.sha256] : []));
      t.equal('log.jsonl records the capture', recorded, [posted.sha256]);
    },
  },
  {
    id: 'levers.headers',
    title: 'tools/check-headers.mjs passes against the served build: the index, its assets, the workers, the runtime, and a model',
    target: 'dev',
    covers: ['R8', 'B4'],
    async run(t) {
      const parsed = parseLock(JSON.parse(await readFile(path.join(REPO, 'models.lock.json'), 'utf8')));
      if (!parsed.ok) throw new Error(parsed.error);
      const model = Object.values(parsed.value.lock.models)[0]?.files[0]?.served;
      const paths = [...Object.values(t.build.workers), ...t.build.ort.files.map((f) => `${t.build.ort.dir}${f}`), ...(model === undefined ? [] : [model])];
      const result = await runTool('tools/check-headers.mjs', [t.baseUrl, ...paths.flatMap((p) => ['--path', p])]);
      const lines = result.stdout.split('\n').filter(Boolean).map((line) => HeaderLine.parse(JSON.parse(line)));
      t.ok('a model path is among the checked paths', model !== undefined, { model });
      t.equal('check-headers exits 0', result.code, 0, { stderr: result.stderr });
      t.equal('every checked path is a 200 with the contract\'s headers', lines.filter((l) => !l.ok), [], { checked: lines.map((l) => l.path) });
    },
  },
  {
    id: 'levers.synth-master',
    title: 'a page fetches the synth master route\'s 2048 x 1536 bytes with the fixture\'s pinned SHA-256, and an odd width answers 400',
    target: 'dev',
    covers: [],
    async run(t) {
      await t.page.goto('/');
      const master = await t.page.evaluate(MasterReply, fetchMaster, 'width=2048&height=1536');
      t.equal('the page reads the master as raw RGBA bytes with the fixture\'s digest', master, { status: 200, type: 'application/octet-stream', bytes: 2048 * 1536 * 4, sha256: SYNTH_MASTER_SHA256 });
      t.expectMessage({ because: 'the scenario asks for an odd width, which the route answers 400', channel: 'log', source: 'network', level: 'error', url: /\/dev\/synth\/master\?width=2047/ });
      const odd = await t.page.evaluate(MasterReply, fetchMaster, 'width=2047&height=1536');
      t.equal('an odd width answers 400', odd.status, 400);
    },
  },
];
