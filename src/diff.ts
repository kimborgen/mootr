// The PR diff API's local half (S-1530), run on the ITSA home. A PR's diff comes from git, not the GitHub API:
// `refs/pull/N/head` and the main branch are fetched from the repo's origin URL into a bare cache repo under
// STAM_HOME (never into the checkout named in `settings.itsa.repos`, which is a live checkout), and the diff runs
// from the merge base to the head. The file list is cached per head sha; file bytes come from git objects.
// Only the human reaches it (daemon.ts forwards to the home); `denied()` from src/files.ts holds for every path.
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { STAM_HOME } from './config.ts';
import { settings } from './settings.ts';
import { SAFE_HEADERS, TEXT_CAP, denied, typeByExt } from './files.ts';

export class DiffError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type FileClass = 'tests' | 'lockfiles' | 'generated' | 'docs';
// The order classes are tried in: the first match wins.
export const CLASS_ORDER: FileClass[] = ['tests', 'lockfiles', 'generated', 'docs'];
export type DiffStatus = 'added' | 'modified' | 'deleted' | 'renamed';
// `headBlob` and `baseBlob` are the file's git blob ids at the PR head and at the merge base (absent on the side it doesn't exist), so a viewer can key per-file state by content.
export type RawFile = { path: string; oldPath?: string; status: DiffStatus; additions: number; deletions: number; binary: boolean; headBlob?: string; baseBlob?: string };
// A path on the files deny list is listed without counts and `denied: true`; its content is never served.
export type DiffFile = RawFile & { class: FileClass | null; denied?: true };

// A binary larger than this isn't served; text over TEXT_CAP is cut unless `all` is asked for.
export const BINARY_CAP = 50 * 1024 * 1024;
const MAX_LISTS = 100;

const globRe = (g: string): string => g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '.*');

// Whether a repo-relative path matches one pattern: `dir/` names a folder anywhere in the path, a pattern
// with no other `/` matches the file name, anything else matches the whole path. Pure.
export function matchPattern(pattern: string, path: string): boolean {
  if (!pattern) return false;
  if (pattern.endsWith('/')) {
    const dir = pattern.slice(0, -1);
    return !!dir && new RegExp(`(^|/)${globRe(dir)}/`).test(path);
  }
  if (!pattern.includes('/')) return new RegExp(`^${globRe(pattern)}$`).test(path.split('/').pop() ?? path);
  return new RegExp(`^${globRe(pattern.replace(/^\//, ''))}$`).test(path);
}

// The class of a path under `classes` (class name to patterns), or null. Pure.
export function classify(path: string, classes: Record<string, string[]>): FileClass | null {
  for (const c of CLASS_ORDER) if ((classes[c] ?? []).some((p) => matchPattern(p, path))) return c;
  return null;
}

const run = (args: string[], opts: { cwd?: string; timeout?: number; maxBuffer?: number } = {}): Promise<{ stdout: string; stderr: string }> =>
  new Promise((ok, fail) =>
    execFile('git', args, { cwd: opts.cwd, timeout: opts.timeout, killSignal: 'SIGKILL', maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', LC_ALL: 'C' } }, (err, stdout, stderr) => {
      if (err) Object.assign(err, { stderr: String(stderr) });
      err ? fail(err) : ok({ stdout: String(stdout), stderr: String(stderr) });
    }),
  );

// One fetch or diff at a time per repo, so two requests don't write the same refs.
const locks = new Map<string, Promise<unknown>>();
function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = next.catch(() => {});
  locks.set(key, tail);
  tail.then(() => locks.get(key) === tail && locks.delete(key));
  return next;
}

const fetched = new Map<string, number>(); // `repo#pr` -> when it was last fetched
const used = new Map<string, number>(); // `repo#pr` -> a counter of its last use, to drop the longest unused ref first
let tick = 0;
const lists = new Map<string, RawFile[]>(); // `repo:head:mergeBase` -> the file list, insertion ordered

// Forgets what is cached in memory (tests).
export function resetCaches(): void {
  fetched.clear();
  used.clear();
  lists.clear();
}

export const cacheDir = (repo: string) => join(STAM_HOME, 'cache', 'diff', `${repo.replace(/[^\w.-]/g, '_')}.git`);

export function checkoutOf(repo: string): string {
  const path = settings().itsa.repos[repo];
  if (!path || !Object.hasOwn(settings().itsa.repos, repo)) throw new DiffError(404, `unknown repo ${repo}: it is not in settings.itsa.repos`);
  return path;
}

async function ensureCache(repo: string, checkout: string): Promise<string> {
  const dir = cacheDir(repo);
  if (existsSync(join(dir, 'HEAD'))) return dir;
  mkdirSync(join(STAM_HOME, 'cache', 'diff'), { recursive: true });
  try {
    // The checkout's objects are borrowed (as `clone --reference` does), so a fetch only brings what the checkout lacks.
    const objects = (await run(['rev-parse', '--path-format=absolute', '--git-path', 'objects'], { cwd: checkout })).stdout.trim();
    await run(['init', '--bare', '--quiet', dir]);
    mkdirSync(join(dir, 'objects', 'info'), { recursive: true });
    writeFileSync(join(dir, 'objects', 'info', 'alternates'), objects + '\n');
  } catch (e: any) {
    throw new DiffError(500, `can't prepare the diff cache for ${repo}: ${String(e.stderr ?? e.message).split('\n')[0]}`);
  }
  return dir;
}

const sha = (s: string) => /^[0-9a-f]{40,64}$/.test(s);

// Makes sure the cache has the PR's head and main, fetching when the last fetch is older than `refreshSeconds`.
async function ensure(repo: string, pr: number): Promise<{ dir: string; checkout: string; head: string; main: string }> {
  const checkout = checkoutOf(repo);
  return serialize(repo, async () => {
    const dir = await ensureCache(repo, checkout);
    const s = settings();
    const prRef = `refs/stam-diff/pr/${pr}`;
    const mainRef = 'refs/stam-diff/main';
    const key = `${repo}#${pr}`;
    used.set(key, ++tick);
    const fresh = Date.now() - (fetched.get(key) ?? 0) < s.diff.refreshSeconds * 1000;
    const resolve = async () => {
      try {
        const [head, main] = await Promise.all([run(['rev-parse', '--verify', `${prRef}^{commit}`], { cwd: dir }), run(['rev-parse', '--verify', `${mainRef}^{commit}`], { cwd: dir })]);
        return { head: head.stdout.trim(), main: main.stdout.trim() };
      } catch {
        return undefined;
      }
    };
    if (fresh) {
      const r = await resolve();
      if (r) return { dir, checkout, ...r };
    }
    let url: string;
    try {
      url = (await run(['config', '--get', 'remote.origin.url'], { cwd: checkout })).stdout.trim();
    } catch {
      url = '';
    }
    if (!url) throw new DiffError(500, `the checkout of ${repo} has no remote.origin.url`);
    try {
      await run(['fetch', '--quiet', '--no-tags', url, `+refs/pull/${pr}/head:${prRef}`, `+refs/heads/${s.itsa.mainBranch}:${mainRef}`], { cwd: dir, timeout: s.diff.fetchSeconds * 1000 });
    } catch (e: any) {
      const err = String(e.stderr ?? e.message);
      if (e.killed || e.signal) throw new DiffError(504, `fetching PR ${pr} of ${repo} timed out after ${s.diff.fetchSeconds}s`);
      if (/couldn't find remote ref refs\/pull\//.test(err)) throw new DiffError(404, `no PR ${pr} in ${repo}`);
      throw new DiffError(502, `fetching PR ${pr} of ${repo} failed: ${err.trim().split('\n').pop() ?? ''}`);
    }
    fetched.set(key, Date.now());
    await ownObjects(dir);
    await pruneRefs(dir, repo, pr, s.diff.maxPrRefs).catch(() => {});
    const r = await resolve();
    if (!r) throw new DiffError(502, `fetching PR ${pr} of ${repo} left no head`);
    return { dir, checkout, ...r };
  });
}

// After the first fetch the cache takes its own copy of the borrowed objects and drops the link, as
// `clone --dissociate` does, so a `git gc` in the checkout can't take objects the cache refs need.
async function ownObjects(dir: string): Promise<void> {
  const alt = join(dir, 'objects', 'info', 'alternates');
  if (!existsSync(alt)) return;
  try {
    await run(['repack', '-a', '-d', '-q'], { cwd: dir });
    rmSync(alt);
  } catch {}
}

// Keeps the `max` most recently used PR refs, never the one being asked for; a dropped one is refetched when asked for again.
async function pruneRefs(dir: string, repo: string, current: number, max: number): Promise<void> {
  const refs = (await run(['for-each-ref', '--format=%(refname)', 'refs/stam-diff/pr/'], { cwd: dir })).stdout.split('\n').filter(Boolean);
  const num = (r: string) => Number(r.slice(r.lastIndexOf('/') + 1));
  const old = refs.filter((r) => num(r) !== current).sort((a, b) => (used.get(`${repo}#${num(b)}`) ?? 0) - (used.get(`${repo}#${num(a)}`) ?? 0));
  for (const r of old.slice(Math.max(0, max - 1))) {
    await run(['update-ref', '-d', r], { cwd: dir });
    fetched.delete(`${repo}#${num(r)}`);
    used.delete(`${repo}#${num(r)}`);
  }
}

// Where the diff starts: the merge base of main and the head. A merged PR has none of its own (the head is in
// main), so it starts from the first parent of the merge commit that brought the head in.
async function mergeBaseOf(dir: string, main: string, head: string): Promise<string> {
  const mb = (await run(['merge-base', main, head], { cwd: dir })).stdout.trim();
  if (mb !== head || head === main) return mb;
  const path = (await run(['rev-list', '--first-parent', '--ancestry-path', `${head}..${main}`], { cwd: dir })).stdout.split('\n').filter(Boolean);
  const merge = path[path.length - 1];
  if (!merge) return mb;
  try {
    const parent = (await run(['rev-parse', '--verify', `${merge}^1`], { cwd: dir })).stdout.trim();
    return (await run(['merge-base', parent, head], { cwd: dir })).stdout.trim();
  } catch {
    return mb;
  }
}

const STATUS: Record<string, DiffStatus> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', T: 'modified', C: 'added' };

// The files a diff touches, from `--name-status -z` and `--numstat -z` (same order), and `--raw -z --no-abbrev` for the blob ids. Pure.
export function parseDiff(nameStatus: string, numstat: string, raw = ''): RawFile[] {
  const ns = nameStatus.split('\0');
  const files: RawFile[] = [];
  for (let i = 0; i < ns.length && ns[i]; ) {
    const code = ns[i++][0];
    const two = code === 'R' || code === 'C';
    const first = ns[i++];
    const second = two ? ns[i++] : undefined;
    files.push({ path: second ?? first, ...(two ? { oldPath: first } : {}), status: STATUS[code] ?? 'modified', additions: 0, deletions: 0, binary: false });
  }
  const nt = numstat.split('\0');
  let f = 0;
  for (let i = 0; i < nt.length && nt[i] && f < files.length; f++) {
    const [a, d, path] = nt[i++].split('\t');
    if (path === '') i += 2; // a rename: the old and new path follow as two more tokens
    const file = files[f];
    if (a === '-') file.binary = true;
    else {
      file.additions = Number(a) || 0;
      file.deletions = Number(d) || 0;
    }
  }
  // `:oldmode newmode oldblob newblob STATUS` NUL path NUL [new path NUL], one entry per file in the same order.
  const rw = raw.split('\0');
  const zero = /^0+$/;
  for (let i = 0, f = 0; i < rw.length && rw[i] && f < files.length; f++) {
    const m = /^:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) (\w)/.exec(rw[i++]);
    if (m && (m[3] === 'R' || m[3] === 'C')) i++;
    i++;
    if (!m) continue;
    if (!zero.test(m[1])) files[f].baseBlob = m[1];
    if (!zero.test(m[2])) files[f].headBlob = m[2];
  }
  return files;
}

export async function list(repo: string, pr: number): Promise<{ repo: string; pr: number; head: string; base: string; mergeBase: string; files: DiffFile[] }> {
  const { dir, checkout, head, main } = await ensure(repo, pr);
  let mergeBase: string;
  try {
    mergeBase = await mergeBaseOf(dir, main, head);
  } catch {
    throw new DiffError(422, `PR ${pr} of ${repo} has no merge base with ${settings().itsa.mainBranch}`);
  }
  const key = `${repo}:${head}:${mergeBase}`;
  let hit = lists.get(key);
  if (!hit) {
    const args = ['diff', '-z', '-M', '--no-ext-diff', '--no-textconv', '--no-color'];
    try {
      const [ns, nu, rw] = await Promise.all([run([...args, '--name-status', mergeBase, head], { cwd: dir }), run([...args, '--numstat', mergeBase, head], { cwd: dir }), run([...args, '--raw', '--no-abbrev', mergeBase, head], { cwd: dir })]);
      hit = parseDiff(ns.stdout, nu.stdout, rw.stdout);
    } catch (e: any) {
      throw new DiffError(500, `git diff failed: ${String(e.stderr ?? e.message).split('\n')[0]}`);
    }
    lists.set(key, hit);
    while (lists.size > MAX_LISTS) lists.delete(lists.keys().next().value!);
  }
  const classes = settings().diff.classes;
  const files = hit.map((f): DiffFile => (denied(join(checkout, f.path)) || (f.oldPath && denied(join(checkout, f.oldPath))) ? { path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}), status: f.status, additions: 0, deletions: 0, binary: false, class: null, denied: true } : { ...f, class: classify(f.path, classes) }));
  return { repo, pr, head, base: main, mergeBase, files };
}

// Reads at most `limit` bytes of a blob.
function readBlob(dir: string, blob: string, limit: number): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const p = spawn('git', ['cat-file', 'blob', blob], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let n = 0;
    p.stdout.on('data', (c: Buffer) => {
      chunks.push(c);
      n += c.length;
      if (n >= limit) p.kill('SIGKILL');
    });
    p.on('error', fail);
    p.on('close', () => ok(Buffer.concat(chunks).subarray(0, limit)));
  });
}

const isText = (b: Buffer): boolean => {
  const s = b.subarray(0, 4096);
  if (s.includes(0)) return false;
  for (let cut = 0; cut <= 3 && cut < s.length; cut++) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(s.subarray(0, s.length - cut));
      return true;
    } catch {}
  }
  return s.length === 0;
};

// A path in the repo, validated: relative, no `..`, no empty parts, no NUL.
function cleanPath(p: string): string {
  if (!p) throw new DiffError(400, 'path is required');
  if (p.includes('\0') || p.startsWith('/') || p.split('/').some((s) => s === '' || s === '..' || s === '.')) throw new DiffError(400, 'path must be a plain path inside the repo');
  return p;
}

// Writes the whole file at one side of the diff: the head of the PR, or the merge base it is compared with.
// `want` is the head and base the list returned: with both, exactly those commits are served, so a PR pushed to
// since the list was drawn doesn't change the sides under the viewer. Without them, the current ones are, and
// `x-stam-head` and `x-stam-base` say which.
export async function serveFile(res: ServerResponse, repo: string, pr: number, path: string, side: 'base' | 'head', all: boolean, want: { head?: string; base?: string } = {}): Promise<void> {
  const rel = cleanPath(path);
  // The deny list is judged on the path as it would sit in the checkout, so `.env` and `*.pem` stay closed.
  if (denied(join(checkoutOf(repo), rel))) throw new DiffError(403, 'not available');
  const has = async (d: string, c: string) => run(['cat-file', '-e', `${c}^{commit}`], { cwd: d }).then(() => true, () => false);
  let dir = cacheDir(repo);
  let head = want.head ?? '';
  let main = want.base ?? '';
  if (!(head && main && existsSync(join(dir, 'HEAD')) && (await has(dir, head)) && (await has(dir, main)))) {
    const cur = await ensure(repo, pr);
    dir = cur.dir;
    head = want.head ?? cur.head;
    main = want.base ?? cur.main;
    if (!(await has(dir, head)) || !(await has(dir, main))) throw new DiffError(404, `the head or base asked for is not in the cache for PR ${pr} of ${repo}; reload the diff`);
  }
  let rev = head;
  if (side === 'base') {
    try {
      rev = await mergeBaseOf(dir, main, head);
    } catch {
      throw new DiffError(422, `PR ${pr} of ${repo} has no merge base`);
    }
  }
  const tree = (await run(['ls-tree', '-z', rev, '--', rel], { cwd: dir }).catch(() => ({ stdout: '' }))).stdout.split('\0')[0];
  const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(tree);
  if (!m || m[4] !== rel) throw new DiffError(404, `no ${rel} at the ${side} of PR ${pr}`);
  if (m[2] !== 'blob') throw new DiffError(400, `${rel} is not a file at the ${side} of PR ${pr}`);
  const blob = m[3];
  if (!sha(blob)) throw new DiffError(500, 'unexpected object id');
  const size = Number((await run(['cat-file', '-s', blob], { cwd: dir })).stdout.trim());
  if (size > BINARY_CAP) throw new DiffError(413, `${rel} is ${size} bytes, over the ${BINARY_CAP} byte limit`);
  let body = await readBlob(dir, blob, Math.min(size, TEXT_CAP));
  let type = typeByExt(rel);
  const text = isText(body);
  if (type.startsWith('text/') && !text) type = 'application/octet-stream';
  else if (type === 'application/octet-stream' && text) type = 'text/plain; charset=utf-8';
  const textual = type.startsWith('text/');
  let truncated = false;
  if (size > body.length) {
    if (textual && !all) truncated = true;
    else body = await readBlob(dir, blob, size);
  }
  const { 'accept-ranges': _ranges, ...safe } = SAFE_HEADERS;
  const head_: Record<string, string | number> = { ...safe, 'content-type': type, 'content-length': body.length, 'x-stam-size': size, 'x-stam-sha': blob, 'x-stam-head': head, 'x-stam-base': main, ...(truncated ? { 'x-stam-truncated': '1' } : {}) };
  if (!textual && !/^(image|video|audio)\//.test(type) && type !== 'application/pdf') head_['content-disposition'] = `attachment; filename="${basename(rel).replace(/[^\w. -]/g, '_')}"`;
  res.writeHead(200, head_);
  res.end(body);
}

// The GitHub `OWNER/REPO` a remote URL names (https, ssh or scp form), or null for any other host.
export function githubSlug(url: string): string | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

// The repos the diff API serves (S-1533): each name in `settings.itsa.repos` with the GitHub repo its checkout's origin
// names (null when that isn't GitHub or can't be read), so the page can tell which PR links and URLs open in-app.
export async function repos(): Promise<{ repos: { name: string; github: string | null }[] }> {
  const out = await Promise.all(
    Object.entries(settings().itsa.repos).map(async ([name, path]) => {
      let github: string | null = null;
      try {
        github = githubSlug((await run(['config', '--get', 'remote.origin.url'], { cwd: path })).stdout);
      } catch {}
      return { name, github };
    }),
  );
  return { repos: out };
}

// What the two routes share: the human check, the parameters, and the answer. A list returns its JSON; a file
// is written to `res` and the result is undefined.
export async function request(kind: 'list' | 'file' | 'repos', human: boolean, q: URLSearchParams, res: ServerResponse): Promise<object | undefined> {
  if (!human) throw new DiffError(403, 'only the human can read diffs');
  if (kind === 'repos') return repos();
  const repo = q.get('repo') ?? '';
  const pr = q.get('pr') ?? '';
  if (!repo) throw new DiffError(400, 'repo is required');
  if (!/^[1-9]\d{0,8}$/.test(pr)) throw new DiffError(400, 'pr must be a PR number');
  if (kind === 'list') return list(repo, Number(pr));
  const side = q.get('side') ?? 'head';
  if (side !== 'base' && side !== 'head') throw new DiffError(400, 'side must be base or head');
  const want: { head?: string; base?: string } = {};
  for (const k of ['head', 'base'] as const) {
    const v = q.get(k);
    if (v) {
      if (!sha(v)) throw new DiffError(400, `${k} must be a commit sha`);
      want[k] = v;
    }
  }
  await serveFile(res, repo, Number(pr), q.get('path') ?? '', side, q.get('all') === '1', want);
  return undefined;
}
