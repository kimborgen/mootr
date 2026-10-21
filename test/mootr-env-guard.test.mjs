#!/usr/bin/env node
// Guard for the test env scrub (S-3140). A reader takes MOOTR_X before STAM_X (src/env.ts), so a test that starts the CLI or a
// daemon, or sets its own STAM_HOME, must first drop the names a stam agent's environment carries, both MOOTR_ and STAM_, or a
// stray one reaches the live home. A node test imports test/tmphome.mjs or test/scrub-env.mjs; a shell test sources test/lib.sh;
// a Go test package that runs node calls testenv.Scrub (go/internal/testenv). Free: `node --test test/mootr-env-guard.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { withMootrTwins } from '../src/env.ts';
import { SCRUBBED } from './scrub-env.mjs';

const ROOT = join(import.meta.dirname, '..');
const code = (text) => text.split('\n').filter((l) => !/^\s*(\/\/|#|\*)/.test(l)).join('\n');

// A node file touches a home when it sets STAM_HOME in the process, or runs the CLI or a daemon as a child.
const NODE_HOME = /process\.env\.STAM_HOME\s*=(?!=)/;
const NODE_SPAWN = /(?<![\w.])(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\(/;
const NODE_TARGET = /cli\.ts|stam-fast|bin\/stamd?\b|daemon\.ts|scripts\/|process\.execPath|\.\.\.process\.env/;
// An import of a scrubbing helper, or a real delete of a MOOTR_ name: a file that only names MOOTR_ (a sentinel, a comment) doesn't scrub.
const NODE_SCRUB = /(from|import) '\.\/(tmphome|scrub-env)\.mjs'|delete\s+[\w.]+\[[^\]]*MOOTR_|withMootrTwins\(/;
export function nodeUnscrubbed(text) {
  const c = code(text);
  const touches = NODE_HOME.test(c) || (NODE_SPAWN.test(c) && NODE_TARGET.test(c));
  return touches && !NODE_SCRUB.test(c);
}
// A shell file touches a home when it sets STAM_HOME or runs a daemon; lib.sh scrubs.
export function shUnscrubbed(text) {
  const c = code(text);
  return /^\s*(export\s+)?STAM_HOME=|^\s*\S*stam\S* daemon run|^\s*\S*bin\/stamd(\s|$)/m.test(c) && !/lib\.sh|unset[^\n]*MOOTR_|MOOTR_[^\n]*\bunset\b/.test(c);
}
// A Go test package runs node when a test file does; one of its files must call testenv.Scrub.
export function goUnscrubbed(files) {
  return files.some((t) => /exec\.Command\("node"/.test(t)) && !files.some((t) => /testenv\.Scrub\(\)/.test(t));
}

function walk(dir, keep) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, keep));
    else if (keep(name)) out.push(p);
  }
  return out;
}
const rel = (p) => p.slice(ROOT.length + 1);

test('a node test that touches a home or spawns the CLI or a daemon scrubs both env names first', () => {
  const files = [...walk(join(ROOT, 'test'), (n) => n.endsWith('.mjs')), ...walk(join(ROOT, 'web/check'), (n) => n.endsWith('.mjs'))]
    .filter((f) => !f.endsWith('test/tmphome.mjs') && !f.endsWith('test/scrub-env.mjs') && !/test\/(mootr-[a-z-]+|tmphome)\.test\.mjs$/.test(f) && !f.endsWith('web/check/chromium-lock.mjs'));
  // Exempt: the tests of the scrubbers themselves (they set sentinels on purpose), and chromium-lock.mjs, which only re-runs a
  // check under the lock with the env its parent gave it (STAM_URL and the rest must survive).
  assert.deepEqual(files.filter((f) => nodeUnscrubbed(readFileSync(f, 'utf8'))).map(rel), []);
});

test('a shell test that sets a home or runs a daemon sources test/lib.sh', () => {
  const files = [...walk(join(ROOT, 'test'), (n) => n.endsWith('.sh')), ...walk(join(ROOT, 'web/check'), (n) => n.endsWith('.sh'))]
    .filter((f) => !f.endsWith('test/lib.sh'));
  assert.deepEqual(files.filter((f) => shUnscrubbed(readFileSync(f, 'utf8'))).map(rel), []);
});

test('a Go test package that runs node calls testenv.Scrub', () => {
  const dirs = new Map();
  for (const f of walk(join(ROOT, 'go'), (n) => n.endsWith('_test.go'))) {
    const d = dirname(f);
    dirs.set(d, [...(dirs.get(d) ?? []), readFileSync(f, 'utf8')]);
  }
  assert.deepEqual([...dirs].filter(([, files]) => goUnscrubbed(files)).map(([d]) => rel(d)), []);
});

test('the guard fails a test that skips the scrub', () => {
  const spawnsCli = "import { spawnSync } from 'node:child_process';\nspawnSync(process.execPath, [join(ROOT, 'src/cli.ts'), 'prune']);\n";
  assert.equal(nodeUnscrubbed(spawnsCli), true, 'a CLI spawn with no scrub');
  assert.equal(nodeUnscrubbed("process.env.STAM_HOME = mkdtempSync('x');\n"), true, 'a home with no scrub');
  assert.equal(nodeUnscrubbed("import './scrub-env.mjs';\n" + spawnsCli), false, 'scrub-env');
  assert.equal(nodeUnscrubbed("import { tempHome } from './tmphome.mjs';\n" + spawnsCli), false, 'tmphome');
  assert.equal(nodeUnscrubbed("spawnSync(process.execPath, [join(ROOT, 'scripts/sweep-test-homes.mjs')], { env: { ...process.env, STAM_HOME: h } });\n"), true, 'a scripts/ spawn with the parent env');
  assert.equal(nodeUnscrubbed("const SENTINEL = { MOOTR_HOME: '/x' };\nspawnSync(process.execPath, ['x.mjs']);\n"), true, 'naming MOOTR_ is not a scrub');
  assert.equal(nodeUnscrubbed("for (const k of ks) delete process.env[`MOOTR_${k}`];\nspawnSync(process.execPath, ['x.mjs']);\n"), false, 'an explicit delete scrubs');
  assert.equal(nodeUnscrubbed('// spawnSync(cli.ts)\nconst x = 1;\n'), false, 'a comment is not a spawn');
  assert.equal(shUnscrubbed('stam daemon run &\n'), true);
  assert.equal(shUnscrubbed('# MOOTR_HOME\nstam daemon run &\n'), true, 'naming MOOTR_ is not a scrub');
  assert.equal(shUnscrubbed('. ./test/lib.sh\nstam daemon run &\n'), false);
  assert.equal(goUnscrubbed(['exec.Command("node", "x.mjs")']), true);
  assert.equal(goUnscrubbed(['exec.Command("node", "x.mjs")', 'func init() { testenv.Scrub() }']), false);
});

test('scrub-env drops every live-reaching name in both spellings, and nothing else', () => {
  assert.deepEqual(withMootrTwins(['STAM_HOME']), ['STAM_HOME', 'MOOTR_HOME']);
  for (const n of ['HOME', 'PORT', 'URL', 'TOKEN', 'MACHINE']) {
    assert.ok(SCRUBBED.includes(`STAM_${n}`) && SCRUBBED.includes(`MOOTR_${n}`), `${n} is scrubbed under both names`);
  }
  assert.ok(!SCRUBBED.includes('STAM_EMBEDDER'));
});

test('a node child that imports scrub-env sees none of the names, and no value reaches the output', () => {
  const out = execChild();
  assert.equal(out, 'HOME=- PORT=- URL=- TOKEN=- MACHINE=- | E=kept');
  assert.ok(!out.includes('live-secret'));
});
import { execFileSync } from 'node:child_process';
function execChild() {
  const env = { PATH: process.env.PATH };
  for (const k of SCRUBBED) env[k] = 'live-secret';
  env.STAM_EMBEDDER = 'kept';
  return execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e',
    `await import(${JSON.stringify(join(ROOT, 'test/scrub-env.mjs'))});` +
    "const g = (n) => (process.env['STAM_' + n] ?? process.env['MOOTR_' + n] ?? '-');" +
    "console.log(['HOME','PORT','URL','TOKEN','MACHINE'].map((n) => n + '=' + g(n)).join(' ') + ' | E=' + process.env.STAM_EMBEDDER);"],
  { env, encoding: 'utf8' }).trim();
}
