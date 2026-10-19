#!/usr/bin/env node
// S-1402: an archive that leaves without the agent's final retro round records why, as one
// `archive:round-skipped` event: a stopped or paused agent, one whose harness is gone, and one
// that let the deadline pass without filing. An agent that filed its round gets none. Fake
// harness, throwaway STAM_HOME and tmux socket; no daemon, network, or models:
// `node --test test/round-skipped.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-round-skipped-');
const socket = `round-skipped-test-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
process.env.STAM_EMBEDDER = 'stub';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [] }));

let db, lifecycle;
// Agent ids whose fake server still runs a turn with no pane (a live harness).
const turnAlive = new Set();
const pushed = new Map();
before(async () => {
  db = await import('../src/db.ts');
  lifecycle = await import('../src/lifecycle.ts');
  const { adapters } = await import('../src/adapters/index.ts');
  adapters.fake = {
    pushPrompt: async (a, text) => {
      pushed.set(a.id, [...(pushed.get(a.id) ?? []), text]);
      return true;
    },
    launch: async () => ({ argv: ['sleep', '600'], env: {} }),
    afterLaunch: async () => {},
    turnRunning: async (a) => turnAlive.has(a.id),
  };
});
after(() => {
  spawnSync('tmux', ['-L', socket, 'kill-server']);
  rmSync(home, { recursive: true, force: true });
});

let n = 0;
function agent({ lifecycle: lc = 'active', activity = 'idle' } = {}) {
  const id = db.newAgentId();
  const cwd = join(home, `work-${id}`);
  mkdirSync(cwd);
  db.createAgent({ id, name: `r${++n}`, role: '', machine: 'test', harness: 'fake', model: null, effort: null, cwd, parent_id: null, session_id: `sess-${id}` });
  db.updateAgent(id, { workspace: JSON.stringify({ spec: { kind: 'dir', path: cwd }, cwd }), lifecycle: lc, activity });
  return db.getAgent(id);
}
const skipped = (id) => db.listEvents(id, 500).filter((e) => e.type === 'archive:round-skipped').map((e) => (typeof e.data === 'string' ? JSON.parse(e.data) : e.data));

test('a shut-down agent archives with the reason shut_down', async () => {
  const a = agent({ lifecycle: 'shut_down' });
  await lifecycle.archive(a);
  assert.deepEqual(skipped(a.id), [{ reason: 'shut_down' }]);
});

test('a paused agent archives with the reason paused', async () => {
  const a = agent({ lifecycle: 'paused' });
  await lifecycle.archive(a);
  assert.deepEqual(skipped(a.id), [{ reason: 'paused' }]);
});

test('an active agent whose harness is gone archives with the reason harness_gone', async () => {
  const a = agent();
  assert.equal(await lifecycle.archive(a), 'done');
  assert.deepEqual(skipped(a.id), [{ reason: 'harness_gone' }]);
});

test('a live agent that files nothing by the deadline is archived with deadline_no_round', async () => {
  const a = agent();
  turnAlive.add(a.id);
  await lifecycle.archive(a);
  assert.deepEqual(skipped(a.id), [], 'asked, not skipped yet');
  await lifecycle.runDueArchives(Date.now() + 60 * 60_000);
  assert.deepEqual(skipped(a.id), [{ reason: 'deadline_no_round' }]);
});

test('a live agent that filed its round before the deadline gets no skip event', async () => {
  const a = agent();
  turnAlive.add(a.id);
  await lifecycle.archive(a);
  db.addEvent(a.id, 'retro_final', { effort: {} });
  await lifecycle.runDueArchives(Date.now() + 60 * 60_000);
  assert.equal(db.getAgent(a.id).lifecycle, 'archived');
  assert.deepEqual(skipped(a.id), []);
});

// A plain shutdown asks an active agent for its final round, idle or not (S-1402).
test('shutting down an idle agent asks for the round and stops it at the deadline', async () => {
  const a = agent();
  turnAlive.add(a.id);
  assert.match(await lifecycle.shutdown(a), /waiting for/);
  assert.ok((pushed.get(a.id) ?? []).some((t) => t.includes('final: true')), 'the final-round ask went in');
  assert.equal(JSON.parse(db.getAgent(a.id).pending_action).type, 'shutdown');
  assert.equal(db.getAgent(a.id).lifecycle, 'active', 'not stopped before the round or deadline');
  await lifecycle.runDueArchives(Date.now() + 60 * 60_000);
  assert.equal(db.getAgent(a.id).lifecycle, 'shut_down');
  assert.equal(db.getAgent(a.id).pending_action, null);
});

test('an agent that already filed its round is shut down at once', async () => {
  const a = agent();
  db.addEvent(a.id, 'retro_final', { effort: {} });
  assert.equal(await lifecycle.shutdown(a), 'done');
  assert.equal(db.getAgent(a.id).lifecycle, 'shut_down');
});

test('an archive that ends at the agent\'s turn end without a round records turn_ended_no_round', async () => {
  const a = agent({ activity: 'working' });
  turnAlive.add(a.id);
  await lifecycle.archive(a);
  assert.equal(db.getAgent(a.id).lifecycle, 'active');
  db.updateAgent(a.id, { activity: 'idle' });
  await lifecycle.onIdle(a.id);
  assert.equal(db.getAgent(a.id).lifecycle, 'active', 'the first turn end is the running step, not the round');
  await lifecycle.onIdle(a.id);
  assert.equal(db.getAgent(a.id).lifecycle, 'archived');
  assert.deepEqual(skipped(a.id), [{ reason: 'turn_ended_no_round' }]);
});

test('a pending archive on a dead harness records harness_gone', async () => {
  const a = agent({ activity: 'working' });
  turnAlive.add(a.id);
  await lifecycle.archive(a);
  turnAlive.delete(a.id);
  await lifecycle.runPendingOnDead(db.getAgent(a.id));
  assert.equal(db.getAgent(a.id).lifecycle, 'archived');
  assert.deepEqual(skipped(a.id), [{ reason: 'harness_gone' }]);
});

test('a shutdown asked mid-step waits for the step: the sweep does not stop it', async () => {
  const a = agent({ activity: 'working' });
  turnAlive.add(a.id);
  await lifecycle.shutdown(a);
  assert.equal(JSON.parse(db.getAgent(a.id).pending_action).at, undefined);
  await lifecycle.runDueArchives(Date.now() + 60 * 60_000);
  assert.equal(db.getAgent(a.id).lifecycle, 'active');
  assert.equal(JSON.parse(db.getAgent(a.id).pending_action).type, 'shutdown');
});

test('the sweep leaves a shutdown whose pending was replaced since', async () => {
  const a = agent();
  turnAlive.add(a.id);
  await lifecycle.shutdown(a);
  const stale = db.getAgent(a.id);
  // The pending changed between the sweep's list and its action: a later deadline replaces it.
  db.updateAgent(a.id, { pending_action: JSON.stringify({ type: 'shutdown', at: Date.now() + 2 * 60 * 60_000 }) });
  await lifecycle.runDueArchives(Date.now() + 60 * 60_000, [stale]);
  assert.equal(db.getAgent(a.id).lifecycle, 'active');
});

// S-1618: a shutdown records its own reason; the later archive of the stopped agent keeps it.
test('a shutdown that ends at the turn end without a round records turn_ended_no_round, kept by the archive', async () => {
  const a = agent({ activity: 'working' });
  turnAlive.add(a.id);
  await lifecycle.shutdown(a);
  assert.deepEqual(skipped(a.id), [], 'asked, not skipped yet');
  db.updateAgent(a.id, { activity: 'idle' });
  await lifecycle.onIdle(a.id);
  await lifecycle.onIdle(a.id);
  assert.equal(db.getAgent(a.id).lifecycle, 'shut_down');
  assert.deepEqual(skipped(a.id), [{ reason: 'turn_ended_no_round' }]);
  await lifecycle.archive(db.getAgent(a.id));
  assert.deepEqual(skipped(a.id), [{ reason: 'turn_ended_no_round' }]);
});

test('a shutdown that passes its deadline without a round records deadline_no_round, kept by the archive', async () => {
  const a = agent();
  turnAlive.add(a.id);
  await lifecycle.shutdown(a);
  await lifecycle.runDueArchives(Date.now() + 60 * 60_000);
  assert.equal(db.getAgent(a.id).lifecycle, 'shut_down');
  assert.deepEqual(skipped(a.id), [{ reason: 'deadline_no_round' }]);
  await lifecycle.archive(db.getAgent(a.id));
  assert.deepEqual(skipped(a.id), [{ reason: 'deadline_no_round' }]);
});

test('a resumed agent that is shut down and archived again gets a fresh event', async () => {
  const a = agent({ lifecycle: 'shut_down' });
  await lifecycle.archive(a);
  db.updateAgent(a.id, { lifecycle: 'shut_down' });
  db.addEvent(a.id, 'resume', {});
  await lifecycle.archive(db.getAgent(a.id));
  assert.equal(skipped(a.id).length, 2);
});

test('a shutdown of an agent that filed its round records nothing', async () => {
  const a = agent({ activity: 'working' });
  turnAlive.add(a.id);
  await lifecycle.shutdown(a);
  db.addEvent(a.id, 'retro_final', { effort: {} });
  db.updateAgent(a.id, { activity: 'idle' });
  await lifecycle.onIdle(a.id);
  assert.equal(db.getAgent(a.id).lifecycle, 'shut_down');
  assert.deepEqual(skipped(a.id), []);
});

// S-1618: a wrap-up pushed mid-turn may be queued by the harness (OpenCode), so the running step's
// end must not stop the agent before the wrap-up turn runs.
for (const kind of ['shutdown', 'archive']) {
  const ask = (a) => (kind === 'shutdown' ? lifecycle.shutdown(a) : lifecycle.archive(a));
  const done = (a) => db.getAgent(a.id).lifecycle === (kind === 'shutdown' ? 'shut_down' : 'archived');

  test(`a mid-turn ${kind}: the step's end gives the queued wrap-up turn, whose end stops it`, async () => {
    const a = agent({ activity: 'working' });
    turnAlive.add(a.id);
    await ask(a);
    db.updateAgent(a.id, { activity: 'idle' });
    await lifecycle.onIdle(a.id);
    assert.equal(db.getAgent(a.id).lifecycle, 'active', 'held for the wrap-up turn');
    const p = JSON.parse(db.getAgent(a.id).pending_action);
    assert.equal(p.waited, true);
    assert.ok(p.at > Date.now(), 'with a fresh deadline');
    db.addEvent(a.id, 'retro_final', { effort: {} });
    await lifecycle.onIdle(a.id);
    assert.ok(done(a), 'the wrap-up turn ended with the round filed');
    assert.deepEqual(skipped(a.id), []);
  });

  test(`a mid-turn ${kind} whose queued wrap-up never runs stops at the extended deadline`, async () => {
    const a = agent({ activity: 'working' });
    turnAlive.add(a.id);
    await ask(a);
    db.updateAgent(a.id, { activity: 'idle' });
    await lifecycle.onIdle(a.id);
    await lifecycle.runDueArchives(Date.now() + 60 * 60_000);
    assert.ok(done(a));
    assert.deepEqual(skipped(a.id), [{ reason: 'deadline_no_round' }]);
  });

  test(`a mid-turn ${kind} of an agent that filed its round in the running step stops at its turn end`, async () => {
    const a = agent({ activity: 'working' });
    turnAlive.add(a.id);
    await ask(a);
    db.addEvent(a.id, 'retro_final', { effort: {} });
    db.updateAgent(a.id, { activity: 'idle' });
    await lifecycle.onIdle(a.id);
    assert.ok(done(a));
  });
}

// S-1618 review: a shutdown that asked for no round records no skip.
test('shutting down a paused idle agent records no skip: no round was asked', async () => {
  const a = agent({ lifecycle: 'paused' });
  await lifecycle.shutdown(a);
  assert.equal(db.getAgent(a.id).lifecycle, 'shut_down');
  assert.deepEqual(skipped(a.id), []);
});
