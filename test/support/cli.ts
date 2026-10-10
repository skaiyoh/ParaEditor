// Helpers that run the repository's real CLIs (tools/*.mjs) as child
// processes, so the tests exercise them the way a person or a driver does.

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export type RunResult = { readonly code: number | null; readonly stdout: string; readonly stderr: string };

/** Runs `node <script> ...args` from the repository root and collects its output. */
export function runTool(script: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(REPO, script), ...args], { cwd: REPO });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export type Server = { readonly url: string; stop(): Promise<void> };

/** Starts tools/serve.mjs on a free port and resolves once it prints the URL it bound. */
export function startServer(args: readonly string[]): Promise<Server> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(REPO, 'tools/serve.mjs'), '--port', '0', ...args], { cwd: REPO });
    let out = '';
    const onData = (d: Buffer) => {
      out += d.toString();
      const m = /http:\/\/127\.0\.0\.1:\d+\//.exec(out);
      if (m === null) return;
      child.stdout.off('data', onData);
      const exited = new Promise<void>((done) => child.once('exit', () => done()));
      resolve({
        url: m[0],
        stop: async () => {
          child.kill('SIGTERM');
          await exited;
        },
      });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.once('exit', (code) => reject(new Error(`serve.mjs exited with ${code} before listening: ${out}`)));
  });
}

export function tempDir(label: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `noisy-${label}-`));
}

/** Writes files (relative path -> contents) under root, creating directories. */
export async function writeTree(root: string, files: Readonly<Record<string, string | Uint8Array>>): Promise<void> {
  for (const [rel, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), contents);
  }
}
