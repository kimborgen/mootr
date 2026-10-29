#!/usr/bin/env node
// S-578: an agent stuck in 'starting' with no harness process never finishes its step, so a
// pending archive waits forever and only the human could kill it. Reconcile marks such an agent
// stopped past settings.startingTimeoutMinutes, tells its parent, and runs a pending archive at
// once; a pending archive on any agent whose harness is gone completes at once too. A forced
// archive never waits for the step, an unforced one on a live agent does, and a harness that
// keeps running its turn with no pane (OpenCode's server) counts as live. Runs against a
// throwaway STAM_HOME and tmux socket with a fake harness; no daemon, no network, no models:
// `node --test test/starting-archive.test.mjs`.
import { test, before, after } from 'node:test';
import { killTmuxServer } from '../src/tmux-socket.ts';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-starting-archive-');
const socket = `starting-archive-test-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
process.env.STAM_EMBEDDER = 'stub';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [] }));

let db, lifecycle, mail, createWorkspace, daemon;
// Fake-harness state: agent ids whose server still runs a turn with no pane, agent ids whose
// `turnRunning` probe throws, a slow `turnRunning` probe per agent, and launches held open, per
// agent, so a test can make one resolve late.
const turnAlive = new Set();
const turnThrow = new Set();
const turnProbe = new Map();
const launchGates = new Map();
// What stam pushed into each agent, so a test can check the archive's wrap-up went in.
const pushed = new Map();
before(async () => {
  db = await import('../src/db.ts');
  lifecycle = await import('../src/lifecycle.ts');
  mail = await import('../src/mail.ts');
  daemon = await import('../src/daemon.ts');
  const { adapters } = await import('../src/adapters/index.ts');
  ({ createWorkspace } = await import('../src/workspace.ts'));
  adapters.fake = {
    pushPrompt: async (a, text) => {
      pushed.set(a.id, [...(pushed.get(a.id) ?? []), text]);
      return true;
    },
    launch: async (a) => {
      const gate = launchGates.get(a.id);
      if (gate) await gate.promise;
      return { argv: ['sleep', '600'], env: {} };
    },
    afterLaunch: async () => {},
    turnRunning: async (a) => {
      if (turnThrow.has(a.id)) throw new Error('the server did not answer');
      const probe = turnProbe.get(a.id);
      if (probe) {
        await probe.promise;
        return probe.value;
      }
      return turnAlive.has(a.id);
    },
  };
});
after(() => {
  killTmuxServer(socket);
  rmSync(home, { recursive: true, force: true });
});

// A fake-harness agent per test. `created_at` defaults to now, so a test that wants the starting
// timeout to have passed sets it back itself.
let n = 0;
function agent({ parent = null, created_at = new Date().toISOString(), activity = 'starting' } = {}) {
  const id = db.newAgentId();
  const cwd = join(home, `work-${id}`);
  mkdirSync(cwd);
  db.createAgent({ id, name: `c${++n}`, role: '', machine: 'test', harness: 'fake', model: null, effort: null, cwd, parent_id: parent, session_id: `sess-${id}` });
  db.updateAgent(id, { workspace: JSON.stringify({ spec: { kind: 'dir', path: cwd }, cwd }), lifecycle: 'active', activity, created_at });
  return db.getAgent(id);
}
const longAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const events = (id, type) => db.listEvents(id, 500).filter((e) => e.type === type);
const pending = (id) => (db.getAgent(id).pending_action ? JSON.parse(db.getAgent(id).pending_action) : null);
// The final-round wrap-up an archive sent this agent, if any.
const wrapUp = (id) => (pushed.get(id) ?? []).find((t) => t.includes('final: true'));
// Runs the final-round deadline sweep as reconcile does each tick, past every pending deadline.
const sweep = () => lifecycle.runDueArchives(Date.now() + 60 * 60_000);
// An active agent with a real worktree holding an uncommitted change, so only discard removes it.
// `alive` puts it behind a live server turn (turnAlive): a pending archive then asks the final round.
function dirtyAgent({ alive = false } = {}) {
  const repo = join(home, `repo-${++n}`);
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
  const ws = createWorkspace({ kind: 'worktree', repo }, `dirty-${n}`);
  writeFileSync(join(ws.cwd, 'a.txt'), 'changed\n'); // uncommitted
  const id = db.newAgentId();
  db.createAgent({ id, name: `dirty${n}`, role: '', machine: 'test', harness: 'fake', model: null, effort: null, cwd: ws.cwd, parent_id: null, session_id: `sess-${id}` });
  db.updateAgent(id, { workspace: JSON.stringify(ws), lifecycle: 'active', activity: 'working' });
  if (alive) turnAlive.add(id);
  return { id, ws };
}

test('a stuck-starting agent with no harness is marked stopped, and its parent is told', async () => {
  const parent = agent({ activity: 'idle' });
  const a = agent({ parent: parent.id, created_at: longAgo(20) });
  assert.equal(lifecycle.startingStuck(db.getAgent(a.id), false), true);
  await lifecycle.markStartingDead(db.getAgent(a.id));
  const now = db.getAgent(a.id);
  assert.equal(now.lifecycle, 'shut_down');
  assert.equal(now.activity, 'unknown');
  assert.match(now.activity_detail, /never started/);
  assert.equal(events(a.id, 'starting:dead').length, 1);
  assert.ok(mail.queuedNoticeCount(parent.id) >= 1, 'the parent got a notice');
  assert.ok(events(parent.id, 'notice:queued').some((e) => (e.data ?? '').includes('never started')));
});

test('a young starting agent, one with a live pane, or one not starting is left alone', () => {
  const young = agent();
  assert.equal(lifecycle.startingStuck(db.getAgent(young.id), false), false, 'under the timeout');
  const old = agent({ created_at: longAgo(20) });
  assert.equal(lifecycle.startingStuck(db.getAgent(old.id), true), false, 'pane is alive');
  db.updateAgent(old.id, { activity: 'working' });
  assert.equal(lifecycle.startingStuck(db.getAgent(old.id), false), false, 'not starting');
});

test('a starting agent past the old 60 s grace is still left alone until its configured deadline', () => {
  const a = agent({ created_at: longAgo(1.5) }); // 90 s, past the old fixed grace
  assert.equal(lifecycle.startingStuck(db.getAgent(a.id), false), false, 'under startingTimeoutMinutes');
});

test('a starting agent whose server still runs a turn is not marked dead', async () => {
  const a = agent({ created_at: longAgo(20) });
  turnAlive.add(a.id);
  await lifecycle.markStartingDead(db.getAgent(a.id));
  assert.equal(db.getAgent(a.id).lifecycle, 'active', 'left alone');
  assert.equal(events(a.id, 'starting:dead').length, 0);
  turnAlive.delete(a.id);
});

test('a pending archive on a stuck-starting agent completes at once', async () => {
  const a = agent({ created_at: longAgo(20) });
  db.updateAgent(a.id, { pending_action: JSON.stringify({ type: 'archive', force: false }) });
  await lifecycle.markStartingDead(db.getAgent(a.id));
  assert.equal(db.getAgent(a.id).lifecycle, 'archived');
  assert.equal(db.getAgent(a.id).pending_action, null);
  assert.equal(events(a.id, 'starting:dead').length, 1);
  assert.equal(events(a.id, 'archive').length, 1);
});

test('a pending archive on an agent whose harness is gone runs at once (runPendingOnDead)', async () => {
  const a = agent({ activity: 'working' }); // active, no tmux session
  assert.equal(lifecycle.harnessRunning(db.getAgent(a.id)), false);
  db.updateAgent(a.id, { pending_action: JSON.stringify({ type: 'archive', force: false }) });
  await lifecycle.runPendingOnDead(db.getAgent(a.id));
  assert.equal(db.getAgent(a.id).lifecycle, 'archived');
  assert.equal(events(a.id, 'archive').length, 1);
});

test('runPendingOnDead leaves a non-stop pending action (e.g. restart) alone', async () => {
  const a = agent();
  db.updateAgent(a.id, { pending_action: JSON.stringify({ type: 'restart', reason: 'test' }) });
  await lifecycle.runPendingOnDead(db.getAgent(a.id));
  assert.equal(lifecycle.pendingStop(db.getAgent(a.id)), null);
  assert.equal(JSON.parse(db.getAgent(a.id).pending_action).type, 'restart');
});

test('an unforced archive of a live server turn waits, and asks for the final round', async () => {
  const a = agent({ activity: 'working' }); // no tmux session
  turnAlive.add(a.id);
  assert.equal(lifecycle.harnessRunning(db.getAgent(a.id)), false, 'no pane');
  assert.equal(await lifecycle.harnessTurnAlive(db.getAgent(a.id)), true, 'the server still runs its turn');
  assert.equal(await lifecycle.harnessAlive(db.getAgent(a.id)), true, 'so the harness is alive');
  const r = await lifecycle.archive(db.getAgent(a.id), false);
  assert.match(r, /waiting for .* to finish its step/, 'an unforced archive of a live server turn waits');
  assert.equal(db.getAgent(a.id).lifecycle, 'active');
  assert.equal(pending(a.id).type, 'archive');
  assert.equal(pending(a.id).force, false);
  assert.equal(typeof pending(a.id).at, 'number', 'the final round has a deadline');
  assert.ok(wrapUp(a.id), 'the wrap-up with the final round went in');

  // The dead-harness path defers while the server turn is live, rather than archiving on a guess.
  await lifecycle.runPendingOnDead(db.getAgent(a.id));
  assert.equal(db.getAgent(a.id).lifecycle, 'active', 'deferred, not archived');
  assert.ok(events(a.id, 'archive:deferred').length >= 1);

  // The deadline sweep archives it anyway (S-1043): it can no longer wait forever.
  await sweep();
  assert.equal(db.getAgent(a.id).lifecycle, 'archived');
  assert.ok(events(a.id, 'archive:final-round-timeout').length >= 1, 'the deadline, not a turn end, archived it');
  turnAlive.delete(a.id);
});

test('an unknown harness turn state asks the final round, and the deadline archives it', async () => {
  // An idle, waiting, or errored agent used to archive at once (S-578 review); now each gets the
  // wrap-up and the deadline, so an unaskable harness can't leave the archive stuck.
  for (const activity of ['idle', 'waiting', 'errored']) {
    const a = agent({ activity }); // no tmux session
    turnThrow.add(a.id);
    assert.equal(await lifecycle.harnessTurnAlive(db.getAgent(a.id)), undefined, `${activity}: unknown, not false`);
    const r = await lifecycle.archive(db.getAgent(a.id), false);
    assert.match(r, /waiting for .* to finish its step/, `${activity}: waits for the final round`);
    assert.equal(db.getAgent(a.id).lifecycle, 'active', `${activity}: still active`);
    assert.equal(events(a.id, 'archive').length, 0, `${activity}: not archived`);
    assert.equal(pending(a.id).type, 'archive', `${activity}: the archive was stored`);
    assert.equal(typeof pending(a.id).at, 'number', `${activity}: with a deadline`);

    // A pending archive is deferred while the state is unknown, not run on a guess.
    await lifecycle.runPendingOnDead(db.getAgent(a.id));
    assert.equal(db.getAgent(a.id).lifecycle, 'active', `${activity}: deferred, not archived`);

    // The deadline runs it regardless.
    await sweep();
    assert.equal(db.getAgent(a.id).lifecycle, 'archived', `${activity}: the deadline archived it`);
    turnThrow.delete(a.id);
  }
});

test('a forced archive of a live agent mid-step still asks the final round (S-1043)', async () => {
  // A real tmux session with a live pane, so harnessRunning is true.
  const live = agent();
  await lifecycle.startHarness(db.getAgent(live.id), undefined, false, 'spawn');
  db.updateAgent(live.id, { activity: 'working', activity_detail: 'mid-step' });
  assert.equal(lifecycle.harnessRunning(db.getAgent(live.id)), true, 'the harness is up');
  const r = await lifecycle.archive(db.getAgent(live.id), true);
  assert.match(r, /waiting for .* to finish its step/, 'force no longer archives at once');
  assert.equal(db.getAgent(live.id).lifecycle, 'active');
  assert.equal(pending(live.id).force, true);
  assert.ok(wrapUp(live.id), 'the forced archive still sent the final-round prompt');
  // The wrap-up was pushed mid-step (S-1618): the step's end gives the wrap-up turn, whose end archives it.
  await lifecycle.onIdle(live.id);
  assert.equal(db.getAgent(live.id).lifecycle, 'active');
  await lifecycle.onIdle(live.id);
  assert.equal(db.getAgent(live.id).lifecycle, 'archived');
});

test('a forced archive of an idle agent asks the final round, and archives on its next turn end', async () => {
  const a = agent({ activity: 'idle' });
  turnAlive.add(a.id); // a live harness, so the archive asks rather than runs at once
  const r = await lifecycle.archive(db.getAgent(a.id), true);
  assert.match(r, /waiting for .* to finish its step/);
  assert.equal(pending(a.id).force, true);
  assert.ok(wrapUp(a.id), 'the idle agent got the final round');
  await lifecycle.onIdle(a.id);
  assert.equal(db.getAgent(a.id).lifecycle, 'archived');
  assert.equal(events(a.id, 'archive:final-round-timeout').length, 0, 'the turn end archived it, not the deadline');
  turnAlive.delete(a.id);
});

test('an unforced archive of an idle, finished agent (not waiting) asks the final round', async () => {
  // The case cos hit archiving ci-cost: an agent idle at its prompt on main archived at once,
  // since whenIdle saw it idle; on this branch every archive asks for the final round first (S-1043).
  const a = agent({ activity: 'idle' });
  await lifecycle.startHarness(db.getAgent(a.id), undefined, false, 'spawn');
  db.updateAgent(a.id, { activity: 'idle', activity_detail: 'at its prompt' });
  assert.equal(lifecycle.harnessRunning(db.getAgent(a.id)), true, 'a live pane');
  const r = await lifecycle.archive(db.getAgent(a.id), false);
  assert.match(r, /waiting for .* to finish its step/, 'an idle finished agent waits for its final round');
  assert.equal(db.getAgent(a.id).lifecycle, 'active');
  assert.ok(wrapUp(a.id), 'the wrap-up with the final round went in');
  await lifecycle.onIdle(a.id);
  assert.equal(db.getAgent(a.id).lifecycle, 'archived');
});

test('an unforced archive of an idle agent in wait_for asks the final round and archives on its turn end', async () => {
  const a = agent({ activity: 'idle' });
  turnAlive.add(a.id);
  db.addWait({ agent_id: a.id, kind: 'agent', source: 'declared', target: 'azxky' });
  assert.equal(db.getAgent(a.id).activity, 'waiting', 'it is in a wait_for');
  const r = await lifecycle.archive(db.getAgent(a.id), false);
  assert.match(r, /waiting for .* to finish its step/);
  assert.ok(wrapUp(a.id), 'the waiting agent got the final round');
  // Its wrap-up turn ends: archive now, not at the deadline.
  await lifecycle.onIdle(a.id);
  assert.equal(db.getAgent(a.id).lifecycle, 'archived');
  assert.equal(events(a.id, 'archive:final-round-timeout').length, 0);
  turnAlive.delete(a.id);
});

test('a forced archive with a dirty worktree asks the final round, then archives at its deadline', async () => {
  const { id, ws } = dirtyAgent({ alive: true }); // a live harness, so it waits for the final round
  const r = await lifecycle.archive(db.getAgent(id), true);
  assert.match(r, /waiting for .* to finish its step/);
  assert.equal(db.getAgent(id).lifecycle, 'active');
  assert.equal(pending(id).force, true);
  assert.equal(pending(id).discard, true, 'force implies discard');
  assert.ok(wrapUp(id), 'the forced archive still sent the final round');
  assert.ok(existsSync(ws.cwd), 'the dirty worktree stays until the archive runs');

  // The timeout archives it anyway, and discard throws the change away.
  await sweep();
  assert.equal(db.getAgent(id).lifecycle, 'archived');
  assert.ok(!existsSync(ws.cwd), 'the dirty worktree was removed');
  assert.ok(events(id, 'archive:final-round-timeout').length >= 1, 'the deadline archived it');
  turnAlive.delete(id);
});

test('an unforced archive that fails at its deadline does not retry forever (S-1043 review)', async () => {
  const { id, ws } = dirtyAgent({ alive: true }); // a live harness, so it asks for the final round
  const r = await lifecycle.archive(db.getAgent(id), false);
  assert.match(r, /waiting for .* to finish its step/);
  // At the deadline the archive runs with discard=false, so the dirty worktree refuses it.
  await sweep();
  const cur = db.getAgent(id);
  assert.equal(cur.lifecycle, 'active', 'the archive failed; it did not archive');
  assert.equal(cur.pending_action, null, 'the failed archive is cleared, not retried every tick');
  assert.match(cur.activity_detail, /archive failed/);
  assert.equal(events(id, 'archive:failed').length, 1);
  // Another tick does nothing: no five-second loop.
  await sweep();
  assert.equal(events(id, 'archive:failed').length, 1, 'the failure is not retried');
  assert.ok(existsSync(ws.cwd), 'the dirty worktree stays');
  turnAlive.delete(id);
});

test('a pending archive from before the deadline existed gets one, not archived on sight (S-1043 review)', async () => {
  const a = agent({ activity: 'working' }); // no pane, no server turn
  db.updateAgent(a.id, { pending_action: JSON.stringify({ type: 'archive', force: false }) });
  await sweep();
  const mid = db.getAgent(a.id);
  assert.equal(mid.lifecycle, 'active', 'not archived on the first sweep');
  assert.equal(typeof pending(a.id).at, 'number', 'it got a deadline');
  await sweep();
  assert.equal(db.getAgent(a.id).lifecycle, 'archived', 'due on the next sweep');
});

test('a paused agent archives at once, since it cannot take the wrap-up (S-1043 review)', async () => {
  const a = agent({ activity: 'idle' });
  await lifecycle.startHarness(db.getAgent(a.id), undefined, false, 'spawn'); // a live pane
  db.updateAgent(a.id, { lifecycle: 'paused', paused_by: JSON.stringify(['human']), activity: 'unknown' });
  const r = await lifecycle.archive(db.getAgent(a.id), false);
  assert.equal(r, 'done');
  assert.equal(db.getAgent(a.id).lifecycle, 'archived');
  assert.equal(wrapUp(a.id), undefined, 'no wrap-up asked of a paused agent');
});

test('the archive route keeps force implying discard (S-1043 review)', async () => {
  // Force true and discard omitted: control must not pass an explicit false, or force stops discarding.
  const ok = dirtyAgent();
  assert.equal(await daemon.control(db.getAgent(ok.id), 'archive', { by: 'x', force: true }), 'done');
  assert.equal(db.getAgent(ok.id).lifecycle, 'archived');
  assert.ok(!existsSync(ok.ws.cwd), 'the dirty worktree was discarded');

  // Force true but discard explicitly false: the dirty worktree is refused.
  const no = dirtyAgent();
  await assert.rejects(daemon.control(db.getAgent(no.id), 'archive', { by: 'x', force: true, discard: false }), /Commit or discard its changes/);
  assert.equal(db.getAgent(no.id).lifecycle, 'active');
  assert.ok(existsSync(no.ws.cwd), 'the dirty worktree stays');
  assert.equal(events(no.id, 'archive').length, 0);
});

test('a dead harness archives at once, with no final-round wait', async () => {
  const unforced = agent({ activity: 'working' }); // no tmux session, turnRunning false
  assert.equal(lifecycle.harnessRunning(db.getAgent(unforced.id)), false);
  assert.equal(await lifecycle.archive(db.getAgent(unforced.id), false), 'done');
  assert.equal(db.getAgent(unforced.id).lifecycle, 'archived');
  assert.equal(events(unforced.id, 'pending').length, 0, 'no wrap-up asked of a dead harness');

  const forced = agent({ activity: 'working' });
  assert.equal(await lifecycle.archive(db.getAgent(forced.id), true), 'done');
  assert.equal(db.getAgent(forced.id).lifecycle, 'archived');
  assert.equal(events(forced.id, 'pending').length, 0);
});

test('an unforced archive of a still-starting agent waits, rather than racing its launch', async () => {
  const a = agent(); // activity 'starting', no session, created just now
  const r = await lifecycle.archive(db.getAgent(a.id), false);
  assert.match(r, /waiting for .* to finish its step/);
  assert.equal(pending(a.id).type, 'archive');
  assert.equal(pending(a.id).force, false);
  assert.equal(typeof pending(a.id).at, 'number', 'the final round has a deadline');
  assert.equal(db.getAgent(a.id).lifecycle, 'active');
});

test('a launch superseded by markStartingDead does not revive the agent', async () => {
  const a = agent({ created_at: longAgo(20) });
  let release;
  launchGates.set(a.id, { promise: new Promise((r) => (release = r)) });
  // The launch is now held inside adapter.launch.
  const started = lifecycle.startHarness(db.getAgent(a.id), 'go', false, 'spawn');
  db.updateAgent(a.id, { pending_action: JSON.stringify({ type: 'archive', force: false }) });
  await lifecycle.markStartingDead(db.getAgent(a.id));
  assert.equal(db.getAgent(a.id).lifecycle, 'archived');
  // Release the launch: it must not create a session or mark the agent active.
  release();
  await started;
  assert.equal(db.getAgent(a.id).lifecycle, 'archived', 'the delayed launch did not revive it');
  assert.equal(db.getAgent(a.id).pending_action, null);
  assert.equal(lifecycle.harnessRunning(db.getAgent(a.id)), false, 'no session was created');
  assert.equal(events(a.id, 'spawn').length, 0, 'the launch did not record a spawn');
});

test('a launch that finishes during the turn probe leaves the agent active (markStartingDead re-reads)', async () => {
  const a = agent({ created_at: longAgo(20) }); // starting, no pane
  let releaseProbe;
  turnProbe.set(a.id, { promise: new Promise((r) => (releaseProbe = r)), value: false });
  let releaseLaunch;
  launchGates.set(a.id, { promise: new Promise((r) => (releaseLaunch = r)) });
  // The launch is held inside adapter.launch; the turn probe is held too.
  const started = lifecycle.startHarness(db.getAgent(a.id), undefined, false, 'spawn');
  const marking = lifecycle.markStartingDead(db.getAgent(a.id));
  // Let the launch finish while the probe is outstanding: it creates a live pane.
  launchGates.delete(a.id);
  releaseLaunch();
  await started;
  assert.equal(lifecycle.harnessRunning(db.getAgent(a.id)), true, 'the launch left a live pane');
  releaseProbe();
  await marking;
  const now = db.getAgent(a.id);
  assert.equal(now.lifecycle, 'active', 'not marked dead over a live harness');
  assert.equal(events(a.id, 'starting:dead').length, 0);
  assert.equal(lifecycle.harnessRunning(now), true, 'the pane is still live');
  turnProbe.delete(a.id);
});

test('markStartingDead bails when the agent is no longer starting after the probe', async () => {
  const a = agent({ created_at: longAgo(20) });
  let releaseProbe;
  turnProbe.set(a.id, { promise: new Promise((r) => (releaseProbe = r)), value: false });
  const marking = lifecycle.markStartingDead(db.getAgent(a.id));
  // The agent moved on (a hook set it working) while the probe ran.
  db.updateAgent(a.id, { activity: 'working', activity_detail: 'turn began' });
  releaseProbe();
  await marking;
  assert.equal(db.getAgent(a.id).lifecycle, 'active', 'left alone');
  assert.equal(events(a.id, 'starting:dead').length, 0);
  turnProbe.delete(a.id);
});
