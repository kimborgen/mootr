#!/usr/bin/env node
// The Go catch-up list (S-2244, scripts/go-catchup.mjs) against a scratch git repo: a module lists the commits since its port SHA
// that touch its globs, newest first; a module with no port SHA is skipped; ONLY limits the list; an unknown port SHA throws.
// Nothing touches the real repo or GitHub. Run with `node --test test/go-catchup-unit.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmphome.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const SCRIPT = join(ROOT, 'scripts/go-catchup.mjs');
const { catchUp } = await import(SCRIPT);

process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'go-catchup-test';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'go-catchup-test@stam.local';

const repo = tempDir('stam-go-catchup-');
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (path, text, subject) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
  git('add', '-A');
  git('commit', '-q', '-m', subject);
  return git('rev-parse', 'HEAD');
};

// Commit order: init (docs only), mail a1, web w1, mail a2, mail b1 (a new file in the mail folder).
let init, mailA1, webW1, mailA2, mailB1;
const modules = () => [
  { name: 'mail', globs: ['src/mail/**'], portSha: mailA1 },
  { name: 'web', globs: ['src/web.ts'], portSha: init },
  { name: 'top', globs: ['src/*.ts'], portSha: init },
  { name: 'unported', globs: ['src/**'], portSha: '' },
];

before(() => {
  git('init', '-q', '-b', 'main');
  init = commit('docs/x.md', 'init\n', 'init');
  mailA1 = commit('src/mail/a.ts', 'a1\n', 'mail: a1');
  webW1 = commit('src/web.ts', 'w1\n', 'web: w1');
  mailA2 = commit('src/mail/a.ts', 'a2\n', 'mail: a2');
  mailB1 = commit('src/mail/b.ts', 'b1\n', 'mail: b1');
});

after(() => rmSync(repo, { recursive: true, force: true }));

test('catchUp: a module lists only its own commits since its port SHA, newest first', () => {
  const mail = catchUp({ repo, modules: modules(), ref: 'main', only: 'mail' });
  assert.deepEqual(mail.map((m) => m.name), ['mail']);
  assert.equal(mail[0].portSha, mailA1);
  assert.deepEqual(mail[0].commits.map((c) => c.sha), [mailB1, mailA2]);
  assert.deepEqual(mail[0].commits.map((c) => c.subject), ['mail: b1', 'mail: a2']);
  assert.match(mail[0].commits[0].date, /^\d{4}-\d{2}-\d{2}$/);
});

test('catchUp: a module with a file glob sees only its file, and ports from the commit it names', () => {
  const web = catchUp({ repo, modules: modules(), ref: 'main', only: 'web' })[0];
  assert.deepEqual(web.commits.map((c) => c.sha), [webW1]);
});

test('catchUp: a single-level glob does not cross folders (git :(glob) pathspec)', () => {
  const top = catchUp({ repo, modules: modules(), ref: 'main', only: 'top' })[0];
  assert.deepEqual(top.commits.map((c) => c.sha), [webW1]);
});

test('catchUp: modules without a port SHA are skipped; ONLY limits the list', () => {
  const all = catchUp({ repo, modules: modules(), ref: 'main' });
  assert.deepEqual(all.map((m) => m.name), ['mail', 'web', 'top']);
  assert.deepEqual(catchUp({ repo, modules: modules(), ref: 'main', only: 'unported' }), []);
  assert.deepEqual(catchUp({ repo, modules: modules(), ref: 'main', only: 'nope' }), []);
});

test('catchUp: a port SHA at the ref itself lists nothing; an unknown one is an error', () => {
  const atHead = catchUp({ repo, modules: [{ name: 'mail', globs: ['src/mail/**'], portSha: mailB1 }], ref: 'main' });
  assert.deepEqual(atHead[0].commits, []);
  assert.throws(() => catchUp({ repo, modules: [{ name: 'x', globs: ['src/**'], portSha: '0'.repeat(40) }], ref: 'main' }));
});

test('catchUp: a non-linear history keeps the branch commits and drops the merge (--full-history)', () => {
  // A branch changes a module's file and reverts it before the merge: the file ends where it started, so a simplified log would
  // drop the branch's two commits. Both stay; the merge commit itself is not listed.
  const dir = tempDir('stam-go-catchup-merge-');
  const g = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = (path, text, subject) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
    g('add', '-A');
    g('commit', '-q', '-m', subject);
    return g('rev-parse', 'HEAD');
  };
  g('init', '-q', '-b', 'main');
  const start = put('src/mail/a.ts', 'a0\n', 'start');
  g('checkout', '-q', '-b', 'feat');
  const change = put('src/mail/a.ts', 'a1\n', 'feat: change a');
  const revert = put('src/mail/a.ts', 'a0\n', 'feat: revert a');
  g('checkout', '-q', 'main');
  put('docs/x.md', 'main\n', 'main: docs');
  g('merge', '-q', '--no-ff', '-m', 'Merge feat', 'feat');
  const merge = g('rev-parse', 'HEAD');
  const [mail] = catchUp({ repo: dir, modules: [{ name: 'mail', globs: ['src/mail/**'], portSha: start }], ref: 'main' });
  assert.deepEqual(mail.commits.map((c) => c.sha), [revert, change]);
  assert.ok(!mail.commits.some((c) => c.sha === merge), 'the merge commit is left out');
});

test('the CLI refuses a module name that is not in docs/migration/modules.json', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'no-such-module'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no module named no-such-module/);
});
