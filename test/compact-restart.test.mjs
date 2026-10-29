#!/usr/bin/env node
// What a restarted daemon does with a compaction it cut short (S-358). A compaction that finished
// or failed isn't "cut short", so a later real exit stays an exit, and neither is one of a harness
// whose compaction keeps it up (Codex, OpenCode). One with neither is recovered: a compactor still
// running on the agent's session (marked STAM_COMPACTOR, or a legacy headless one in its workspace)
// is stopped and confirmed gone before the one compaction runs, without waiting on it, so other lost
// agents recover too; the same holds for an S-257 context-exit recovery. The recover action stays set
// until the resume, marked compacted once the compaction ran, and an agent archived meanwhile isn't
// relaunched. Runs against a throwaway STAM_HOME and tmux
// socket with a fake harness; no daemon, no network, no models: `node --test test/compact-restart.test.mjs`.
import { test, before, after } from 'node:test';
import { killTmuxServer } from '../src/tmux-socket.ts';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-compact-restart-');
const socket = `compact-restart-test-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
// The private tmux server goes with the process on every exit, even when after() never runs (a signal, a crash).
process.on('exit', () => killTmuxServer(socket));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(130));
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_COMPACTOR']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [] }));
// recoverLost waits for the network first; this test has none.
globalThis.fetch = async () => ({ ok: true });

let db, lifecycle;
// How the fake harness's compaction ends, per agent id: 'done', 'fail', or a promise it waits on.
const plan = new Map();
// Per agent id: compactions run, whether one ran while a stray compactor was alive, and launches.
const compactions = new Map();
const overlaps = new Map();
const launches = new Map();
// The pending action each launch saw: the recover action, until the launch clears it.
const pendingAtLaunch = new Map();
const children = [];
// Running, as /proc says: a zombie has exited and waits only for this process to reap it.
function alive(c) {
  try {
    return !/^\S+ \(.*\) Z /.test(readFileSync(`/proc/${c.pid}/stat`, 'utf8'));
  } catch {
    return false;
  }
}
before(async () => {
  db = await import('../src/db.ts');
  lifecycle = await import('../src/lifecycle.ts');
  const { adapters } = await import('../src/adapters/index.ts');
  adapters.fake = {
    pushPrompt: async () => true,
    launch: async (a) => {
      launches.set(a.id, (launches.get(a.id) ?? 0) + 1);
      pendingAtLaunch.set(a.id, a.pending_action);
      return { argv: ['sleep', '600'], env: {} };
    },
    afterLaunch: async () => {},
    compact: async (a) => {
      compactions.set(a.id, (compactions.get(a.id) ?? 0) + 1);
      if (children.some((c) => c.agent === a.id && alive(c))) overlaps.set(a.id, true);
      const how = plan.get(a.id);
      if (how === 'fail') throw new Error('compaction failed');
      if (how && how !== 'done') await how;
      return { relaunch: false };
    },
    compactQuits: true,
  };
  // A harness whose compaction keeps it running, as Codex's and OpenCode's do.
  adapters['fake-live'] = { ...adapters.fake, compactQuits: undefined };
});
after(() => {
  for (const c of children) c.kill('SIGKILL');
  killTmuxServer(socket);
  rmSync(home, { recursive: true, force: true });
});

let n = 0;
function agent(how = 'done', harness = 'fake') {
  const id = db.newAgentId();
  const cwd = join(home, `work-${id}`);
  mkdirSync(cwd);
  db.createAgent({ id, name: `c${++n}`, role: '', machine: 'test', harness, model: null, effort: null, cwd, parent_id: null, session_id: `sess-${id}` });
  db.updateAgent(id, { lifecycle: 'active', activity: 'idle' });
  plan.set(id, how);
  return db.getAgent(id);
}
const events = (id, type) => db.listEvents(id, 500).filter((e) => e.type === type);
// The fake compactor's script. It exits once this test process or its home is gone (S-428), so a
// test killed hard leaves no compactor running for good.
const FAKE_COMPACTOR = `const [t, h] = [${process.pid}, ${JSON.stringify(home)}];
setInterval(() => {
  try { process.kill(t, 0); require('node:fs').statSync(h); } catch { process.exit(0); }
}, 1000);`;
// A headless compactor left by the old daemon: `-p … --resume SESSION`, in `cwd`, with `env` added.
async function compactor(a, { cwd = a.cwd, env = {} } = {}) {
  const c = spawn(process.execPath, ['-e', FAKE_COMPACTOR, '--', '-p', '--resume', a.session_id, '--output-format', 'json'], { cwd, env: { ...process.env, ...env }, stdio: 'ignore' });
  c.agent = a.id;
  children.push(c);
  await new Promise((r) => c.once('spawn', r));
  return c;
}
// The daemon stopped mid-compaction: an unfinished `compact` event (a legacy one has no op), harness down.
function cutShort(a, op) {
  db.addEvent(a.id, 'compact', { reason: 'idle past the cache lifetime', ...(op ? { op } : {}) });
  assert.equal(lifecycle.compactionExit(db.getAgent(a.id)), true);
  assert.equal(db.getAgent(a.id).lifecycle, 'shut_down');
}
const until = async (f) => {
  for (let i = 0; i < 500 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(f());
};

test('a finished compaction is not cut short: a later exit stays an exit', async () => {
  const a = agent('done');
  await lifecycle.requestCompaction(a, { reason: 'test' });
  assert.equal(events(a.id, 'compact:done').length, 1);
  assert.equal(lifecycle.compactionInterrupted(db.getAgent(a.id)), null);
  assert.equal(lifecycle.compactionExit(db.getAgent(a.id)), false);
  assert.equal(db.getAgent(a.id).lifecycle, 'active', 'left for the exit check');
});

test('a failed compaction is not cut short either', async () => {
  const a = agent('fail');
  await assert.rejects(lifecycle.requestCompaction(a, { reason: 'test' }));
  assert.equal(events(a.id, 'compact:failed').length, 1);
  assert.equal(lifecycle.compactionInterrupted(db.getAgent(a.id)), null);
  assert.equal(lifecycle.compactionExit(db.getAgent(a.id)), false);
});

test('two lost agents: a legacy and a marked compactor are stopped, each compacts once, and both resume', { timeout: 60_000 }, async () => {
  const a = agent();
  const b = agent();
  // A legacy compactor (no marker, no op) in a's workspace; a marked one for b, elsewhere.
  const ca = await compactor(a);
  const cb = await compactor(b, { cwd: home, env: { STAM_COMPACTOR: `${b.id}:op-b` } });
  // Not compactors of theirs: a's session from another folder, unmarked; b's session marked for another agent.
  const strayA = await compactor(a, { cwd: home });
  const strayB = await compactor(b, { env: { STAM_COMPACTOR: 'zzzzz:op' } });
  strayA.agent = strayB.agent = null;
  cutShort(a);
  cutShort(b, 'op-b');
  await lifecycle.recoverLost();
  for (const [x, c] of [[a, ca], [b, cb]]) {
    assert.equal(alive(c), false, `${x.name}'s compactor was stopped`);
    assert.equal(events(x.id, 'compact:killed').length, 1);
    assert.equal(compactions.get(x.id), 1, 'exactly one compactor ran');
    assert.equal(overlaps.get(x.id), undefined, 'never alongside the stopped one');
    assert.equal(db.getAgent(x.id).lifecycle, 'active');
    assert.equal(launches.get(x.id), 1);
    assert.equal(db.getAgent(x.id).pending_action, null);
  }
  assert.ok(alive(strayA) && alive(strayB), 'processes that are not its compactors are left alone');
});

test('the recover action stays set while it compacts; an agent archived meanwhile is not relaunched', { timeout: 60_000 }, async () => {
  let release;
  const a = agent(new Promise((r) => (release = r)));
  cutShort(a, 'op-a');
  const recovery = lifecycle.recoverLost();
  await until(() => compactions.get(a.id) === 1);
  assert.equal(JSON.parse(db.getAgent(a.id).pending_action).type, 'recover', 'a restart now would still recover it');
  db.updateAgent(a.id, { lifecycle: 'archived' });
  release();
  await recovery;
  assert.equal(launches.get(a.id), undefined, 'no relaunch');
  assert.equal(db.getAgent(a.id).lifecycle, 'archived');
  assert.equal(events(a.id, 'recover:cancelled').length, 1);
  assert.equal(db.getAgent(a.id).pending_action, null);
});

test("a harness whose compaction keeps it up isn't cut short by a restart: its exit stays an exit", () => {
  const a = agent('done', 'fake-live');
  db.addEvent(a.id, 'compact', { reason: 'idle past the cache lifetime', op: 'op-live' });
  assert.equal(lifecycle.compactionExit(db.getAgent(a.id)), false);
  assert.equal(db.getAgent(a.id).lifecycle, 'active', 'left for the exit check');
});

test('an S-257 context-exit recovery also stops a compactor still running on the session', { timeout: 60_000 }, async () => {
  const a = agent();
  // A restart during this recovery's own headless compaction left its compactor running.
  const c = await compactor(a, { cwd: home, env: { STAM_COMPACTOR: `${a.id}:op-ctx` } });
  db.updateAgent(a.id, { context_tokens: 320_000 });
  lifecycle.markLost(db.getAgent(a.id), 'harness exited', { compact: true, tokens: 320_000 });
  await lifecycle.recoverLost();
  assert.equal(alive(c), false);
  assert.equal(events(a.id, 'compact:killed').length, 1);
  assert.equal(compactions.get(a.id), 1);
  assert.equal(overlaps.get(a.id), undefined);
  assert.equal(db.getAgent(a.id).lifecycle, 'active');
});

test('once compacted, the recover action is marked so: a restart before the resume resumes without compacting again', { timeout: 60_000 }, async () => {
  const a = agent();
  cutShort(a, 'op-once');
  await lifecycle.recoverLost();
  const seen = JSON.parse(pendingAtLaunch.get(a.id));
  assert.equal(seen.compacted, true);
  assert.equal(seen.compact, undefined);
  // The daemon restarted right then: the same action, recovered again, only resumes.
  const b = agent();
  db.updateAgent(b.id, { lifecycle: 'shut_down', activity: 'unknown', pending_action: JSON.stringify({ ...seen }) });
  await lifecycle.recoverLost();
  assert.equal(compactions.get(b.id), undefined, 'no second compaction');
  assert.equal(launches.get(b.id), 1);
  assert.equal(db.getAgent(b.id).lifecycle, 'active');
});
