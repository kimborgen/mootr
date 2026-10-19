#!/usr/bin/env node
// Unit tests for S-40: a branch link names its repo (settings name or absolute path) and
// branch; its facts come from git on this daemon (diff against main, clean merge, head, behind);
// review, tests, and screenshots are recorded on the link; the merge queue lists the
// ready_to_merge ITSAs with a branch link. Throwaway STAM_HOME and temp git repos, no daemon.
// Run with `node --test test/itsa-queue.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { tempHome, tempDir } from './tmphome.mjs';

const home = tempHome('stam-queue-');
const repo = tempDir('stam-queue-repo-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `itsa-queue-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

let db, itsa, queue, mail, settingsMod;
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const commit = (file, text, msg) => {
  writeFileSync(join(repo, file), text);
  git('add', file);
  git('commit', '-qm', msg);
};

before(async () => {
  db = await import('../src/db.ts');
  itsa = await import('../src/itsa.ts');
  queue = await import('../src/itsa-queue.ts');
  mail = await import('../src/mail.ts');
  settingsMod = await import('../src/settings.ts');
  db.open();
  // The repo a branch link names is configured by name only.
  settingsMod.setSetting('itsa', { repos: { 'clean-repo': repo } });
  db.createAgent({ id: 'a1', name: 'alice', role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  commit('a.txt', 'base\n', 'base');
  git('checkout', '-q', '-b', 'clean');
  commit('b.txt', 'one\ntwo\nthree\n', 'add b');
  git('checkout', '-q', 'main');
  commit('c.txt', 'main moved on\n', 'main: add c');
  git('checkout', '-q', '-b', 'conflict', 'HEAD~1');
  commit('a.txt', 'theirs\n', 'conflict: change a');
  git('checkout', '-q', 'main');
  commit('a.txt', 'ours\n', 'main: change a');
});
after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

test('a clean branch: its diff against main, clean merge, head, and how far behind main', async () => {
  const f = await queue.branchFacts('clean-repo', 'clean');
  assert.equal(f.error, null);
  assert.equal(f.head, git('rev-parse', 'clean'));
  assert.deepEqual(f.diff, { files: 1, insertions: 3, deletions: 0 });
  assert.equal(f.mergeable, true);
  assert.equal(f.behind, 2);
});

test('a conflicting branch merges unclean, and its working tree is left alone', async () => {
  const before = git('status', '--porcelain');
  const f = await queue.branchFacts('clean-repo', 'conflict');
  assert.equal(f.mergeable, false);
  assert.equal(f.behind, 2);
  assert.equal(git('status', '--porcelain'), before);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main');
});

test('a branch that does not exist says so, and has no facts', async () => {
  const f = await queue.branchFacts('clean-repo', 'nope');
  assert.match(f.error, /no branch nope/);
  assert.equal(f.head, null);
  assert.equal(f.diff, null);
});

test('a repo must be a settings name or an absolute path', async () => {
  assert.equal((await queue.branchFacts('unknown-repo', 'clean')).error, 'repo unknown-repo is not configured in settings.itsa.repos');
  assert.equal(queue.repoPath('clean-repo'), settingsMod.settings().itsa.repos['clean-repo']);
});

test('a branch link needs its branch and its repo, and stores the repo', async () => {
  await assert.rejects(itsa.create({ title: 'No branch', by: 'human', links: [{ system: 'branch', repo: 'clean-repo' }] }), /needs its branch name/);
  await assert.rejects(itsa.create({ title: 'No repo', by: 'human', links: [{ system: 'branch', external_id: 'clean' }] }), /needs its repo/);
  await assert.rejects(itsa.create({ title: 'Bad repo', by: 'human', links: [{ system: 'branch', external_id: 'clean', repo: 'nowhere' }] }), /unknown repo nowhere/);
  await assert.rejects(itsa.create({ title: 'Path', by: 'human', links: [{ system: 'branch', external_id: 'clean', repo }] }), /by a name in settings.itsa.repos, not a path/);
  await assert.rejects(itsa.create({ title: 'Dash', by: 'human', links: [{ system: 'branch', external_id: '--output=/tmp/x', repo: 'clean-repo' }] }), /not starting with -/);
  const x = await itsa.create({ title: 'Ship clean', by: 'human', owner: 'alice', links: [{ system: 'branch', external_id: 'clean', repo: 'clean-repo' }] });
  const l = itsa.links(x.id)[0];
  assert.equal(l.system, 'branch');
  assert.equal(l.external_id, 'clean');
  assert.equal(l.url, '');
  assert.equal(l.meta.repo, 'clean-repo');
});

test('a review, tests, and screenshots are recorded on the branch link; the record replaces only what is given', async () => {
  const x = await itsa.create({ title: 'Record', by: 'human', owner: 'alice', links: [{ system: 'branch', external_id: 'clean', repo: 'clean-repo' }] });
  await itsa.recordLink(x.id, 1, { review: { verdict: 'approve', summary: 'Looks right.' } }, 'human');
  let l = itsa.links(x.id)[0];
  assert.equal(l.meta.review.verdict, 'approve');
  assert.equal(l.meta.review.by, 'human');
  await itsa.recordLink(x.id, 1, { tests: { passed: 12, failed: 0, skipped: 1, command: 'npm test' } }, 'human');
  l = itsa.links(x.id)[0];
  assert.deepEqual([l.meta.tests.passed, l.meta.tests.failed, l.meta.tests.skipped], [12, 0, 1]);
  assert.equal(l.meta.review.verdict, 'approve', 'an unrelated field keeps the review');
  await assert.rejects(itsa.recordLink(x.id, 1, { review: { verdict: 'merge it' } }), /verdict is approve, request_changes, comment/);
  await assert.rejects(itsa.recordLink(x.id, 1, { tests: { passed: -1 } }), /whole number/);
  await assert.rejects(itsa.recordLink(x.id, 1, { screenshots: [{ mail_id: 'm0000000', name: 'x.png' }] }), /no attachment x.png/);
});

test('recording on a link that is not a branch is refused', async () => {
  const x = await itsa.create({ title: 'Url only', by: 'human', links: [{ url: 'https://example.com/pr/1', system: 'url' }] });
  await assert.rejects(itsa.recordLink(x.id, 1, { review: { verdict: 'approve' } }), /not a branch/);
});

test('the merge queue lists ready_to_merge ITSAs with a branch link, each with its facts', async () => {
  const ready = await itsa.create({ title: 'Queue me', by: 'human', owner: 'alice', links: [{ system: 'branch', external_id: 'clean', repo: 'clean-repo' }] });
  await itsa.set(ready.id, { status: 'ready_to_merge' }, 'human');
  const noBranch = await itsa.create({ title: 'Ready, no branch', by: 'human', owner: 'alice' });
  await itsa.set(noBranch.id, { status: 'ready_to_merge' }, 'human');
  const notReady = await itsa.create({ title: 'Not ready', by: 'human', links: [{ system: 'branch', external_id: 'conflict', repo: 'clean-repo' }] });
  const rows = await queue.queue();
  assert.deepEqual(rows.map((r) => r.id), [ready.id]);
  assert.equal(rows[0].link.branch, 'clean');
  assert.equal(rows[0].facts.mergeable, true);
  assert.deepEqual(rows[0].facts.diff, { files: 1, insertions: 3, deletions: 0 });
  assert.ok(!rows.some((r) => r.id === notReady.id));
  assert.ok(!rows.some((r) => r.id === noBranch.id));
});

test('an unconfigured repo name is a row error in the queue, not a crash', async () => {
  const x = await itsa.create({ title: 'Gone repo', by: 'human', links: [{ system: 'branch', external_id: 'clean', repo: 'clean-repo' }] });
  await itsa.set(x.id, { status: 'ready_to_merge' }, 'human');
  // The name is removed from settings after the link was made.
  settingsMod.setSetting('itsa', { repos: {} });
  const row = (await queue.queue()).find((r) => r.id === x.id);
  assert.equal(row.facts.error, 'repo clean-repo is not configured in settings.itsa.repos');
  assert.equal(row.facts.diff, null);
  settingsMod.setSetting('itsa', { repos: { 'clean-repo': repo } });
});

test('the default repo is the one a release was built from, or this checkout', async () => {
  const release = tempDir('stam-queue-release-');
  try {
    writeFileSync(join(release, '.release.json'), JSON.stringify({ release: 'abc', repo: repo }));
    assert.deepEqual(settingsMod.defaultRepos(release), { [basename(repo)]: repo });
    const plain = tempDir('stam-queue-plain-');
    assert.deepEqual(settingsMod.defaultRepos(plain), {});
    mkdirSync(join(plain, '.git'));
    assert.deepEqual(settingsMod.defaultRepos(plain), { [basename(plain)]: plain });
    rmSync(plain, { recursive: true, force: true });
  } finally {
    rmSync(release, { recursive: true, force: true });
  }
});
