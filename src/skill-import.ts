// Skill import (S-890): add a public skill folder from GitHub to STAM_HOME/skills, record where it
// came from (origin.json), and tell when the origin moved so Settings › Skills can offer Update.
//
// What is fetched is untrusted. Nothing in it runs: git is called with a fixed argument list built
// here (the source only picks validated URL and path parts), hooks, filters, global config and
// credential prompts are off, submodules are not followed, and the folder is checked (names, size,
// symlinks, SKILL.md frontmatter) in a temp folder before it replaces anything.
import { execFile } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { STAM_HOME } from './config.ts';
import { SKILLS_DIR, agentsSkillsDir } from './instructions.ts';

export class ImportError extends Error {}

export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_FILES = 300;
const GIT_TIMEOUT_MS = 120_000;
// The trees-only clone is stopped when its folder grows past this: a huge repository's history of
// trees can fill the disk well inside the timeout. Mutable so a test can lower it.
export const limits = { cloneBytes: 200 * 1024 * 1024, pollMs: 250 };
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface Origin {
  url: string;
  path: string;
  ref?: string;
  commit: string;
  tree?: string;
  // A repository head seen later whose folder was the same as at import, so it isn't checked again.
  seen?: string;
  date: string;
}
// Where a source points: `url` is what git clones and what origin.json records.
export interface Source {
  url: string;
  path: string;
  ref?: string;
}

export interface ImportOptions {
  // Allow file:///ABSOLUTE/REPO.git#PATH sources: tests only, the daemon passes it in a test home.
  allowFile?: boolean;
}

// A GitHub URL, OWNER/REPO, or OWNER/REPO/path; github.com over https only. A /tree/REF/path or
// /blob/REF/path/SKILL.md URL names a ref (one path segment) and a folder.
export function parseSource(input: string, opts: ImportOptions = {}): Source {
  const s = String(input ?? '').trim();
  if (!s || s.length > 300 || /[\s\0\\?]/.test(s)) throw new ImportError('give a GitHub URL, OWNER/REPO, or OWNER/REPO/path');
  if (s.startsWith('file://')) {
    if (!opts.allowFile) throw new ImportError('only github.com sources can be imported');
    const [url, rest = ''] = s.split('#');
    const at = rest.lastIndexOf('@');
    const ref = at >= 0 ? rest.slice(at + 1) : '';
    return { url, path: cleanPath(at >= 0 ? rest.slice(0, at) : rest), ...(ref ? { ref } : {}) };
  }
  let rest = s;
  const m = /^(?:https:\/\/)?(?:www\.)?github\.com\/(.*)$/i.exec(s);
  if (m) rest = m[1];
  else if (/^[a-z][a-z0-9+.-]*:/i.test(s) || /^[^/]*\.[^/]*\//.test(s)) throw new ImportError('only github.com sources can be imported');
  const parts = rest.replace(/\/+$/, '').split('/');
  const [owner, repoRaw, ...tail] = parts;
  const repo = repoRaw?.replace(/\.git$/, '');
  if (!owner || !repo || !SEGMENT.test(owner) || !SEGMENT.test(repo)) throw new ImportError('give a GitHub URL, OWNER/REPO, or OWNER/REPO/path');
  let ref: string | undefined;
  let path = tail;
  if (m && (tail[0] === 'tree' || tail[0] === 'blob')) {
    ref = tail[1];
    path = tail.slice(2);
    if (!ref || !SEGMENT.test(ref)) throw new ImportError('the branch or tag in the URL is not a plain name');
    if (tail[0] === 'blob') {
      if (path.at(-1) !== 'SKILL.md') throw new ImportError('give the folder that holds SKILL.md');
      path = path.slice(0, -1);
    }
  }
  return { url: `https://github.com/${owner}/${repo}`, path: cleanPath(path.join('/')), ...(ref ? { ref } : {}) };
}

function cleanPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  for (const seg of parts) if (!SEGMENT.test(seg)) throw new ImportError(`the path "${p}" holds a name that is not allowed`);
  return parts.join('/');
}

// Bytes under a folder, links not followed; stops counting once past `cap`.
function dirBytes(dir: string, cap: number): number {
  let n = 0;
  const walk = (d: string) => {
    let names: string[] = [];
    try {
      names = readdirSync(d);
    } catch {}
    for (const name of names) {
      if (n > cap) return;
      const p = join(d, name);
      try {
        const st = lstatSync(p);
        if (st.isDirectory()) walk(p);
        else n += st.size;
      } catch {}
    }
  };
  walk(dir);
  return n;
}
const tooBig = () => new ImportError(`the repository is too large to fetch (over ${limits.cloneBytes / 1024 / 1024} MB of history)`);

function git(args: string[], cwd: string | undefined, allowFile: boolean, input?: string, watch?: string): Promise<string> {
  const flags = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', `protocol.file.allow=${allowFile ? 'always' : 'never'}`, '-c', 'submodule.recurse=false', '-c', 'core.symlinks=true'];
  return new Promise((ok, fail) => {
    const child = execFile(
      'git',
      [...flags, ...args],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false', GIT_ALLOW_PROTOCOL: allowFile ? 'https:file' : 'https' },
      },
      (err, stdout, stderr) => {
        clearInterval(timer);
        if (big) return fail(tooBig());
        if (err) return fail(new ImportError(`git ${args.find((a) => !a.startsWith('-')) ?? ''} failed: ${String(stderr || err.message).trim().split('\n')[0]}`));
        ok(stdout);
      },
    );
    let big = false;
    const timer = watch
      ? setInterval(() => {
          if (dirBytes(watch, limits.cloneBytes) > limits.cloneBytes) {
            big = true;
            child.kill('SIGKILL');
          }
        }, limits.pollMs)
      : undefined;
    // A git that exits before reading fails this write with EPIPE; the callback reports the exit (S-2040).
    child.stdin?.on('error', () => {});
    if (input !== undefined) child.stdin?.end(input);
  });
}

// One import or update at a time: they share STAM_HOME/skills.
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

function frontmatter(text: string): { name: string; description: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) throw new ImportError('SKILL.md has no frontmatter');
  const lines = m[1].split(/\r?\n/);
  const value = (key: string): string => {
    const i = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
    if (i < 0) return '';
    const first = lines[i].replace(new RegExp(`^${key}\\s*:\\s*`), '');
    const rest: string[] = [];
    for (const l of lines.slice(i + 1)) {
      if (/^\S/.test(l)) break;
      rest.push(l.trim());
    }
    const folded = /^[>|][+-]?$/.test(first);
    return (folded ? rest : [first, ...rest]).filter(Boolean).join(' ').replace(/^(["'])([\s\S]*)\1$/, '$2').trim();
  };
  return { name: value('name'), description: value('description') };
}

// Walks the fetched folder without following links: counts files and bytes, and refuses anything
// that is not a plain file, folder or a symlink that stays inside the folder.
function inspect(root: string, topGit = false): { files: number; bytes: number } {
  const realRoot = realpathSync(root);
  let files = 0;
  let bytes = 0;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      // A skill at the repository root sits beside the clone's own .git, which isn't copied.
      if (topGit && dir === root && e.name === '.git') continue;
      if (e.name.toLowerCase() === '.git' || e.name === '..') throw new ImportError(`the folder holds a ${e.name} entry`);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) {
        const target = readlinkSync(p);
        const lexical = resolve(dirname(p), target);
        const inside = (x: string) => x === realRoot || x.startsWith(realRoot + sep) || x === root || x.startsWith(root + sep);
        if (isAbsolute(target) || !inside(lexical)) throw new ImportError(`${relative(root, p)} is a symlink that points outside the skill folder`);
        let resolved: string | undefined;
        try {
          resolved = realpathSync(p);
        } catch {}
        if (resolved && !inside(resolved)) throw new ImportError(`${relative(root, p)} is a symlink that points outside the skill folder`);
        files++;
      } else if (st.isDirectory()) {
        walk(p);
      } else if (st.isFile()) {
        files++;
        bytes += st.size;
      } else {
        throw new ImportError(`${relative(root, p)} is not a plain file`);
      }
      if (files > MAX_FILES) throw new ImportError(`the folder holds more than ${MAX_FILES} files`);
      if (bytes > MAX_BYTES) throw new ImportError(`the folder is larger than ${MAX_BYTES / 1024 / 1024} MB`);
    }
  };
  walk(root);
  return { files, bytes };
}

export interface TreeStats {
  files: number;
  bytes: number;
}

function checkStats(files: number, bytes: number): TreeStats {
  if (files > MAX_FILES) throw new ImportError(`the folder holds more than ${MAX_FILES} files`);
  if (bytes > MAX_BYTES) throw new ImportError(`the folder is larger than ${MAX_BYTES / 1024 / 1024} MB`);
  return { files, bytes };
}

// File count and bytes from GitHub's trees API answer, which gives every blob's size without a download.
export function statsFromApi(json: { tree?: { type?: string; size?: number }[]; truncated?: boolean }): TreeStats {
  if (json.truncated || !Array.isArray(json.tree)) throw new ImportError('the folder is too large to list');
  let files = 0;
  let bytes = 0;
  for (const e of json.tree) {
    if (e.type === 'commit') throw new ImportError('the folder holds a submodule');
    if (e.type !== 'blob') continue;
    files++;
    bytes += Number(e.size) || 0;
  }
  return checkStats(files, bytes);
}

// How big the folder is, before any of its files is downloaded. A GitHub source asks the trees API for
// the folder's tree id; a local test repository, where nothing is downloaded, lists it with git.
export async function treeSizes(src: Source, repo: string, treeSha: string, allowFile: boolean, fetcher: typeof fetch = fetch): Promise<TreeStats> {
  const gh = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(src.url);
  if (!gh) {
    if (!allowFile) throw new ImportError('only github.com sources can be imported');
    let files = 0;
    let bytes = 0;
    for (const rec of (await git(['ls-tree', '-r', '-l', '-z', treeSha], repo, true)).split('\0').filter(Boolean)) {
      if (rec.startsWith('160000')) throw new ImportError('the folder holds a submodule');
      files++;
      bytes += Number(/^\S+\s+\S+\s+\S+\s+(\d+|-)\t/.exec(rec)?.[1]) || 0;
    }
    return checkStats(files, bytes);
  }
  let r: Response;
  try {
    r = await fetcher(`https://api.github.com/repos/${gh[1]}/${gh[2]}/git/trees/${treeSha}?recursive=1`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'stam' }, signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new ImportError(`could not size the folder at GitHub: ${e instanceof Error ? e.message : e}`);
  }
  if (!r.ok) throw new ImportError(r.status === 403 || r.status === 429 ? 'GitHub refused to size the folder (rate limit); try again later' : `could not size the folder at GitHub (${r.status})`);
  return statsFromApi((await r.json()) as Parameters<typeof statsFromApi>[0]);
}

export const counters = { clones: 0 };

// Shallow, blobless clone with nothing checked out (trees only, no file contents), then the folder's
// tree is listed and sized, and only after it passes are its files downloaded and checked out.
async function cloneTrees(src: Source, repo: string, work: string, allowFile: boolean): Promise<{ commit: string; treeish: string; tree: string }> {
  counters.clones++;
  await git(['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--no-tags', ...(src.ref ? ['--branch', src.ref] : []), '--', src.url, repo], work, allowFile, undefined, work);
  if (dirBytes(repo, limits.cloneBytes) > limits.cloneBytes) throw tooBig();
  const treeish = src.path ? `HEAD:${src.path}` : 'HEAD^{tree}';
  const tree = (await git(['rev-parse', treeish], repo, allowFile).catch(() => '')).trim();
  if (!tree) throw new ImportError(`no folder "${src.path}" in the repository`);
  const commit = (await git(['rev-parse', 'HEAD'], repo, allowFile)).trim();
  return { commit, treeish, tree };
}

async function fetchFolder(src: Source, work: string, allowFile: boolean): Promise<{ dir: string; commit: string; tree: string }> {
  const repo = join(work, 'clone');
  const { commit, tree } = await cloneTrees(src, repo, work, allowFile);
  await treeSizes(src, repo, tree, allowFile);
  await git(['checkout', '--force', 'HEAD', '--', src.path ? `:(literal)${src.path}` : '.'], repo, allowFile);
  return { dir: src.path ? join(repo, src.path) : repo, commit, tree };
}

function readOrigin(dir: string): Origin | undefined {
  try {
    const o = JSON.parse(readFileSync(join(dir, 'origin.json'), 'utf8'));
    return typeof o?.url === 'string' && typeof o?.path === 'string' ? o : undefined;
  } catch {
    return undefined;
  }
}
export const originOf = (name: string) => readOrigin(join(SKILLS_DIR, name));
const sameOrigin = (a: Origin, b: Source) => a.url === b.url && a.path === b.path && (a.ref ?? '') === (b.ref ?? '');

export interface Imported {
  name: string;
  path: string;
  commit: string;
  updated: boolean;
}

async function run(src: Source, expect: string | undefined, opts: ImportOptions): Promise<Imported> {
  const allowFile = Boolean(opts.allowFile);
  mkdirSync(STAM_HOME, { recursive: true });
  const work = mkdtempSync(join(STAM_HOME, '.skill-import-'));
  try {
    const { dir, commit, tree } = await fetchFolder(src, work, allowFile);
    if (!existsSync(join(dir, 'SKILL.md'))) throw new ImportError('no SKILL.md in that folder');
    inspect(dir, !src.path);
    const fm = frontmatter(readFileSync(join(dir, 'SKILL.md'), 'utf8'));
    const folder = src.path ? basename(src.path) : basename(src.url).replace(/\.git$/, '');
    if (!fm.name || !SKILL_NAME.test(fm.name) || fm.name.length > 64) throw new ImportError('the name in SKILL.md must be lowercase letters, digits and hyphens, at most 64 characters');
    if (fm.name !== folder) throw new ImportError(`the name "${fm.name}" in SKILL.md must match its folder "${folder}"`);
    if (!fm.description || fm.description.length > 1024) throw new ImportError('SKILL.md needs a description of at most 1024 characters');
    if (expect && fm.name !== expect) throw new ImportError(`the origin's skill is now called "${fm.name}", not "${expect}"`);
    const target = join(SKILLS_DIR, fm.name);
    if (existsSync(join(homedir(), '.claude', 'skills', fm.name))) throw new ImportError(`you already have a skill called "${fm.name}" in ~/.claude/skills`);
    // A real folder, or a link that isn't stam's own, in the shared agents folder would hide or be hidden by this one.
    const agents = join(agentsSkillsDir(), fm.name);
    try {
      lstatSync(agents);
      if (!(lstatSync(agents).isSymbolicLink() && readlinkSync(agents) === target)) throw new ImportError(`you already have a skill called "${fm.name}" in ~/.agents/skills`);
    } catch (e) {
      if (e instanceof ImportError) throw e;
    }
    const existing = existsSync(target) ? readOrigin(target) : undefined;
    if (existsSync(target) && !(existing && sameOrigin(existing, src))) throw new ImportError(`a skill called "${fm.name}" already exists`);
    const stage = join(work, 'stage');
    cpSync(dir, stage, { recursive: true, verbatimSymlinks: true, filter: (p) => basename(p) !== '.git' });
    const origin: Origin = { url: src.url, path: src.path, ...(src.ref ? { ref: src.ref } : {}), commit, tree, date: new Date().toISOString() };
    // The fetched folder may ship its own origin.json, or a link at that name aimed at SKILL.md: remove
    // whatever is there (not following it) so the write below creates a plain file.
    rmSync(join(stage, 'origin.json'), { recursive: true, force: true });
    writeFileSync(join(stage, 'origin.json'), JSON.stringify(origin, null, 2) + '\n');
    mkdirSync(SKILLS_DIR, { recursive: true });
    // Swap in the new folder; put the old one back if the move fails.
    const old = join(work, `old-${fm.name}`);
    if (existsSync(target)) renameSync(target, old);
    try {
      renameSync(stage, target);
    } catch (e) {
      if (existsSync(old)) renameSync(old, target);
      throw e;
    }
    forgetChecks(fm.name);
    return { name: fm.name, path: target, commit, updated: Boolean(existing) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export const importSkill = async (source: string, opts: ImportOptions = {}): Promise<Imported> => {
  const src = parseSource(source, opts);
  return serial(() => run(src, undefined, opts));
};

// Re-fetch an imported skill from the origin recorded in its origin.json.
export const updateSkill = async (name: string, opts: ImportOptions = {}): Promise<Imported> => {
  if (!SKILL_NAME.test(name)) throw new ImportError('not a skill name');
  const o = originOf(name);
  if (!o) throw new ImportError(`"${name}" was not imported, so it has no origin to update from`);
  const src: Source = { url: o.url, path: o.path, ...(o.ref ? { ref: o.ref } : {}) };
  return serial(() => run(src, name, opts));
};

// Put back a skill folder an interrupted Update moved aside, and remove leftover work folders. Run at
// daemon start, when no import is under way.
export function recoverImports(): void {
  let names: string[] = [];
  try {
    names = readdirSync(STAM_HOME).filter((n) => /^\.skill-(import|check)-/.test(n));
  } catch {}
  for (const n of names) {
    const w = join(STAM_HOME, n);
    try {
      for (const e of readdirSync(w)) {
        if (!e.startsWith('old-')) continue;
        const target = join(SKILLS_DIR, e.slice(4));
        if (!existsSync(target)) {
          mkdirSync(SKILLS_DIR, { recursive: true });
          renameSync(join(w, e), target);
        }
      }
    } catch {}
    rmSync(w, { recursive: true, force: true });
  }
}

export interface UpdateState {
  moved: boolean;
  commit?: string;
  error?: string;
}

const CHECK_TTL_MS = 10 * 60 * 1000;
const CHECK_PARALLEL = 2;
const checks = new Map<string, { at: number; key: string; p: Promise<UpdateState> }>();
export const forgetChecks = (name?: string) => (name ? checks.delete(name) : checks.clear());
let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  while (running >= CHECK_PARALLEL) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

// The origin's current head: the repository's HEAD, or the pinned branch or tag.
async function remoteHead(o: Origin, allowFile: boolean): Promise<string> {
  const pats = o.ref ? [`refs/heads/${o.ref}`, `refs/tags/${o.ref}`, `refs/tags/${o.ref}^{}`] : ['HEAD'];
  const lines = (await git(['ls-remote', '--', o.url, ...pats], undefined, allowFile)).split('\n').filter(Boolean);
  const peeled = lines.find((l) => l.endsWith('^{}'));
  return (peeled ?? lines[0] ?? '').split(/\s/)[0];
}

function writeOrigin(name: string, o: Origin): void {
  const file = join(SKILLS_DIR, name, 'origin.json');
  rmSync(file + '.tmp', { recursive: true, force: true });
  writeFileSync(file + '.tmp', JSON.stringify(o, null, 2) + '\n');
  renameSync(file + '.tmp', file);
}

async function checkNow(name: string, o: Origin, allowFile: boolean): Promise<UpdateState> {
  try {
    const head = await remoteHead(o, allowFile);
    if (!head) return { moved: false, error: 'the origin has no such head' };
    if (head === o.commit || head === o.seen) return { moved: false, commit: head };
    const work = mkdtempSync(join(STAM_HOME, '.skill-check-'));
    try {
      const { commit, tree } = await cloneTrees({ url: o.url, path: o.path, ...(o.ref ? { ref: o.ref } : {}) }, join(work, 'clone'), work, allowFile);
      if (o.tree && tree === o.tree) {
        // Only other files changed: remember this head, so it isn't cloned again until the origin moves.
        // The folder may have been updated while this check ran: write only over the origin it started from.
        try {
          const now = originOf(name);
          if (now && now.commit === o.commit && (now.tree ?? '') === (o.tree ?? '') && (now.seen ?? '') === (o.seen ?? '')) writeOrigin(name, { ...o, seen: commit });
        } catch {}
        return { moved: false, commit };
      }
      return { moved: true, commit };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  } catch (e) {
    return { moved: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Has the origin changed under the skill's path? The head is compared first, and only a moved head is
// cloned (trees only) to compare the folder. Answers are kept for ten minutes, never an error, and at
// most two checks run at once.
export function checkUpdate(name: string, opts: ImportOptions = {}): Promise<UpdateState> {
  const o = originOf(name);
  if (!o) return Promise.resolve({ moved: false, error: 'no origin' });
  const key = `${o.commit}|${o.seen ?? ''}|${o.tree ?? ''}`;
  const hit = checks.get(name);
  if (hit && hit.key === key && Date.now() - hit.at < CHECK_TTL_MS) return hit.p;
  const p = slot(() => checkNow(name, o, Boolean(opts.allowFile)));
  checks.set(name, { at: Date.now(), key, p });
  void p.then((r) => {
    if (r.error && checks.get(name)?.p === p) checks.delete(name);
  });
  return p;
}
