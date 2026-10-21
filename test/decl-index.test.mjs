#!/usr/bin/env node
// Go to declaration's index (S-1532, src/decl.ts): declarations per kind and language, ranking, denied and generated
// files skipped, the cache per sha, the human-only check, unknown repos and shas, and a checkout file's HEAD.
// Temp git repos, no network, no daemon: `node --test test/decl-index.test.mjs`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome, tempDir, tempDirOutside } from './tmphome.mjs';

const stamHome = tempHome('stam-decl-');
const root = tempDir('stam-decl-repos-');
process.env.STAM_HOME = stamHome;
process.env.STAM_MACHINE = 'decl-test-box';
process.env.HOME = tempDir('stam-decl-home-');
const checkout = join(root, 'checkout');
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
const put = (rel, content) => {
  mkdirSync(join(checkout, rel, '..'), { recursive: true });
  writeFileSync(join(checkout, rel), content);
};
const commit = (msg) => (git(checkout, 'add', '-A'), git(checkout, 'commit', '-q', '-m', msg), git(checkout, 'rev-parse', 'HEAD').trim());
let s, d, sha1, sha2, wt, wtSha, otherWt;

const ask = (q, human = true, wait) => d.request(human, new URLSearchParams(q), wait);
const fails = async (q, status, human = true) => {
  await assert.rejects(ask(q, human), (e) => (assert.ok(e instanceof d.DeclError, String(e)), assert.equal(e.status, status, e.message), true));
};
const names = (body) => body.matches.map((m) => `${m.path}:${m.line}:${m.kind}`);

before(async () => {
  s = await import('../src/settings.ts');
  d = await import('../src/decl.ts');
  git(root, 'init', '-q', '-b', 'main', checkout);
  put('src/app.ts', [
    "import { helper } from './util.js';",
    'export function start() { return helper(); }',
    'export class Server { listen() {} #secret() {} }',
    'interface Opts { port: number }',
    'type Id = string;',
    'enum Mode { A, B }',
    'const LIMIT = 1, other = (x: number) => x;',
    'let counter = 0;',
    'var legacy = 1;',
    'export { LIMIT as MAX };',
    'function shared() {}',
    '',
  ].join('\n'));
  put('src/util.ts', 'export function helper() { return 1 }\nexport function shared() {}\n');
  put('src/view.tsx', 'export function Panel() { return <div /> }\nexport function shared() {}\n');
  put('lib/far.js', 'export function shared() {}\n');
  put('lib/jsx.jsx', 'export const Button = () => <b />\n');
  put('py/mod.py', 'import os.path as osp, py.base\nfrom .base import Base\n\ndef run(x):\n    return x\n\nclass Job(Base):\n    def go(self):\n        pass\n\nRETRIES = 3\n');
  put('py/base.py', 'class Base:\n    pass\n');
  put('rs/lib.rs', 'pub fn parse() {}\nstruct Token { a: i32 }\ntrait Lex { fn lex(&self); }\nimpl Token { fn len(&self) {} }\n');
  put('go/main.go', 'package main\nfunc Serve() {}\ntype Conf struct { a int }\nconst Port = 1\n');
  put('.env.ts', 'export const SECRET_NAME = 1;\n');
  put('conf/.ssh/hosts.ts', 'export const KEYED = 1;\n');
  put('dist/bundle.js', 'export function bundled() {}\n');
  put('node_modules/pkg/index.js', 'export function fromDeps() {}\n');
  put('web/app.min.js', 'function minified() {}\n');
  put('big/huge.ts', 'export const HUGE = 1;\n' + '// x\n'.repeat(300_000));
  writeFileSync(join(checkout, 'bin.ts'), Buffer.concat([Buffer.from('export const BIN = 1;\n'), Buffer.from([0, 1, 2])]));
  put('docs/notes.md', '# shared\n');
  sha1 = commit('one');
  put('src/util.ts', 'export function helper() { return 2 }\nexport function shared() {}\nexport function added() {}\n');
  sha2 = commit('two');
  // A linked worktree of the checkout, where the agents' trees live (S-2101), and a worktree of a repo that
  // is not configured, to prove the git linkage (not a name) decides.
  wt = join(stamHome, 'worktrees', 'checkout-wt');
  mkdirSync(join(stamHome, 'worktrees'), { recursive: true });
  git(checkout, 'worktree', 'add', '-q', '-b', 'wt', wt);
  writeFileSync(join(wt, 'src', 'wt.ts'), 'export function fromWorktree() { return 1 }\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'wt');
  wtSha = git(wt, 'rev-parse', 'HEAD').trim();
  const other = join(root, 'other');
  git(root, 'init', '-q', '-b', 'main', other);
  mkdirSync(join(other, 'src'), { recursive: true });
  writeFileSync(join(other, 'src', 'o.ts'), 'export const OTHER = 1;\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-q', '-m', 'o');
  otherWt = join(stamHome, 'worktrees', 'other-wt');
  git(other, 'worktree', 'add', '-q', '-b', 'owt', otherWt);
  writeFileSync(join(stamHome, 'settings.json'), JSON.stringify({ itsa: { repos: { app: checkout } } }));
  s.settingsChanged();
});

test('declarations per kind and language', async () => {
  const want = {
    start: 'src/app.ts:2:function', Server: 'src/app.ts:3:class', listen: 'src/app.ts:3:method', '#secret': 'src/app.ts:3:method',
    Opts: 'src/app.ts:4:interface', Id: 'src/app.ts:5:type', Mode: 'src/app.ts:6:enum', LIMIT: 'src/app.ts:7:const', other: 'src/app.ts:7:const',
    counter: 'src/app.ts:8:let', legacy: 'src/app.ts:9:var', MAX: 'src/app.ts:10:export', Panel: 'src/view.tsx:1:function', Button: 'lib/jsx.jsx:1:const',
    run: 'py/mod.py:4:function', Job: 'py/mod.py:7:class', go: 'py/mod.py:8:method', RETRIES: 'py/mod.py:11:var',
    parse: 'rs/lib.rs:1:function', Token: 'rs/lib.rs:2:struct', Lex: 'rs/lib.rs:3:trait', len: 'rs/lib.rs:4:method',
    Serve: 'go/main.go:2:function', Conf: 'go/main.go:3:struct', Port: 'go/main.go:4:const',
  };
  for (const [name, at] of Object.entries(want)) {
    const r = await ask({ repo: 'app', sha: sha1, name });
    assert.equal(r.status, 200);
    assert.equal(r.body.state, 'ready');
    assert.deepEqual(names(r.body), [at], name);
  }
  const x = await ask({ repo: 'app', sha: sha1, name: 'x' });
  assert.deepEqual(x.body.matches, [], "an arrow function's parameter is not a declaration");
  const r = await ask({ repo: 'app', sha: sha1, name: 'Server' });
  assert.equal(r.body.matches[0].col, 14);
  assert.equal(r.body.matches[0].text, 'export class Server { listen() {} #secret() {} }');
  assert.deepEqual(r.body.root, { host: 'decl-test-box', path: checkout });
});

test('ranking: the same file, its imports, its directory, then the rest', async () => {
  const r = await ask({ repo: 'app', sha: sha1, name: 'shared', from: 'src/app.ts' });
  assert.deepEqual(names(r.body), ['src/app.ts:11:function', 'src/util.ts:2:function', 'src/view.tsx:2:function', 'lib/far.js:1:function']);
  assert.equal(r.body.total, 4);
  const v = await ask({ repo: 'app', sha: sha1, name: 'shared', from: 'src/view.tsx' });
  assert.deepEqual(names(v.body), ['src/view.tsx:2:function', 'src/app.ts:11:function', 'src/util.ts:2:function', 'lib/far.js:1:function']);
  const none = await ask({ repo: 'app', sha: sha1, name: 'shared' });
  assert.deepEqual(names(none.body), ['lib/far.js:1:function', 'src/app.ts:11:function', 'src/util.ts:2:function', 'src/view.tsx:2:function'], 'with no from, by path');
  const py = await ask({ repo: 'app', sha: sha1, name: 'Base', from: 'py/mod.py' });
  assert.deepEqual(names(py.body), ['py/base.py:1:class']);
});

test('resolveImport: TS twins of .js names, extensions, index files, Python packages', () => {
  const has = new Map(['src/util.ts', 'src/a/index.tsx', 'py/base.py', 'py/pkg/__init__.py', 'top/x.py'].map((p, i) => [p, i]));
  assert.equal(d.resolveImport('src/app.ts', './util.js', has), 0);
  assert.equal(d.resolveImport('src/app.ts', './util', has), 0);
  assert.equal(d.resolveImport('src/app.ts', './a', has), 1);
  assert.equal(d.resolveImport('src/app.ts', 'react', has), -1);
  assert.equal(d.resolveImport('py/mod.py', '.base', has), 2);
  assert.equal(d.resolveImport('py/mod.py', '.pkg', has), 3);
  assert.equal(d.resolveImport('py/sub/m.py', '..base', has), 2);
  assert.equal(d.resolveImport('py/mod.py', 'top.x', has), 4);
});

test('denied, generated, vendored, minified, oversized and binary files give no names', async () => {
  for (const name of ['SECRET_NAME', 'KEYED', 'bundled', 'fromDeps', 'minified', 'HUGE', 'BIN']) {
    const r = await ask({ repo: 'app', sha: sha1, name });
    assert.deepEqual(r.body.matches, [], name);
    assert.equal(r.body.total, 0, name);
  }
  const ix = await d.indexFor('app', sha1);
  for (const f of ix.files) assert.ok(!/(^|\/)(\.env|\.ssh|dist|node_modules)|\.min\.|huge|bin\.ts|\.md$/.test(f), f);
  const denied = await ask({ repo: 'app', sha: sha1, name: 'shared', from: '.env.ts' });
  assert.equal(denied.body.from, undefined, 'a denied from file is not echoed or used');
});

test('the index is built once per sha and kept on disk', async () => {
  d.resetCaches();
  const before = d.stats.builds;
  await ask({ repo: 'app', sha: sha2, name: 'added' });
  assert.equal(d.stats.builds, before + 1);
  const again = await ask({ repo: 'app', sha: sha2, name: 'added' });
  assert.deepEqual(names(again.body), ['src/util.ts:3:function']);
  assert.equal(d.stats.builds, before + 1, 'a second lookup at the same sha reuses the index');
  const old = await ask({ repo: 'app', sha: sha1, name: 'added' });
  assert.deepEqual(old.body.matches, [], 'another sha has its own index');
  d.resetCaches();
  await ask({ repo: 'app', sha: sha2, name: 'added' });
  assert.equal(d.stats.builds, 0, 'after a restart the index is read from disk');
  assert.equal(d.stats.diskHits, 1);
  const files = readdirSync(join(stamHome, 'cache', 'decl', 'app'));
  assert.deepEqual(files.sort(), [`${sha1}.json`, `${sha2}.json`].sort());
});

test('a build that takes longer than the wait answers 202 building, then ready', async () => {
  d.resetCaches();
  for (const f of readdirSync(join(stamHome, 'cache', 'decl', 'app'))) execFileSync('rm', [join(stamHome, 'cache', 'decl', 'app', f)]);
  const r = await ask({ repo: 'app', sha: sha1, name: 'start' }, true, 0);
  assert.equal(r.status, 202);
  assert.deepEqual(r.body, { state: 'building', repo: 'app', sha: sha1 });
  await d.indexFor('app', sha1);
  const done = await ask({ repo: 'app', sha: sha1, name: 'start' }, true, 0);
  assert.equal(done.status, 200);
  assert.deepEqual(names(done.body), ['src/app.ts:2:function']);
});

test('only the human; bad names, unknown repos and shas are clear errors', async () => {
  await fails({ repo: 'app', sha: sha1, name: 'start' }, 403, false);
  await fails({ repo: 'app', sha: sha1, name: 'a b' }, 400);
  await fails({ repo: 'app', sha: sha1, name: '' }, 400);
  await fails({ repo: 'app', sha: 'main', name: 'start' }, 400);
  await fails({ repo: 'nope', sha: sha1, name: 'start' }, 404);
  await fails({ repo: 'app', sha: 'f'.repeat(40), name: 'start' }, 404);
  await fails({ repo: 'app', sha: sha1, name: 'start', from: '../x.ts' }, 400);
});

test('a file in a checkout: its HEAD is indexed; a file outside every checkout is no-repo', async () => {
  const r = await ask({ host: 'decl-test-box', file: join(checkout, 'src/app.ts'), name: 'shared' });
  assert.equal(r.body.state, 'ready');
  assert.equal(r.body.sha, sha2);
  assert.equal(r.body.from, 'src/app.ts');
  assert.equal(r.body.matches[0].path, 'src/app.ts');
  // decl.ts takes the first folder above a file that holds a `.git`, and a file under test/run.sh's TMPDIR finds this
  // worktree's own checkout. The no-repo file goes in /tmp instead. On storage /tmp/.git exists as an empty folder, so
  // there the answer is no-repo because git rev-parse fails in it, not because no `.git` exists above.
  const out = tempDirOutside('stam-decl-out-');
  writeFileSync(join(out, 'x.ts'), 'const a = 1\n');
  assert.deepEqual((await ask({ host: 'decl-test-box', file: join(out, 'x.ts'), name: 'a' })).body, { state: 'no-repo' });
  assert.deepEqual((await ask({ host: 'other-box', file: join(checkout, 'src/app.ts'), name: 'a' })).body, { state: 'no-repo' }, 'another host');
  assert.ok(existsSync(join(stamHome, 'cache', 'decl', 'app', `${sha2}.json`)));
});

test('a Python import keeps the names after an alias', async () => {
  const ix = await d.indexFor('app', sha2);
  const mod = ix.fileIdx.get('py/mod.py');
  assert.deepEqual(ix.imports[mod].map((i) => ix.files[i]), ['py/base.py'], '`import os.path as osp, py.base` and `from .base import` both name py/base.py');
});

test('a build that runs too long stops its worker with a clear error', async () => {
  const files = [{ path: 'src/app.ts', blob: execFileSync('git', ['rev-parse', `${sha1}:src/app.ts`], { cwd: checkout, encoding: 'utf8' }).trim() }];
  await assert.rejects(d.parseInWorker(checkout, files, 1), (e) => (assert.equal(e.status, 504), assert.match(e.message, /took over 0s and was stopped/), true));
  const ok = await d.parseInWorker(checkout, files);
  assert.equal(ok[0].path, 'src/app.ts');
});

test('a worker stopped at the timeout takes its git child with it (S-1918)', async () => {
  // A `git` that records its pid and then waits, so the worker's cat-file child is still running when the limit hits.
  const bin = tempDir('stam-decl-fakegit-');
  const pidFile = join(bin, 'pid');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 60\n`);
  chmodSync(join(bin, 'git'), 0o755);
  const was = process.env.PATH;
  process.env.PATH = `${bin}:${was}`;
  try {
    const files = [{ path: 'src/app.ts', blob: 'a'.repeat(40) }];
    const run = d.parseInWorker(checkout, files, 3000);
    // Wait on the state (the child started), not on time; the limit is generous for a slow worker start.
    const started = new Promise((res) => { const t = setInterval(() => { if (existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim()) { clearInterval(t); res(); } }, 20); });
    await Promise.race([started, run.catch(() => {})]);
    await assert.rejects(run, (e) => (assert.equal(e.status, 504), true));
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    assert.ok(pid > 0, 'the child started');
    // Killed counts: the worker thread is gone, so nobody reaps the child and it stays a zombie (state Z) until the process ends.
    const gone = () => { try { return readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '')[0] === 'Z'; } catch { return true; } };
    for (let i = 0; i < 100 && !gone(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(gone(), 'the cat-file child is dead after the timeout');
  } finally { process.env.PATH = was; }
});

test("a file in a linked worktree is indexed at the worktree's HEAD; another repo's worktree is no-repo", async () => {
  const r = await ask({ host: 'decl-test-box', file: join(wt, 'src/wt.ts'), name: 'fromWorktree' });
  assert.equal(r.body.state, 'ready');
  assert.equal(r.body.sha, wtSha, "the worktree's own HEAD, not the main checkout's");
  assert.equal(r.body.from, 'src/wt.ts');
  assert.equal(r.body.root.path, realpathSync(wt));
  assert.deepEqual(names(r.body), ['src/wt.ts:1:function']);
  // The main checkout still indexes its own HEAD.
  const main = await ask({ host: 'decl-test-box', file: join(checkout, 'src/app.ts'), name: 'added' });
  assert.equal(main.body.sha, sha2);
  // A worktree of a repo that is not in itsa.repos matches nothing.
  assert.deepEqual((await ask({ host: 'decl-test-box', file: join(otherWt, 'src/o.ts'), name: 'OTHER' })).body, { state: 'no-repo' });
});

test('a symlink into a worktree is looked up at the file it points to, in the worktree', async () => {
  // A link in the main checkout to a worktree file, and a link in the worktree to a checkout file: each resolves
  // to the real file, so its HEAD and its root are the ones of the file's own checkout.
  const intoWt = join(checkout, 'src', 'into-wt.ts');
  const outOfWt = join(wt, 'src', 'out-of-wt.ts');
  symlinkSync(join(wt, 'src', 'wt.ts'), intoWt);
  symlinkSync(join(checkout, 'src', 'app.ts'), outOfWt);
  const into = await ask({ host: 'decl-test-box', file: intoWt, name: 'fromWorktree' });
  assert.equal(into.body.state, 'ready');
  assert.equal(into.body.sha, wtSha, 'the link resolves into the worktree, so the worktree HEAD');
  assert.equal(into.body.from, 'src/wt.ts');
  assert.equal(into.body.root.path, realpathSync(wt));
  const out = await ask({ host: 'decl-test-box', file: outOfWt, name: 'added' });
  assert.equal(out.body.state, 'ready');
  assert.equal(out.body.sha, sha2, 'the link resolves into the checkout, so the checkout HEAD');
  assert.equal(out.body.from, 'src/app.ts');
  assert.equal(out.body.root.path, realpathSync(checkout));
});

test("a worktree nested inside the checkout is indexed at its own HEAD, not the checkout's", async () => {
  // A linked worktree under the checkout's folder (as a `.claude/worktrees` one is): its path is under the
  // checkout's root, but its nearest `.git` is its own, so its declarations come from its own HEAD.
  const nested = join(checkout, 'nested-wt');
  git(checkout, 'worktree', 'add', '-q', '-b', 'nested', nested);
  writeFileSync(join(nested, 'src', 'nested.ts'), 'export function nestedOnly() { return 3 }\n');
  git(nested, 'add', '-A');
  git(nested, 'commit', '-q', '-m', 'nested');
  const nestedSha = git(nested, 'rev-parse', 'HEAD').trim();
  const r = await ask({ host: 'decl-test-box', file: join(nested, 'src/nested.ts'), name: 'nestedOnly' });
  assert.equal(r.body.state, 'ready');
  assert.equal(r.body.sha, nestedSha, "the nested worktree's own HEAD, not the checkout's");
  assert.equal(r.body.from, 'src/nested.ts');
  assert.equal(r.body.root.path, realpathSync(nested));
  assert.deepEqual(names(r.body), ['src/nested.ts:1:function']);
});
