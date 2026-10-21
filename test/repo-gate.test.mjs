#!/usr/bin/env node
// The generic PR gate (S-2202, scripts/repo-gate.mjs): runs the gates .stam/repo.json picks for a PR on its head merged
// onto the base, reading the config from the base branch (a PR that weakens its own gates is still gated by main's),
// and posts stam/gates with `; base SHA` and a comment. Throwaway git repos and a fake gh reached only through STAM_GH.
// Run with `node --test test/repo-gate.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmphome.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const GATE = join(ROOT, 'scripts/repo-gate.mjs');

const CONFIG = {
  github: 'acme/widgets',
  gates: [
    { name: 'always', command: 'test -f README' },
    { name: 'web', command: 'test -f web/app.js', when: 'web/**' },
    { name: 'strict', command: 'echo strict ran; exit 4', when: 'strict/**' },
    { name: 'merged', command: 'test -f base-later && test -f merged/head', when: 'merged/**' },
    { name: 'named', command: 'exit 0', when: [] },
    // The isolation probes: what a gate's env holds, whether it can reach the checkout's git, a hang, a leftover child.
    { name: 'envcheck', command: 'test -z "$GH_TOKEN$GITHUB_TOKEN$STAM_TOKEN$SECRET_KEY" && test "$HOME" != "$REAL_HOME" && test "$PASSME" = yes && test "$STAM_GATE" = 1', when: 'envcheck/**' },
    { name: 'gitdir', command: 'test -z "$(git remote)" && git update-ref refs/heads/planted HEAD', when: 'gitdir/**' },
    { name: 'hang', command: 'sleep 60', when: 'hang/**' },
    { name: 'leftover', command: 'sleep 300 & echo $! > "$PIDFILE"', when: 'leftover/**' },
    { name: 'waiter', command: 'echo $$ > "$PIDFILE.tmp" && mv "$PIDFILE.tmp" "$PIDFILE" && exec sleep 300', when: 'waiter/**' },
    // Runs after waiter: a signal during waiter must not let it start.
    { name: 'second', command: 'echo $$ > "$PIDFILE.second" && exec sleep 300', when: 'second/**' },
  ],
};

let work, origin, seed, clone, ghBin;
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

function commit(files, msg, cwd = seed) {
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, f)), { recursive: true });
    writeFileSync(join(cwd, f), c);
  }
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', msg);
  return git(cwd, 'rev-parse', 'HEAD');
}

// A PR branch off main with FILES, pushed to origin; returns its head.
function openPr(n, files) {
  git(seed, 'checkout', '-q', '-B', `pr-${n}`, 'origin/main');
  const head = commit(files, `pr ${n}`);
  git(seed, 'push', '-q', '-f', 'origin', `pr-${n}`);
  git(seed, 'checkout', '-q', 'main');
  return head;
}

before(() => {
  work = tempDir('stam-repo-gate-');
  origin = join(work, 'origin.git');
  seed = join(work, 'seed');
  clone = join(work, 'clone');
  git(work, 'init', '-q', '--bare', '-b', 'main', origin);
  git(work, 'init', '-q', '-b', 'main', seed);
  git(seed, 'remote', 'add', 'origin', origin);
  commit({ README: 'x\n', '.stam/repo.json': JSON.stringify(CONFIG), 'conflict.txt': 'base\n' }, 'base');
  git(seed, 'push', '-q', 'origin', 'main');
  git(work, 'clone', '-q', origin, clone);
  // The fake gh: `pr view` serves pr-N.json from FAKE_GH_DIR; every other call is recorded in calls.jsonl, a comment
  // with its body. It is not on PATH, so only STAM_GH reaches it.
  ghBin = join(work, 'bin', 'fake-gh');
  mkdirSync(dirname(ghBin));
  writeFileSync(ghBin, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.env.FAKE_GH_DIR;
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(readFileSync(join(dir, \`pr-\${args[2]}.json\`), 'utf8'));
  process.exit(0);
}
let body;
if (args[0] === 'pr' && args[1] === 'comment') body = readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ args, body }) + '\\n');
`);
  chmodSync(ghBin, 0o755);
});
after(() => rmSync(work, { recursive: true, force: true }));

// Runs the gate on PR N as the fake gh serves it; returns the run, its status post and its comment.
function gate(name, n, { head, headRefName = `pr-${n}`, baseRefName = 'main', body = 'ITSA: S-1\nGates: auto\nDeploy: normal', env = {}, pr = {} }) {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `pr-${n}.json`), JSON.stringify({ headRefName, headRefOid: head, body, baseRefName, ...pr }));
  const r = spawnSync(process.execPath, [GATE, String(n)], {
    env: { ...process.env, STAM_GH: ghBin, FAKE_GH_DIR: dir, STAM_GATE_REPO: clone, STAM_REPO_GATE_CACHE: join(dir, 'cache'), ...env },
    encoding: 'utf8',
  });
  const file = join(dir, 'calls.jsonl');
  const calls = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  const post = calls.find((c) => c.args[0] === 'api');
  const field = (k) => post?.args.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1);
  const posted = post && { path: post.args[1], state: field('state'), context: field('context'), description: field('description') };
  const comment = calls.find((c) => c.args[1] === 'comment');
  return { ...r, posted, comment, calls };
}

const main = () => git(seed, 'rev-parse', 'origin/main');

test('the gates with no when and those a changed path matches pass: success with the base sha, on the config repo', () => {
  const head = openPr(1, { 'web/app.js': 'x\n' });
  const r = gate('pass', 1, { head });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.posted.state, 'success');
  assert.equal(r.posted.path, `repos/acme/widgets/statuses/${head}`);
  assert.equal(r.posted.context, 'stam/gates');
  assert.equal(r.posted.description, `gates pass: always, web; base ${main()}`);
  assert.deepEqual(r.comment.args.slice(0, 5), ['pr', 'comment', '1', '--repo', 'acme/widgets']);
  assert.match(r.comment.body, /- pass: always\n- pass: web$/);
  assert.equal(r.stdout.trim(), `success: ${r.posted.description}`);
});

test('a gate named on the Gates: line runs; a failing one fails the PR with its log tail', () => {
  const head = openPr(2, { 'strict/x': 'x\n' });
  const r = gate('fail', 2, { head, body: 'Gates: named' });
  assert.equal(r.posted.state, 'failure');
  assert.equal(r.posted.description, `gates fail: strict; base ${main()}`);
  assert.match(r.comment.body, /- pass: always\n- FAIL: strict \(exit 4\)\n\n {2}```\n {2}strict ran\n {2}```\n- pass: named/);
  assert.equal(r.status, 1);
});

test('a PR that rewrites .stam/repo.json is still gated by the base branch config', () => {
  const weakened = { ...CONFIG, gates: CONFIG.gates.map((g) => (g.name === 'strict' ? { ...g, command: 'exit 0' } : g)) };
  const head = openPr(3, { 'strict/x': 'x\n', '.stam/repo.json': JSON.stringify(weakened) });
  const r = gate('weaken', 3, { head });
  assert.equal(r.posted.state, 'failure');
  assert.match(r.posted.description, /^gates fail: strict;/);
});

test('the gates run on the head merged onto the current base, not the head alone', () => {
  const head = openPr(4, { 'merged/head': 'x\n' });
  git(seed, 'checkout', '-q', 'main');
  git(seed, 'reset', '-q', '--hard', 'origin/main');
  commit({ 'base-later': 'x\n' }, 'base moves on');
  git(seed, 'push', '-q', 'origin', 'main');
  const r = gate('merged', 4, { head });
  assert.equal(r.posted.state, 'success', r.comment?.body);
  assert.equal(r.posted.description, `gates pass: always, merged; base ${main()}`);
});

test('an unknown gate name, a conflict, a base that is not the main branch, and a moved head each fail without running gates', () => {
  const head = openPr(5, { 'web/app.js': 'x\n' });
  const unknown = gate('unknown', 5, { head, body: 'Gates: tsc; phone' });
  assert.equal(unknown.posted.state, 'failure');
  // The status description is cut at 140 characters; the comment has the whole list.
  assert.match(unknown.posted.description, /^unknown gates: tsc, phone; \.stam\/repo\.json has always, web, .*; base [0-9a-f]{40}$/);
  assert.match(unknown.comment.body, /unknown gates: tsc, phone; \.stam\/repo\.json has always, web, strict, merged, named, envcheck, gitdir, hang, leftover, waiter, second\./);

  const conflictHead = openPr(6, { 'conflict.txt': 'head\n' });
  git(seed, 'checkout', '-q', 'main');
  git(seed, 'reset', '-q', '--hard', 'origin/main');
  commit({ 'conflict.txt': 'main\n' }, 'main edits conflict.txt');
  git(seed, 'push', '-q', 'origin', 'main');
  const conflict = gate('conflict', 6, { head: conflictHead });
  assert.equal(conflict.posted.state, 'failure');
  assert.match(conflict.posted.description, /^merge conflict: conflict\.txt; base /);

  // A PR aimed at a branch that carries its own weak config (mainBranch set to itself) is refused: only origin's
  // default branch, or the settings' mainBranch, is trusted.
  openPr(8, { '.stam/repo.json': JSON.stringify({ ...CONFIG, mainBranch: 'pr-8', gates: [] }) });
  const stacked = gate('stacked', 5, { head, baseRefName: 'pr-8' });
  assert.equal(stacked.posted.state, 'failure');
  assert.equal(stacked.posted.description, 'base is pr-8, not main');
  // Settings may name another main branch; then that branch's config is the one read.
  const named = gate('settings-main', 5, { head, baseRefName: 'pr-8', env: { STAM_REPO_CONFIG: JSON.stringify({ mainBranch: 'pr-8' }) } });
  assert.match(named.posted.description, /^gates pass: no gates; base [0-9a-f]{40}$/);

  const moved = gate('moved', 5, { head: conflictHead });
  assert.equal(moved.posted.state, 'failure');
  assert.match(moved.comment.body, /^Gates not run: PR head moved to /);
});

test('with no config on the base the gate fails; a STAM_REPO_CONFIG fallback alone is enough', (t) => {
  const bare = join(work, 'bare-origin.git');
  const s = join(work, 'bare-seed');
  const c = join(work, 'bare-clone');
  git(work, 'init', '-q', '--bare', '-b', 'main', bare);
  git(work, 'init', '-q', '-b', 'main', s);
  git(s, 'remote', 'add', 'origin', bare);
  commit({ README: 'x\n' }, 'base', s);
  git(s, 'push', '-q', 'origin', 'main');
  git(s, 'checkout', '-q', '-b', 'pr-7');
  const head = commit({ 'a.txt': 'x\n' }, 'pr', s);
  git(s, 'push', '-q', 'origin', 'pr-7');
  git(work, 'clone', '-q', bare, c);
  const none = gate('no-config', 7, { head, env: { STAM_GATE_REPO: c } });
  assert.equal(none.posted.state, 'failure');
  assert.match(none.posted.description, /^main has no \.stam\/repo\.json/);
  // gh fills {owner}/{repo} from the checkout when nothing names the GitHub repo.
  assert.equal(none.posted.path, `repos/{owner}/{repo}/statuses/${head}`);

  const fb = gate('fallback', 7, { head, env: { STAM_GATE_REPO: c, STAM_REPO_CONFIG: JSON.stringify({ github: 'acme/fb', gates: [{ name: 'readme', command: 'test -f README' }] }) } });
  assert.equal(fb.posted.state, 'success');
  assert.equal(fb.posted.path, `repos/acme/fb/statuses/${head}`);
  assert.match(fb.posted.description, /^gates pass: readme; base /);
});

test('usage: a missing or non-numeric PR exits 2', () => {
  assert.equal(spawnSync(process.execPath, [GATE], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [GATE, 'abc'], { encoding: 'utf8' }).status, 2);
});

test('a gate gets an allowlisted env with a scratch HOME: no tokens or keys, only the extra names STAM_REPO_GATE_ENV lists', () => {
  const head = openPr(20, { 'envcheck/x': 'x\n' });
  const env = { GH_TOKEN: 'gh-secret', GITHUB_TOKEN: 'gh-secret', STAM_TOKEN: 'stam-secret', SECRET_KEY: 'k', REAL_HOME: process.env.HOME, PASSME: 'yes', STAM_REPO_GATE_ENV: 'PASSME,REAL_HOME' };
  const r = gate('env', 20, { head, env });
  assert.equal(r.posted.state, 'success', r.comment?.body);
  // Without the name in STAM_REPO_GATE_ENV, PASSME is dropped too.
  const dropped = gate('env-dropped', 20, { head, env: { ...env, STAM_REPO_GATE_ENV: 'REAL_HOME' } });
  assert.equal(dropped.posted.state, 'failure');
});

test("a gate runs in its own clone with no remote: it can't move the checkout's refs", () => {
  const head = openPr(21, { 'gitdir/x': 'x\n' });
  const r = gate('gitdir', 21, { head });
  assert.equal(r.posted.state, 'success', r.comment?.body);
  assert.equal(git(clone, 'for-each-ref', 'refs/heads/planted'), '', 'the planted ref stayed in the run\'s clone');
  assert.equal(git(clone, 'worktree', 'list').split('\n').length, 1, 'no worktree of the checkout was made');
});

test('a gate past its timeout is stopped and fails with "timed out"; a child it leaves behind is stopped too', () => {
  const head = openPr(22, { 'hang/x': 'x\n' });
  const r = gate('hang', 22, { head, env: { STAM_REPO_GATE_TIMEOUT_MIN: '0.02' } });
  assert.equal(r.posted.state, 'failure');
  assert.match(r.comment.body, /- FAIL: hang \(timed out after 0\.02 min\)/);

  const pidFile = join(work, 'leftover.pid');
  const left = gate('leftover', 23, { head: openPr(23, { 'leftover/x': 'x\n' }), env: { PIDFILE: pidFile, STAM_REPO_GATE_ENV: 'PIDFILE' } });
  assert.equal(left.posted.state, 'success', left.comment?.body);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the background sleep was stopped with its gate');
});

// Starts the gate on PR N, sends SIGTERM once the waiter gate runs, and returns the exit code, whether the waiter is still
// alive, and whether the second gate started or gh recorded a status or comment.
async function signalRun(name, n, files) {
  const head = openPr(n, files);
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `pr-${n}.json`), JSON.stringify({ headRefName: `pr-${n}`, headRefOid: head, body: 'ITSA: S-1\nGates: auto\nDeploy: normal', baseRefName: 'main' }));
  const pidFile = join(dir, 'waiter.pid');
  const run = spawn(process.execPath, [GATE, String(n)], {
    env: { ...process.env, STAM_GH: ghBin, FAKE_GH_DIR: dir, STAM_GATE_REPO: clone, STAM_REPO_GATE_CACHE: join(dir, 'cache'), PIDFILE: pidFile, STAM_REPO_GATE_ENV: 'PIDFILE' },
    stdio: 'ignore',
  });
  const exited = new Promise((r) => run.once('exit', (code) => r(code)));
  // The gate writes its pid once it runs (the file appears whole, by rename).
  while (!existsSync(pidFile)) await new Promise((r) => setTimeout(r, 50));
  const pid = Number(readFileSync(pidFile, 'utf8'));
  run.kill('SIGTERM');
  const code = await exited;
  // The stopped gate may stay a zombie for a moment, until init reaps it.
  let alive;
  try {
    alive = !/^Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]);
  } catch {
    alive = false;
  }
  return { code, alive, second: existsSync(`${pidFile}.second`), ghCalls: existsSync(join(dir, 'calls.jsonl')) ? readFileSync(join(dir, 'calls.jsonl'), 'utf8') : '' };
}

test('a signal during a gate stops it and starts no later gate; it exits 130 and posts nothing', async () => {
  const mid = await signalRun('signal-mid', 27, { 'waiter/x': 'x\n', 'second/x': 'x\n' });
  assert.equal(mid.code, 130);
  assert.equal(mid.alive, false, 'the gate was stopped with the run');
  assert.equal(mid.second, false, 'the gate after it never started');
  assert.equal(mid.ghCalls, '', 'no status or comment posted');
  // The final gate: its exit must not let the run go on to post a failure.
  const last = await signalRun('signal-last', 28, { 'waiter/x': 'x\n' });
  assert.equal(last.code, 130);
  assert.equal(last.alive, false);
  assert.equal(last.ghCalls, '', 'no status or comment posted');
});

test("each run keeps its own logs and comment file; a second run doesn't remove the first one's", () => {
  const head = openPr(24, { 'strict/x': 'x\n' });
  const env = { STAM_REPO_GATE_CACHE: join(work, 'shared-cache') };
  gate('logs-1', 24, { head, env });
  gate('logs-2', 24, { head, env });
  const runs = readdirSync(join(work, 'shared-cache', 'logs', 'pr-24'));
  assert.equal(runs.length, 2);
  for (const run of runs) assert.match(readFileSync(join(work, 'shared-cache', 'logs', 'pr-24', run, '2-strict.log'), 'utf8'), /strict ran/);
  assert.deepEqual(readdirSync(join(work, 'shared-cache')).filter((f) => f.endsWith('.md')), [], 'comment files are removed after posting');
});

// Starts a process group that holds flock on LOCK until it is killed; resolves once it holds it. The group is killed
// whole, since flock's child holds the lock's fd too.
function holdFlock(lock) {
  const child = spawn('flock', [lock, 'sh', '-c', 'echo held; exec sleep 300'], { stdio: ['ignore', 'pipe', 'inherit'], detached: true });
  return new Promise((r) => child.stdout.on('data', (d) => String(d).includes('held') && r(child)));
}

test('one run at a time: a held lock, empty as flock leaves it, makes a run wait and give up; a dead holder blocks nothing', async () => {
  const head = openPr(25, { a: '25\n' });
  const cache = join(work, 'lock-cache');
  mkdirSync(cache, { recursive: true });
  const lock = join(cache, 'gate.lock');
  const holder = await holdFlock(lock);
  try {
    assert.equal(readFileSync(lock, 'utf8'), '', 'the held lock file is empty');
    const held = gate('lock-held', 25, { head, env: { STAM_REPO_GATE_CACHE: cache, STAM_REPO_GATE_LOCK_WAIT_MIN: '0.01' } });
    assert.equal(held.status, 1);
    assert.match(held.stderr, /waiting for another gate run[\s\S]*another gate run holds .*gate\.lock/);
    assert.equal(held.posted, undefined, 'nothing posted without the lock');
  } finally {
    const gone = new Promise((r) => holder.once('exit', r));
    process.kill(-holder.pid, 'SIGKILL');
    await gone;
  }
  // The killed holder's lock file is still there; the kernel released its lock.
  assert.ok(existsSync(lock));
  const taken = gate('lock-dead', 25, { head, env: { STAM_REPO_GATE_CACHE: cache } });
  assert.equal(taken.posted.state, 'success', taken.stderr);
});

test('concurrent runs never overlap: each holds the lock from start to end', async () => {
  const cache = join(work, 'lock-race');
  const log = join(work, 'lock-race.log');
  const run = (name) =>
    new Promise((r) => {
      const code = `import { withLock } from ${JSON.stringify(GATE)};
import { appendFileSync } from 'node:fs';
await withLock(process.env, async () => {
  appendFileSync(process.env.LOG, 'start ${name}\\n');
  await new Promise((s) => setTimeout(s, 200));
  appendFileSync(process.env.LOG, 'end ${name}\\n');
});`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
        env: { ...process.env, STAM_REPO_GATE_CACHE: cache, LOG: log },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let err = '';
      child.stderr.on('data', (d) => (err += d));
      child.on('exit', (status) => r({ status, err }));
    });
  const results = await Promise.all(['a', 'b', 'c', 'd'].map(run));
  for (const res of results) assert.equal(res.status, 0, res.err);
  const lines = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 8);
  for (let i = 0; i < lines.length; i += 2) {
    const name = lines[i].replace(/^start /, '');
    assert.equal(lines[i], `start ${name}`, lines.join('\n'));
    assert.equal(lines[i + 1], `end ${name}`, `a run started inside another's:\n${lines.join('\n')}`);
  }
});

test("a fork PR is refused as unsupported, not read as a moved head", () => {
  const head = openPr(26, { a: '26\n' });
  const r = gate('fork', 26, { head, pr: { isCrossRepository: true, headRepositoryOwner: { login: 'someone' } } });
  assert.equal(r.posted.state, 'failure');
  assert.equal(r.posted.description, "fork PRs aren't supported (head someone:pr-26)");
});
