// Go to declaration's index (S-1532), run on the ITSA home next to the PR diff API (src/diff.ts). At a commit sha,
// every source file in the repo's tree is parsed with CodeMirror's own Lezer grammars and its declarations kept:
// `{ name, path, line, col, kind }`. Built once per repo and sha in a worker thread (src/decl-worker.ts), one build
// at a time per repo, and kept on disk under STAM_HOME/cache/decl, the newest few per repo. Denied, generated,
// vendored, lockfile and oversized files give no names. Only the human reaches it; daemon.ts forwards to the home.
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, posix, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import { MACHINE, STAM_HOME } from './config.ts';
import { settings } from './settings.ts';
import { denied } from './files.ts';
import { cacheDir, checkoutOf, classify, DiffError } from './diff.ts';
import { declLangOf } from './decl-walk.ts';
import type { WorkFile, WorkResult } from './decl-worker.ts';

export class DeclError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// A source file larger than this isn't parsed (a bundled or generated file that slipped past the patterns).
export const SIZE_CAP = 1024 * 1024;
// At most this many files are parsed per commit.
export const MAX_FILES = 20_000;
export const MAX_MATCHES = 30;
// Indexes kept on disk per repo, and parsed indexes kept in memory.
export const MAX_DISK = 12;
const MAX_MEM = 4;
// How long a request waits for a build before it answers 202 "building".
export const WAIT_MS = 1500;
// The longest a worker may parse before it is stopped and the build fails (which frees the repo's build lock).
export const BUILD_MS = 180_000;
const VERSION = 1;

// [name, file index, line, col, kind, line text]
type Row = [string, number, number, number, string, string];
export interface DeclIndex { v: number; repo: string; sha: string; ms: number; files: string[]; decls: Row[]; imports: number[][] }
type Loaded = DeclIndex & { byName: Map<string, number[]>; fileIdx: Map<string, number> };
export interface Match { path: string; line: number; col: number; kind: string; text: string }

const git = (args: string[], cwd: string, maxBuffer = 256 * 1024 * 1024): Promise<string> =>
  new Promise((ok, fail) =>
    execFile('git', args, { cwd, maxBuffer, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } }, (err, stdout, stderr) => {
      if (err) Object.assign(err, { stderr: String(stderr) });
      err ? fail(err) : ok(String(stdout));
    }),
  );

const sha = (s: string) => /^[0-9a-f]{40,64}$/.test(s);
const indexDir = (repo: string) => join(STAM_HOME, 'cache', 'decl', repo.replace(/[^\w.-]/g, '_'));
const indexFile = (repo: string, s: string) => join(indexDir(repo), `${s}.json`);

const mem = new Map<string, Loaded>(); // `repo:sha`, insertion ordered, newest last
const builds = new Map<string, Promise<Loaded>>(); // `repo:sha` -> the build under way
const locks = new Map<string, Promise<unknown>>(); // repo -> the tail of its builds
export const stats = { builds: 0, diskHits: 0 };

// Forgets what is in memory (tests).
export function resetCaches(): void {
  mem.clear();
  builds.clear();
  stats.builds = 0;
  stats.diskHits = 0;
}

function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = next.catch(() => {});
  locks.set(key, tail);
  tail.then(() => locks.get(key) === tail && locks.delete(key));
  return next;
}

// Where the commit's objects are: the diff cache (PR heads, merge bases) or the checkout (its own HEAD). Both are only read.
async function gitDirFor(repo: string, checkout: string, commit: string): Promise<string> {
  for (const dir of [cacheDir(repo), checkout]) {
    if (!existsSync(dir)) continue;
    try {
      await git(['cat-file', '-e', `${commit}^{commit}`], dir);
      return dir;
    } catch {}
  }
  throw new DeclError(404, `commit ${commit.slice(0, 12)} is not in ${repo}; open the diff again`);
}

// Which files of a `git ls-tree -r -l -z` listing are parsed: a supported language, under the size cap, not denied,
// and not a lockfile, generated or vendored path (the `diff.classes` patterns, node_modules among them). Pure.
export function pickFiles(listing: string, checkout: string, classes: Record<string, string[]>): WorkFile[] {
  const out: WorkFile[] = [];
  for (const entry of listing.split('\0')) {
    const m = /^(\d+) (\w+) ([0-9a-f]+) +(\d+|-)\t(.*)$/s.exec(entry);
    if (!m || m[2] !== 'blob' || m[1] === '120000') continue;
    const [, , , blob, size, path] = m;
    if (Number(size) > SIZE_CAP || !declLangOf(path)) continue;
    const cls = classify(path, classes);
    if (cls === 'generated' || cls === 'lockfiles') continue;
    if (denied(join(checkout, path))) continue;
    out.push({ path, blob });
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

export function parseInWorker(dir: string, files: WorkFile[], limitMs = BUILD_MS): Promise<WorkResult[]> {
  return new Promise((ok, fail) => {
    const w = new Worker(new URL('./decl-worker.ts', import.meta.url), { workerData: { decl: true, dir, files }, resourceLimits: { maxOldGenerationSizeMb: 1024 } });
    let done = false;
    // The worker's `git cat-file` child, while it runs: terminating the thread doesn't stop it, so it is killed here.
    let child: number | null = null;
    const end = (f: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void w.terminate();
      if (child) try { process.kill(child, 'SIGKILL'); } catch {}
      f();
    };
    const timer = setTimeout(() => end(() => fail(new DeclError(504, `indexing ${files.length} files took over ${Math.round(limitMs / 1000)}s and was stopped`))), limitMs);
    w.on('message', (m: { results?: WorkResult[]; error?: string; pid?: number | null }) => {
      if ('pid' in m) { child = m.pid ?? null; return; }
      end(() => (m.error ? fail(new DeclError(500, `indexing failed: ${m.error}`)) : ok(m.results ?? [])));
    });
    w.once('error', (e) => end(() => fail(new DeclError(500, `indexing failed: ${e.message}`))));
    w.once('exit', (code) => end(() => fail(new DeclError(500, `the indexer exited (${code})`))));
  });
}

// The file a relative import names, among the indexed paths, or -1. JS tries the TS twins of `.js` names, the
// extensions and `index`; Python reads leading dots as packages up. Pure.
export function resolveImport(from: string, spec: string, has: Map<string, number>): number {
  const tryAll = (cands: string[]) => { for (const c of cands) { const i = has.get(c); if (i !== undefined) return i; } return -1; };
  const dir = posix.dirname(from);
  if (/\.py[i]?$/.test(from)) {
    const dots = /^\.*/.exec(spec)![0].length;
    let base = dir;
    for (let i = 1; i < dots; i++) base = posix.dirname(base);
    const rest = spec.slice(dots).replace(/\./g, '/');
    const roots = dots ? [base] : ['.', dir];
    return tryAll(roots.flatMap((r) => { const p = posix.normalize(posix.join(r, rest)); return [`${p}.py`, `${p}.pyi`, `${p}/__init__.py`]; }));
  }
  if (!spec.startsWith('.')) return -1;
  const p = posix.normalize(posix.join(dir, spec));
  const twin = p.replace(/\.(m|c)?js(x)?$/, (_, mc, x) => `.${mc ?? ''}ts${x ?? ''}`);
  const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.d.ts'];
  return tryAll([p, twin, ...exts.map((e) => p + e), ...exts.map((e) => `${p}/index${e}`)]);
}

function load(ix: DeclIndex): Loaded {
  const byName = new Map<string, number[]>();
  ix.decls.forEach((d, i) => { const l = byName.get(d[0]); l ? l.push(i) : byName.set(d[0], [i]); });
  return { ...ix, byName, fileIdx: new Map(ix.files.map((f, i) => [f, i])) };
}

function remember(key: string, ix: Loaded): Loaded {
  mem.delete(key);
  mem.set(key, ix);
  while (mem.size > MAX_MEM) mem.delete(mem.keys().next().value!);
  return ix;
}

// Keeps the MAX_DISK most recently used indexes of a repo; a read touches its file.
async function prune(repo: string): Promise<void> {
  const dir = indexDir(repo);
  let names: string[] = [];
  try { names = (await readdir(dir)).filter((n) => n.endsWith('.json')); } catch { return; }
  const aged = (await Promise.all(names.map(async (n) => ({ n, t: (await stat(join(dir, n)).catch(() => ({ mtimeMs: 0 }))).mtimeMs })))).sort((a, b) => b.t - a.t);
  for (const { n } of aged.slice(MAX_DISK)) await rm(join(dir, n), { force: true });
}

async function build(repo: string, commit: string): Promise<Loaded> {
  const checkout = checkoutOf(repo);
  const dir = await gitDirFor(repo, checkout, commit);
  const t0 = Date.now();
  const listing = await git(['ls-tree', '-r', '-l', '-z', '--full-tree', commit], dir);
  const files = pickFiles(listing, checkout, settings().diff.classes);
  const results = await parseInWorker(dir, files);
  const paths = results.map((r) => r.path);
  const has = new Map(paths.map((p, i) => [p, i]));
  const decls: Row[] = [];
  const imports: number[][] = [];
  results.forEach((r, fi) => {
    for (const [name, line, col, kind, text] of r.decls) decls.push([name, fi, line, col, kind, text]);
    imports.push([...new Set(r.imports.map((s) => resolveImport(r.path, s, has)).filter((i) => i >= 0 && i !== fi))]);
  });
  const ix: DeclIndex = { v: VERSION, repo, sha: commit, ms: Date.now() - t0, files: paths, decls, imports };
  await mkdir(indexDir(repo), { recursive: true });
  const out = indexFile(repo, commit);
  await writeFile(out + '.tmp', JSON.stringify(ix));
  await rename(out + '.tmp', out);
  await prune(repo);
  stats.builds++;
  return load(ix);
}

// An index kept on disk, or null. The JSON parse stays on this thread: at stam2's size (1.4 MB) it takes a few ms.
async function fromDisk(repo: string, commit: string): Promise<Loaded | null> {
  const file = indexFile(repo, commit);
  try {
    const ix = JSON.parse(await readFile(file, 'utf8')) as DeclIndex;
    if (ix.v !== VERSION || ix.sha !== commit) return null;
    const now = new Date();
    await utimes(file, now, now).catch(() => {});
    stats.diskHits++;
    return load(ix);
  } catch {
    return null;
  }
}

// The index of a repo at a commit: from memory, from disk, or built (one build at a time per repo). Concurrent asks
// for the same commit share one promise.
export function indexFor(repo: string, commit: string): Promise<Loaded> {
  const key = `${repo}:${commit}`;
  const hit = mem.get(key);
  if (hit) return Promise.resolve(remember(key, hit));
  let b = builds.get(key);
  if (!b) {
    b = fromDisk(repo, commit)
      .then((ix) => ix ?? serialize(repo, () => build(repo, commit)))
      .then((ix) => remember(key, ix))
      .finally(() => builds.delete(key));
    builds.set(key, b);
  }
  return b;
}

// The matches for a name, ranked: the `from` file, the files it imports, its directory, then the rest; by path and
// line within each. Pure.
export function rank(ix: Loaded, name: string, from?: string): { matches: Match[]; total: number } {
  const rows = (ix.byName.get(name) ?? []).map((i) => ix.decls[i]);
  const fi = from === undefined ? undefined : ix.fileIdx.get(from);
  const imported = new Set(fi === undefined ? [] : ix.imports[fi] ?? []);
  const fromDir = from === undefined ? null : posix.dirname(from);
  const tier = (r: Row) => (r[1] === fi ? 0 : imported.has(r[1]) ? 1 : fromDir !== null && posix.dirname(ix.files[r[1]]) === fromDir ? 2 : 3);
  const sorted = rows.map((r) => ({ r, t: tier(r), p: ix.files[r[1]] })).sort((a, b) => a.t - b.t || (a.p < b.p ? -1 : a.p > b.p ? 1 : 0) || a.r[2] - b.r[2]);
  return { matches: sorted.slice(0, MAX_MATCHES).map(({ r, p }) => ({ path: p, line: r[2], col: r[3], kind: r[4], text: r[5] })), total: rows.length };
}

const IDENT = /^[\p{L}\p{Nl}$_#][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$_]{0,199}$/u;
const git_ = (args: string[], cwd: string) => git(args, cwd).then((s) => s.trim());

// The nearest folder at or above `file` holding a `.git` entry: a checkout's or a worktree's root.
function gitTopOf(file: string): string | null {
  for (let dir = dirname(file); ; ) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// The linked worktree of `root`'s repo that holds an absolute path, or null. The path's nearest `.git` root is
// asked for its common dir: it is a linked worktree of that repo only when the common dir is the checkout's own,
// which also stops a separate clone or another repo's worktree (the same folder name) from matching.
async function worktreeHit(root: string, real: string): Promise<{ checkout: string; rel: string } | null> {
  const top = gitTopOf(real);
  if (!top) return null;
  try {
    const [repoCommon, common, toplevel] = await Promise.all([
      git_(['rev-parse', '--path-format=absolute', '--git-common-dir'], root),
      git_(['rev-parse', '--path-format=absolute', '--git-common-dir'], top),
      git_(['rev-parse', '--show-toplevel'], top),
    ]);
    if (realpathSync(common) !== realpathSync(repoCommon)) return null;
    const tl = realpathSync(toplevel);
    if (!(real === tl || real.startsWith(tl + sep))) return null;
    return { checkout: tl, rel: real.slice(tl.length + 1).split(sep).join('/') };
  } catch {
    return null;
  }
}

// The checkout of `settings.itsa.repos`, or a linked worktree of one, that holds an absolute path on this machine,
// with the path inside it. A worktree is indexed at its own root and HEAD, not the main checkout's.
async function repoOfFile(file: string): Promise<{ repo: string; checkout: string; rel: string } | null> {
  let real: string;
  try { real = realpathSync(file); } catch { return null; }
  for (const [repo, path] of Object.entries(settings().itsa.repos)) {
    let root: string;
    try { root = realpathSync(path); } catch { continue; }
    if (real.startsWith(root + sep)) return { repo, checkout: root, rel: real.slice(root.length + 1).split(sep).join('/') };
    const wt = await worktreeHit(root, real);
    if (wt) return { repo, checkout: wt.checkout, rel: wt.rel };
  }
  return null;
}

export type DeclAnswer =
  | { status: 200; body: { state: 'ready'; repo: string; sha: string; name: string; from?: string; matches: Match[]; total: number; root: { host: string; path: string } } }
  | { status: 200; body: { state: 'no-repo' } }
  | { status: 202; body: { state: 'building'; repo: string; sha: string } };

// `GET /api/decl?repo=R&sha=S&name=X[&from=PATH]`, or `?host=H&file=ABS&name=X` for a file in a checkout (its
// HEAD is indexed). Waits up to WAIT_MS for a build, then answers 202 while it goes on.
export async function request(human: boolean, q: URLSearchParams, waitMs = WAIT_MS): Promise<DeclAnswer> {
  if (!human) throw new DeclError(403, 'only the human can look up declarations');
  const name = q.get('name') ?? '';
  if (!IDENT.test(name)) throw new DeclError(400, 'name must be an identifier');
  let repo = q.get('repo') ?? '';
  let commit = q.get('sha') ?? '';
  let from = q.get('from') ?? undefined;
  let checkout: string;
  try {
    if (q.has('file')) {
      const host = q.get('host') ?? MACHINE;
      const hit = host === MACHINE ? await repoOfFile(q.get('file') ?? '') : null;
      if (!hit) return { status: 200, body: { state: 'no-repo' } };
      ({ repo, checkout } = hit);
      from = hit.rel;
      try { commit = await git_(['rev-parse', '--verify', 'HEAD^{commit}'], checkout); } catch { return { status: 200, body: { state: 'no-repo' } }; }
    } else {
      if (!repo) throw new DeclError(400, 'repo is required');
      if (!sha(commit)) throw new DeclError(400, 'sha must be a commit sha');
      checkout = checkoutOf(repo);
    }
  } catch (e) {
    if (e instanceof DiffError) throw new DeclError(e.status, e.message);
    throw e;
  }
  if (from !== undefined && (from.includes('\0') || from.startsWith('/') || from.split('/').some((s) => s === '..'))) throw new DeclError(400, 'from must be a path inside the repo');
  if (from !== undefined && denied(join(checkout, from))) from = undefined;
  const b = indexFor(repo, commit);
  let timer: NodeJS.Timeout | undefined;
  const ix = await Promise.race([b, new Promise<null>((ok) => { timer = setTimeout(() => ok(null), waitMs); })]).finally(() => clearTimeout(timer));
  if (!ix) {
    b.catch(() => {});
    return { status: 202, body: { state: 'building', repo, sha: commit } };
  }
  return { status: 200, body: { state: 'ready', repo, sha: commit, name, ...(from ? { from } : {}), ...rank(ix, name, from), root: { host: MACHINE, path: checkout } } };
}

// For the realistic-scale check in the PR body: how long a build of `repo` at `commit` takes and how big it is.
export async function measure(repo: string, commit: string): Promise<{ ms: number; files: number; decls: number; bytes: number }> {
  const ix = await indexFor(repo, commit);
  return { ms: ix.ms, files: ix.files.length, decls: ix.decls.length, bytes: (await stat(indexFile(repo, commit))).size };
}
