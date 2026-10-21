// Text embeddings for search by meaning (S-141). Two providers, picked by `search.embedder`
// in settings (STAM_EMBEDDER=stub or off overrides it, for tests and the deploy check): `stub`, a deterministic hashed
// bag of stems with no model, and `local`, a small transformers.js model that runs in a worker
// thread. The model is not a repo dependency: it is installed once under STAM_HOME/embedder
// (`stam embedder install`, or the daemon in the background on first need), and loaded lazily.
// `embed` returns null when no vectors are available, and search falls back to keywords.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { STAM_HOME } from './config.ts';
import * as db from './db.ts';
import { plainText } from './search.ts';
import { settings } from './settings.ts';
import { envVar } from './env.ts';

export const LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const LOCAL_VERSION = '4.3.1';
// The model's Hugging Face revision, pinned so a change to the model's files reinstalls.
export const LOCAL_REVISION = '751bff37182d3f1213fa05d7196b954e230abad9';
export const STUB_MODEL = 'stub-256';
const STUB_DIM = 256;
const DIR = join(STAM_HOME, 'embedder');
// The worker is terminated after this long without a request, so the model's memory is freed.
// STAM_EMBED_IDLE_MS shortens it, for measuring the unload.
const IDLE_MS = Number(envVar('EMBED_IDLE_MS')) || 10 * 60_000;
export const BATCH = 16;
// Texts sent to the worker per model run. onnxruntime keeps the largest activation buffers it
// has needed for the life of the worker (a CPU memory arena), so a run of 16 padded texts holds
// about 1 GB of native memory (S-2127); one text per run holds about 200 MB and embeds as fast,
// since there is no padding to the batch's longest text.
export const RUN_BATCH = 1;
// Only the first characters of a text are embedded.
export const CHARS = 2000;

export type Provider = 'local' | 'stub' | 'off';

export function provider(): Provider {
  if (envVar('EMBEDDER') === 'stub') return 'stub';
  if (envVar('EMBEDDER') === 'off') return 'off';
  return settings().search.embedder === 'off' ? 'off' : 'local';
}

// The model the current provider writes vectors with; null when search is off.
export function currentModel(): string | null {
  const p = provider();
  return p === 'stub' ? STUB_MODEL : p === 'local' ? LOCAL_MODEL : null;
}

// Common words that say nothing about a text's meaning.
const STOP = new Set('a an and are as at be been but by can did do does for from had has have he her his i if in into is it its me my no not of on or our she so that the their them then there these they this to too us was we were what when which who why will with would you your'.split(' '));

// A word's stem, for the stub: plurals and -ing / -ed forms share one.
function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

// FNV-1a: a stable hash, so the same word lands in the same dimension in every process.
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

export function stubVector(text: string): Float32Array {
  const v = new Float32Array(STUB_DIM);
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!w || STOP.has(w)) continue;
    v[hash(stem(w)) % STUB_DIM] += 1;
  }
  return normalise(v);
}

export function normalise(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

// The text an embedding is made from: the subject and body as prose, capped.
export function embedText(subject: string, body: string): string {
  return plainText(`${subject}\n${body}`).slice(0, CHARS);
}

// --- local provider -------------------------------------------------------------------

let worker: Worker | undefined;
let idleTimer: NodeJS.Timeout | undefined;
let pending = new Map<number, { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }>();
let nextId = 1;

// The marker install() writes last, atomically, after the package, the prune, and the model load
// succeed. A marker for another version or model, or none (a partial install), is not installed.
const MARK = join(DIR, 'installed.json');

// Whether the install finished for the current package and model.
export function installed(): boolean {
  try {
    const m = JSON.parse(readFileSync(MARK, 'utf8'));
    return m.version === LOCAL_VERSION && m.model === LOCAL_MODEL && m.revision === LOCAL_REVISION && existsSync(join(DIR, 'node_modules', '@huggingface', 'transformers', 'package.json'));
  } catch {
    return false;
  }
}

type State = 'missing' | 'installing' | 'failed' | 'installed';
let installing: Promise<void> | undefined;
// The last install failed. Background retries wait 1, 5, then 15 minutes, then an hour at most.
// Only a daemon restart or `stam embedder install` starts over: a new mail doesn't.
let failed = false;
const RETRY_MS = [60_000, 300_000, 900_000, 3_600_000];
let attempts = 0;
let retryAt = 0;
// Whether something has asked for an embedder since the last install. The installer's own timer
// retries only then, so an idle daemon with a broken install doesn't run npm for nothing.
let wanted = false;
let installTimer: NodeJS.Timeout | undefined;
// Test seam: replaces the npm and model steps of install(), and resets the retry state.
let installSteps: (() => Promise<void>) | undefined;
export function setInstallSteps(fn: (() => Promise<void>) | undefined): void {
  installSteps = fn;
  clearTimeout(installTimer);
  installTimer = undefined;
  attempts = 0;
  retryAt = 0;
  wanted = false;
  failed = false;
}
const installedHooks: (() => void)[] = [];

// Runs once `install` has finished: the daemon's backfill waits on it.
export function whenInstalled(fn: () => void): void {
  installedHooks.push(fn);
}

export function state(): State {
  if (installing) return 'installing';
  if (failed) return 'failed';
  return installed() ? 'installed' : 'missing';
}

// Installs the package under STAM_HOME/embedder, then loads the model once so its download
// happens now and not on the first search. Resolves when done; errors are thrown.
export function install(log: (m: string) => void = console.error): Promise<void> {
  if (installing) return installing;
  installing = (async () => {
    if (installSteps) return installSteps();
    mkdirSync(DIR, { recursive: true });
    rmSync(MARK, { force: true });
    writeFileSync(join(DIR, 'package.json'), JSON.stringify({ private: true, dependencies: { '@huggingface/transformers': LOCAL_VERSION } }, null, 2) + '\n');
    log(`embedder: installing @huggingface/transformers@${LOCAL_VERSION} under ${DIR}`);
    await new Promise<void>((resolve, reject) =>
      execFile('npm', ['install', '--prefix', DIR, '--no-audit', '--no-fund', '--ignore-scripts', '--save-exact'], { maxBuffer: 16 * 1024 * 1024 }, (err, _out, errOut) => (err ? reject(new Error(errOut || err.message)) : resolve())),
    );
    prune(DIR);
    log(`embedder: installed; loading ${LOCAL_MODEL} once`);
    await runLocal(['warm up']);
    await unload();
    const tmp = MARK + '.tmp';
    writeFileSync(tmp, JSON.stringify({ version: LOCAL_VERSION, model: LOCAL_MODEL, revision: LOCAL_REVISION, installed: new Date().toISOString() }, null, 2) + '\n');
    renameSync(tmp, MARK);
    log('embedder: ready');
  })()
    .then(() => {
      installing = undefined;
      failed = false;
      attempts = 0;
      retryAt = 0;
      wanted = false;
      clearTimeout(installTimer);
      installTimer = undefined;
      for (const fn of installedHooks.splice(0)) fn();
    })
    .catch((e) => {
      installing = undefined;
      failed = true;
      attempts++;
      retryAt = Date.now() + RETRY_MS[Math.min(attempts, RETRY_MS.length) - 1];
      log(`embedder: install failed: ${e instanceof Error ? e.message : e}`);
      ensureInstallTimer();
      throw e;
    });
  return installing;
}

// Deletes what this machine can't run, to keep the install small: the onnxruntime-node binaries of
// other platforms and CPUs, its GPU providers, and onnxruntime-web (the node build doesn't load it).
// sharp stays: transformers.js requires it at load, so removing it breaks the model.
function prune(dir: string): void {
  const nm = join(dir, 'node_modules');
  rmSync(join(nm, 'onnxruntime-web'), { recursive: true, force: true });
  const bin = join(nm, 'onnxruntime-node', 'bin', 'napi-v6');
  if (!existsSync(bin)) return;
  for (const os of readdirSync(bin)) {
    if (os !== process.platform) rmSync(join(bin, os), { recursive: true, force: true });
    else for (const arch of readdirSync(join(bin, os))) if (arch !== process.arch) rmSync(join(bin, os, arch), { recursive: true, force: true });
  }
  const cpu = join(bin, process.platform, process.arch);
  if (existsSync(cpu)) for (const f of readdirSync(cpu)) if (/cuda|tensorrt|dml|webgpu/i.test(f)) rmSync(join(cpu, f), { force: true });
}

// Starts the install in the background, once per daemon, when a search or an index needs it.
function startBackgroundInstall(): void {
  if (installing || Date.now() < retryAt) return;
  install().catch(() => {});
}

// The installer's own timer: while an embedder is wanted and not installed, the next attempt runs
// when its retry time comes, with no mail or search needed. One timer at a time, unref'd.
function ensureInstallTimer(): void {
  if (installing || installTimer || !wanted || installed()) return;
  installTimer = setTimeout(() => {
    installTimer = undefined;
    startBackgroundInstall();
  }, Math.max(0, retryAt - Date.now()));
  installTimer.unref();
}


function getWorker(): Worker {
  if (worker) return worker;
  // STAM_EMBED_WORKER replaces the worker file, for a test that must not load the model.
  worker = new Worker(envVar('EMBED_WORKER') ?? new URL('./embed-worker.ts', import.meta.url), { workerData: { entry: entryPath() } });
  worker.on('message', ({ id, vecs, error }: { id: number; vecs?: Float32Array[]; error?: string }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve(vecs!);
  });
  // A worker that dies fails its waiting calls; the next call starts a new one.
  const dead = (e: Error) => {
    for (const p of pending.values()) p.reject(e);
    pending = new Map();
    worker = undefined;
  };
  worker.on('error', dead);
  worker.on('exit', () => dead(new Error('embedder worker exited')));
  return worker;
}

// The model's entry point inside the installed package.
function entryPath(): string {
  const dir = join(DIR, 'node_modules', '@huggingface', 'transformers');
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const exp = pkg.exports?.['.'];
  const rel = (typeof exp === 'object' && (exp.node?.import ?? exp.import)) || pkg.module || pkg.main || 'index.js';
  return pathToFileURL(join(dir, rel)).href;
}

function runLocal(texts: string[]): Promise<Float32Array[]> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, texts, model: LOCAL_MODEL, revision: LOCAL_REVISION, cache: DIR });
    // Only an idle worker is unloaded: each request resets the timer.
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void unload(), IDLE_MS);
    idleTimer.unref();
  });
}

// Unloads the model now (the idle timer does this after IDLE_MS without a request).
export async function unload(): Promise<void> {
  clearTimeout(idleTimer);
  const w = worker;
  worker = undefined;
  if (w) await w.terminate();
}

// Vectors for texts, in order; null when the provider is off or the local model isn't ready.
// A local model that isn't installed yet starts its install in the background and returns null.
export async function embed(texts: string[]): Promise<Float32Array[] | null> {
  if (!texts.length) return [];
  const p = provider();
  if (p === 'off') return null;
  if (p === 'stub') return texts.map(stubVector);
  if (!installed()) {
    wanted = true;
    startBackgroundInstall();
    ensureInstallTimer();
    return null;
  }
  try {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += RUN_BATCH) out.push(...(await runLocal(texts.slice(i, i + RUN_BATCH))));
    return out;
  } catch (e) {
    console.error(`embedder: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

export interface EmbedderInfo {
  provider: Provider;
  model: string | null;
  dim: number | null;
  state: State | 'stub' | 'off';
  // Rows indexed per source, under the current model.
  indexed: { source: string; n: number }[];
}

// What `stam embedder status` and the tests read.
export function embedderInfo(): EmbedderInfo {
  const p = provider();
  const model = currentModel();
  const counts = db.embeddingCounts().filter((c) => c.model === model);
  const indexed = counts.map((c) => ({ source: c.source, n: c.n }));
  if (p === 'off') return { provider: p, model, dim: null, state: 'off', indexed };
  if (p === 'stub') return { provider: p, model, dim: STUB_DIM, state: 'stub', indexed };
  return { provider: p, model, dim: 384, state: state(), indexed };
}
