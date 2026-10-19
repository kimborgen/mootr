#!/usr/bin/env node
// The pre-deploy canary (S-1749). Before the deploy watcher restarts live, it runs the new release as a scratch daemon
// on a copy of stam.db under a fixed synthetic load, next to the release that runs now on another copy under the same
// load, and holds the deploy when the new one regresses. aa181742 (S-1725) is the case: event-loop stalls on every
// activity change, which only showed after the live restart, and rolled back.
//   node scripts/canary.mjs SHA     exit 0 pass, 1 regression, 2 the canary couldn't run (never a pass)
// The steps: build SHA's release without switching to it (`stam deploy --build-only`), copy stam.db in one step
// (VACUUM INTO, which a busy live daemon can't restart), then for the baseline (releases/current) and the new release in
// turn: copy that into a fresh STAM_HOME, start `daemon run` from the release at nice priority on a fresh port and tmux
// socket, wait for its health, and for STAM_CANARY_LOAD_S replay hook and statusline POSTs (activity changes) on the
// db's newest agents while /api/health and /api/health/db are timed and the event-loop stalls the daemon reports
// (src/stall.ts) are collected. Stalls before the load starts are the daemon's startup, reported apart, not judged.
// The new release regresses when a probe fails, a probe is slow more often than the baseline's (capped) plus a margin
// (the larger of STAM_CANARY_SLOW_MARGIN and STAM_CANARY_SLOW_FRACTION of the samples, S-1862), its stalls under load
// add up to more than STAM_CANARY_STALL_FACTOR times the baseline's plus STAM_CANARY_STALL_MARGIN_MS, or more load
// requests fail. A run with no load (no agents, or a baseline that took none) can't judge, so it is an error. A release
// that started and fails is run once more on the same build and db copy, against the same baseline, and fails only when
// the rerun fails too (STAM_CANARY_RERUN=0 turns that off): one noisy run under machine load doesn't hold a deploy.
// Isolation of the canary's daemons: each gets its own HOME and STAM_HOME, a stub folder first on PATH whose tmux,
// harnesses, gh, ssh, systemctl, sudo, tailscale and pkill only record the call and fail, the same stubs as its harness
// binaries, no peers, no model or GitHub endpoints, and no push devices or peer outbox in its db copy. The build step is
// `stam deploy --build-only`, whose own check (src/deploy.ts) starts a scratch daemon on a private tmux socket, as every
// deploy does. Every run folder, the db copy with it, is removed on every path; a SIGTERM or an abort stops the
// daemons and the build and removes it too, and a run killed outright is swept by the next one.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { getPriority, homedir, hostname, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
// A URL nothing listens on: the daemon's model, GitHub, voice and registry calls fail at once.
const DEAD_URL = 'http://127.0.0.1:9';
// What the stubs stand in for: tmux and every harness, the commands that reach other machines, and the ones that
// change this machine's services or processes.
const STUBS = ['tmux', 'claude', 'codex', 'opencode', 'gh', 'ssh', 'systemctl', 'sudo', 'tailscale', 'pkill'];
// The tables stripped from the copy: what would reach outside (push notifications, mail to peers).
const STRIPPED = ['push_devices', 'peer_outbox'];

// Everything the canary reads from the environment. Durations are milliseconds unless the name says seconds.
export function canaryConfig(env = process.env) {
  const home = env.STAM_HOME || join(homedir(), '.local/share/stam');
  return {
    home,
    db: join(home, 'stam.db'),
    releases: join(home, 'releases'),
    repo: env.STAM_DEPLOY_REPO || join(homedir(), 'projects/stam2'),
    // The run folders, on disk: /tmp may be RAM (tmpfs), and the db is copied into it.
    tmp: env.STAM_CANARY_TMP || join(homedir(), '.cache', 'stam-canary'),
    // The machine the scratch daemon calls itself: the db's own, so its agents are local to it as they are live.
    machine: env.STAM_CANARY_MACHINE || hostname(),
    // Prints the new release's folder on its last line.
    build: env.STAM_CANARY_BUILD_CMD ?? 'bin/stam deploy --build-only "$CANARY_SHA"',
    buildMs: Number(env.STAM_CANARY_BUILD_TIMEOUT_S ?? 360) * 1000,
    backupMs: Number(env.STAM_CANARY_BACKUP_TIMEOUT_S ?? 120) * 1000,
    // The baseline's release folder; releases/current when unset.
    baseline: env.STAM_CANARY_BASELINE || undefined,
    // The build and the daemons run at this nice; the caller's own priority is left alone.
    nice: Number(env.STAM_CANARY_NICE ?? 10),
    startMs: Number(env.STAM_CANARY_START_S ?? 90) * 1000,
    loadMs: Number(env.STAM_CANARY_LOAD_S ?? 60) * 1000,
    sampleMs: Number(env.STAM_CANARY_SAMPLE_MS ?? 2000),
    // The pause between two load requests.
    paceMs: Number(env.STAM_CANARY_PACE_MS ?? 25),
    agents: Number(env.STAM_CANARY_AGENTS ?? 24),
    slowS: Number(env.STAM_DEPLOY_SLOW_S ?? 0.1),
    stallMarginMs: Number(env.STAM_CANARY_STALL_MARGIN_MS ?? 1000),
    stallFactor: Number(env.STAM_CANARY_STALL_FACTOR ?? 2),
    // How many slow samples a probe may have beyond the baseline's (S-1862): at least slowMargin (the watcher's 2), and
    // slowFraction of the samples when that is more, so 3 of 30 over 0.1 s on a busy machine isn't a regression.
    slowMargin: Number(env.STAM_CANARY_SLOW_MARGIN ?? 2),
    slowFraction: Number(env.STAM_CANARY_SLOW_FRACTION ?? 0.15),
    // A failing release runs once more before the canary says fail (S-1862).
    rerun: env.STAM_CANARY_RERUN !== '0',
  };
}

// The longest one request to the scratch daemon waits (call's fetch timeout).
const CALL_MS = 5000;
// The longest a canary runs: the build, the db copy, then the daemons (the baseline, the new release, and its rerun,
// S-1862), each with its start, its load, and its stop (15 s), plus the requests that can start just before a deadline
// and run their whole timeout: the last start check, the last load request, the last two probes, and the final stall read.
export const canaryWorst = (c) => c.buildMs + c.backupMs + (c.rerun ? 3 : 2) * (c.startMs + c.loadMs + 15_000 + 5 * CALL_MS);

// What a SIGTERM must clean up: the process groups still running (daemons, builds, copies) and the run folders.
const live = { groups: new Set(), dirs: new Set() };

function cleanup() {
  for (const pid of live.groups) killTree(pid);
  live.groups.clear();
  for (const dir of live.dirs) rmSync(dir, { recursive: true, force: true });
  live.dirs.clear();
}

// Signals a process started detached, as its group's leader: the whole group, then the pid itself.
function killGroup(pid, signal) {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, signal);
    } catch {}
  }
}

// What a build's check() (src/deploy.ts) leaves when the build is killed: its daemon's tmux server, which setsid takes
// out of the group, and its stam-check-* home. Read from the env of the group's processes, before they are killed:
// only a stam-check-* socket and a stam-check-* folder in the temp dir are ever taken.
function checkLeftovers(pgid) {
  const sockets = new Set();
  const homes = new Set();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      // After the command name: state, ppid, pgrp.
      if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]) !== pgid) continue;
      const env = Object.fromEntries(readFileSync(`/proc/${name}/environ`, 'utf8').split('\0').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
      if (/^stam-check-[\w-]+$/.test(env.STAM_TMUX_SOCKET ?? '')) sockets.add(env.STAM_TMUX_SOCKET);
      const home = env.STAM_HOME ?? '';
      if (dirname(home) === tmpdir() && basename(home).startsWith('stam-check-')) homes.add(home);
    } catch {}
  }
  return { sockets, homes };
}

// Kills a group for good, and what a check() in it left outside the group.
function killTree(pid) {
  const left = checkLeftovers(pid);
  killGroup(pid, 'SIGKILL');
  for (const socket of left.sockets) spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore', timeout: 5000 });
  for (const home of left.homes) rmSync(home, { recursive: true, force: true });
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

// Removes what a canary killed outright left: a run folder whose canary is gone, after stopping the daemons that
// still run from it. A daemon is stopped only when its pid file is in that folder and its cwd is that home, so
// nothing else is ever killed.
export function sweepStale(c) {
  if (!existsSync(c.tmp)) return;
  for (const name of readdirSync(c.tmp)) {
    const pid = Number(/^run-(\d+)-/.exec(name)?.[1]);
    if (!pid || alive(pid)) continue;
    const run = join(c.tmp, name);
    for (const sub of existsSync(run) ? readdirSync(run) : []) {
      const home = join(run, sub);
      let daemon;
      try {
        daemon = Number(readFileSync(join(home, 'daemon.pid'), 'utf8'));
      } catch {
        continue;
      }
      let cwd;
      try {
        cwd = readlinkSync(`/proc/${daemon}/cwd`);
      } catch {
        continue;
      }
      if (cwd === home || cwd === realpathSync(home)) killGroup(daemon, 'SIGKILL');
    }
    rmSync(run, { recursive: true, force: true });
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

// The stubs, each a script that appends its name and arguments to the stub log and fails.
function writeStubs(dir, logFile) {
  mkdirSync(dir, { recursive: true });
  for (const name of STUBS) {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> '${logFile}'\necho "${name}: not available in the canary" >&2\nexit 1\n`);
    chmodSync(file, 0o755);
  }
}

// Runs a command in its own process group, tracked for cleanup, killed as a group at its timeout or on abort.
// Resolves with its status and output; never rejects.
function runGroup(command, args, { cwd, env, timeout, signal, nice }) {
  return new Promise((done) => {
    // An abort that came first never starts the command (an 'abort' listener doesn't fire for a past abort).
    if (signal?.aborted) return done({ status: 1, stdout: '', stderr: 'aborted', timedOut: false });
    const argv = nice === undefined ? [command, ...args] : ['nice', '-n', String(nice), command, ...args];
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    live.groups.add(child.pid);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeout);
    const abort = () => killTree(child.pid);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', (e) => (stderr += e.message));
    child.on('close', (status) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      // Anything the command left in its group goes with it.
      killTree(child.pid);
      live.groups.delete(child.pid);
      done({ status: status ?? 1, stdout, stderr, timedOut });
    });
  });
}

// The copy, in a child so its timeout can kill it: one VACUUM INTO, a single statement over one read snapshot, so the
// live daemon's writes can't restart it as they restart the online backup's steps. Then the copy is stripped of
// STRIPPED, and the newest Claude Code agents are printed, as JSON, for the load.
const COPY = `
import { DatabaseSync } from 'node:sqlite';
const [src, dst, wanted, stripped] = process.argv.slice(1);
const db = new DatabaseSync(src, { readOnly: true });
try { db.prepare('VACUUM INTO ?').run(dst); } finally { db.close(); }
const copy = new DatabaseSync(dst);
try {
  for (const t of JSON.parse(stripped)) { try { copy.exec('DELETE FROM ' + t); } catch {} }
  const ids = copy.prepare("SELECT id FROM agents WHERE harness = 'claude' ORDER BY rowid DESC LIMIT ?").all(Number(wanted)).map((r) => r.id);
  console.log(JSON.stringify(ids));
} finally { copy.close(); }
`;

// Copies the db to `file` and returns the agents the load acts on. Throws on a missing db, a failed or timed-out copy,
// or a copy with no agents table.
export async function copyDb(c, file, signal) {
  if (!existsSync(c.db)) throw new Error(`no database at ${c.db}`);
  const r = await runGroup(process.execPath, ['--no-warnings', '--input-type=module', '-e', COPY, c.db, file, String(c.agents), JSON.stringify(STRIPPED)], { env: process.env, timeout: c.backupMs, signal });
  // The error line of the child's stack ("Error: no such table: agents"), else its last lines.
  const why = () => r.stderr.split('\n').find((l) => /^\w*Error\b/.test(l.trim()))?.trim() ?? r.stderr.trim().split('\n').slice(-3).join('\n');
  if (r.status !== 0 || r.timedOut) throw new Error(r.timedOut ? `timed out after ${c.backupMs / 1000} s` : why());
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const dbBytes = (c) => [c.db, `${c.db}-wal`].reduce((n, f) => n + (existsSync(f) ? statSync(f).size : 0), 0);

// The new release's folder, from the build command's last line, and whether the build created it: its
// `build-only: created NAME` line (S-1750); a build that prints none (an older stam, a test's build) reused it. The build
// runs in its own group at the canary's nice: a timeout or an abort kills it whole (npm, the build's check daemon), so
// nothing outlives it.
async function buildNew(c, sha, signal) {
  const r = await runGroup('sh', ['-c', c.build], { cwd: c.repo, env: { ...process.env, CANARY_SHA: sha }, timeout: c.buildMs, signal, nice: c.nice });
  const out = `${r.stdout}${r.stderr}`.trim();
  if (r.status !== 0 || r.timedOut) throw new Error(`building ${sha.slice(0, 10)} ${r.timedOut ? 'timed out' : `exited ${r.status}`}: ${out.split('\n').slice(-5).join('\n')}`);
  const dir = r.stdout.trim().split('\n').pop()?.trim();
  if (!dir || !existsSync(join(dir, 'src', 'cli.ts'))) throw new Error(`the build of ${sha.slice(0, 10)} named no release folder: ${out.split('\n').slice(-3).join('\n')}`);
  return { dir, created: new RegExp(`^build-only: created ${basename(dir)}$`, 'm').test(r.stdout) };
}

// One authenticated request to the scratch daemon, timed. `ok` is a 2xx answer; `body` the parsed JSON, or {}.
async function call(port, token, method, path, body) {
  const t0 = performance.now();
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(CALL_MS),
    });
    const text = await r.text();
    let parsed = {};
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { ok: r.status < 300, status: r.status, secs: (performance.now() - t0) / 1000, body: parsed && typeof parsed === 'object' ? parsed : {} };
  } catch (e) {
    return { ok: false, status: 0, secs: (performance.now() - t0) / 1000, body: {}, error: e.message };
  }
}

// One agent's turn, as Claude Code's hooks and status line report it: each request changes its activity.
const STATUSLINE = { session_id: 'canary', model: { id: 'canary' }, context_window: { total_input_tokens: 1000, context_window_size: 200000 }, cost: { total_cost_usd: 0 } };
const TURN = [
  ['hook', { hook_event_name: 'UserPromptSubmit', session_id: 'canary', prompt: 'canary load' }],
  ['statusline', STATUSLINE],
  ['hook', { hook_event_name: 'PreToolUse', session_id: 'canary', tool_name: 'Bash', tool_input: {} }],
  ['hook', { hook_event_name: 'PostToolUse', session_id: 'canary', tool_name: 'Bash', tool_input: {} }],
  ['hook', { hook_event_name: 'Stop', session_id: 'canary', last_assistant_message: 'canary', stop_hook_active: false }],
];

const stallStats = () => ({ count: 0, totalMs: 0, maxMs: 0, labels: {} });

// Runs one release on its own copy of the db, under the load, and returns what it measured. `started` is false
// when it never answered its health; `log` then holds the end of its daemon log.
export async function runRelease(c, release, name, run, dbFile, agents, signal) {
  const home = join(run, name);
  mkdirSync(home, { recursive: true });
  copyFileSync(dbFile, join(home, 'stam.db'));
  // The process runner never spawns or mails from a canary.
  writeFileSync(join(home, 'settings.json'), `${JSON.stringify({ process: { run: 'off' } })}\n`);
  const stubs = join(run, `stubs-${name}`);
  const stubLog = join(run, `stub-calls-${name}.log`);
  writeStubs(stubs, stubLog);
  const port = await freePort();
  const env = {
    PATH: `${stubs}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: home,
    LANG: process.env.LANG ?? 'C.UTF-8',
    STAM_HOME: home,
    STAM_PORT: String(port),
    STAM_TMUX_SOCKET: `stam-canary-${basename(run)}-${name}`,
    STAM_BIND: '127.0.0.1',
    STAM_MACHINE: c.machine,
    STAM_RELEASE_ID: basename(release),
    STAM_OPENCODE_PORT: String(await freePort()),
    STAM_CLAUDE_BIN: join(stubs, 'claude'),
    STAM_CODEX_BIN: join(stubs, 'codex'),
    STAM_OPENCODE_BIN: join(stubs, 'opencode'),
    STAM_EMBEDDER: 'stub',
    STAM_OPENROUTER_URL: DEAD_URL,
    STAM_GITHUB_API: DEAD_URL,
    STAM_ELEVENLABS_URL: DEAD_URL,
    STAM_MCP_REGISTRY_URL: DEAD_URL,
  };
  const logFile = join(home, 'daemon.log');
  const fd = openSync(logFile, 'a');
  const t0 = performance.now();
  // Detached, so the daemon leads its own group and a stop takes its workers with it. `nice` execs the daemon, so the
  // pid is the daemon's.
  const child = spawn('nice', ['-n', String(c.nice), process.execPath, '--no-warnings', join(release, 'src', 'cli.ts'), 'daemon', 'run'], { cwd: home, env, stdio: ['ignore', fd, fd], detached: true });
  closeSync(fd);
  live.groups.add(child.pid);
  writeFileSync(join(home, 'daemon.pid'), String(child.pid));
  let exited = false;
  child.on('exit', () => (exited = true));
  const res = { name, release: basename(release), started: false, startMs: 0, nice: undefined, health: probeStats(), db: probeStats(), load: { ok: 0, failed: 0 }, startup: stallStats(), stalls: stallStats(), stubCalls: [], log: '' };
  // Stalls the daemon logged before the load started are its startup's; the rest are the load's.
  let loadFrom = Infinity;
  const seen = new Set();
  const noteStalls = (body) => {
    for (const s of Array.isArray(body.stalls) ? body.stalls : []) {
      const key = `${s.at}|${s.ms}|${s.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const into = Date.parse(s.at) >= loadFrom ? res.stalls : res.startup;
      into.count++;
      into.totalMs += s.ms;
      into.maxMs = Math.max(into.maxMs, s.ms);
      into.labels[s.label] = (into.labels[s.label] ?? 0) + s.ms;
    }
  };
  const stopped = () => exited || signal?.aborted;
  try {
    let token;
    const until = Date.now() + c.startMs;
    while (!stopped() && Date.now() < until) {
      try {
        token ??= readFileSync(join(home, 'token'), 'utf8').trim();
      } catch {}
      if (token) {
        const h = await call(port, token, 'GET', '/api/health');
        if (h.ok && h.body.ok === true) {
          res.started = true;
          noteStalls(h.body);
          break;
        }
      }
      await sleep(250);
    }
    res.startMs = Math.round(performance.now() - t0);
    try {
      res.nice = getPriority(child.pid);
    } catch {}
    if (!res.started) {
      res.log = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').slice(-15).join('\n') : '';
      return res;
    }
    loadFrom = Date.now();
    const end = loadFrom + c.loadMs;
    const load = async () => {
      for (let i = 0; Date.now() < end && !stopped(); i++) {
        if (!agents.length) return;
        const agent = agents[Math.floor(i / TURN.length) % agents.length];
        const [kind, body] = TURN[i % TURN.length];
        const r = await call(port, token, 'POST', `/api/${kind}/claude/${encodeURIComponent(agent)}`, body);
        res.load[r.ok ? 'ok' : 'failed']++;
        if (c.paceMs > 0) await sleep(c.paceMs);
      }
    };
    const probe = async () => {
      while (Date.now() < end && !stopped()) {
        const h = await call(port, token, 'GET', '/api/health');
        noteProbe(res.health, h, c, (b) => b.ok === true);
        noteStalls(h.body);
        noteProbe(res.db, await call(port, token, 'GET', '/api/health/db'), c, (b) => b.ok === true);
        await sleep(Math.max(0, Math.min(c.sampleMs, end - Date.now())));
      }
    };
    await Promise.all([load(), probe()]);
    // The stalls of the load's last moments.
    if (!stopped()) noteStalls((await call(port, token, 'GET', '/api/health')).body);
    if (exited) res.log = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').slice(-15).join('\n') : '';
    res.exited = exited;
    return res;
  } finally {
    killGroup(child.pid, 'SIGTERM');
    for (let i = 0; i < 50 && !exited; i++) await sleep(100);
    killGroup(child.pid, 'SIGKILL');
    live.groups.delete(child.pid);
    res.stubCalls = existsSync(stubLog) ? readFileSync(stubLog, 'utf8').split('\n').filter(Boolean) : [];
    // Each copy goes as soon as its run ends, so the disk holds at most the db copy and one daemon's copy.
    rmSync(home, { recursive: true, force: true });
  }
}

const probeStats = () => ({ n: 0, failed: 0, slow: 0, maxS: 0 });

function noteProbe(stats, r, c, up) {
  stats.n++;
  if (!r.ok || !up(r.body)) return void stats.failed++;
  if (r.secs > c.slowS) stats.slow++;
  stats.maxS = Math.max(stats.maxS, r.secs);
}

// Why the new release regresses against the baseline, one reason each; empty when it doesn't.
export function judge(c, base, next) {
  const why = [];
  if (!next.started) return [`it never answered /api/health in ${Math.round(c.startMs / 1000)} s`];
  if (next.exited) why.push('it exited during the load');
  for (const probe of ['health', 'db']) {
    const n = next[probe];
    const b = base[probe];
    if (n.failed > 0) why.push(`${n.failed} of ${n.n} ${probe} probes failed`);
    const allowed = Math.min(b.slow, Math.floor(b.n / 2)) + Math.max(c.slowMargin, Math.ceil(c.slowFraction * n.n));
    if (n.slow > allowed) why.push(`${n.slow} of ${n.n} ${probe} probes over ${c.slowS} s (baseline ${b.slow})`);
  }
  const stallLimit = c.stallFactor * base.stalls.totalMs + c.stallMarginMs;
  if (next.stalls.totalMs > stallLimit) why.push(`event-loop stalls under load added up to ${next.stalls.totalMs} ms (baseline ${base.stalls.totalMs} ms, limit ${stallLimit} ms)`);
  if (next.load.failed > 2 * base.load.failed + 5) why.push(`${next.load.failed} load requests failed (baseline ${base.load.failed})`);
  // A release that took none of the load fails, however many the baseline failed: the canary can't pass it blind.
  else if (next.load.ok === 0 && next.load.failed > 0) why.push(`all ${next.load.failed} load requests failed (baseline ${base.load.failed} of ${base.load.ok + base.load.failed})`);
  return why;
}

// Labels with the most stall ms, as `label N ms`, the top three.
const topLabels = (s) =>
  Object.entries(s.labels)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([label, ms]) => `${label} ${ms} ms`)
    .join(', ');

// One release's numbers as a line, for the canary's output and the watcher's hold mail.
export function describeRun(r) {
  if (!r.started) return `${r.name} ${r.release}: never answered /api/health in ${Math.round(r.startMs / 1000)} s`;
  const top = topLabels(r.stalls);
  // The stubs the daemon called, by name: proof it reached no tmux or harness.
  const stubs = Object.entries(Object.groupBy(r.stubCalls, (l) => l.split(' ')[0])).map(([name, calls]) => `${name} ${calls.length}`);
  return `${r.name} ${r.release}: up in ${(r.startMs / 1000).toFixed(1)} s at nice ${r.nice} (startup stalls ${r.startup.count}, ${r.startup.totalMs} ms); under load: stalls ${r.stalls.count}, ${r.stalls.totalMs} ms, max ${r.stalls.maxMs} ms${top ? ` (${top})` : ''}; health ${r.health.failed} failed, ${r.health.slow} slow of ${r.health.n}; db ${r.db.failed} failed, ${r.db.slow} slow of ${r.db.n}; load ${r.load.ok} ok, ${r.load.failed} failed; stub calls: ${stubs.join(', ') || 'none'}`;
}

// The canary of one sha, the function the watcher's later steps call with a sha (bisection, S-1750; auto-lift, S-1770).
// Returns { verdict: 'pass' | 'fail' | 'error', reasons, base, next }: 'error' when it couldn't run or couldn't judge
// (no db, the copy, the build, a full disk, no load, a baseline that won't start, or `signal` aborted), never a pass.
// Each call has its own run folder, removed when it returns, and an abort stops its daemons and its build. Once the
// build ran, the result has `built: { release, created }`: its release folder's name, and whether this build made it.
export async function canary(c, sha, log = console.log, signal) {
  const box = {};
  const r = await canaryRun(c, sha, log, signal, box);
  return box.built ? { ...r, built: box.built } : r;
}

async function canaryRun(c, sha, log, signal, box) {
  mkdirSync(c.tmp, { recursive: true });
  sweepStale(c);
  const run = mkdtempSync(join(c.tmp, `run-${process.pid}-`));
  live.dirs.add(run);
  const canceled = () => ({ verdict: 'error', reasons: ['canceled'] });
  try {
    if (signal?.aborted) return canceled();
    const need = 3 * dbBytes(c);
    const { bavail, bsize } = statfsSync(c.tmp);
    if (bavail * bsize < need) return { verdict: 'error', reasons: [`${c.tmp} has ${Math.round((bavail * bsize) / 1e6)} MB free; the db copy and a daemon's copy need ${Math.round(need / 1e6)} MB`] };
    let baseline;
    try {
      baseline = c.baseline ?? realpathSync(join(c.releases, 'current'));
    } catch {
      return { verdict: 'error', reasons: [`no ${join(c.releases, 'current')} to compare with`] };
    }
    let next;
    try {
      const built = await buildNew(c, sha, signal);
      next = built.dir;
      box.built = { release: basename(built.dir), created: built.created };
    } catch (e) {
      return signal?.aborted ? canceled() : { verdict: 'error', reasons: [e.message] };
    }
    if (signal?.aborted) return canceled();
    const dbFile = join(run, 'copy.db');
    let agents;
    try {
      agents = await copyDb(c, dbFile, signal);
    } catch (e) {
      return signal?.aborted ? canceled() : { verdict: 'error', reasons: [`the db copy failed: ${e.message}`] };
    }
    if (!agents.length) return { verdict: 'error', reasons: ['the db has no Claude Code agents to put load on'] };
    log(`canary: ${agents.length} agents under load, ${Math.round(c.loadMs / 1000)} s per release`);
    if (signal?.aborted) return canceled();
    const base = await runRelease(c, baseline, 'baseline', run, dbFile, agents, signal);
    if (signal?.aborted) return canceled();
    log(`canary: ${describeRun(base)}`);
    if (!base.started) return { verdict: 'error', reasons: [`the baseline ${base.release} never answered /api/health`, base.log], base };
    if (base.exited) return { verdict: 'error', reasons: [`the baseline ${base.release} exited during the load, so nothing can be compared`, base.log], base };
    if (base.load.ok === 0) return { verdict: 'error', reasons: [`the baseline ${base.release} took no load (${base.load.failed} requests failed), so nothing can be compared`], base };
    let fresh = await runRelease(c, next, 'new', run, dbFile, agents, signal);
    if (signal?.aborted) return canceled();
    log(`canary: ${describeRun(fresh)}`);
    let reasons = judge(c, base, fresh);
    // A release that ran and failed runs again on the same build and copy, against the same baseline (S-1862): it fails
    // only when the rerun does too. One that never started or exited fails at once.
    let first;
    if (reasons.length && c.rerun && fresh.started && !fresh.exited) {
      first = reasons;
      log(`canary: the new release failed (${reasons.join('; ')}); running it once more`);
      fresh = await runRelease(c, next, 'rerun', run, dbFile, agents, signal);
      if (signal?.aborted) return canceled();
      log(`canary: ${describeRun(fresh)}`);
      reasons = judge(c, base, fresh);
      if (reasons.length) reasons = [...reasons, `the first run failed too: ${first.join('; ')}`];
    }
    // A release that started and failed every load request is caught by judge; one that got no request at all can't be judged.
    if (fresh.started && !fresh.exited && fresh.load.ok + fresh.load.failed === 0) return { verdict: 'error', reasons: [`no load reached ${fresh.release}`], base, next: fresh };
    if (!fresh.started || fresh.exited) reasons.push(fresh.log);
    return { verdict: reasons.length ? 'fail' : 'pass', reasons, base, next: fresh, ...(first ? { first } : {}) };
  } finally {
    rmSync(run, { recursive: true, force: true });
    live.dirs.delete(run);
  }
}

const EXIT = { pass: 0, fail: 1, error: 2 };

async function cli(args) {
  if (args.length !== 1 || !/^[0-9a-f]{7,40}$/.test(args[0])) {
    console.error('usage: node scripts/canary.mjs SHA');
    process.exit(2);
  }
  // The watcher's timeout and systemd's stop send SIGTERM: the daemons and the build stop and the run folder goes before exiting.
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.once(sig, () => {
      cleanup();
      process.exit(143);
    });
  }
  // A crash is an error, never read as a regression: the daemons and the build stop and the run folder goes.
  const crashed = (e) => {
    cleanup();
    console.log(`canary: error: crashed: ${e?.message ?? e}`);
    process.exit(2);
  };
  process.on('uncaughtException', crashed);
  process.on('unhandledRejection', crashed);
  let r;
  try {
    r = await canary(canaryConfig(), args[0]);
  } catch (e) {
    cleanup();
    console.log(`canary: error: ${e.message}`);
    process.exit(2);
  }
  const reasons = r.reasons.filter(Boolean).join('; ');
  console.log(`canary: ${r.verdict}${reasons ? `: ${reasons}` : ''}`);
  process.exit(EXIT[r.verdict]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) cli(process.argv.slice(2));
