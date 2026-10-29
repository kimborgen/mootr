#!/usr/bin/env node
// Sweeps test leftovers off a machine (S-428): the /tmp/stam-* folders (a /tmp that is RAM, so
// each one costs memory) and the stam-test.* homes under ~/.cache/stam-test that are older than
// N hours and that no process uses. It kills nothing and touches nothing it can't prove is idle.
//   node scripts/sweep-test-homes.mjs                  remove them (default: older than 2 hours)
//   node scripts/sweep-test-homes.mjs --dry-run        print what it would remove or keep, remove nothing
//   node scripts/sweep-test-homes.mjs --hours 6        older than 6 hours
//   node scripts/sweep-test-homes.mjs --review-hours 6 the review folders' age (default 6; see below)
// It also prunes the deps caches (STAM_HOME/deps, ~/.cache/stam-gate-deps: keep entries a release or worktree
// hard-links, main's current keys, and the newest 3 unused) and keeps the newest 2 stam.db.bak-* (S-1965).
//   node scripts/sweep-test-homes.mjs --install        write sweep-test-homes units (stam-* under a real stam home, mootr-* under a mootr one), and enable the timer
// Review leftovers (S-1235): the folders under ~/.cache/stam-review (clones named after a PR or task, and
// .tmp-*), the non-standard homes under ~/.cache/stam-test (rev271, pr198, ...), and ~/.cache/review-*
// go by the same proof (age, cwd, open files, env, argv), plus: no live agent's cwd, workspace, name or
// first prompt names the folder (its path, or its name as a whole word). A folder that is a git worktree
// goes by `git worktree remove`. If the live agents can't be read, those folders are all kept.
// A folder's age is the newest modification time of the folder and its direct entries. A process
// uses a folder when its cwd or an open file lies inside it, a variable in its environment (such as
// STAM_HOME) names a path inside it, or an argument of its command line does. A process of another
// user can't be read, so for the sweep it is not a user: run it as the user who runs the tests.
// Only directories whose name matches the prefixes the unit tests use (testPrefixes) are considered; a symlink is never followed or removed.
// STAM_SWEEP_TMP and STAM_SWEEP_CACHE (or --tmp and --cache) name the two folders, for tests.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tryExclusive } from './deps-lock.mjs';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envVar, setEnvVar } from '../src/env.ts';
import { defaultHome } from '../src/default-home.ts';
import { isMain } from './main-guard.mjs';
import { unitScript, unitToInstall } from './unit-names.mjs';

const SELF = fileURLToPath(import.meta.url);
const NAME = 'sweep-test-homes';

// The prefixes test/*.mjs gives its temporary folders: tempHome('PREFIX-'), tempDir('PREFIX-') (the
// S-668 helper), tempDirOutside('PREFIX-') (the same, in /tmp), and mkdtemp(Sync)(join(tmpdir(), 'PREFIX-')). They are read from the sources at
// sweep time (S-775), so a test that adds a prefix is swept with no list to keep in step. Only a prefix matching PREFIX_SHAPE,
// followed by the anchored random suffix, is swept; never a folder that merely starts with stam-
// (deploy's, a person's). An unreadable test folder yields none, and the sweep then matches nothing:
// safer than guessing.
//
// Threat model: these are trusted sources in our own repo, so the scan only has to stop ACCIDENTAL
// false prefixes, not beat adversarial JS. It accepts a prefix only from a whole, unescaped string
// literal that is the call's only argument; a template, a computed argument, a concatenation, or a
// literal with a backslash or `${` is refused, failing closed. Comments, regex literals, and backtick
// text are skipped. The sweep's own guards still apply: only /tmp and the test cache, only the
// anchored random suffix, only old and unused folders, and never a symlink.
const TEMP_HELPERS = new Set(['tempHome', 'tempDir', 'tempDirOutside', 'mkdtemp', 'mkdtempSync']);
const TEMP_FLAG_ARGS = new Set(['tempDir', 'tempDirOutside']);
const PREFIX_SHAPE = /^stam-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REGEX_AFTER = new Set(['return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'new', 'delete', 'void', 'throw', 'yield', 'await']);

// A small JS tokenizer: enough to drop comments, keep string literals, treat a template or a regex
// literal as one opaque token, and tell a call's argument from text.
function tokens(src) {
  const out = [];
  const push = (kind, value) => out.push({ kind, value });
  // A `/` begins a regex literal when the previous token can end an expression (nothing, an operator,
  // or a keyword); after an identifier, number, `)`, `]` or `}` it is division.
  const regexHere = () => {
    const p = out[out.length - 1];
    if (!p) return true;
    if (p.kind === 'p') return ![')', ']', '}'].includes(p.value);
    if (p.kind === 'id') return REGEX_AFTER.has(p.value);
    return false;
  };
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      i += 2;
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
    } else if (c === '/' && regexHere()) {
      i++;
      let inClass = false;
      while (i < src.length && (inClass || src[i] !== '/')) {
        if (src[i] === '\\') i += 2;
        else {
          if (src[i] === '[') inClass = true;
          else if (src[i] === ']') inClass = false;
          i++;
        }
      }
      i++;
      while (i < src.length && /[a-z]/i.test(src[i])) i++;
      push('re', '');
    } else if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      let value = '';
      while (j < src.length && src[j] !== quote) {
        if (src[j] === '\\') {
          value += src[j] + (src[j + 1] ?? '');
          j += 2;
        } else {
          value += src[j];
          j++;
        }
      }
      push(quote === '`' ? 'tpl' : 'str', value);
      i = j + 1;
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      push('id', src.slice(i, j));
      i = j;
    } else if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9A-Fa-fxX_.]/.test(src[j])) j++;
      push('num', src.slice(i, j));
      i = j;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      push('p', c);
      i++;
    }
  }
  return out;
}

// The prefix a call's whole, unescaped string literal argument names; anything else is refused.
function literalPrefix(tok) {
  if (!tok || tok.kind !== 'str') return null;
  if (tok.value.includes('\\') || tok.value.includes('${')) return null;
  const m = /^(stam-[a-z0-9-]*?)-?$/.exec(tok.value);
  return m ? m[1].replace(/-+$/, '') : null;
}

export function testPrefixes(dir = fileURLToPath(new URL('../test/', import.meta.url))) {
  const found = new Set();
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.mjs'));
  } catch {
    return [];
  }
  for (const f of names) {
    let src = '';
    try {
      src = readFileSync(join(dir, f), 'utf8');
    } catch {
      continue;
    }
    const ts = tokens(src);
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      if (t.kind !== 'id' || !TEMP_HELPERS.has(t.value)) continue;
      if (ts[i + 1]?.kind !== 'p' || ts[i + 1].value !== '(') continue;
      let prefix = null;
      if (t.value === 'tempHome' || t.value === 'tempDir' || t.value === 'tempDirOutside') {
        // tempHome(LITERAL), tempDir(LITERAL) or tempDirOutside(LITERAL): the literal is the whole argument, so `)` closes the call right after.
        // tempHome(LITERAL, tempDirOutside) (or tempDir) also names one, the second argument being that helper, never a value.
        const closesAt = (n, v) => ts[i + n]?.kind === 'p' && ts[i + n].value === v;
        const outsideArg = t.value === 'tempHome' && closesAt(3, ',') && ts[i + 4]?.kind === 'id' && TEMP_FLAG_ARGS.has(ts[i + 4].value) && closesAt(5, ')');
        if (closesAt(3, ')') || outsideArg) prefix = literalPrefix(ts[i + 2]);
      } else {
        // mkdtemp(Sync)(join(tmpdir(), LITERAL)): the literal is the whole first argument, and the
        // two calls close right after it.
        const joinTmpdir = [['id', 'join'], ['p', '('], ['id', 'tmpdir'], ['p', '('], ['p', ')'], ['p', ',']];
        const head = joinTmpdir.every(([k, v], n) => ts[i + 2 + n]?.kind === k && ts[i + 2 + n]?.value === v);
        if (head && ts[i + 9]?.value === ')' && ts[i + 10]?.value === ')') prefix = literalPrefix(ts[i + 8]);
      }
      if (prefix && PREFIX_SHAPE.test(prefix)) found.add(prefix);
    }
  }
  return [...found].sort();
}
export const TEST_PREFIXES = testPrefixes();
// Other folders tests make: test/lib.sh's stam-test.OWNER.XXXXXX, run.sh's stam-test-logs.XXXXXX, the ui flows' stam-ui-shots.XXXXXX.
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// With no derived prefix the group must match nothing, not the empty string (which would let a bare
// "-123456" through): the sweep keeping its hands off is always the safe end.
export function tmpPattern(prefixes) {
  const alt = prefixes.length ? prefixes.map(escape).join('|') : '(?!)';
  return new RegExp(`^(?:(?:${alt})(?:-\\d+)?-[A-Za-z0-9]{6}|stam-test\\..+|stam-test-logs\\.[A-Za-z0-9]{6}|stam-ui-shots\\.[A-Za-z0-9]{6})$`);
}
export const TMP_PATTERN = tmpPattern(TEST_PREFIXES);

// The folders to sweep: [folder, name pattern].
export function roots(env = process.env) {
  const cache = envVar('SWEEP_CACHE', env) || join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'stam-test');
  return [
    [envVar('SWEEP_TMP', env) || '/tmp', TMP_PATTERN],
    [cache, /^stam-test\./],
  ];
}

// The folders of S-1235: [folder, name pattern]. Never the gate deps, playwright or uv: only these roots, and a name
// that is a plain directory name (no dot-dirs but .tmp-*, nothing a clone's own files make).
const NEVER = new Set(['stam-gate-deps', 'ms-playwright', 'uv', 'stam-gate', 'stam-wt']);
export function reviewRoots(env = process.env) {
  const cacheHome = env.XDG_CACHE_HOME || join(homedir(), '.cache');
  const dirName = /^(?:\.tmp-[\w.-]+|[A-Za-z0-9][\w.-]*)$/;
  return [
    [envVar('SWEEP_REVIEW', env) || join(cacheHome, 'stam-review'), dirName],
    [envVar('SWEEP_CACHE', env) || join(cacheHome, 'stam-test'), dirName],
    [envVar('SWEEP_HOME_CACHE', env) || cacheHome, /^review-[\w.-]+$/],
  ];
}

// The text live agents hold: name, cwd, workspace, first prompt. null when it can't be read.
export function liveAgentTexts(env = process.env) {
  try {
    if (envVar('SWEEP_AGENTS', env)) return JSON.parse(readFileSync(envVar('SWEEP_AGENTS', env), 'utf8')).map((a) => JSON.stringify(a));
    const bin = envVar('BIN', env) || 'stam';
    const ls = spawnSync(bin, ['ls'], { encoding: 'utf8', timeout: 30_000 });
    if (ls.status !== 0) return null;
    const texts = [];
    for (const line of ls.stdout.split('\n').slice(1)) {
      const [id, , , , state] = line.trim().split(/\s+/);
      if (!id || state === 'archived') continue;
      const show = spawnSync(bin, ['show', id], { encoding: 'utf8', timeout: 30_000 });
      if (show.status !== 0) return null;
      texts.push(show.stdout);
    }
    return texts;
  } catch {
    return null;
  }
}

// Whether any live agent's text holds the folder's path or its name as a whole word.
export function referenced(path, name, texts) {
  const word = new RegExp(`(?<![A-Za-z0-9_.-])${escape(name)}(?![A-Za-z0-9_-])`);
  return texts.some((t) => t.includes(path) || word.test(t));
}

// A worktree has a .git file; git removes it from its repo. Anything else is a plain folder.
function removeFolder(path) {
  try {
    if (lstatSync(join(path, '.git')).isFile()) {
      const common = spawnSync('git', ['-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
      const repo = common.status === 0 ? dirname(common.stdout.trim()) : '';
      if (repo && existsSync(repo) && spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', path], { encoding: 'utf8' }).status === 0) return;
    }
  } catch {}
  rmSync(path, { recursive: true, force: true });
}

// A read error that makes a process's use unknown: not a process that exited mid-read (ENOENT, ESRCH). Everything
// else, a permission denial included, counts, so a same-user process made undumpable (PR_SET_DUMPABLE=0, which
// turns its cwd, fd and environ into EACCES) can't hide a folder it uses.
const gone = (e) => e?.code === 'ENOENT' || e?.code === 'ESRCH';

// Processes whose state this user can never read, and which hold nothing in a cache folder: their own comm names
// them (from /proc/PID/stat, which stays readable). systemd --user (cwd /), its (sd-pam) helper, and ssh-agent
// (a socket) keep a different set of capabilities, so cwd and fd answer EACCES. Trust assumption: the comm is
// whatever the process set, so a same-user process can rename itself and hide; these exemptions guard against
// accident (this host's own helpers, which never hold a cache folder), not against a process deliberately hiding.
const OPAQUE_COMMS = new Set(['systemd', '(sd-pam)', 'ssh-agent']);
// The comm and state letter from /proc/PID/stat. A zombie (Z) or dead (X) process has released everything, but its
// cwd, fd and environ answer EACCES, so it is not unknown.
function statOf(base) {
  try {
    const stat = readFileSync(join(base, 'stat'), 'utf8');
    return { comm: stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')), state: stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) };
  } catch {
    return { comm: null, state: null };
  }
}

// What every process names, once per run: its cwd, open files, environment values, and arguments.
// `only`, a list of pid strings, limits the scan to those processes (tests: so the host's other processes can't
// change the result). A read error on a process this user owns (or on /proc itself) sets `unreadable` on the result, and inUse then
// answers yes for every path: unknown usage keeps the entry (S-1965). Exempt: a process that exits mid-read, a zombie,
// one of another user (it can't be read, so for the sweep it is not a user), and one in OPAQUE_COMMS.
export function claimedPaths(procDir = '/proc', only = null) {
  const out = [];
  out.unreadable = false;
  let names = [];
  try {
    names = readdirSync(procDir);
  } catch {
    out.unreadable = true;
  }
  const mine = typeof process.getuid === 'function' ? process.getuid() : -1;
  for (const n of names) {
    if (!/^\d+$/.test(n) || Number(n) === process.pid) continue;
    if (only && !only.includes(n)) continue;
    const base = join(procDir, n);
    // The process's own uid, from /proc/PID/status (world-readable): the owner of /proc/PID is root for a process
    // made undumpable (PR_SET_DUMPABLE=0), so it can't tell whose process this is. A process that exited (ENOENT,
    // ESRCH) is skipped; any other failure to tell is unknown, so the process counts as ours.
    let owned = true;
    try {
      const m = readFileSync(join(base, 'status'), 'utf8').match(/^Uid:\s+(\d+)/m);
      if (m) owned = Number(m[1]) === mine;
    } catch (e) {
      if (gone(e)) continue;
    }
    // A process mid-exec or mid-exit can fail one read; the read is repeated a few times before it counts as unknown.
    let got = [];
    let bad = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      got = [];
      bad = false;
      let info;
      const note = (e) => {
        if (!owned || gone(e)) return;
        info ??= statOf(base);
        if (info.state === 'Z' || info.state === 'X') return;
        if (!OPAQUE_COMMS.has(info.comm) || !['EACCES', 'EPERM'].includes(e?.code)) bad = true;
      };
      const read = (p) => {
        try {
          return readFileSync(p, 'utf8');
        } catch (e) {
          note(e);
          return '';
        }
      };
      try {
        got.push(readlinkSync(join(base, 'cwd')));
      } catch (e) {
        note(e);
      }
      try {
        for (const fd of readdirSync(join(base, 'fd'))) {
          try {
            got.push(readlinkSync(join(base, 'fd', fd)));
          } catch (e) {
            note(e);
          }
        }
      } catch (e) {
        note(e);
      }
      for (const kv of read(join(base, 'environ')).split('\0')) got.push(kv.slice(kv.indexOf('=') + 1));
      got.push(...read(join(base, 'cmdline')).split('\0'));
      if (!bad) break;
      try {
        lstatSync(base);
      } catch {
        bad = false;
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    out.push(...got);
    if (bad) out.unreadable = true;
  }
  const paths = out.filter((p) => p.includes('/'));
  paths.unreadable = out.unreadable;
  return paths;
}

// Whether any claimed path is `dir` or inside it, or a longer string that holds `dir/` (a shell
// command line, or a list of paths).
export function inUse(dir, claims) {
  if (claims.unreadable) return true;
  return claims.some((c) => c === dir || c.startsWith(dir + sep) || c.includes(dir + sep) || c.includes(`${dir} `));
}

// Newest modification time (ms) of `dir` and its direct entries.
// With `deep`, the whole tree below it too (a review clone is edited in src/, not at its top), skipping
// node_modules, never following a symlink, and counting an unreadable entry as new.
export function newest(dir, deep = false) {
  let t = lstatSync(dir).mtimeMs;
  for (const e of readdirSync(dir)) {
    try {
      const p = join(dir, e);
      const st = lstatSync(p);
      t = Math.max(t, st.mtimeMs);
      if (deep && st.isDirectory() && e !== 'node_modules') t = Math.max(t, newest(p, true));
    } catch {
      // Unreadable below a review folder: treat it as just changed, so it is kept.
      if (deep) return Infinity;
    }
  }
  return t;
}

// STAM_SWEEP_PROC and STAM_SWEEP_PIDS (a comma list) name the proc root and the only pids to scan, for tests.
// Only a full comma list of positive integers up to PID_MAX counts; anything else (empty, whitespace, a stray comma, garbage) is
// treated as unset, with a warning, so a malformed filter scans every process instead of none.
const PID_MAX = 4194304;
export function pidsOf(env) {
  const v = envVar('SWEEP_PIDS', env);
  if (v === undefined) return null;
  // Each pid is at most Linux's pid_max ceiling, 2^22: a larger number names no process and would filter every one out.
  if (/^[1-9]\d*(,[1-9]\d*)*$/.test(v) && v.split(',').every((p) => Number(p) <= PID_MAX)) return v.split(',');
  console.error(`STAM_SWEEP_PIDS=${JSON.stringify(v)} is not a comma list of pids; scanning every process`);
  return null;
}

// Returns [{ path, action: 'remove' | 'keep', why }]; removes unless `dryRun`.
export function sweep({ hours = 2, reviewHours = 6, dryRun = false, now = Date.now(), env = process.env, claims, agents } = {}) {
  const held = claims ?? claimedPaths(envVar('SWEEP_PROC', env) || '/proc', pidsOf(env));
  const results = [];
  const texts = agents === undefined ? liveAgentTexts(env) : agents;
  const seen = new Set();
  const lists = [
    ...roots(env).map(([root, pattern]) => [root, pattern, hours, false]),
    ...reviewRoots(env).map(([root, pattern]) => [root, pattern, reviewHours, true]),
  ];
  for (const [root, pattern, h, review] of lists) {
    const cutoff = now - h * 3600_000;
    let names = [];
    try {
      // A root that is a symlink would let the sweep reach outside the allowed folders.
      if (!lstatSync(root).isDirectory()) continue;
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names.filter((n) => pattern.test(n) && !(review && n === '.git')).sort()) {
      const path = join(root, name);
      if (seen.has(path)) continue;
      seen.add(path);
      if (NEVER.has(name)) continue;
      let st;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      let real = path;
      try {
        real = realpathSync(path);
      } catch {}
      if (newest(path, review) > cutoff) results.push({ path, action: 'keep', why: `newer than ${h} h` });
      else if (inUse(path, held) || inUse(real, held)) results.push({ path, action: 'keep', why: 'a process uses it' });
      else if (review && !texts) results.push({ path, action: 'keep', why: 'live agents unreadable' });
      else if (review && referenced(path, name, texts)) results.push({ path, action: 'keep', why: 'a live agent names it' });
      else {
        if (!dryRun) removeFolder(path);
        results.push({ path, action: 'remove', why: `older than ${h} h, unused` });
      }
    }
  }
  return results;
}

// Caches that fill the disk (S-1965): the deps caches and the database backups. Never uv or bai2: only
// these folders. A deps entry is KEY, 16 hex digits; deploy's own prune handles .tmp- and .damaged- ones.
export const KEEP_UNUSED_DEPS = 3;
export const KEEP_BACKUPS = 2;
const DEPS_KEY = /^[0-9a-f]{16}$/;

// The keys main's lockfiles name now (S-1044 depsKey for STAM_HOME/deps, gate.mjs for the gate cache),
// for the dev and non-dev installs, so the entry a next link needs is never pruned.
export function currentKeys(mainDir) {
  const keys = new Set();
  for (const dir of ['', 'web']) {
    const abs = join(mainDir, dir);
    const pkg = join(abs, 'package.json');
    const lock = join(abs, 'package-lock.json');
    if (!existsSync(pkg)) continue;
    const tail = `${process.version} ${process.platform} ${process.arch}`;
    const h = (lockText, extra) => createHash('sha256').update(readFileSync(pkg)).update(lockText).update(extra).digest('hex').slice(0, 16);
    if (existsSync(lock)) for (const dev of [true, false]) keys.add(h(readFileSync(lock), `${dev} ${tail}`));
    keys.add(h(existsSync(lock) ? readFileSync(lock) : '', tail));
  }
  return keys;
}

// A cache entry is in use when its node_modules was hard-linked into a release or worktree (`cp -al`):
// its .package-lock.json then has more than one link. (Same test as find -samefile, without the walk.)
function linkedElsewhere(entry) {
  // No node_modules: nothing to link, so nothing uses it. Any other failure to look is unknown, which keeps the entry.
  try {
    lstatSync(join(entry, 'node_modules'));
  } catch (e) {
    return e?.code !== 'ENOENT';
  }
  try {
    return lstatSync(join(entry, 'node_modules', '.package-lock.json')).nlink > 1;
  } catch {
    return true;
  }
}

function entryTime(entry) {
  let t = lstatSync(entry).mtimeMs;
  for (const m of ['.used', '.ready']) {
    try {
      t = Math.max(t, lstatSync(join(entry, m)).mtimeMs);
    } catch {}
  }
  return t;
}

// Bytes available to the user on the filesystem of `path`: df's number, which counts hard links once.
export function freeBytes(path) {
  const st = statfsSync(path);
  return st.bavail * st.bsize;
}

// Prunes one deps cache: keeps entries in use, entries a process names, `keys` (main's current ones), and the
// newest `keep` of the rest. Returns [{ path, action, why }].
// Selection and the rename of each victim to a hidden .pruned- name happen under the root's exclusive lock
// (scripts/deps-lock.mjs), which every consumer holds shared while it checks and links; busy, or no flock(1),
// prunes nothing. The renamed victims are deleted after the lock is released.
export function pruneDepsCache(root, { keys = new Set(), keep = KEEP_UNUSED_DEPS, claims, dryRun = false } = {}) {
  try {
    if (!lstatSync(root).isDirectory()) return [];
  } catch {
    return [];
  }
  const lock = dryRun ? null : tryExclusive(root);
  if (!dryRun && !lock) return [{ path: root, action: 'keep', why: 'the cache lock is busy or flock is missing' }];
  const out = [];
  const doomed = [];
  try {
    let names = [];
    try {
      names = readdirSync(root).filter((n) => DEPS_KEY.test(n));
    } catch {
      return out;
    }
    const spare = [];
    for (const name of names.sort()) {
      const path = join(root, name);
      let st;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      if (keys.has(name)) out.push({ path, action: 'keep', why: "matches main's lockfiles" });
      else if (linkedElsewhere(path)) out.push({ path, action: 'keep', why: 'linked by a release or worktree, or unreadable' });
      else if (inUse(path, claims)) out.push({ path, action: 'keep', why: 'a process uses it' });
      else spare.push({ path, t: entryTime(path) });
    }
    spare.sort((a, b) => b.t - a.t || a.path.localeCompare(b.path));
    spare.forEach(({ path }, i) => {
      if (i < keep) return out.push({ path, action: 'keep', why: `one of the newest ${keep} unused` });
      let why = `unused and older than the newest ${keep}`;
      if (!dryRun) {
        const hidden = join(root, `.pruned-${path.slice(root.length + 1)}-${process.pid}`);
        try {
          renameSync(path, hidden);
          doomed.push(hidden);
        } catch {
          return out.push({ path, action: 'keep', why: 'could not be set aside' });
        }
      }
      out.push({ path, action: 'remove', why });
    });
  } finally {
    lock?.release();
  }
  // Victims set aside by this run, and any an interrupted run left.
  if (!dryRun) {
    try {
      for (const n of readdirSync(root)) if (/^\.pruned-/.test(n)) doomed.push(join(root, n));
    } catch {}
  }
  for (const d of new Set(doomed)) rmSync(d, { recursive: true, force: true });
  return out;
}

// Keeps the newest `keep` stam.db.bak-* files in `home` (deploy's pre-deploy copies).
export function pruneBackups(home, { keep = KEEP_BACKUPS, claims, dryRun = false } = {}) {
  const out = [];
  let names = [];
  try {
    names = readdirSync(home).filter((n) => n.startsWith('stam.db.bak-'));
  } catch {
    return out;
  }
  const files = [];
  for (const n of names) {
    const path = join(home, n);
    try {
      const st = lstatSync(path);
      if (st.isFile()) files.push({ path, t: st.mtimeMs });
    } catch {}
  }
  files.sort((a, b) => b.t - a.t || b.path.localeCompare(a.path));
  files.forEach(({ path }, i) => {
    if (i < keep) out.push({ path, action: 'keep', why: `one of the newest ${keep} backups` });
    else if (inUse(path, claims)) out.push({ path, action: 'keep', why: 'a process uses it' });
    else {
      if (!dryRun) rmSync(path, { force: true });
      out.push({ path, action: 'remove', why: `older than the newest ${keep} backups` });
    }
  });
  return out;
}

// The roots come from env (STAM_HOME, STAM_GATE_DEPS, STAM_SWEEP_MAIN), so a test names its own. The disk
// gain is the df difference on the stam home, since hard links make du overcount.
export function pruneCaches({ dryRun = false, env = process.env, claims } = {}) {
  const held = claims ?? claimedPaths(envVar('SWEEP_PROC', env) || '/proc', pidsOf(env));
  const home = envVar('HOME', env) || defaultHome();
  const gate = envVar('GATE_DEPS', env) || join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'stam-gate-deps');
  const main = envVar('SWEEP_MAIN', env) || join(homedir(), 'projects/stam2');
  const keys = currentKeys(main);
  let before = null;
  try {
    before = freeBytes(existsSync(home) ? home : homedir());
  } catch {}
  const results = [
    ...pruneDepsCache(join(home, 'deps'), { keys, claims: held, dryRun }),
    ...pruneDepsCache(gate, { keys, claims: held, dryRun }),
    ...pruneBackups(home, { claims: held, dryRun }),
  ];
  let freed = null;
  try {
    if (before != null && !dryRun) freed = freeBytes(existsSync(home) ? home : homedir()) - before;
  } catch {}
  return { results, freed };
}

export function install(env = process.env) {
  const dir = envVar('SWEEP_UNIT_DIR', env) || join(homedir(), '.config/systemd/user');
  mkdirSync(dir, { recursive: true });
  const home = envVar('HOME', env) || defaultHome();
  const UNIT = unitToInstall(dir, NAME, home);
  // A timer outlives the worktree this ran from, so it runs the deployed release's copy (else the main checkout's); and a user unit's PATH
  // lacks ~/.local/bin and node's dir, which `stam` (the live-agent check) needs.
  const checkout = join(homedir(), 'projects/stam2/scripts/sweep-test-homes.mjs');
  const script = unitScript(home, 'scripts/sweep-test-homes.mjs', existsSync(checkout) ? checkout : SELF);
  const path = [dirname(process.execPath), join(homedir(), '.local/bin'), '/usr/local/bin', '/usr/bin', '/bin'].join(':');
  writeFileSync(join(dir, `${UNIT}.service`), ['[Unit]', 'Description=Remove unused, old test homes and review clones (S-428, S-1235)', '', '[Service]', 'Type=oneshot', `Environment=PATH=${path}`, `ExecStart=${process.execPath} --no-warnings ${script}`, ''].join('\n'));
  writeFileSync(join(dir, `${UNIT}.timer`), ['[Unit]', 'Description=Sweep old test homes and review clones every hour (S-428, S-1235)', '', '[Timer]', 'OnCalendar=hourly', 'Persistent=true', `Unit=${UNIT}.service`, '', '[Install]', 'WantedBy=timers.target', ''].join('\n'));
  if (!envVar('SWEEP_UNIT_DIR', env)) spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
  if (!envVar('SWEEP_UNIT_DIR', env)) spawnSync('systemctl', ['--user', 'enable', '--now', `${UNIT}.timer`], { stdio: 'inherit' });
  console.log(`installed ${UNIT}.service and ${UNIT}.timer in ${dir}${envVar('SWEEP_UNIT_DIR', env) ? '; not enabled (test dir)' : ' and enabled the timer'}`);
}

function main(args) {
  const env = { ...process.env };
  let hours = 2;
  let reviewHours = 6;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--install') return install();
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--hours') hours = Number(args[++i]);
    else if (a === '--review-hours') reviewHours = Number(args[++i]);
    else if (a === '--review') setEnvVar('SWEEP_REVIEW', args[++i], env);
    else if (a === '--home-cache') setEnvVar('SWEEP_HOME_CACHE', args[++i], env);
    else if (a === '--tmp') setEnvVar('SWEEP_TMP', args[++i], env);
    else if (a === '--cache') setEnvVar('SWEEP_CACHE', args[++i], env);
    else {
      console.error('usage: node scripts/sweep-test-homes.mjs [--dry-run] [--hours N] [--review-hours N] [--review DIR] [--home-cache DIR] [--tmp DIR] [--cache DIR] [--install]');
      process.exit(2);
    }
  }
  if (!(hours >= 0) || !(reviewHours >= 0)) {
    console.error('--hours needs a number');
    process.exit(2);
  }
  const show = (r) => console.log(`${r.action === 'remove' && dryRun ? 'would remove' : r.action === 'remove' ? 'removed' : 'kept'} ${r.path} (${r.why})`);
  for (const r of sweep({ hours, reviewHours, dryRun, env })) show(r);
  const { results, freed } = pruneCaches({ dryRun, env });
  for (const r of results) show(r);
  if (freed != null && results.some((r) => r.action === 'remove')) console.log(`freed ${(freed / 2 ** 20).toFixed(0)} MiB on the stam disk (df)`);
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
