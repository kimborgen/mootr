#!/usr/bin/env node
// The story check (S-648): keeps the component storybook (docs/stories.md) current. A static check,
// git diff plus regex over source, with no build and no browser.
//   node scripts/story-check.mjs BASE HEAD            the PR body's `Stories:` line comes from STORY_CHECK_BODY
//   STORY_CHECK_MODE=exempt|structural                run only the per-PR exemption or only the global checks (S-830)
//   node scripts/story-check.mjs --pending            prints every component with no story; the rollout
//                                                     is over, so this is empty (S-1096), and a file
//                                                     that appears here needs a story
// It fails when
//   1. an added or changed component file exports a component no story's `code` lists,
//   2. a story's `code` link doesn't resolve (checked for every story, not only changed ones),
//   3. a component file changed but the stories that cover it didn't, unless the PR body has
//      `Stories: unchanged, REASON` (or `unchanged: REASON`, `unchanged. REASON`, `unchanged for X`; S-914),
//      or `Stories: X updated; unchanged for Y, REASON` (S-1964). The PR's own changes are the diff from the
//      merge base of BASE and HEAD, so a branch behind BASE isn't blamed for BASE's changes (S-1818).
//   4. a motion file changed with no web/check/*.mjs browser check in the PR, unless the PR body has
//      `Motion check: none, REASON` (S-1281). Runs in the per-PR modes only, since it needs the PR's body.
// Stories, tests, and web/src/stories/** are never components.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = 'web/src/';
const STORY_FILE = /\.stories\.tsx$/;
const isSource = (p) => p.startsWith(SRC) && /\.tsx$/.test(p);
const isStories = (p) => STORY_FILE.test(p) || /\.test\.tsx?$/.test(p) || p.startsWith('web/src/stories/');
export const isComponentFile = (p) => isSource(p) && !isStories(p);

const LINK = /['"`](web\/src\/[\w./-]+\.tsx?)#(\w+)['"`]/g;
// A code list is an array literal in the code (S-824): a story's `code:` array, or the same list
// passed positionally, as the `block(...)` helper of mailblocks.stories.tsx does. Every string in it
// is one bare symbol name or one path#Symbol, so prose never is one: a path named inside `what`,
// `when` or `rules` claims nothing, even when it sits in brackets (S-685).
const isCodeToken = (s) => /^web\/src\/[\w./-]+\.tsx?#\w+$/.test(s) || /^[A-Za-z_$][\w$]*$/.test(s);
const linksIn = (src) => [...src.matchAll(LINK)].map((m) => ({ file: m[1], symbol: m[2] }));

// The string literals and the brackets that are really code. A `[` inside a string or a comment is
// not a bracket: reading one as an array let a bracketed path#Symbol in prose count as coverage,
// which would let an unstoried component pass (S-824 review). A scanner, not a parser: the sources
// here are TSX, and this only has to be right about strings, comments and brackets.
function scan(src) {
  const strings = [];
  const brackets = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); i = n < 0 ? src.length : n; continue; }
    if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); i = n < 0 ? src.length : n + 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const start = i++;
      let value = '';
      while (i < src.length) {
        if (src[i] === '\\') { value += src[i + 1] ?? ''; i += 2; continue; }
        if (src[i] === c) { i++; break; }
        value += src[i++];
      }
      strings.push({ start, end: i, value });
      continue;
    }
    if (c === '[' || c === ']') brackets.push({ index: i, char: c });
    i++;
  }
  return { strings, brackets };
}

// Every flat array literal whose strings are all code tokens: a `[` whose next bracket is its own
// `]`. Each is returned as its strings' source, quotes included, for the link regex.
export function codeLists(src) {
  const { strings, brackets } = scan(src);
  const out = [];
  for (let i = 0; i < brackets.length - 1; i++) {
    const [open, close] = [brackets[i], brackets[i + 1]];
    if (open.char !== '[' || close.char !== ']') continue;
    const inside = strings.filter((s) => s.start > open.index && s.end <= close.index);
    if (inside.length && inside.every((s) => isCodeToken(s.value))) out.push(inside.map((s) => src.slice(s.start, s.end)));
  }
  return out;
}

export const codeLinks = (src) => {
  const out = codeLists(src).flatMap((strings) => strings.flatMap((s) => linksIn(s)));
  return out.filter((l, i) => out.findIndex((x) => x.file === l.file && x.symbol === l.symbol) === i);
};
// PascalCase with at least one lowercase letter, so ALL_CAPS constants don't count.
const COMPONENT = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?|const|class)\s+([A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*)\b(.*)/gm;

// The components a source file exports.
export function exportedComponents(src) {
  // A context (`export const X = createContext(...)`) is state, not a component.
  return [...src.matchAll(COMPONENT)].filter((m) => !/^\s*(?::[^=]*)?=\s*(?:React\.)?createContext\b/.test(m[2])).map((m) => m[1]);
}

const declares = (src, name) => new RegExp(`\\b(function|const|let|class|interface|type)\\s+${name}\\b`).test(src);

// The first Stories line of a PR body that claims unchanged stories (a bullet counts too), or undefined. It is
// `Stories: unchanged`, or a line that names updated stories and then the unchanged ones, `Stories: X updated;
// unchanged for Y, because …` (S-1964). pr_open reads it to refuse a malformed one up front (S-914).
const UNCHANGED_LINE = /^Stories:\s*unchanged\b|^Stories:.*\bupdated\b.*\bunchanged\b/;
export function storiesUnchangedLine(body) {
  return String(body ?? '').split(/\r?\n/).map((l) => l.trim().replace(/^[-*]\s+/, '')).find((l) => UNCHANGED_LINE.test(l));
}

// The accepted form (S-914): `unchanged`, then a separator, then a reason that doesn't start with one.
// `,` `:` `;` `—` may touch the reason; `.` and `-` need a space after them, so `unchanged.md` and
// `unchanged-ish` are refused. A bare `unchanged` has no reason, and `mostly unchanged` isn't the line.
export function storiesUnchanged(body) {
  const line = storiesUnchangedLine(body);
  return line !== undefined && /^unchanged(?:\s*[,:;]\s*|\s*[.—-]\s+|\s*—\s*|\s+for\s+)[^\s,:;.—-]/.test(line.slice(line.search(/\bunchanged\b/)));
}

// The form a refused Stories line is shown next to, so a developer can copy it (S-914).
export const STORIES_FORM = 'Stories: unchanged, REASON';

// The motion files (S-1281): every web/src/system file that isn't a test or a story, and the sidebar and
// row flip and motion hooks. Kept here so the list is easy to change. Motion files are not all components
// (system.css, flights.ts), so this doesn't use isComponentFile.
// No system-view owner is active, so this list was set without one; change it when one is.
export const MOTION_FILES = ['web/src/sidebar-flip.tsx', 'web/src/sidebar-motion.tsx', 'web/src/row-flip.ts', 'web/src/useMotion.ts'];
export const isMotionFile = (p) => (p.startsWith('web/src/system/') && !/\.(test|stories)\./.test(p)) || MOTION_FILES.includes(p);
// A browser check is a web/check/*.mjs file directly in web/check (S-1281).
const isBrowserCheck = (p) => /^web\/check\/[^/]+\.mjs$/.test(p);

// The form a refused Motion check line is shown next to (S-1281), and the accepted line: `none`, a comma,
// then a reason that doesn't start with a separator, as for `Stories: unchanged`. A bullet counts too.
export const MOTION_FORM = 'Motion check: none, REASON';
export function motionExempt(body) {
  return String(body ?? '').split(/\r?\n/).map((l) => l.trim().replace(/^[-*]\s+/, '')).some((l) => /^Motion check:\s*none\s*,\s*[^\s,:;.—-]/.test(l));
}

// The pure check. FILES maps every web/src .ts/.tsx path at HEAD to its source; CHANGED lists the
// added or changed paths; RENAMES maps a renamed file's new path to its old one. Returns the failure
// messages (none: it passes).
// MODE splits the check (S-830) so a merge train can run it per PR and on its tip: 'full' (the default)
// runs everything, 'exempt' runs only the per-PR rules (3 and 4, which need the PR's body), and 'structural'
// runs only the checks that are about the tree as a whole (rules 1 and 2). gate.mjs runs 'exempt' per PR.
// 'branch' (S-1942) is 'exempt' plus rule 1 for the components the PR adds or changes only: what pr_open
// refuses before a push, without blaming the base's own components.
export function checkStories({ files, changed, body, renames = {}, mode = 'full' }) {
  const structural = mode !== 'exempt' && mode !== 'branch';
  const ownStructure = structural || mode === 'branch';
  const exempt = mode !== 'structural';
  const errors = [];
  const links = []; // { story, file, symbol }
  for (const [story, src] of Object.entries(files)) {
    if (!STORY_FILE.test(story)) continue;
    for (const l of codeLinks(src)) links.push({ story, ...l });
  }
  if (structural) for (const l of links) {
    const src = files[l.file];
    if (src === undefined) errors.push(`${l.story}: the code link ${l.file}#${l.symbol} names a file that doesn't exist. Fix the path in the story's code list.`);
    else if (!declares(src, l.symbol)) errors.push(`${l.story}: the code link ${l.file}#${l.symbol} names a symbol ${l.file} doesn't declare. Rename the link or remove it.`);
  }
  const listed = (file, symbol) => links.some((l) => l.file === file && (symbol === undefined || l.symbol === symbol));
  const storiesFor = (file) => [...new Set(links.filter((l) => l.file === file).map((l) => l.story))];

  const unchangedOk = storiesUnchanged(body);
  for (const p of changed) {
    if (!isComponentFile(p) || files[p] === undefined) continue;
    const missing = exportedComponents(files[p]).filter((c) => !listed(p, c));
    if (ownStructure) {
      for (const c of missing) {
        errors.push(`${p}: the component ${c} has no story. Add a story whose code lists '${p}#${c}' to ${p.replace(/\.tsx$/, '.stories.tsx')} (docs/stories.md).`);
      }
    }
    if (exempt) {
      const covering = storiesFor(p);
      if (!missing.length && covering.length && !unchangedOk && !covering.some((s) => changed.includes(s))) {
        errors.push(`${p} changed but its stories (${covering.join(', ')}) didn't. Update them (What, When, Rules, states), or add a line 'Stories: unchanged, REASON' to the PR body.`);
      }
    }
  }
  if (exempt) {
    // A Stories line that claims unchanged stories needs its reason (S-914), when a component changed: a PR that
    // changes no component passes the stories step whatever its line says. pr_open runs this same check (S-1942).
    const claim = storiesUnchangedLine(body);
    if (claim !== undefined && changed.some(isComponentFile) && !storiesUnchanged(body)) errors.push(`the Stories line "${claim}" needs a reason: write it as ${STORIES_FORM} (docs/pull-requests.md)`);
    // Rule 4 (S-1281): a motion change needs a browser check in the same PR, or the PR's own exemption.
    const motion = changed.filter(isMotionFile);
    if (motion.length && !changed.some(isBrowserCheck) && !motionExempt(body)) {
      errors.push(`motion files changed (${motion.join(', ')}) with no web/check/*.mjs browser check; add one or put "${MOTION_FORM}" in the PR body`);
    }
  }
  return errors;
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

// The merge base of BASE and HEAD (BASE itself when they have none in common), so the diff below is the PR's own (S-1818).
function mergeBase(base, head, cwd) {
  const r = spawnSync('git', ['merge-base', base, head], { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : base;
}

// Reads HEAD's web/src sources and the paths changed from the merge base of BASE and HEAD to HEAD, in the repo at CWD.
export function checkRange(base, head, { cwd = ROOT, body = '', mode = 'full' } = {}) {
  const names = (a) => git(a, cwd).split('\n').filter(Boolean);
  const from = mergeBase(base, head, cwd);
  const paths = names(['ls-tree', '-r', '--name-only', head, '--', SRC]).filter((p) => /\.tsx?$/.test(p));
  const files = {};
  for (const p of paths) files[p] = git(['show', `${head}:${p}`], cwd);
  const changed = names(['diff', '--name-only', '--no-renames', '--diff-filter=AM', from, head]);
  const renames = {};
  for (const l of names(['diff', '--name-status', '-M', '--diff-filter=R', from, head])) {
    const [, from, to] = l.split('\t');
    renames[to] = from;
  }
  return checkStories({ files, changed, body, renames, mode });
}

// checkRange without blocking, for pr_open on the ITSA home, where the daemon must keep answering (S-1942). The
// same rules run on the same reads: git runs as child processes, each with a timeout, and a call that runs past
// it rejects with `timedOut` set, so the caller can refuse with a clear message rather than pass silently.
function gitAsync(args, { cwd, input, timeoutMs }) {
  return new Promise((resolveRun, reject) => {
    const child = spawn('git', args, { cwd });
    const out = [];
    const err = [];
    const timer = setTimeout(() => {
      child.kill();
      const e = new Error(`git ${args[0]} timed out after ${timeoutMs / 1000} s`);
      e.timedOut = true;
      reject(e);
    }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    // A child that exits before its input is read is a broken pipe here; its exit code is the failure, so ignore it.
    child.stdin.on('error', () => {});
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun(Buffer.concat(out));
      else reject(new Error(`git ${args.join(' ')} failed: ${Buffer.concat(err).toString().trim()}`));
    });
    child.stdin.end(input ?? '');
  });
}

// The blobs `head:PATH` for each path, read in one `git cat-file --batch` (the output is `OID TYPE SIZE`, the content, a newline).
function blobsOf(buf, paths) {
  const files = {};
  let i = 0;
  for (const p of paths) {
    const nl = buf.indexOf(0x0a, i);
    const [, type, size] = buf.toString('utf8', i, nl).split(' ');
    if (type === 'missing') throw new Error(`git cat-file: ${p} is missing`);
    i = nl + 1;
    files[p] = buf.toString('utf8', i, i + Number(size));
    i += Number(size) + 1;
  }
  return files;
}

export async function checkRangeAsync(base, head, { cwd = ROOT, body = '', mode = 'full', timeoutMs = 30_000 } = {}) {
  const text = (args, input) => gitAsync(args, { cwd, input, timeoutMs }).then((b) => b.toString('utf8'));
  const names = async (a) => (await text(a)).split('\n').filter(Boolean);
  // As mergeBase: BASE itself when the two share no history (S-1818).
  const from = await text(['merge-base', base, head]).then((s) => s.trim() || base, (e) => { if (e.timedOut) throw e; return base; });
  const paths = (await names(['ls-tree', '-r', '--name-only', head, '--', SRC])).filter((p) => /\.tsx?$/.test(p));
  const files = blobsOf(await gitAsync(['cat-file', '--batch'], { cwd, input: paths.map((p) => `${head}:${p}\n`).join(''), timeoutMs }), paths);
  const changed = await names(['diff', '--name-only', '--no-renames', '--diff-filter=AM', from, head]);
  const renames = {};
  for (const l of await names(['diff', '--name-status', '-M', '--diff-filter=R', from, head])) {
    const [, old, now] = l.split('\t');
    renames[now] = old;
  }
  return checkStories({ files, changed, body, renames, mode });
}

// Every component file with no story, for `node scripts/story-check.mjs --pending` (S-1096). The
// rollout that list tracked is over, so on a current tree this is empty; a file it does name needs
// a story of its own.
export function pendingList(cwd = ROOT) {
  const paths = git(['ls-files', SRC], cwd).split('\n').filter((p) => /\.tsx?$/.test(p));
  const files = Object.fromEntries(paths.map((p) => [p, readFileSync(resolve(cwd, p), 'utf8')]));
  const covered = new Set();
  for (const [p, src] of Object.entries(files)) if (STORY_FILE.test(p)) for (const l of codeLinks(src)) covered.add(l.file);
  return paths.filter((p) => isComponentFile(p) && !covered.has(p) && exportedComponents(files[p]).length > 0).sort();
}

function cli(args) {
  if (args[0] === '--pending') {
    console.log(JSON.stringify(pendingList(), null, 2));
    return;
  }
  if (args.length !== 2) {
    console.error('usage: node scripts/story-check.mjs BASE HEAD   (PR body in STORY_CHECK_BODY)');
    process.exit(2);
  }
  // The script's own repo, not the cwd's: run from another checkout it must not check that one (S-1300).
  const errors = checkRange(args[0], args[1], { cwd: ROOT, body: process.env.STORY_CHECK_BODY ?? '', mode: process.env.STORY_CHECK_MODE ?? 'full' });
  for (const e of errors) console.error(`story-check: ${e}`);
  if (errors.length) process.exit(1);
  console.log('story-check: ok');
}

if (isMain()) cli(process.argv.slice(2));

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
