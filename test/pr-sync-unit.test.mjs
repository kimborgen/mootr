#!/usr/bin/env node
// PR head sync (S-667, src/pr-sync.ts) and pr_open's push from the worktree (src/pr-open.ts pushOwnBranch),
// against throwaway git repos and a fake `gh` that serves the open PR list from a file.
// Run with `node --test test/pr-sync-unit.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDir } from './tmphome.mjs';

const base = tempDir('stam-pr-sync-test-');
process.env.STAM_HOME = join(base, 'home');
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];
mkdirSync(process.env.STAM_HOME, { recursive: true });

const B = 'stam/feat';
const d = join(base, 'repos');
const prs = join(base, 'prs.json');
const stateFile = join(base, 'state.json');
let sync, pr, cfg, work, dev, cfgHome;

const git = (cwd, args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const sha = (repo, ref) => git(repo, ['rev-parse', ref]);
const remoteSha = (repo, ref) => git(repo, ['ls-remote', repo, ref]).split('\t')[0];
const setPrs = (list) => writeFileSync(prs, JSON.stringify(list));
const commit = (cwd, text) => {
  writeFileSync(join(cwd, 'a.txt'), text);
  git(cwd, ['commit', '-qam', text]);
  return sha(cwd, 'HEAD');
};
const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const silent = () => {};

before(async () => {
  mkdirSync(d, { recursive: true });
  mkdirSync(join(base, 'bin'));
  writeFileSync(join(base, 'bin', 'gh'), `#!/bin/sh\ncat ${prs}\n`);
  chmodSync(join(base, 'bin', 'gh'), 0o755);
  git(d, ['init', '-q', '--bare', '-b', 'main', 'origin.git']);
  git(d, ['init', '-q', '--bare', '-b', 'main', 'storage.git']);
  // dev is a developer's worktree on storage: its origin is storage's bare repo.
  dev = join(d, 'dev');
  git(d, ['clone', '-q', join(d, 'storage.git'), 'dev']);
  git(dev, ['checkout', '-q', '-b', 'main']);
  writeFileSync(join(dev, 'a.txt'), 'base');
  git(dev, ['add', '.']);
  git(dev, ['commit', '-qm', 'base']);
  git(dev, ['push', '-q', 'origin', 'main']);
  git(dev, ['push', '-q', join(d, 'origin.git'), 'main']);
  git(dev, ['checkout', '-q', '-b', B]);
  commit(dev, 'v1');
  git(dev, ['push', '-q', 'origin', B]);
  // work is the ITSA home's checkout: origin is GitHub's stand-in, storage the bare repo.
  work = join(d, 'work');
  git(d, ['clone', '-q', join(d, 'origin.git'), 'work']);
  git(work, ['remote', 'add', 'storage', join(d, 'storage.git')]);
  (await import('../src/settings.ts')).setSetting('itsa', { ...(await import('../src/settings.ts')).settings().itsa, repos: { stam2: work } });
  cfg = { repoName: 'stam2', repo: work, storage: 'storage', origin: 'origin', gh: join(base, 'bin', 'gh'), github: 'example/stam', base: 'main' };
  sync = await import('../src/pr-sync.ts');
  pr = await import('../src/pr-open.ts');
});

after(() => rmSync(base, { recursive: true, force: true }));

test('a branch first seen is recorded, not pushed', async () => {
  const s1 = remoteSha(join(d, 'storage.git'), `refs/heads/${B}`);
  setPrs([{ number: 1, headRefName: B, headRefOid: 'a'.repeat(40) }]);
  const r = await sync.syncPrs(cfg, silent, stateFile);
  assert.deepEqual(r.pushed, []);
  assert.equal(state()[B], s1);
});

test('a new storage head is pushed to GitHub with the lease on the PR head', async () => {
  // GitHub holds the old head: push v1 there by hand.
  git(dev, ['push', '-q', join(d, 'origin.git'), `${B}:refs/heads/${B}`]);
  const old = sha(dev, 'HEAD');
  const s2 = commit(dev, 'v2');
  git(dev, ['push', '-q', 'origin', B]);
  setPrs([{ number: 1, headRefName: B, headRefOid: old }]);
  const logs = [];
  const r = await sync.syncPrs(cfg, (l) => logs.push(l), stateFile);
  assert.deepEqual(r.pushed, [B]);
  assert.equal(remoteSha(join(d, 'origin.git'), `refs/heads/${B}`), s2);
  assert.equal(state()[B], s2);
  assert.match(logs[0], /#1 stam\/feat/);
});

test('skips when storage is unchanged since the last sync, even if GitHub differs', async () => {
  // A manager pushed a fix straight to GitHub: GitHub's head is ahead of the recorded storage sha.
  const other = join(d, 'mgr');
  git(d, ['clone', '-q', '-b', B, join(d, 'origin.git'), 'mgr']);
  const mgr = commit(other, 'manager fix');
  git(other, ['push', '-q', 'origin', B]);
  setPrs([{ number: 1, headRefName: B, headRefOid: mgr }]);
  const r = await sync.syncPrs(cfg, silent, stateFile);
  assert.deepEqual(r.pushed, []);
  assert.equal(remoteSha(join(d, 'origin.git'), `refs/heads/${B}`), mgr, 'GitHub keeps the manager fix');
});

test('skips a closed or merged PR: only the open list is read', async () => {
  commit(dev, 'v3');
  git(dev, ['push', '-q', 'origin', B]);
  const before = remoteSha(join(d, 'origin.git'), `refs/heads/${B}`);
  setPrs([]);
  const r = await sync.syncPrs(cfg, silent, stateFile);
  assert.deepEqual(r.pushed, []);
  assert.equal(remoteSha(join(d, 'origin.git'), `refs/heads/${B}`), before);
  assert.equal(state()[B], undefined, 'state for a closed PR is dropped');
});

test('does not clobber a GitHub fix: storage S1 synced, manager pushes M, developer pushes S2', async () => {
  const origin = join(d, 'origin.git');
  const s1 = remoteSha(join(d, 'storage.git'), `refs/heads/${B}`);
  git(dev, ['push', '-q', origin, `${B}:refs/heads/${B}`, '--force']);
  writeFileSync(stateFile, JSON.stringify({ [B]: s1 }));
  const other = join(d, 'mgr2');
  git(d, ['clone', '-q', '-b', B, origin, 'mgr2']);
  const m = commit(other, 'manager fix 2');
  git(other, ['push', '-q', 'origin', B]);
  // The developer diverges from S1 on storage.
  git(dev, ['reset', '-q', '--hard', s1]);
  const s2 = commit(dev, 'dev fix 2');
  git(dev, ['push', '-q', 'origin', B]);
  setPrs([{ number: 1, headRefName: B, headRefOid: m }]);
  const logs = [];
  const r = await sync.syncPrs(cfg, (l) => logs.push(l), stateFile);
  assert.deepEqual(r.pushed, []);
  assert.deepEqual(r.skipped, [B]);
  assert.match(logs[0], /conflict/);
  assert.equal(remoteSha(origin, `refs/heads/${B}`), m, 'GitHub keeps the manager fix');
  assert.equal(state()[B], s1, 'state kept');
  assert.equal(git(work, ['for-each-ref', 'refs/stam/pr-sync', 'refs/stam/pr-sync-gh']), '', 'scratch refs deleted');
  assert.notEqual(s2, m);
  // Storage ahead of GitHub (GitHub's head is an ancestor of it): pushed.
  git(dev, ['reset', '-q', '--hard', s1]);
  const s3 = commit(dev, 'dev fix 3');
  git(dev, ['push', '-q', '--force', 'origin', B]);
  git(dev, ['push', '-q', '--force', origin, `${s1}:refs/heads/${B}`]);
  setPrs([{ number: 1, headRefName: B, headRefOid: s1 }]);
  writeFileSync(stateFile, JSON.stringify({ [B]: 'e'.repeat(40) }));
  const r2 = await sync.syncPrs(cfg, silent, stateFile);
  assert.deepEqual(r2.pushed, [B]);
  assert.equal(remoteSha(origin, `refs/heads/${B}`), s3);
});

test('the lease protects a concurrent push: GitHub moves between the PR list and the push', async () => {
  const origin = join(d, 'origin.git');
  const g0 = remoteSha(origin, `refs/heads/${B}`);
  // Storage is ahead of g0; GitHub's real head moves to M after gh listed g0 (the fake gh serves a fixed list).
  git(dev, ['reset', '-q', '--hard', g0]);
  git(dev, ['fetch', '-q', 'origin']);
  const s = commit(dev, 'storage ahead');
  git(dev, ['push', '-q', '--force', 'origin', B]);
  const other = join(d, 'mgr3');
  git(d, ['clone', '-q', '-b', B, origin, 'mgr3']);
  const m = commit(other, 'concurrent');
  git(other, ['push', '-q', 'origin', B]);
  setPrs([{ number: 1, headRefName: B, headRefOid: g0 }]);
  writeFileSync(stateFile, JSON.stringify({ [B]: 'd'.repeat(40) }));
  const r = await sync.syncPrs(cfg, silent, stateFile);
  assert.deepEqual(r.failed, [B]);
  assert.deepEqual(r.pushed, []);
  assert.equal(remoteSha(origin, `refs/heads/${B}`), m, 'the concurrent push stands');
  assert.equal(state()[B], 'd'.repeat(40), 'retried next tick');
  assert.notEqual(s, m);
});

test('single flight: a tick while a sync runs is skipped', async () => {
  setPrs([]);
  assert.equal(sync.syncTick(cfg, silent, stateFile, () => false), null, 'no linked branch: no tick');
  const first = sync.syncTick(cfg, silent, stateFile, () => true);
  assert.ok(first);
  assert.equal(sync.syncTick(cfg, silent, stateFile, () => true), null);
  await first;
  assert.ok(sync.syncTick(cfg, silent, stateFile, () => true), 'free again after it ends');
  await new Promise((r) => setTimeout(r, 500));
});

test('pushOwnBranch pushes a worktree on the branch to its origin; not on the home, a wrong branch, or no cwd', async () => {
  const s = await import('../src/settings.ts');
  const { MACHINE } = await import('../src/config.ts');
  const wt = join(d, 'wt');
  git(dev, ['worktree', 'add', '-q', '-b', 'stam/new', wt, 'main']);
  const head = commit(wt, 'new work');
  // The ITSA home is this machine: nothing to push.
  assert.equal(await pr.pushOwnBranch(wt, 'stam/new'), false);
  assert.equal(remoteSha(join(d, 'storage.git'), 'refs/heads/stam/new'), '');
  s.setSetting('itsa', { ...s.settings().itsa, home: `${MACHINE}-elsewhere` });
  assert.equal(await pr.pushOwnBranch(wt, 'stam/other'), false, 'cwd is on another branch');
  assert.equal(await pr.pushOwnBranch(null, 'stam/new'), false);
  assert.equal(await pr.pushOwnBranch(wt, 'stam/new'), true);
  assert.equal(remoteSha(join(d, 'storage.git'), 'refs/heads/stam/new'), head);
  // Main and a main checkout are refused; the worktree's own push of its branch still passes (S-3495: its tracking ref moves with it).
  await assert.rejects(pr.pushOwnBranch(wt, 'main'), /won't push or open a PR from main/);
  await assert.rejects(pr.pushOwnBranch(join(d, 'dev'), B), /main checkout/);
  const head2 = commit(wt, 'more work');
  assert.equal(await pr.pushOwnBranch(wt, 'stam/new'), true);
  assert.equal(remoteSha(join(d, 'storage.git'), 'refs/heads/stam/new'), head2);
});

test('pushOwnBranchHead returns the worktree head it pushed, and an unreadable head refuses before any push (S-3486)', async () => {
  const wt = join(d, 'wt-head');
  git(dev, ['worktree', 'add', '-q', '-b', 'stam/headed', wt, 'main']);
  const head = commit(wt, 'headed work');
  assert.equal(await pr.pushOwnBranchHead(wt, 'stam/headed'), head);
  assert.equal(await pr.pushOwnBranchHead(wt, 'stam/other'), null, 'not on that branch: nothing pushed');
  // A git that can't read HEAD's commit: the branch is not pushed, and the call refuses rather than go on without a head.
  const head2 = commit(wt, 'more headed work');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  mkdirSync(join(base, 'nohead'), { recursive: true });
  writeFileSync(join(base, 'nohead', 'git'), `#!/bin/sh\ncase "$*" in *"rev-parse --verify HEAD"*) echo broken >&2; exit 1;; esac\nexec ${realGit} "$@"\n`);
  chmodSync(join(base, 'nohead', 'git'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${join(base, 'nohead')}:${path}`;
  try {
    await assert.rejects(pr.pushOwnBranchHead(wt, 'stam/headed'), /pushing stam\/headed to origin from the worktree failed/);
  } finally {
    process.env.PATH = path;
  }
  assert.notEqual(remoteSha(join(d, 'storage.git'), 'refs/heads/stam/headed'), head2, 'the unreadable head pushed nothing');
});

test('a rebased branch pushes over its own old head, leased to the head it read (S-3495)', async () => {
  const wt = join(d, 'wt-rebase');
  git(dev, ['worktree', 'add', '-q', '-b', 'stam/rebased', wt, 'main']);
  const old = commit(wt, 'rebase work');
  assert.equal(await pr.pushOwnBranchHead(wt, 'stam/rebased'), old);
  // Main moves on storage, and the branch is rebased onto it: its new head is no fast-forward of the old one.
  const up = join(d, 'main-up');
  git(d, ['clone', '-q', join(d, 'storage.git'), 'main-up']);
  writeFileSync(join(up, 'b.txt'), 'newer main');
  git(up, ['add', 'b.txt']);
  git(up, ['commit', '-qm', 'newer main']);
  git(up, ['push', '-q', 'origin', 'main']);
  git(wt, ['fetch', '-q', 'origin', 'main']);
  git(wt, ['rebase', '-q', 'origin/main']);
  const rebased = sha(wt, 'HEAD');
  assert.notEqual(rebased, old);
  assert.equal(await pr.pushOwnBranchHead(wt, 'stam/rebased'), rebased);
  assert.equal(remoteSha(join(d, 'storage.git'), 'refs/heads/stam/rebased'), rebased);
});

test('another writer pushed after this worktree last fetched: the push is refused, and storage keeps that head (S-3495)', async () => {
  const wt = join(d, 'wt-race');
  git(dev, ['worktree', 'add', '-q', '-b', 'stam/race', wt, 'main']);
  const first = commit(wt, 'race v1');
  assert.equal(await pr.pushOwnBranchHead(wt, 'stam/race'), first);
  const mine = commit(wt, 'race v2');
  // Another writer pushes to the branch after this worktree's last push, before the push below (the hook runs after the lease is read).
  const other = join(d, 'race-other');
  git(d, ['clone', '-q', '-b', 'stam/race', join(d, 'storage.git'), 'race-other']);
  let theirs = '';
  pr.pushOwnBranchHooks.afterRead = async () => {
    theirs = commit(other, 'other writer');
    git(other, ['push', '-q', 'origin', 'HEAD:refs/heads/stam/race']);
  };
  try {
    await assert.rejects(pr.pushOwnBranchHead(wt, 'stam/race'), /another push moved it/);
  } finally {
    pr.pushOwnBranchHooks.afterRead = async () => {};
  }
  assert.equal(remoteSha(join(d, 'storage.git'), 'refs/heads/stam/race'), theirs, 'the other writer\'s head stays on storage');
  assert.notEqual(theirs, mine);
});

test('a fetch that moves origin without a rebase onto it is refused, and storage keeps the other writer\'s head (S-3495)', async () => {
  const wt = join(d, 'wt-fetched');
  git(dev, ['worktree', 'add', '-q', '-b', 'stam/fetched', wt, 'main']);
  const first = commit(wt, 'fetched v1');
  assert.equal(await pr.pushOwnBranchHead(wt, 'stam/fetched'), first);
  const other = join(d, 'fetched-other');
  git(d, ['clone', '-q', '-b', 'stam/fetched', join(d, 'storage.git'), 'fetched-other']);
  const theirs = commit(other, 'other writer');
  git(other, ['push', '-q', 'origin', 'HEAD:refs/heads/stam/fetched']);
  // The worktree fetches the new head but does not rebase onto it: its lease must not pass.
  git(wt, ['fetch', '-q', 'origin']);
  commit(wt, 'fetched v2');
  await assert.rejects(pr.pushOwnBranchHead(wt, 'stam/fetched'), /another push moved it.*rebase onto it/);
  assert.equal(remoteSha(join(d, 'storage.git'), 'refs/heads/stam/fetched'), theirs, 'the other writer\'s head stays on storage');
});

test('a branch another writer created on origin, which this worktree never saw, is refused (S-3495)', async () => {
  const wt = join(d, 'wt-foreign');
  git(dev, ['worktree', 'add', '-q', '-b', 'stam/foreign', wt, 'main']);
  const mine = commit(wt, 'foreign work');
  const other = join(d, 'foreign-other');
  git(d, ['clone', '-q', join(d, 'storage.git'), 'foreign-other']);
  git(other, ['checkout', '-q', '-b', 'stam/foreign']);
  const theirs = commit(other, 'someone else first');
  git(other, ['push', '-q', 'origin', 'HEAD:refs/heads/stam/foreign']);
  await assert.rejects(pr.pushOwnBranchHead(wt, 'stam/foreign'), /another push moved it.*fetch stam\/foreign from origin, rebase onto it/);
  assert.equal(remoteSha(join(d, 'storage.git'), 'refs/heads/stam/foreign'), theirs, 'the other writer\'s branch stays on storage');
  assert.notEqual(theirs, mine);
});

test('callerHead reads the worktree head on the ITSA home without pushing, and pushes then reads elsewhere (S-3486)', async () => {
  const s = await import('../src/settings.ts');
  const { MACHINE } = await import('../src/config.ts');
  const wt = join(d, 'wt-home');
  git(dev, ['worktree', 'add', '-q', '-b', 'stam/homed', wt, 'main']);
  const head = commit(wt, 'homed work');
  const home = s.settings().itsa.home;
  try {
    s.setSetting('itsa', { ...s.settings().itsa, home: MACHINE });
    assert.equal(await pr.callerHead(wt, 'stam/homed'), head);
    assert.equal(remoteSha(join(d, 'storage.git'), 'refs/heads/stam/homed'), '', 'the home pushes nothing');
    assert.equal(await pr.callerHead(wt, 'stam/other'), null, 'not on that branch');
    assert.equal(await pr.callerHead(null, 'stam/homed'), null);
    // A cwd that is no repo, or is gone, gives no head instead of refusing (the assistant or cos opening another agent's branch).
    mkdirSync(join(base, 'plain-dir'), { recursive: true });
    assert.equal(await pr.callerHead(join(base, 'plain-dir'), 'stam/homed'), null);
    assert.equal(await pr.callerHead(join(base, 'no-such-dir'), 'stam/homed'), null);
    s.setSetting('itsa', { ...s.settings().itsa, home: `${MACHINE}-elsewhere` });
    assert.equal(await pr.callerHead(wt, 'stam/homed'), head);
    assert.equal(remoteSha(join(d, 'storage.git'), 'refs/heads/stam/homed'), head, 'elsewhere it pushes');
  } finally {
    s.setSetting('itsa', { ...s.settings().itsa, home });
  }
});

test('the ITSA home gives the full verdict before storage moves: rule 2 links pass, no link or an unreachable home refuses (S-684)', async () => {
  const db = await import('../src/db.ts');
  const itsa = await import('../src/itsa.ts');
  db.open();
  const mk = (id, branch) => {
    db.createAgent({ id, name: `n-${id}`, role: 'developer', machine: 'm', harness: 'claude', model: 'm', effort: 'low', cwd: '/tmp', parent_id: null, session_id: null });
    db.open().prepare('UPDATE agents SET workspace = ? WHERE id = ?').run(JSON.stringify({ worktree: { branch, path: '/tmp/x' } }), id);
  };
  mk('bbbb1', 'stam/wt-main');
  mk('bbbb2', 'stam/theirs');
  const via = { agent: 'bbbb1', boss: false };
  // What the home runs for a forwarded call: its own links, rule 1 as the caller's daemon answered.
  const x = await itsa.create({ title: 'Mine', owner: 'bbbb1', by: 'human' });
  await assert.rejects(pr.pushCheckHere('stam/extra', via), /rule 2/, 'no link: refused');
  await itsa.addLink(x.key, { system: 'branch', external_id: 'stam/extra', repo: 'stam2', url: '' }, 'human');
  await pr.pushCheckHere('stam/extra', via);
  await itsa.addLink(x.key, { system: 'branch', external_id: 'stam/theirs', repo: 'stam2', url: '' }, 'human');
  await assert.rejects(pr.pushCheckHere('stam/theirs', via), /rule 1/, "another agent's branch stays refused whatever it links");
  // pushOwnBranch asks the home first; with the home unreachable, storage's branch is not advanced.
  const wt = join(d, 'wt-extra');
  git(dev, ['worktree', 'add', '-q', '-b', 'stam/extra', wt, 'main']);
  commit(wt, 'extra work');
  await assert.rejects(pr.pushOwnBranch(wt, 'stam/extra', via), /not a configured peer/);
  assert.equal(remoteSha(join(d, 'storage.git'), 'refs/heads/stam/extra'), '');
});

test('a conflict is logged once per (GitHub sha, storage sha) pair, and again when either moves (S-673)', async () => {
  const L = 'stam/log';
  const origin = join(d, 'origin.git');
  git(dev, ['checkout', '-q', '-b', L]);
  const c1 = commit(dev, 'log c1');
  git(dev, ['push', '-q', 'origin', L]);
  git(dev, ['push', '-q', origin, `${L}:refs/heads/${L}`]);
  // Synced at c1. A manager then pushes m1 to GitHub while the developer moves storage to s1, off c1: a conflict.
  writeFileSync(stateFile, JSON.stringify({ [L]: c1 }));
  const mgr = join(d, 'mgr-log');
  git(d, ['clone', '-q', '-b', L, origin, 'mgr-log']);
  const m1 = commit(mgr, 'log m1');
  git(mgr, ['push', '-q', 'origin', L]);
  git(dev, ['reset', '-q', '--hard', c1]);
  commit(dev, 'log s1');
  git(dev, ['push', '-q', 'origin', L]);
  const logs = [];
  const log = (l) => logs.push(l);
  const conflicts = () => logs.filter((l) => /conflict/.test(l)).length;
  setPrs([{ number: 2, headRefName: L, headRefOid: m1 }]);
  const r = await sync.syncPrs(cfg, log, stateFile);
  assert.deepEqual(r.skipped, [L]);
  assert.equal(conflicts(), 1);
  await sync.syncPrs(cfg, log, stateFile);
  assert.equal(conflicts(), 1, 'the next tick, same shas: nothing new logged');
  // GitHub's head moves: a manager's commit on top of m1.
  const m2 = commit(mgr, 'log m2');
  git(mgr, ['push', '-q', 'origin', L]);
  setPrs([{ number: 2, headRefName: L, headRefOid: m2 }]);
  await sync.syncPrs(cfg, log, stateFile);
  assert.equal(conflicts(), 2, 'GitHub sha moved: logged again');
  await sync.syncPrs(cfg, log, stateFile);
  assert.equal(conflicts(), 2);
  // Storage's head moves: the developer's next commit.
  commit(dev, 'log s2');
  git(dev, ['push', '-q', 'origin', L]);
  await sync.syncPrs(cfg, log, stateFile);
  assert.equal(conflicts(), 3, 'storage sha moved: logged again');
  await sync.syncPrs(cfg, log, stateFile);
  assert.equal(conflicts(), 3);
});

test('a reused branch name: storage holds an old merged head, pr_open recorded the new PR head as synced; nothing is pushed (S-1419)', async () => {
  const R = 'stam/reused';
  const origin = join(d, 'origin.git');
  git(dev, ['checkout', '-q', 'main']);
  git(dev, ['checkout', '-q', '-b', R]);
  const oldHead = commit(dev, 'old agent');
  git(dev, ['push', '-q', 'origin', R]);
  // The new agent's PR head, on GitHub only, branched from main and unrelated to the old head.
  git(dev, ['checkout', '-q', 'main']);
  git(dev, ['checkout', '-q', '-b', 'stam/reused-new']);
  const newHead = commit(dev, 'new agent');
  git(dev, ['push', '-q', origin, `stam/reused-new:refs/heads/${R}`]);
  writeFileSync(stateFile, JSON.stringify({ [R]: newHead }));
  setPrs([{ number: 480, headRefName: R, headRefOid: newHead }]);
  const logs = [];
  const r = await sync.syncPrs(cfg, (l) => logs.push(l), stateFile);
  assert.deepEqual(r.pushed, []);
  assert.deepEqual(r.skipped, [R]);
  assert.equal(remoteSha(origin, `refs/heads/${R}`), newHead, 'the open PR keeps its head');
  assert.match(logs[0], /conflict/);
  assert.notEqual(oldHead, newHead);
});

test('a noteSynced that lands between the tick\'s read and its write survives (S-675)', async () => {
  const N = 'stam/noted';
  const origin = join(d, 'origin.git');
  git(dev, ['checkout', '-q', '-b', N, 'main']);
  const n1 = commit(dev, 'noted n1');
  git(dev, ['push', '-q', 'origin', N]);
  git(dev, ['push', '-q', origin, `${N}:refs/heads/${N}`]);
  const n2 = commit(dev, 'noted n2');
  git(dev, ['push', '-q', 'origin', N]);
  writeFileSync(stateFile, JSON.stringify({ [N]: 'c'.repeat(40) }));
  setPrs([{ number: 3, headRefName: N, headRefOid: n1 }]);
  // The log line comes after the push and before the write: pr_open notes a head there.
  const noted = 'f'.repeat(40);
  const r = await sync.syncPrs(cfg, () => sync.noteSynced(N, noted, stateFile), stateFile);
  assert.deepEqual(r.pushed, [N]);
  assert.equal(remoteSha(origin, `refs/heads/${N}`), n2);
  assert.equal(state()[N], noted, 'the newer note wins over the tick\'s own sha');
});

test('conflictLogged forgets a branch whose PR closed: the same conflict logs again on reopen (S-675)', async () => {
  const L = 'stam/log';
  const logs = [];
  const conflicts = () => logs.filter((l) => /conflict/.test(l)).length;
  const gh = remoteSha(join(d, 'origin.git'), `refs/heads/${L}`);
  // An earlier test left this pair logged: a tick with the PR closed prunes it.
  setPrs([]);
  await sync.syncPrs(cfg, () => {}, stateFile);
  setPrs([{ number: 2, headRefName: L, headRefOid: gh }]);
  const c1 = sha(dev, `${L}~1`);
  writeFileSync(stateFile, JSON.stringify({ [L]: c1 }));
  await sync.syncPrs(cfg, (l) => logs.push(l), stateFile);
  await sync.syncPrs(cfg, (l) => logs.push(l), stateFile);
  assert.equal(conflicts(), 1, 'logged once while open');
  setPrs([]);
  await sync.syncPrs(cfg, (l) => logs.push(l), stateFile);
  setPrs([{ number: 2, headRefName: L, headRefOid: gh }]);
  writeFileSync(stateFile, JSON.stringify({ [L]: c1 }));
  await sync.syncPrs(cfg, (l) => logs.push(l), stateFile);
  assert.equal(conflicts(), 2, 'the entry was pruned while the PR was closed');
});
