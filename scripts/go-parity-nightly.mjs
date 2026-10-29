#!/usr/bin/env node
// Nightly Go parity run (S-2297, S-2194): checks out origin/main into its own scratch clone, builds go/, runs
// scripts/go-parity.mjs over the FREE list with STAM_DAEMON=go, and publishes the result. Runs on goHost() only (STAM_GO_PARITY_HOST, default storage).
//
//   node scripts/go-parity-nightly.mjs            one run (refused with exit 75 while another run holds the lock)
//   node scripts/go-parity-nightly.mjs --install  write go-parity units (stam-* under a real stam home, mootr-* under a mootr one) to ~/.config/systemd/user, enable the timer
//   node scripts/go-parity-nightly.mjs --status   print the last run's one-line summary
//
// Files, under STAM_GO_PARITY_DIR (default STAM_HOME/go-parity): parity.json (the per-test results, the shape of
// docs/migration/parity.json), last-run.json (state, shas, counts, newly failing tests, the summary line), parity.prev.json
// (the night before), and lock. The summary line is also posted as a comment on S-2194. Only test names, counts and shas
// reach them: never a test's output, an environment variable or a token. docs/migration/parity.json on main is not touched;
// a module PR updates the committed copy.
//
// The run uses its own clone (DIR/repo), never ~/projects/stam2, and no live daemon. It takes one test slot
// (scripts/test-slot.sh). Its tests' daemons, tmux servers and homes are stopped when the run ends, however it ends:
// test/lib.sh cleans up on exit and a watchdog reaps a killed run; this script then sweeps what is left by pid, and the
// service's cgroup holds the rest. The run is stopped after STAM_GO_PARITY_TIMEOUT_S (default 4 h).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonCounts, goHost } from './go-parity.mjs';
import { envVar, withTwins } from '../src/env.ts';
import { defaultHome } from '../src/default-home.ts';
import { killTmuxServer } from '../src/tmux-socket.ts';
import { isMain } from './main-guard.mjs';
import { unitScript, unitToInstall } from './unit-names.mjs';

const SELF = fileURLToPath(import.meta.url);
const NAME = 'go-parity';
const ITSA = 'S-2194';
export const OWNER = 'go-parity-ni'; // STAM_AGENT_ID go-parity-nightly, as test/lib.sh cuts it to 12 characters
const LOCKED = 75;

// What the night did, from the two parity documents ({tests: {NAME: {status, daemon}}}). The headline counts the tests that
// start a daemon (daemonCounts): the others, node files and scripts with no daemon, say nothing about Go and are `na`.
// `prev` is null on the first night; a previous file with no `daemon` flags (written before they existed) gives no delta.
export function summarize(prev, next) {
  const c = daemonCounts(next.tests);
  const prevCounted = prev && Object.values(prev.tests ?? {}).some((t) => 'daemon' in t);
  const newlyFailing = prev ? Object.entries(next.tests).filter(([n, t]) => t.status === 'fail' && prev.tests?.[n]?.status === 'pass').map(([n]) => n).sort() : [];
  return { pass: c.pass, total: c.total, skip: c.skip, na: c.na, delta: prevCounted ? c.pass - daemonCounts(prev.tests).pass : null, first: !prev, newlyFailing };
}

// The one line posted on S-2194.
export function summaryLine({ state, go_sha, pass, total, skip, na, delta, first, newlyFailing, why }) {
  const sha = go_sha ? go_sha.slice(0, 8) : 'unknown';
  if (state !== 'ok') return `Nightly Go parity (main ${sha}): no result, ${why ?? state}.`;
  const change = first ? 'first run' : delta === null ? 'no earlier count' : `${delta >= 0 ? '+' : ''}${delta} since last night`;
  const extra = `${skip ? `, ${skip} skipped` : ''}, ${na} n/a`;
  const failing = newlyFailing.length ? `; newly failing: ${newlyFailing.slice(0, 10).join(', ')}${newlyFailing.length > 10 ? ` and ${newlyFailing.length - 10} more` : ''}` : '; none newly failing';
  return `Nightly Go parity (main ${sha}): ${pass} of ${total} daemon e2e tests pass (${change}${extra})${failing}.`;
}

// The service and timer texts. The script path is the release symlink's, so a deploy swaps the code under the timer.
export function unitTexts({ node, script, path, unit = `mootr-${NAME}` }) {
  return {
    service: [
      '[Unit]', 'Description=Nightly Go parity run over the FREE tests (S-2297, S-2194)', '',
      '[Service]', 'Type=oneshot',
      // The run stops itself after STAM_GO_PARITY_TIMEOUT_S (4 h); this is the cap above that. The default KillMode
      // (control-group) stops every process of a stopped run, including a daemon a test started with setsid.
      'TimeoutStartSec=5h',
      `Environment=PATH=${path}`,
      `ExecStart=${node} --no-warnings ${script}`, '',
    ].join('\n'),
    timer: [
      '[Unit]', 'Description=Run the Go parity run every night (S-2297)', '',
      // 03:30 host time: outside working hours. Persistent: a night the machine was off runs at the next boot.
      '[Timer]', 'OnCalendar=*-*-* 03:30:00', 'Persistent=true', `Unit=${unit}.service`, '',
      '[Install]', 'WantedBy=timers.target', '',
    ].join('\n'),
  };
}

export function install(env = process.env) {
  const dir = envVar('GO_PARITY_UNIT_DIR', env) || join(homedir(), '.config/systemd/user');
  mkdirSync(dir, { recursive: true });
  const home = envVar('HOME', env) || defaultHome();
  const UNIT = unitToInstall(dir, NAME, home);
  const script = unitScript(home, 'scripts/go-parity-nightly.mjs', SELF);
  const path = [dirname(process.execPath), join(homedir(), '.local/bin'), '/usr/local/bin', '/usr/bin', '/bin'].join(':');
  const { service, timer } = unitTexts({ node: process.execPath, script, path, unit: UNIT });
  writeFileSync(join(dir, `${UNIT}.service`), service);
  writeFileSync(join(dir, `${UNIT}.timer`), timer);
  if (!envVar('GO_PARITY_UNIT_DIR', env)) {
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
    spawnSync('systemctl', ['--user', 'enable', '--now', `${UNIT}.timer`], { stdio: 'inherit' });
  }
  console.log(`installed ${UNIT}.service and ${UNIT}.timer in ${dir}${envVar('GO_PARITY_UNIT_DIR', env) ? '; not enabled (test dir)' : ' and enabled the timer'}; runs ${script}`);
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || '').trim().split('\n')[0]}`);
  return r.stdout.trim();
}

// Stops what a run's tests left, by proof of ownership as test/test-watchdog.sh does: a home whose owner file names this
// run's agent id and a dead run, each daemon whose environment names that home, and its tmux server. Returns the homes removed.
export function sweepLeftovers(testTmp) {
  const removed = [];
  let names = [];
  try { names = readdirSync(testTmp).filter((n) => n.startsWith(`stam-test.${OWNER}.`)); } catch { return removed; }
  const read = (file, enc = 'utf8') => { try { return readFileSync(file, enc); } catch { return ''; } };
  for (const name of names) {
    const home = join(testTmp, name);
    const owner = read(join(home, 'owner'));
    const pid = /^pid=(\d+)$/m.exec(owner)?.[1];
    if (!new RegExp(`^agent=${OWNER}$`, 'm').test(owner)) continue;
    if (pid && existsSync(`/proc/${pid}`)) continue; // its run is still going
    for (const d of readdirSync(home, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const h = join(home, d.name);
      const dpid = Number(read(join(h, 'daemon.pid')).trim());
      if (dpid > 1 && read(`/proc/${dpid}/environ`, 'latin1').split('\0').includes(`STAM_HOME=${h}`)) process.kill(dpid, 'SIGKILL');
      const sock = /STAM_TMUX_SOCKET=(\S+)/.exec(read(join(h, 'test.env')))?.[1];
      if (sock) killTmuxServer(sock);
    }
    rmSync(home, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

// A guarded sweep: the files a crashed run left half written must not stop the sweep of the next home.
function safeSweep(testTmp) {
  try { return sweepLeftovers(testTmp); } catch (e) { console.error(`go-parity-nightly: sweep: ${e.message}`); return []; }
}

// Runs CMD in its own process group; after `limitMs` the group gets TERM, and KILL 30 s later. Resolves to { code, timedOut }.
function runLimited(cmd, args, opts, limitMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
    let timedOut = false;
    const kill = (sig) => { try { process.kill(-child.pid, sig); } catch { /* gone */ } };
    const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), 30000).unref(); }, limitMs);
    const onSignal = (sig) => () => { kill(sig); };
    for (const s of ['SIGTERM', 'SIGINT']) process.once(s, onSignal(s));
    child.on('close', (code) => { clearTimeout(timer); kill('SIGKILL'); resolve({ code, timedOut }); });
    child.on('error', () => { clearTimeout(timer); resolve({ code: 1, timedOut }); });
  });
}

async function run(env) {
  const home = envVar('HOME', env) || defaultHome();
  const dir = envVar('GO_PARITY_DIR', env) || join(home, 'go-parity');
  const repo = join(dir, 'repo');
  const testTmp = envVar('GO_PARITY_TESTTMP', env) || join(homedir(), '.cache/stam-test');
  const scratch = join(dir, 'tmp');
  const limitMs = Number(envVar('GO_PARITY_TIMEOUT_S', env) || 14400) * 1000;
  mkdirSync(scratch, { recursive: true });
  const result = { state: 'error', started_at: new Date().toISOString() };
  let doc = null;
  try {
    if (!existsSync(join(repo, '.git'))) {
      rmSync(repo, { recursive: true, force: true });
      const origin = envVar('GO_PARITY_REPO', env) || join(homedir(), 'projects/stam2.git');
      const r = spawnSync('git', ['clone', '--quiet', origin, repo], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error('clone failed');
    }
    git(repo, 'fetch', '--quiet', 'origin', 'main');
    git(repo, 'checkout', '--quiet', '--force', '--detach', 'origin/main');
    git(repo, 'clean', '-fdxq', '-e', 'node_modules');
    result.go_sha = git(repo, 'rev-parse', 'HEAD');
    const runEnv = { ...env, TMPDIR: scratch, ...withTwins({ STAM_TEST_TMPDIR: testTmp, STAM_AGENT_ID: 'go-parity-nightly', STAM_GO_PARITY_ANYHOST: envVar('GO_PARITY_ANYHOST', env) || '' }) };
    // The root dependencies: reinstalled when the lock changed, as scripts/ensure-deps.sh does for the live checkout.
    const lockFile = join(repo, 'package-lock.json');
    const lockSha = existsSync(lockFile) ? createHash('sha256').update(readFileSync(lockFile)).digest('hex') : null;
    const shaFile = join(dir, 'deps.sha');
    if (lockSha && (!existsSync(join(repo, 'node_modules')) || (existsSync(shaFile) ? readFileSync(shaFile, 'utf8') : '') !== lockSha)) {
      const r = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: repo, env: runEnv, stdio: 'ignore', timeout: 600000 });
      if (r.status !== 0) { result.state = 'install-failed'; result.why = 'npm ci failed'; throw new Error(result.why); }
      writeFileSync(shaFile, lockSha);
    }
    const built = spawnSync('sh', ['go/build.sh'], { cwd: repo, env: runEnv, stdio: 'ignore', timeout: 900000 });
    if (built.status !== 0) { result.state = 'build-failed'; result.why = 'go/build.sh failed'; throw new Error(result.why); }

    const file = join(dir, 'parity.json');
    // The first night starts from the committed copy, so the modules stay as the module PRs set them.
    // It has no run_at, which marks a file no run wrote: night 1 has no previous night to report a change against.
    if (!existsSync(file)) {
      const { run_at: _seeded, ...seed } = readJson(join(repo, 'docs/migration/parity.json')) ?? { tests: {} };
      writeJson(file, seed);
    }
    const prev = existsSync(file) && readJson(file)?.run_at ? readJson(file) : null;
    if (prev) writeJson(join(dir, 'parity.prev.json'), prev);
    const { code, timedOut } = await runLimited('sh', ['scripts/test-slot.sh', 'node', 'scripts/go-parity.mjs', '--file', file], { cwd: repo, env: runEnv }, limitMs);
    if (timedOut) { result.state = 'timeout'; result.why = `stopped after ${limitMs / 3600000} h`; throw new Error(result.why); }
    doc = readJson(file);
    if (code !== 0 || !doc) { result.state = 'run-failed'; result.why = `go-parity.mjs exited ${code}`; throw new Error(result.why); }
    Object.assign(result, { state: 'ok' }, summarize(prev, doc));
  } catch (e) {
    console.error(`go-parity-nightly: ${e.message}`);
  } finally {
    safeSweep(testTmp);
    rmSync(scratch, { recursive: true, force: true });
  }
  result.finished_at = new Date().toISOString();
  result.summary = summaryLine(result);
  writeJson(join(dir, 'last-run.json'), result);
  console.log(result.summary);
  post(env, result.summary);
  return result.state === 'ok' ? 0 : 1;
}

// Posts the line on S-2194 with the deployed CLI. A failed post is logged, never fatal: the files hold the result.
function post(env, note) {
  const stam = join(defaultHome(), 'releases/current');
  const cmd = envVar('GO_PARITY_POST_CMD', env) ?? 'bin/stam itsa post "$PARITY_ITSA" "$PARITY_NOTE" --system go-parity';
  const r = spawnSync('sh', ['-c', cmd], { cwd: envVar('GO_PARITY_POST_CWD', env) || stam, env: { ...env, PARITY_ITSA: ITSA, PARITY_NOTE: note }, stdio: 'ignore', timeout: 60000 });
  if (r.status !== 0) console.error(`go-parity-nightly: posting on ${ITSA} failed (exit ${r.status})`);
}

function main(args, env = process.env) {
  if (args[0] === '--install') return install(env);
  const dir = envVar('GO_PARITY_DIR', env) || join(envVar('HOME', env) || defaultHome(), 'go-parity');
  if (args[0] === '--status') {
    const last = readJson(join(dir, 'last-run.json'));
    console.log(last ? `${last.finished_at} ${last.summary}` : 'no run yet');
    return;
  }
  if (!envVar('GO_PARITY_ANYHOST', env) && hostname() !== goHost(env)) {
    console.error(`go-parity-nightly: runs on ${goHost(env)} only (this is ${hostname()})`);
    process.exit(2);
  }
  mkdirSync(dir, { recursive: true });
  if (args[0] === '--under-flock') return run(env).then((c) => process.exit(c));
  // One run at a time: the lock is taken here, before anything is checked out, and held until the run ends. -o keeps the
  // lock fd out of the run, so a daemon a test leaks can't hold it. -n: a second run is refused, not queued.
  const r = spawnSync('flock', ['-n', '-o', '-E', String(LOCKED), join(dir, 'lock'), process.execPath, '--no-warnings', SELF, '--under-flock'], { stdio: 'inherit', env });
  if (r.status === LOCKED) console.error('go-parity-nightly: another run holds the lock; refused');
  process.exit(r.status ?? 1);
}

// The unit runs it through the releases/current symlink, so compare real paths.
if (isMain(import.meta.url)) main(process.argv.slice(2));
