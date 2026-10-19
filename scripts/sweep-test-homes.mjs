#!/usr/bin/env node
// Sweeps test leftovers off a machine (S-428): the /tmp/stam-* folders (a /tmp that is RAM, so
// each one costs memory) and the stam-test.* homes under ~/.cache/stam-test that are older than
// N hours and that no process uses. It kills nothing and touches nothing it can't prove is idle.
//   node scripts/sweep-test-homes.mjs                  remove them (default: older than 2 hours)
//   node scripts/sweep-test-homes.mjs --dry-run        print what it would remove or keep, remove nothing
//   node scripts/sweep-test-homes.mjs --hours 6        older than 6 hours
//   node scripts/sweep-test-homes.mjs --review-hours 6 the review folders' age (default 6; see below)
//   node scripts/sweep-test-homes.mjs --install        write stam-sweep-test-homes.service and .timer, and enable the timer
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
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const UNIT = 'stam-sweep-test-homes';

// The prefixes test/*.mjs gives its temporary folders: tempHome('PREFIX-'), tempDir('PREFIX-') (the
// S-668 helper), and mkdtemp(Sync)(join(tmpdir(), 'PREFIX-')). They are read from the sources at
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
const TEMP_HELPERS = new Set(['tempHome', 'tempDir', 'mkdtemp', 'mkdtempSync']);
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
      if (t.value === 'tempHome' || t.value === 'tempDir') {
        // tempHome(LITERAL) or tempDir(LITERAL): the literal is the whole argument, so `)` closes the call right after.
        if (ts[i + 3]?.kind === 'p' && ts[i + 3].value === ')') prefix = literalPrefix(ts[i + 2]);
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
  const cache = env.STAM_SWEEP_CACHE || join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'stam-test');
  return [
    [env.STAM_SWEEP_TMP || '/tmp', TMP_PATTERN],
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
    [env.STAM_SWEEP_REVIEW || join(cacheHome, 'stam-review'), dirName],
    [env.STAM_SWEEP_CACHE || join(cacheHome, 'stam-test'), dirName],
    [env.STAM_SWEEP_HOME_CACHE || cacheHome, /^review-[\w.-]+$/],
  ];
}

// The text live agents hold: name, cwd, workspace, first prompt. null when it can't be read.
export function liveAgentTexts(env = process.env) {
  try {
    if (env.STAM_SWEEP_AGENTS) return JSON.parse(readFileSync(env.STAM_SWEEP_AGENTS, 'utf8')).map((a) => JSON.stringify(a));
    const bin = env.STAM_BIN || 'stam';
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

function readText(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

// What every process names, once per run: its cwd, open files, environment values, and arguments.
export function claimedPaths(procDir = '/proc') {
  const out = [];
  let names = [];
  try {
    names = readdirSync(procDir);
  } catch {}
  for (const n of names) {
    if (!/^\d+$/.test(n) || Number(n) === process.pid) continue;
    const base = join(procDir, n);
    try {
      out.push(readlinkSync(join(base, 'cwd')));
    } catch {}
    try {
      for (const fd of readdirSync(join(base, 'fd'))) {
        try {
          out.push(readlinkSync(join(base, 'fd', fd)));
        } catch {}
      }
    } catch {}
    for (const kv of readText(join(base, 'environ')).split('\0')) out.push(kv.slice(kv.indexOf('=') + 1));
    out.push(...readText(join(base, 'cmdline')).split('\0'));
  }
  return out.filter((p) => p.includes('/'));
}

// Whether any claimed path is `dir` or inside it, or a longer string that holds `dir/` (a shell
// command line, or a list of paths).
export function inUse(dir, claims) {
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

// Returns [{ path, action: 'remove' | 'keep', why }]; removes unless `dryRun`.
export function sweep({ hours = 2, reviewHours = 6, dryRun = false, now = Date.now(), env = process.env, claims, agents } = {}) {
  const held = claims ?? claimedPaths();
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

export function install(env = process.env) {
  const dir = env.STAM_SWEEP_UNIT_DIR || join(homedir(), '.config/systemd/user');
  mkdirSync(dir, { recursive: true });
  // A timer outlives the worktree this ran from, so it runs the deployed release's copy (else the main checkout's); and a user unit's PATH
  // lacks ~/.local/bin and node's dir, which `stam` (the live-agent check) needs.
  const candidates = [join(homedir(), '.local/share/stam/releases/current/scripts/sweep-test-homes.mjs'), join(homedir(), 'projects/stam2/scripts/sweep-test-homes.mjs')];
  const script = candidates.find((c) => existsSync(c)) ?? SELF;
  const path = [dirname(process.execPath), join(homedir(), '.local/bin'), '/usr/local/bin', '/usr/bin', '/bin'].join(':');
  writeFileSync(join(dir, `${UNIT}.service`), ['[Unit]', 'Description=Remove unused, old test homes and review clones (S-428, S-1235)', '', '[Service]', 'Type=oneshot', `Environment=PATH=${path}`, `ExecStart=${process.execPath} --no-warnings ${script}`, ''].join('\n'));
  writeFileSync(join(dir, `${UNIT}.timer`), ['[Unit]', 'Description=Sweep old test homes and review clones every hour (S-428, S-1235)', '', '[Timer]', 'OnCalendar=hourly', 'Persistent=true', `Unit=${UNIT}.service`, '', '[Install]', 'WantedBy=timers.target', ''].join('\n'));
  if (!env.STAM_SWEEP_UNIT_DIR) spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
  if (!env.STAM_SWEEP_UNIT_DIR) spawnSync('systemctl', ['--user', 'enable', '--now', `${UNIT}.timer`], { stdio: 'inherit' });
  console.log(`installed ${UNIT}.service and ${UNIT}.timer in ${dir}${env.STAM_SWEEP_UNIT_DIR ? '; not enabled (test dir)' : ' and enabled the timer'}`);
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
    else if (a === '--review') env.STAM_SWEEP_REVIEW = args[++i];
    else if (a === '--home-cache') env.STAM_SWEEP_HOME_CACHE = args[++i];
    else if (a === '--tmp') env.STAM_SWEEP_TMP = args[++i];
    else if (a === '--cache') env.STAM_SWEEP_CACHE = args[++i];
    else {
      console.error('usage: node scripts/sweep-test-homes.mjs [--dry-run] [--hours N] [--review-hours N] [--review DIR] [--home-cache DIR] [--tmp DIR] [--cache DIR] [--install]');
      process.exit(2);
    }
  }
  if (!(hours >= 0) || !(reviewHours >= 0)) {
    console.error('--hours needs a number');
    process.exit(2);
  }
  for (const r of sweep({ hours, reviewHours, dryRun, env })) console.log(`${r.action === 'remove' && dryRun ? 'would remove' : r.action === 'remove' ? 'removed' : 'kept'} ${r.path} (${r.why})`);
}

// import.meta.url is the real path; argv[1] is as typed, so a symlinked checkout would run nothing.
const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) main(process.argv.slice(2));
