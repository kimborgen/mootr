#!/usr/bin/env node
// The workspace a spawn gets (S-627): the developer type's worktree default applies unless the
// spawner passes `worktree` itself, an explicit `worktree: false` still works for a directory that
// isn't live, and a developer that ends up without a worktree in the live deploy checkout is
// refused — checked on the resolved workspace, so a `workspace_script` that printed the checkout is
// caught too, while other types (whose cwd is often the checkout) are left alone. Real git repos
// under a throwaway STAM_HOME, no daemon, no model: `node --test test/spawn-worktree-unit.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const work = mkdtempSync(join(tmpdir(), 'stam-spawn-worktree-'));
// git must not look above the test's folder for a repo: the gate's TMPDIR sits inside its own checkout, which would make
// the non-git directory below a repo (S-2985).
process.env.GIT_CEILING_DIRECTORIES = [work, realpathSync(work)].join(':');
after(() => rmSync(work, { recursive: true, force: true }));
// test-slot.sh puts TMPDIR inside the worktree's own git repo; stop git's upward search at `work`
// so the not-a-repo fixture below is not one.
process.env.GIT_CEILING_DIRECTORIES = work;

// The live deploy checkout is named by STAM_DEPLOY_REPO here, so the test never reads (or writes)
// the real one. `elsewhere` is a plain directory, and `inside` a linked worktree inside the
// checkout: its own working tree, so a spawn that works there needs no worktree of its own.
const checkout = join(work, 'stam2');
const elsewhere = join(work, 'work');
const inside = join(checkout, 'wt-inside');
const env = { ...process.env, GIT_AUTHOR_NAME: 'spawn-test', GIT_AUTHOR_EMAIL: 'spawn-test@stam.local', GIT_COMMITTER_NAME: 'spawn-test', GIT_COMMITTER_EMAIL: 'spawn-test@stam.local' };
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
mkdirSync(checkout);
mkdirSync(join(checkout, 'src'));
mkdirSync(elsewhere);
git('init', '-q', '-b', 'main', checkout);
git('-C', checkout, 'commit', '-q', '--allow-empty', '-m', 'one');
git('-C', checkout, 'worktree', 'add', '-q', '-b', 'wt-inside', inside);

// config.ts reads the home and the environment when it loads, so both are set before the modules
// under test are imported.
process.env.STAM_HOME = tempHome('stam-spawn-worktree-home-');
process.env.STAM_DEPLOY_REPO = checkout;

let ws, types;
before(async () => {
  ws = await import('../src/workspace.ts');
  types = await import('../src/agent-types.ts');
});

const developer = () => types.agentType('developer');
// The workspace a spec resolves to, as the daemon makes it: createWorkspace is what runs the
// script, so this is the cwd the refusal reads.
const made = (spec, name = 'made') => ws.createWorkspace(spec, name);

test('the developer type defaults to its own worktree', () => {
  assert.equal(developer().worktree, true, 'the shipped developer type defaults to a worktree');
  assert.deepEqual(ws.spawnWorkspaceSpec({}, developer(), elsewhere), { kind: 'worktree', repo: elsewhere, branch: undefined });
  // An explicit branch carries through; a spawn with no type still gets a plain directory.
  assert.deepEqual(ws.spawnWorkspaceSpec({ branch: 'stam/x' }, developer(), elsewhere), { kind: 'worktree', repo: elsewhere, branch: 'stam/x' });
  assert.deepEqual(ws.spawnWorkspaceSpec({}, undefined, elsewhere), { kind: 'dir', path: elsewhere });
  // The default also saves a developer whose cwd is the live deploy checkout.
  assert.equal(ws.spawnWorkspaceSpec({}, developer(), checkout).kind, 'worktree');
});

test('an explicit worktree: false still works for a directory that is not live', () => {
  assert.deepEqual(ws.spawnWorkspaceSpec({ worktree: false }, developer(), elsewhere), { kind: 'dir', path: elsewhere });
  assert.deepEqual(ws.spawnWorkspaceSpec({ worktree: false }, undefined, elsewhere), { kind: 'dir', path: elsewhere });
  // A cwd that isn't in a git repo has no checkout to hold.
  const loose = join(work, 'not-a-repo');
  assert.deepEqual(ws.spawnWorkspaceSpec({ worktree: false }, undefined, loose), { kind: 'dir', path: loose });
  // The caller's own workspace choice wins over the type's worktree default.
  assert.equal(ws.spawnWorkspaceSpec({ workspace_script: 'printf %s ' + elsewhere }, developer(), elsewhere).kind, 'script');
  assert.equal(ws.spawnWorkspaceSpec({ workspace_instructions: 'make your own' }, developer(), elsewhere).kind, 'instructions');
});

test('a base on a spawn that makes no worktree is refused, not dropped (S-1278)', () => {
  assert.throws(() => ws.spawnWorkspaceSpec({ base: 'origin/stam/x', worktree: false }, developer(), elsewhere), /base needs a worktree spawn/);
  assert.throws(() => ws.spawnWorkspaceSpec({ base: 'origin/stam/x', workspace_script: 'printf %s ' + elsewhere }, developer(), elsewhere), /base needs a worktree spawn/);
  assert.throws(() => ws.spawnWorkspaceSpec({ base: 'origin/stam/x' }, undefined, elsewhere), /base needs a worktree spawn/);
});

test('the developer default makes a real worktree on the repo, not just a spec', () => {
  const spec = ws.spawnWorkspaceSpec({}, developer(), checkout);
  const real = made(spec, 'dev-real');
  try {
    assert.equal(real.worktree?.branch, 'stam/dev-real', `branch: ${JSON.stringify(real.worktree)}`);
    assert.equal(realpathSync(real.worktree.repo), realpathSync(checkout));
    assert.ok(real.cwd.startsWith(join(process.env.STAM_HOME, 'worktrees') + '/'), `cwd is under STAM_HOME/worktrees: ${real.cwd}`);
    // It is a linked worktree on that branch, so the developer's commits stay out of the checkout.
    assert.equal(git('-C', real.cwd, 'rev-parse', '--show-toplevel').trim(), realpathSync(real.cwd));
    assert.equal(git('-C', real.cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'stam/dev-real');
    assert.equal(ws.spawnWorkspaceRefusal(developer(), real), null);
  } finally {
    ws.cleanupWorkspace(real, true);
  }
  assert.equal(existsSync(real.cwd), false, 'the worktree is cleaned up');
});

test('a worktree made from another agent\'s worktree is removed after that agent is archived (S-1049)', () => {
  const parent = made(ws.spawnWorkspaceSpec({}, developer(), checkout), 'dev-parent');
  const child = made({ kind: 'worktree', repo: parent.cwd }, 'dev-child');
  assert.equal(realpathSync(child.worktree.repo), realpathSync(parent.cwd), 'the child is made from the parent worktree');
  assert.equal(ws.cleanupWorkspace(parent, true).startsWith('removed worktree'), true);
  assert.equal(existsSync(parent.cwd), false, 'the parent worktree is gone');
  // The child's repo path is now gone; archive still removes its worktree, from the main repo.
  assert.equal(ws.cleanupWorkspace(child, true).startsWith('removed worktree'), true);
  assert.equal(existsSync(child.cwd), false, 'the child worktree is removed');
  assert.equal(git('-C', checkout, 'worktree', 'list', '--porcelain').includes(child.cwd), false, 'git no longer lists the child');
});

test('archive deletes an empty worktree branch and keeps one with work, a checked-out one, or a base in use (S-994)', () => {
  const branches = () => git('-C', checkout, 'branch', '--list', '--format=%(refname:short)').split('\n');
  const fromMain = (name) => made({ kind: 'worktree', repo: checkout, base: 'main' }, name);
  // Empty: nothing beyond the commit it was cut from, so the branch goes with the worktree.
  const empty = fromMain('s994-empty');
  assert.ok(branches().includes('stam/s994-empty'));
  assert.match(ws.cleanupWorkspace(empty, true), /branch stam\/s994-empty deleted/);
  assert.equal(branches().includes('stam/s994-empty'), false, 'the empty branch is deleted');
  // Own commit: kept, with the reason.
  const own = fromMain('s994-own');
  git('-C', own.cwd, 'commit', '-q', '--allow-empty', '-m', 'own work');
  assert.match(ws.cleanupWorkspace(own, true, true), /branch stam\/s994-own kept: it has commits of its own/);
  assert.ok(branches().includes('stam/s994-own'));
  // Checked out elsewhere: the branch stays.
  const shared = fromMain('s994-shared');
  git('-C', shared.cwd, 'checkout', '-q', '--detach');
  const other = join(work, 's994-other');
  git('-C', checkout, 'worktree', 'add', '-q', other, 'stam/s994-shared');
  assert.match(ws.cleanupWorkspace(shared, true), /kept: it is checked out in another worktree/);
  assert.ok(branches().includes('stam/s994-shared'));
  git('-C', checkout, 'worktree', 'remove', '--force', other);
  // Another live agent's worktree was cut from it (branchIsBase reads their stored workspaces): the branch stays.
  const base = fromMain('s994-base');
  const child = made({ kind: 'worktree', repo: base.cwd }, 's994-child');
  const asBase = (others) => ws.branchIsBase(base, others.map((o) => JSON.stringify(o)));
  assert.equal(asBase([]), false);
  assert.equal(asBase([{ worktree: { repo: base.cwd, path: 'x', branch: 'y' } }]), true, 'cut from its worktree');
  assert.equal(asBase([{ worktree: { repo: checkout, path: 'x', branch: 'y', base: 'stam/s994-base' } }]), true, 'cut from its branch');
  assert.equal(asBase([{ worktree: { repo: checkout, path: 'x', branch: 'y', base: 'main' } }, {}]), false);
  assert.match(ws.cleanupWorkspace(base, true, false, ws.branchIsBase(base, [JSON.stringify(child)])), /kept: another agent's worktree was cut from it/);
  assert.ok(branches().includes('stam/s994-base'));
  ws.cleanupWorkspace(child, true);
  // A tip on origin/main that is not the recorded base is empty too, so it goes.
  const onMain = fromMain('s994-onmain');
  git('-C', checkout, 'update-ref', 'refs/remotes/origin/main', git('-C', onMain.cwd, 'rev-parse', 'HEAD').trim());
  try {
    onMain.baseUsed = { ...onMain.baseUsed, sha: '0'.repeat(40) };
    assert.match(ws.cleanupWorkspace(onMain, true), /branch stam\/s994-onmain deleted/);
    assert.equal(branches().includes('stam/s994-onmain'), false);
  } finally {
    git('-C', checkout, 'update-ref', '-d', 'refs/remotes/origin/main');
  }
  // `git branch -d` refuses a tip the repo's HEAD doesn't contain: the branch stays and the archive succeeds.
  const unmerged = fromMain('s994-unmerged');
  git('-C', unmerged.cwd, 'commit', '-q', '--allow-empty', '-m', 'unmerged');
  unmerged.baseUsed = { ...unmerged.baseUsed, sha: git('-C', unmerged.cwd, 'rev-parse', 'HEAD').trim() };
  assert.match(ws.cleanupWorkspace(unmerged, true, true), /branch stam\/s994-unmerged kept: git branch -d refused/);
  assert.ok(branches().includes('stam/s994-unmerged'));
});

test('archive keeps the branch and succeeds when the empty-branch check throws (S-2740)', () => {
  // dropEmptyBranch runs `git worktree list` unguarded; a git on PATH that fails that one call makes it throw
  // after the worktree is already removed. cleanupWorkspace must report the branch as kept, not crash the archive.
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const shim = join(work, 'git-shim');
  mkdirSync(shim, { recursive: true });
  writeFileSync(join(shim, 'git'), `#!/bin/sh\ncase " $* " in *" worktree list "*) echo 'fatal: injected failure' >&2; exit 1 ;; esac\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const empty = made({ kind: 'worktree', repo: checkout, base: 'main' }, 's2740-throws');
  const savedPath = process.env.PATH;
  process.env.PATH = `${shim}:${savedPath}`;
  let out;
  try {
    out = ws.cleanupWorkspace(empty, true);
  } finally {
    process.env.PATH = savedPath;
  }
  assert.match(out, /^removed worktree .*; branch stam\/s2740-throws kept: couldn't check: /);
  assert.equal(existsSync(empty.cwd), false, 'the worktree is removed');
  assert.ok(git('-C', checkout, 'branch', '--list', 'stam/s2740-throws').includes('stam/s2740-throws'), 'the branch is kept');
});

test('archive of an agent without a worktree is a no-op, not a throw (S-2740)', () => {
  // The archive asks branchIsBase for every workspace, including a plain directory with no worktree.
  const plain = { kind: 'dir', path: elsewhere, cwd: elsewhere };
  assert.equal(ws.branchIsBase(plain, [JSON.stringify({ worktree: { repo: checkout, path: 'x', branch: 'y' } })]), false);
  assert.equal(ws.cleanupWorkspace(plain, true, false, false), 'nothing to clean up');
  assert.equal(ws.workspaceUnpushedRefusal(plain), null);
});

test('a developer that ends up without a worktree in the live deploy checkout is refused', () => {
  const real = realpathSync(checkout);
  const refuses = (type, workspace, what) => {
    const why = ws.spawnWorkspaceRefusal(type, workspace);
    assert.ok(why, `not refused: ${what}`);
    assert.match(why, /worktree: true/, 'the refusal says to pass worktree: true');
    assert.ok(why.includes(real), `the refusal names ${real}: ${why}`);
  };
  refuses(developer(), made({ kind: 'dir', path: checkout }), 'an explicit worktree: false');
  refuses(developer(), made({ kind: 'dir', path: join(checkout, 'src') }), 'a subdirectory of the checkout');
  refuses(developer(), made({ kind: 'instructions', text: 'make your own', cwd: checkout }), 'instructions in the checkout');
  // A script started somewhere safe that prints the checkout: the check reads the resolved cwd.
  refuses(developer(), made({ kind: 'script', command: 'printf %s ' + checkout, cwd: elsewhere }), 'a script that printed the checkout');
  // The other direction is fine: a script started in the checkout that prints a safe workspace.
  assert.equal(ws.spawnWorkspaceRefusal(developer(), made({ kind: 'script', command: 'printf %s ' + elsewhere, cwd: checkout })), null);
  // A linked worktree inside the checkout is its own working tree, so it is fine too.
  assert.equal(ws.spawnWorkspaceRefusal(developer(), made({ kind: 'dir', path: inside })), null);
});

test('the reviewer types default to their own worktree (S-990), and ring members get it through their type', () => {
  for (const name of ['reviewer', 'reviewer-opus']) {
    const t = types.agentType(name);
    assert.equal(t.worktree, true, `${name} defaults to a worktree`);
    assert.equal(ws.spawnWorkspaceSpec({}, t, checkout).kind, 'worktree', `${name} spawned in the live checkout gets a worktree`);
    // An explicit worktree: false into the live checkout is refused; into another directory it works.
    assert.equal(ws.spawnWorkspaceSpec({ worktree: false }, t, elsewhere).kind, 'dir');
    assert.ok(ws.spawnWorkspaceRefusal(t, made({ kind: 'dir', path: checkout })), `${name} without a worktree in the checkout is refused`);
  }
  // A ring spawns its members by type, so each member gets the worktree its own type defaults to.
  for (const member of types.agentType('review-ring').review.ring.members) {
    assert.equal(types.agentType(member).worktree, true, `ring member ${member} has a worktree default`);
  }
});

test('a registry-only type with `review` set and no worktree field still gets a worktree (S-990)', () => {
  const fallback = { name: 'reviewer-fallback', harness: 'claude', model: 'm', review: { fallback: null, ring: null } };
  assert.equal(ws.spawnWorkspaceSpec({}, fallback, checkout).kind, 'worktree');
  assert.equal(ws.spawnWorkspaceSpec({ worktree: false }, fallback, elsewhere).kind, 'dir');
  assert.ok(ws.spawnWorkspaceRefusal(fallback, made({ kind: 'dir', path: checkout })), 'refused in the live checkout without a worktree');
  assert.equal(ws.spawnWorkspaceRefusal(fallback, made({ kind: 'dir', path: elsewhere })), null);
});

test('a reviewer-type spawn from a non-git directory is a plain dir; an explicit worktree: true still asks for one', () => {
  const loose = join(work, 'not-a-repo');
  mkdirSync(loose, { recursive: true });
  assert.deepEqual(ws.spawnWorkspaceSpec({}, types.agentType('reviewer'), loose), { kind: 'dir', path: loose });
  assert.equal(ws.spawnWorkspaceSpec({ worktree: true }, types.agentType('reviewer'), loose).kind, 'worktree');
});

test('a manager may work in the checkout', () => {
  const atCheckout = made({ kind: 'dir', path: checkout });
  for (const name of ['manager', undefined]) {
    assert.equal(ws.spawnWorkspaceRefusal(name && types.agentType(name), atCheckout), null, `${name} is refused`);
  }
  assert.equal(ws.spawnWorkspaceRefusal(developer(), atCheckout) !== null, true, 'the developer is held to it');
});

test('the live deploy checkout is named by STAM_DEPLOY_REPO, else the release source, else ~/projects/stam2', () => {
  assert.equal(ws.deployCheckout(), checkout);
  delete process.env.STAM_DEPLOY_REPO;
  try {
    // This test runs from a checkout, so the repo settings name it: the fallback, not the override.
    assert.equal(ws.deployCheckout(), realpathSync(join(import.meta.dirname, '..')));
    assert.equal(ws.liveCheckoutRefusal(checkout), null, 'the temp checkout is not the live one without the override');
  } finally {
    process.env.STAM_DEPLOY_REPO = checkout;
  }
});

// A spawn's `base` (S-964): the branch is cut from that ref instead of main. A scratch repo with a
// bare "origin" holding an unmerged branch that the repo has not fetched yet.
test('a base ref cuts the worktree from it; no base is unchanged; an unknown ref leaves nothing', () => {
  const repo = join(work, 'based');
  const origin = join(work, 'based-origin.git');
  mkdirSync(repo);
  git('init', '-q', '-b', 'main', repo);
  git('-C', repo, 'commit', '-q', '--allow-empty', '-m', 'main one');
  git('init', '-q', '--bare', origin);
  git('-C', repo, 'remote', 'add', 'origin', origin);
  git('-C', repo, 'push', '-q', 'origin', 'main');
  git('-C', repo, 'checkout', '-q', '-b', 'stam/stacked');
  git('-C', repo, 'commit', '-q', '--allow-empty', '-m', 'stacked one');
  git('-C', repo, 'push', '-q', 'origin', 'stam/stacked');
  git('-C', repo, 'checkout', '-q', 'main');
  git('-C', repo, 'branch', '-q', '-D', 'stam/stacked');
  git('-C', repo, 'update-ref', '-d', 'refs/remotes/origin/stam/stacked');
  const stacked = git('--git-dir', origin, 'rev-parse', 'refs/heads/stam/stacked').trim();
  const main = git('-C', repo, 'rev-parse', 'main').trim();
  const head = (w) => git('-C', w.cwd, 'rev-parse', 'HEAD').trim();

  // The spec carries base only when given.
  assert.deepEqual(ws.spawnWorkspaceSpec({ base: 'origin/stam/stacked' }, developer(), repo), { kind: 'worktree', repo, branch: undefined, base: 'origin/stam/stacked' });

  const plain = ws.createWorkspace({ kind: 'worktree', repo }, 'based-plain');
  assert.equal(head(plain), main, 'without base the branch is cut from the repo HEAD, as before');
  assert.equal(plain.worktree.base, undefined);

  const remote = ws.createWorkspace({ kind: 'worktree', repo, base: 'origin/stam/stacked' }, 'based-remote');
  assert.equal(head(remote), stacked, 'a remote branch the repo had not fetched is fetched, then used');
  assert.equal(remote.worktree.base, 'origin/stam/stacked');

  git('-C', repo, 'branch', 'local-base', stacked);
  const local = ws.createWorkspace({ kind: 'worktree', repo, base: 'local-base' }, 'based-local');
  assert.equal(head(local), stacked, 'a local branch works too');

  const before = git('-C', repo, 'worktree', 'list');
  assert.throws(() => ws.createWorkspace({ kind: 'worktree', repo, base: 'origin/stam/nope' }, 'based-bad'), /base origin\/stam\/nope does not resolve/);
  assert.equal(git('-C', repo, 'worktree', 'list'), before, 'no worktree is added');
  assert.equal(existsSync(join(process.env.STAM_HOME, 'worktrees', 'based-based-bad')), false);
  assert.equal(git('-C', repo, 'branch', '--list', 'stam/based-bad').trim(), '', 'no branch is made');
});

test('the live deploy checkout does not follow settings or the PR target (S-2083)', async () => {
  const settingsMod = await import('../src/settings.ts');
  delete process.env.STAM_DEPLOY_REPO;
  const before = ws.deployCheckout();
  try {
    settingsMod.setSetting('itsa', { ...settingsMod.settings().itsa, repos: { other: checkout, stam2: checkout }, prOpen: { ...settingsMod.settings().itsa.prOpen, repo: 'other' } });
    assert.equal(ws.deployCheckout(), before);
  } finally {
    process.env.STAM_DEPLOY_REPO = checkout;
  }
});
