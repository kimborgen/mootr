#!/usr/bin/env node
// Unit tests for the agent sweep's selection (src/proctree.ts, S-323): processes carrying the
// agent's id are its own, but a daemon it ran by hand, and the worker that daemon started with
// the id inherited, are not, with or without the pane; nor is another agent's process in its
// tree. Real processes, all started and killed here by pid; no daemon, no network, no sleeps:
// `node --test test/proctree.test.mjs`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentProcesses, dirProcesses } from '../src/proctree.ts';
import { tempDir } from './tmphome.mjs';

const dir = tempDir('stam-proctree-');
const ID = `proctree-${process.pid}`;
const started = [];
// The sweep protects the checkout's parent folder (the worktrees folder, or ~/projects), and under
// test/run.sh TMPDIR is a folder inside the worktree, so a scratch base made in `dir` reads as protected.
// The removeAgentScratchDirs tests make theirs in ~/.cache instead; each is removed when the run ends.
const scratchRoots = [];
function scratchRoot() {
  mkdirSync(join(homedir(), '.cache'), { recursive: true });
  const root = mkdtempSync(join(homedir(), '.cache', 'stam-proctree-scratch-'));
  scratchRoots.push(root);
  return root;
}
after(() => {
  for (const p of started) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {}
  }
  rmSync(dir, { recursive: true, force: true });
  for (const r of scratchRoots) rmSync(r, { recursive: true, force: true });
});

// A stand-in daemon: its command line is `node DIR/cli.ts daemon run`, as a real one's, and it
// starts a worker that inherits its env, the agent's id with it.
writeFileSync(
  join(dir, 'cli.ts'),
  `import { spawn, spawnSync } from 'node:child_process';
const w = spawn('sh', ['-c', 'echo $$ >"$0"; exec sleep 3600', process.argv[4]], { stdio: 'ignore' });
setInterval(() => {}, 1 << 30);
`,
);

async function pidFile(name) {
  const f = join(dir, name);
  while (!existsSync(f) || !readFileSync(f, 'utf8').trim()) await new Promise((r) => setImmediate(r));
  const pid = Number(readFileSync(f, 'utf8'));
  started.push(pid);
  return pid;
}
function run(cmd, args, env) {
  const c = spawn(cmd, args, { stdio: 'ignore', env: { ...process.env, ...env } });
  started.push(c.pid);
  return c.pid;
}

// The pane: a shell with the agent's id that runs the daemon by hand, a process of another
// agent with a child of its own, and an orphan that keeps the id (its parent exits). The pane
// is itself orphaned, so this test's own env (an agent's id when an agent runs it) is not above it.
writeFileSync(
  join(dir, 'pane.sh'),
  `${process.execPath} --no-warnings ${dir}/cli.ts daemon run ${dir}/worker.pid &
echo $! >${dir}/daemon.pid
STAM_AGENT_ID=another sh -c 'sleep 3600 & echo $! >${dir}/under-other.pid; echo $$ >${dir}/other.pid; exec sleep 3600' &
(sleep 3600 & echo $! >${dir}/orphan.pid) &
echo $$ >${dir}/pane.pid; exec sleep 3600
`,
);
run('sh', ['-c', `sh ${dir}/pane.sh </dev/null >/dev/null 2>&1 &`], { STAM_AGENT_ID: ID });
const [pane, daemon, worker, other, underOther, orphan] = await Promise.all(['pane.pid', 'daemon.pid', 'worker.pid', 'other.pid', 'under-other.pid', 'orphan.pid'].map(pidFile));

for (const [how, panePid] of [['with the pane', pane], ['without the pane', undefined]]) {
  test(`${how}: the agent's processes are taken, a hand-run daemon's and another agent's are not`, () => {
    const got = agentProcesses(ID, panePid);
    assert.ok(got.has(orphan), 'the orphan with the id is taken');
    assert.ok(got.has(pane), 'the pane shell, with the id, is taken');
    for (const [name, pid] of Object.entries({ daemon, worker, other, underOther }))
      assert.ok(!got.has(pid), `${name} (${pid}) is spared`);
  });
}

test('pids in spare, and this process and its ancestors, are never taken', () => {
  const got = agentProcesses(ID, pane, [orphan]);
  assert.ok(!got.has(orphan));
  assert.ok(!got.has(process.pid));
});

// S-428: what lies in an archived agent's worktree. Taken: a leftover with the agent's id, by cwd or
// by argv, and a test daemon without the id whose STAM_HOME is a stam-* folder. Spared: a person's
// process (no id, no test home), another agent's, one elsewhere.
test('dirProcesses takes the agent\'s and a test\'s processes in the directory, and spares others', async () => {
  const wt = join(dir, 'wt');
  mkdirSync(wt);
  const base = { ...process.env };
  delete base.STAM_AGENT_ID;
  delete base.STAM_HOME;
  const sp = (cmd, args, opts = {}) => {
    const c = spawn(cmd, args, { stdio: 'ignore', detached: true, env: base, ...opts });
    started.push(c.pid);
    c.unref();
    return c.pid;
  };
  const loop = ['-c', 'while :; do sleep 1; done'];
  const mine = { ...base, STAM_AGENT_ID: ID };
  const byCwd = sp('sh', loop, { cwd: wt, env: mine });
  const byArgv = sp('sh', [...loop, `${wt}/x`], { env: mine });
  const testDaemon = sp('sh', loop, { cwd: wt, env: { ...base, STAM_HOME: join(dir, 'stam-test.user.AbC123', 'main') } });
  const person = sp('sh', loop, { cwd: wt });
  const elsewhere = sp('sh', loop, { env: mine });
  const otherAgent = sp('sh', loop, { cwd: wt, env: { ...base, STAM_AGENT_ID: 'another' } });
  // Wait until each has exec'd sh, so /proc shows its final cwd, argv and env.
  for (const p of [byCwd, byArgv, testDaemon, person, elsewhere, otherAgent])
    while (readFileSync(`/proc/${p}/cmdline`, 'utf8').startsWith(process.execPath)) await new Promise((r) => setImmediate(r));
  const got = dirProcesses(wt, ID);
  assert.ok(got.has(byCwd), 'a leftover with the agent\'s id and its cwd inside is taken');
  assert.ok(got.has(byArgv), 'a path inside in argv is taken');
  assert.ok(got.has(testDaemon), 'a test daemon with a stam-* STAM_HOME is taken');
  assert.ok(!got.has(person), 'a person\'s process with no id and no test home is spared');
  assert.ok(!got.has(elsewhere), 'a process elsewhere is spared');
  assert.ok(!got.has(otherAgent), 'another agent\'s process is spared');
  assert.ok(!got.has(process.pid), 'this process is spared');
  assert.equal(dirProcesses(join(dir, 'missing'), ID).size, 0);
});

// S-604: an archived agent's Claude Code scratch dir.
test('removeClaudeScratch: removed alone, kept when shared, protected, in use, or outside the base', async () => {
  const { removeClaudeScratch, claudeSlug } = await import('../src/proctree.ts');
  const base = join(dir, 'claude-tmp');
  process.env.STAM_CLAUDE_TMP = base;
  const mk = (cwd) => {
    const d = join(base, claudeSlug(cwd));
    mkdirSync(join(d, 'tasks'), { recursive: true });
    writeFileSync(join(d, 'tasks', 'x'), 'x');
    return d;
  };
  try {
    assert.equal(claudeSlug('/home/user/.local/share/stam/worktrees/stam2-ui'), '-home-user--local-share-stam-worktrees-stam2-ui');
    const a = mk('/wt/a');
    assert.match(removeClaudeScratch('/wt/a', ['/wt/other']), /removed/);
    assert.equal(existsSync(a), false);
    const b = mk('/wt/b');
    assert.match(removeClaudeScratch('/wt/b', ['/wt/b']), /kept/);
    assert.equal(existsSync(b), true);
    // The main checkout is STAM_REPO here; without it, the settings' repo for stam2 is used.
    process.env.STAM_REPO = join(dir, 'main-checkout');
    for (const c of [homedir(), process.env.STAM_REPO]) {
      const d = mk(c);
      assert.match(removeClaudeScratch(c, []), /kept/);
      assert.equal(existsSync(d), true);
    }
    delete process.env.STAM_REPO;
    // The settings' repo for stam2 is passed by the caller (proctree must not import settings, S-1249).
    const viaSettings = mk(join(dir, 'settings-checkout'));
    assert.match(removeClaudeScratch(join(dir, 'settings-checkout'), [], join(dir, 'settings-checkout')), /kept/);
    assert.equal(existsSync(viaSettings), true);
    const busy = mk('/wt/busy');
    const pid = run('sleep', ['3600']);
    const sh = spawn('sleep', ['3600'], { cwd: busy, stdio: 'ignore' });
    started.push(sh.pid);
    assert.match(removeClaudeScratch('/wt/busy', []), /process uses/);
    assert.equal(existsSync(busy), true);
    process.kill(sh.pid, 'SIGKILL');
    process.kill(pid, 'SIGKILL');
    // A cwd that slugs to nothing under the base is refused, and an empty slug never reaches rmSync.
    assert.match(removeClaudeScratch('', []), /refused/);
    assert.equal(existsSync(base), true);
  } finally {
    delete process.env.STAM_CLAUDE_TMP;
  }
});

// S-733: an archived agent's worktrees and scratch clones under stam-wt and stam-test.
test('removeAgentScratchDirs: removes its worktree and clone, spares others, live, in-use dirs', async () => {
  const dir = scratchRoot();
  const { removeAgentScratchDirs } = await import('../src/proctree.ts');
  const { execFileSync } = await import('node:child_process');
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', encoding: 'utf8' });
  const main = join(dir, 'scr-main');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'x');
  // The main checkout is never pushed; each worktree's own branch is (S-2298: a worktree is judged by its HEAD).
  const scrOrigin = join(dir, 'scr-origin.git');
  git(dir, 'init', '-q', '--bare', scrOrigin);
  git(main, 'remote', 'add', 'origin', scrOrigin);
  const wt = join(dir, 'scr-wt'), tst = join(dir, 'scr-test');
  mkdirSync(wt);
  mkdirSync(tst);
  const addWt = (n) => {
    git(main, 'worktree', 'add', '-q', '-b', `b-${n}`, join(wt, n));
    git(join(wt, n), 'push', '-q', 'origin', `b-${n}`);
  };
  for (const n of ['mine', 'mine2', 'live', 'busy']) addWt(n);
  // An unrelated unpushed branch on the shared refs: it must not keep a pushed worktree.
  const ident = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];
  const unrelated = git(main, ...ident, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'unrelated').trim();
  git(main, 'update-ref', 'refs/heads/unrelated', unrelated);
  mkdirSync(join(tst, 'mine', 'node_modules'), { recursive: true });
  mkdirSync(join(tst, 'other'));
  mkdirSync(join(tst, 'stam-test.aid1.abc123'));
  mkdirSync(join(tst, 'stam-test.aid12.abc123'));
  const ag = { id: 'aid1', name: 'mine' };
  const sh = spawn('sleep', ['3600'], { cwd: join(wt, 'busy'), stdio: 'ignore' });
  started.push(sh.pid);
  const msgs = await removeAgentScratchDirs(ag, [join(wt, 'live', 'sub')], [wt, tst]);
  assert.equal(existsSync(join(wt, 'mine')), false);
  assert.equal(existsSync(join(tst, 'mine')), false);
  assert.equal(existsSync(join(tst, 'stam-test.aid1.abc123')), false);
  assert.equal(existsSync(join(tst, 'stam-test.aid12.abc123')), true, 'another agent id with the same prefix is spared');
  assert.equal(existsSync(join(wt, 'mine2')), true, 'a name that only starts the same is spared');
  assert.equal(existsSync(join(tst, 'other')), true);
  assert.doesNotMatch(git(main, 'worktree', 'list'), /scr-wt\/mine /, 'worktree metadata is gone');
  assert.match(git(main, 'worktree', 'list'), /mine2/);
  assert.match(msgs.join('\n'), /removed worktree/);
  // live agent's and in-use dirs are kept
  for (const n of ['live', 'busy']) {
    await removeAgentScratchDirs({ id: 'x', name: n }, n === 'live' ? [join(wt, 'live')] : [], [wt]);
    assert.equal(existsSync(join(wt, n)), true, `${n} kept`);
  }
});

// S-2298: a scratch clone with commits on no remote is moved aside, never deleted; a pushed clone and a plain
// folder are deleted; a repo whose state can't be read is kept (moved aside too).
test('removeAgentScratchDirs: keeps a clone with unpushed commits or an unreadable repo, deletes a pushed clone and a plain dir', async () => {
  const dir = scratchRoot();
  const { removeAgentScratchDirs } = await import('../src/proctree.ts');
  const { execFileSync } = await import('node:child_process');
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', encoding: 'utf8' });
  const ident = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];
  const bare = join(dir, 'k-origin.git'), src = join(dir, 'k-src'), kb = join(dir, 'k', 'stam-test');
  git(dir, 'init', '-q', '--bare', bare);
  mkdirSync(src);
  git(src, 'init', '-q', '-b', 'main');
  git(src, ...ident, 'commit', '-q', '--allow-empty', '-m', 'x');
  git(src, 'remote', 'add', 'origin', bare);
  git(src, 'push', '-q', 'origin', 'main');
  mkdirSync(kb, { recursive: true });
  git(kb, 'clone', '-q', bare, 'pushed');
  git(kb, 'clone', '-q', bare, 'unpushed');
  git(join(kb, 'unpushed'), ...ident, 'commit', '-q', '--allow-empty', '-m', 'local only');
  mkdirSync(join(kb, 'broken'));
  writeFileSync(join(kb, 'broken', '.git'), 'gitdir: /nonexistent/stam-k\n');
  mkdirSync(join(kb, 'plain'));
  writeFileSync(join(kb, 'plain', 'a.txt'), 'x');

  const msg = (await removeAgentScratchDirs({ id: 'kid', name: 'unpushed' }, [], [kb])).join('\n');
  assert.equal(existsSync(join(kb, 'unpushed')), false, 'moved out of the scratch base');
  assert.match(msg, /kept, has 1 commit on no remote \(head [0-9a-f]+\); moved to .*\/stam-kept\//);
  const kept = msg.match(/moved to (\S+)/)[1];
  assert.equal(git(kept, 'log', '-1', '--format=%s').trim(), 'local only', 'the commit is still there');

  await removeAgentScratchDirs({ id: 'kid', name: 'pushed' }, [], [kb]);
  assert.equal(existsSync(join(kb, 'pushed')), false, 'a pushed clone is deleted');

  await removeAgentScratchDirs({ id: 'kid', name: 'plain' }, [], [kb]);
  assert.equal(existsSync(join(kb, 'plain')), false, 'a non-git dir is deleted');

  const broken = (await removeAgentScratchDirs({ id: 'kid', name: 'broken' }, [], [kb])).join('\n');
  assert.equal(existsSync(join(kb, 'broken')), false);
  assert.match(broken, /can't be read/);
  assert.equal(existsSync(broken.match(/moved to (\S+)/)[1]), true, 'an unreadable repo is kept, not deleted');
  // A test home (stam-test.ID.RAND) belongs to the test suites: its repo with no remote is deleted, not kept.
  const home = join(kb, 'stam-test.kid.abc');
  mkdirSync(home);
  git(home, 'init', '-q', '-b', 'main');
  git(home, ...ident, 'commit', '-q', '--allow-empty', '-m', 'test');
  await removeAgentScratchDirs({ id: 'kid', name: 'other' }, [], [kb]);
  assert.equal(existsSync(home), false, 'a test home is deleted as before');
});

// S-2298: a clone nested below the agent's dir (up to 3 levels) with commits on no remote keeps the whole dir.
test('removeAgentScratchDirs: keeps the agent dir when a nested clone has unpushed commits', async () => {
  const dir = scratchRoot();
  const { removeAgentScratchDirs } = await import('../src/proctree.ts');
  const { execFileSync } = await import('node:child_process');
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', encoding: 'utf8' });
  const ident = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];
  const bare = join(dir, 'n-origin.git'), src = join(dir, 'n-src'), nb = join(dir, 'n', 'stam-test');
  git(dir, 'init', '-q', '--bare', bare);
  mkdirSync(src);
  git(src, 'init', '-q', '-b', 'main');
  git(src, ...ident, 'commit', '-q', '--allow-empty', '-m', 'x');
  git(src, 'remote', 'add', 'origin', bare);
  git(src, 'push', '-q', 'origin', 'main');
  mkdirSync(join(nb, 'nest', 'work', 'app'), { recursive: true });
  git(join(nb, 'nest', 'work', 'app'), 'clone', '-q', bare, 'clone');
  git(join(nb, 'nest', 'work', 'app', 'clone'), ...ident, 'commit', '-q', '--allow-empty', '-m', 'nested local');

  const msg = (await removeAgentScratchDirs({ id: 'kid', name: 'nest' }, [], [nb])).join('\n');
  assert.equal(existsSync(join(nb, 'nest')), false, 'the agent dir is moved out whole');
  assert.match(msg, /kept, nested repo work\/app\/clone has 1 commit on no remote/);
  const kept = msg.match(/moved to (\S+)/)[1];
  assert.equal(git(join(kept, 'work', 'app', 'clone'), 'log', '-1', '--format=%s').trim(), 'nested local');
});

test('removeAgentScratchDirs: a symlinked base still sees processes, symlinked and protected dirs stay, a test home does nothing', async () => {
  const dir = scratchRoot();
  const { removeAgentScratchDirs } = await import('../src/proctree.ts');
  const real = join(dir, 'sl-real'), link = join(dir, 'sl-link');
  mkdirSync(join(real, 'busy'), { recursive: true });
  mkdirSync(join(real, 'elsewhere'), { recursive: true });
  symlinkSync(real, link);
  const sh = spawn('sleep', ['3600'], { cwd: join(real, 'busy'), stdio: 'ignore' });
  started.push(sh.pid);
  assert.match((await removeAgentScratchDirs({ id: 'a', name: 'busy' }, [], [link])).join(), /process uses/);
  assert.equal(existsSync(join(real, 'busy')), true, 'cwd is a realpath; the symlinked base must not hide it');
  // A symlink named for the agent is left alone, and so is what it points at.
  symlinkSync(join(real, 'elsewhere'), join(real, 'lnk'));
  assert.match((await removeAgentScratchDirs({ id: 'a', name: 'lnk' }, [], [real])).join(), /not a plain directory/);
  assert.equal(existsSync(join(real, 'elsewhere')), true);
  // Anything under ~/projects is refused, whatever the base.
  const oldHome = process.env.HOME;
  process.env.HOME = join(dir, 'fakehome');
  try {
    mkdirSync(join(dir, 'fakehome', 'projects', 'proj'), { recursive: true });
    assert.match((await removeAgentScratchDirs({ id: 'a', name: 'proj' }, [], [join(dir, 'fakehome', 'projects')])).join(), /refused, protected/);
    assert.equal(existsSync(join(dir, 'fakehome', 'projects', 'proj')), true);
    // In a test home the default bases (the real ~/.cache) are never scanned.
    const th = join(dir, 'th', 'home');
    mkdirSync(join(dir, 'fakehome', '.cache', 'stam-wt', 'victim'), { recursive: true });
    mkdirSync(th, { recursive: true });
    writeFileSync(join(th, '.stam-test-home'), '');
    writeFileSync(join(dir, 'th', 'owner'), 'x');
    const r = spawnSync(process.execPath, ['-e', `import('${join(process.cwd(), 'src/proctree.ts')}').then(async (m) => console.log(JSON.stringify(await m.removeAgentScratchDirs({ id: 'a', name: 'victim' }, []))))`], { env: { ...process.env, STAM_HOME: th, HOME: process.env.HOME, XDG_CACHE_HOME: '' }, encoding: 'utf8' });
    assert.equal(r.stdout.trim(), '[]', r.stderr);
    assert.equal(existsSync(join(dir, 'fakehome', '.cache', 'stam-wt', 'victim')), true);
  } finally {
    process.env.HOME = oldHome;
  }
});
