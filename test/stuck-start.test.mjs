#!/usr/bin/env node
// S-3250: a start that never reaches a turn. A promptless launch whose SessionStart hook was lost
// (a daemon restart right after the resume) settles at its prompt once no launch of it runs here;
// any other start still 'starting' with a live pane past settings.stuckStartMinutes is restarted
// once, then errored. A slow start that gets there, a paused or cost-held agent, one on another
// machine, and one a restart already handled are left alone. Runs against a throwaway STAM_HOME
// and tmux socket with a fake harness; no daemon, no network, no models:
// `node --test test/stuck-start.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-stuck-start-');
const socket = `stuck-start-test-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
process.env.STAM_EMBEDDER = 'stub';
process.env.STAM_MACHINE = 'test';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [], stuckStartMinutes: 15 }));

let db, lifecycle;
// Agents whose harness sits at an empty prompt, and afterLaunch calls held open per agent.
const ready = new Set();
const afterGates = new Map();
// adapter.launch calls held open per agent: { promise } resolves, { promise, fail } rejects.
const launchGates = new Map();
before(async () => {
  db = await import('../src/db.ts');
  lifecycle = await import('../src/lifecycle.ts');
  const { adapters } = await import('../src/adapters/index.ts');
  adapters.fake = {
    pushPrompt: async () => true,
    launch: async (a) => {
      const gate = launchGates.get(a.id);
      if (gate) await gate.promise;
      return { argv: ['sleep', '600'], env: {} };
    },
    afterLaunch: async (a) => {
      const gate = afterGates.get(a.id);
      if (gate) await gate.promise;
    },
    atPrompt: (a) => ready.has(a.id),
  };
});
after(() => {
  spawnSync('tmux', ['-L', socket, 'kill-server']);
});

let n = 0;
function agent({ machine = 'test' } = {}) {
  const id = db.newAgentId();
  const cwd = join(home, `work-${id}`);
  mkdirSync(cwd);
  db.createAgent({ id, name: `s${++n}`, role: '', machine, harness: 'fake', model: null, effort: null, cwd, parent_id: null, session_id: `sess-${id}` });
  db.updateAgent(id, { workspace: JSON.stringify({ spec: { kind: 'dir', path: cwd }, cwd }), lifecycle: 'active', activity: 'idle' });
  return db.getAgent(id);
}
const get = (id) => db.getAgent(id);
const events = (id, type) => db.listEvents(id, 500).filter((e) => e.type === type);
const alive = (id) => lifecycle.harnessRunning(get(id));
const later = (minutes) => Date.now() + minutes * 60_000;
// A promptless resume, as the compaction's relaunch makes, with its afterLaunch settled.
async function resumed(a) {
  const { launched } = await lifecycle.startHarness(get(a.id), undefined, true);
  await launched;
  assert.equal(get(a.id).activity, 'starting');
  assert.equal(get(a.id).activity_detail, 'resuming');
  assert.ok(alive(a.id), 'the harness pane is live');
}

test('a promptless resume whose SessionStart was lost settles idle at its prompt', async () => {
  const a = agent();
  await resumed(a);
  // Not at its prompt yet: it stays starting.
  assert.equal(await lifecycle.settleStart(get(a.id), true), false);
  ready.add(a.id);
  assert.equal(await lifecycle.settleStart(get(a.id), true), true);
  assert.equal(get(a.id).activity, 'idle');
  assert.equal(get(a.id).activity_detail, 'ready');
  assert.equal(events(a.id, 'starting:settled').length, 1);
});

test('a launch still in its afterLaunch, one with a prompt, or a dead pane does not settle', async () => {
  const a = agent();
  ready.add(a.id);
  let release;
  afterGates.set(a.id, { promise: new Promise((r) => (release = r)) });
  const { launched } = await lifecycle.startHarness(get(a.id), undefined, true);
  assert.equal(await lifecycle.settleStart(get(a.id), true), false, 'its launch is still running here');
  release();
  await launched;
  afterGates.delete(a.id);
  assert.equal(await lifecycle.settleStart(get(a.id), false), false, 'no live pane');
  db.updateAgent(a.id, { activity_detail: 'with prompt' });
  assert.equal(await lifecycle.settleStart(get(a.id), true), false, 'its prompt is still to go in');
  db.updateAgent(a.id, { activity_detail: 'resuming' });
  assert.equal(await lifecycle.settleStart(get(a.id), true), true, 'settles once its launch is done');
});

test('a start that never reaches a turn is restarted once, then errored', async () => {
  const a = agent();
  await resumed(a);
  assert.equal(lifecycle.startStalled(get(a.id), true, later(10)), false, 'under the bound');
  assert.equal(lifecycle.startStalled(get(a.id), true, later(20)), true, 'past the bound');
  await lifecycle.restartStalledStart(get(a.id), later(20));
  assert.equal(events(a.id, 'starting:restart').length, 1);
  assert.equal(events(a.id, 'resume').length, 2);
  const relaunch = events(a.id, 'resume').find((e) => JSON.parse(e.data).stuck);
  assert.ok(relaunch, 'the restart marks its own launch');
  assert.equal(JSON.parse(relaunch.data).prompt, true, 'with the restart note');
  assert.equal(get(a.id).activity, 'starting');
  assert.equal(get(a.id).lifecycle, 'active');
  // The restart's own start gets stuck too: errored, which tells its parents (org.watchActivity).
  await lifecycle.restartStalledStart(get(a.id), later(40));
  assert.equal(get(a.id).activity, 'errored');
  assert.match(get(a.id).activity_detail, /never reached a turn/);
  assert.equal(events(a.id, 'starting:restart').length, 1, 'restarted only once');
  assert.equal(events(a.id, 'starting:stuck').length, 1);
});

test('the one restart counts per stuck start: a later launch that sticks is restarted again', async () => {
  const a = agent();
  await resumed(a);
  await lifecycle.restartStalledStart(get(a.id), later(20));
  // The restart reached a turn; later the agent is resumed again, and that start sticks.
  db.updateAgent(a.id, { activity: 'idle' });
  await resumed(a);
  await lifecycle.restartStalledStart(get(a.id), later(20));
  assert.equal(events(a.id, 'starting:restart').length, 2, 'restarted again');
  assert.equal(get(a.id).activity, 'starting');
});

test('a restart a daemon restart cut off before it launched is not repeated', async () => {
  const a = agent();
  await resumed(a);
  // The old daemon recorded its restart, then went down before the new launch.
  db.addEvent(a.id, 'starting:restart', { minutes: 15 });
  const launches = events(a.id, 'resume').length;
  await lifecycle.restartStalledStart(get(a.id), later(20));
  assert.equal(get(a.id).activity, 'errored');
  assert.equal(events(a.id, 'resume').length, launches, 'no second launch');
});

test('two restarts asked at once launch once', async () => {
  const a = agent();
  await resumed(a);
  await Promise.all([lifecycle.restartStalledStart(get(a.id), later(20)), lifecycle.restartStalledStart(get(a.id), later(20))]);
  assert.equal(events(a.id, 'starting:restart').length, 1);
  assert.equal(events(a.id, 'resume').filter((e) => JSON.parse(e.data).stuck).length, 1);
});

test('a slow start that reaches a turn is left alone', async () => {
  const a = agent();
  await resumed(a);
  db.updateAgent(a.id, { activity: 'working' });
  assert.equal(lifecycle.startStalled(get(a.id), true, later(20)), false);
  await lifecycle.restartStalledStart(get(a.id), later(20));
  assert.equal(events(a.id, 'starting:restart').length, 0);
  assert.equal(get(a.id).activity, 'working');
});

test('a paused agent, or one not active, is left alone', async () => {
  const a = agent();
  await resumed(a);
  db.updateAgent(a.id, { lifecycle: 'paused', paused_by: JSON.stringify(['human']) });
  assert.equal(lifecycle.startStalled(get(a.id), true, later(20)), false);
  await lifecycle.restartStalledStart(get(a.id), later(20));
  assert.equal(events(a.id, 'starting:restart').length, 0);
  // Shut down with no pause owner, its row still 'starting': not the watchdog's.
  db.updateAgent(a.id, { lifecycle: 'shut_down', paused_by: null });
  assert.equal(lifecycle.startStalled(get(a.id), true, later(20)), false, 'shut down');
});

test('a cost-held agent is left alone, even while active', async () => {
  const a = agent();
  await resumed(a);
  db.open().prepare('INSERT INTO blockers (agent_id, kind, account, reason, since, clear) VALUES (?, ?, ?, ?, ?, ?)').run(a.id, 'budget', '', 'test budget', new Date().toISOString(), null);
  assert.equal(get(a.id).lifecycle, 'active');
  assert.equal(lifecycle.startStalled(get(a.id), true, later(20)), false);
  await lifecycle.restartStalledStart(get(a.id), later(20));
  assert.equal(events(a.id, 'starting:restart').length, 0);
});

test('an agent of another machine, or a dead pane, or the check off, is left alone', async () => {
  const a = agent();
  await resumed(a);
  assert.equal(lifecycle.startStalled(get(a.id), false, later(20)), false, 'dead pane: startingStuck handles it');
  db.updateAgent(a.id, { machine: 'peer' });
  assert.equal(lifecycle.startStalled(get(a.id), true, later(20)), false, 'another machine restarts its own');
  db.updateAgent(a.id, { machine: 'test' });
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [], stuckStartMinutes: 0 }));
  const { settings } = await import('../src/settings.ts');
  assert.equal(settings().stuckStartMinutes, 0);
  assert.equal(lifecycle.startStalled(get(a.id), true, later(20)), false, '0 turns it off');
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [], stuckStartMinutes: 15 }));
  assert.equal(settings().stuckStartMinutes, 15);
});

test('a late SessionStart from a resume does not end a turn that began after the settle', async () => {
  const { adapters } = await import('../src/adapters/index.ts');
  const a = agent();
  const start = (activity, source = 'resume') => adapters.claude.onHook({ ...get(a.id), activity }, { hook_event_name: 'SessionStart', source, session_id: 'sess-new' });
  assert.equal(start('working').activity, undefined, 'a working turn keeps going');
  assert.equal(start('blocked').activity, undefined, 'a dialog stays');
  assert.equal(start('working').session_id, 'sess-new', 'the new session is still recorded');
  assert.equal(start('starting').activity, 'idle', 'a launch still starting goes idle, as before');
  assert.equal(start('working', 'clear').activity, 'idle', 'a /clear still ends it');
});

test('a settle does only what SessionStart does: a pending compaction stays pending', async () => {
  const a = agent();
  await resumed(a);
  ready.add(a.id);
  const pendingCompact = JSON.stringify({ type: 'compact', reason: 'test' });
  db.updateAgent(a.id, { pending_action: pendingCompact });
  assert.equal(await lifecycle.settleStart(get(a.id), true), true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(get(a.id).pending_action, pendingCompact, 'onIdle did not run it');
  assert.equal(events(a.id, 'compact').length, 0);
});

test('a held, paused, not active or stopping agent does not settle', async () => {
  const held = agent();
  await resumed(held);
  ready.add(held.id);
  db.open().prepare('INSERT INTO blockers (agent_id, kind, account, reason, since, clear) VALUES (?, ?, ?, ?, ?, ?)').run(held.id, 'budget', '', 'test budget', new Date().toISOString(), null);
  assert.equal(await lifecycle.settleStart(get(held.id), true), false, 'cost-held while active');
  const paused = agent();
  await resumed(paused);
  ready.add(paused.id);
  db.updateAgent(paused.id, { lifecycle: 'paused', paused_by: JSON.stringify(['human']) });
  assert.equal(await lifecycle.settleStart(get(paused.id), true), false, 'paused');
  db.updateAgent(paused.id, { lifecycle: 'shut_down', paused_by: null });
  assert.equal(await lifecycle.settleStart(get(paused.id), true), false, 'shut down');
  const stopping = agent();
  await resumed(stopping);
  ready.add(stopping.id);
  db.updateAgent(stopping.id, { pending_action: JSON.stringify({ type: 'archive', force: false }) });
  assert.equal(await lifecycle.settleStart(get(stopping.id), true), false, 'pending stop');
  for (const x of [held, paused, stopping]) assert.equal(get(x.id).activity, 'starting');
});

test('a relaunch counts as running from its start: the old pane does not settle meanwhile', async () => {
  const a = agent();
  await resumed(a);
  ready.add(a.id);
  let release;
  launchGates.set(a.id, { promise: new Promise((r) => (release = r)) });
  const run = lifecycle.startHarness(get(a.id), undefined, true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await lifecycle.settleStart(get(a.id), true), false, 'adapter.launch still runs');
  release();
  const { launched } = await run;
  await launched;
  launchGates.delete(a.id);
  assert.equal(await lifecycle.settleStart(get(a.id), true), true, 'settles once it landed');
});

test('a relaunch that fails or is superseded no longer counts as running', async () => {
  const a = agent();
  await resumed(a);
  ready.add(a.id);
  launchGates.set(a.id, { promise: Promise.reject(new Error('launch failed')) });
  launchGates.get(a.id).promise.catch(() => {});
  await assert.rejects(lifecycle.startHarness(get(a.id), undefined, true), /launch failed/);
  launchGates.delete(a.id);
  assert.equal(await lifecycle.settleStart(get(a.id), true), true, 'a failed launch is not in flight');
  const b = agent();
  await resumed(b);
  ready.add(b.id);
  let release;
  launchGates.set(b.id, { promise: new Promise((r) => (release = r)) });
  const run = lifecycle.startHarness(get(b.id), undefined, true);
  await new Promise((r) => setTimeout(r, 20));
  lifecycle.invalidateLaunch(b.id);
  release();
  assert.equal((await run).superseded, true);
  launchGates.delete(b.id);
  assert.equal(await lifecycle.settleStart(get(b.id), true), true, 'a superseded launch is not in flight');
});

test('a launch still in its afterLaunch is not restarted under itself, but is once it has settled', async () => {
  const a = agent();
  await resumed(a);
  let release;
  afterGates.set(a.id, { promise: new Promise((r) => (release = r)) });
  const { launched } = await lifecycle.startHarness(get(a.id), undefined, true);
  // Past the bound (15 min) but under twice it, and its launch is still running here.
  assert.equal(lifecycle.startStalled(get(a.id), true, later(20)), false, 'in flight, under twice the bound');
  release();
  await launched;
  afterGates.delete(a.id);
  assert.equal(lifecycle.startStalled(get(a.id), true, later(20)), true, 'settled, so stalled past the bound');
});

test('a launch whose afterLaunch never settles is stalled once past twice the bound, and restarted', async () => {
  const a = agent();
  await resumed(a);
  let release;
  afterGates.set(a.id, { promise: new Promise((r) => (release = r)) });
  await lifecycle.startHarness(get(a.id), undefined, true);
  // The hung launch's afterLaunch stays open; the restart's own launch must not hang with it.
  afterGates.delete(a.id);
  assert.equal(lifecycle.startStalled(get(a.id), true, later(31)), true, 'hung past twice the bound');
  await lifecycle.restartStalledStart(get(a.id), later(31));
  assert.equal(events(a.id, 'starting:restart').length, 1);
  assert.equal(get(a.id).activity, 'starting');
  release();
});
