#!/usr/bin/env node
// The handoff before a restart stam causes (S-2241). Above the compaction threshold, a harness
// whose compaction relaunches it gets the restart-prepare text with the handoff line and a deadline;
// the restart runs at its turn's end, or, when it called compact_self, the compaction's relaunch is
// the restart. Below the threshold, and on the idle sweep, nothing is asked. An agent that never
// takes the turn restarts at the deadline, and one the ask can't reach restarts now. A second
// restart joins the pending one. Runs against a throwaway STAM_HOME and tmux socket with a fake
// harness; no daemon, no network, no models: `node --test test/restart-handoff.test.mjs`.
import { test, before, after } from 'node:test';
import { killTmuxServer } from '../src/tmux-socket.ts';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-restart-handoff-');
const socket = `restart-handoff-test-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
process.env.STAM_MACHINE ??= 'test-storage';
process.on('exit', () => killTmuxServer(socket));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(130));
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_COMPACTOR']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [], idleCompaction: { minTokens: 100_000 }, cost: { softStopMinutes: 5 } }));

let db, lifecycle, context;
// Per agent id: the prompts pushed, launches with their prompt, and compactions run.
const prompts = new Map();
const launches = new Map();
const compactions = new Map();
// Per agent id: whether a push reaches the harness, how a compaction ends, and whether it relaunches.
const reach = new Map();
const compactPlan = new Map();
const relaunches = new Map();
const push = (m, id, v) => m.set(id, [...(m.get(id) ?? []), v]);

before(async () => {
  db = await import('../src/db.ts');
  lifecycle = await import('../src/lifecycle.ts');
  context = await import('../src/context.ts');
  const { adapters } = await import('../src/adapters/index.ts');
  adapters.fake = {
    pushPrompt: async (a, text) => {
      if (reach.get(a.id) === false) return false;
      push(prompts, a.id, text);
      return true;
    },
    launch: async () => ({ argv: ['sleep', '600'], env: {} }),
    afterLaunch: async (a, prompt) => push(launches, a.id, prompt ?? ''),
    compact: async (a) => {
      push(compactions, a.id, true);
      if (compactPlan.get(a.id) === 'fail') throw new Error('compaction failed');
      return { relaunch: relaunches.get(a.id) ?? true };
    },
    compactQuits: true,
  };
  // A harness whose compaction keeps it running (Codex, OpenCode): never asked.
  adapters['fake-live'] = { ...adapters.fake, compactQuits: undefined };
});
after(() => {
  killTmuxServer(socket);
  rmSync(home, { recursive: true, force: true });
});

let n = 0;
function agent({ tokens = 150_000, harness = 'fake' } = {}) {
  const id = db.newAgentId();
  const cwd = join(home, `work-${id}`);
  mkdirSync(cwd);
  db.createAgent({ id, name: `h${++n}`, role: '', machine: 'test-storage', harness, model: null, effort: null, cwd, parent_id: null, session_id: `sess-${id}` });
  db.updateAgent(id, { lifecycle: 'active', activity: 'idle', idle_since: new Date(Date.now() - 3_600_000).toISOString(), context_tokens: tokens });
  return db.getAgent(id);
}
const events = (id, type) => db.listEvents(id, 500).filter((e) => e.type === type);
const pending = (id) => JSON.parse(db.getAgent(id).pending_action ?? 'null');
const handoffAsked = (id) => (prompts.get(id) ?? []).some((t) => t.includes('compact_self'));
// The agent takes the pushed turn and ends it.
async function turn(a) {
  db.updateAgent(a.id, { activity: 'working' });
  db.updateAgent(a.id, { activity: 'idle' });
  await lifecycle.onIdle(a.id);
}

test('above the threshold, a restart asks for the handoff first and runs at the turn end', async () => {
  const a = agent();
  const r = await lifecycle.restart(a, 'reconnect MCP servers');
  assert.match(r, /hand off/);
  assert.equal(prompts.get(a.id).length, 1);
  const text = prompts.get(a.id)[0];
  assert.match(text, /Your harness will restart/, 'the restart-prepare text');
  assert.match(text, /compact_self/, 'the handoff line');
  assert.match(text, /150k/);
  const p = pending(a.id);
  assert.equal(p.type, 'restart');
  assert.equal(p.handoff, true);
  assert.ok(p.at > Date.now() + 4 * 60_000 && p.at <= Date.now() + 5 * 60_000, 'deadline from cost.softStopMinutes');
  assert.equal(launches.get(a.id), undefined, 'no restart before the turn ends');
  await turn(a);
  assert.equal(launches.get(a.id).length, 1);
  assert.match(launches.get(a.id)[0], /Your harness restarted \(reconnect MCP servers\)/);
  assert.equal(pending(a.id), null);
});

test('below the threshold, an idle agent restarts at once with nothing asked', async () => {
  const a = agent({ tokens: 50_000 });
  await lifecycle.restart(a, 'reconnect MCP servers');
  assert.equal(prompts.get(a.id), undefined);
  assert.equal(events(a.id, 'restart:handoff').length, 0);
  assert.equal(launches.get(a.id).length, 1);
});

test('a harness whose compaction keeps it running is never asked', async () => {
  const a = agent({ harness: 'fake-live' });
  await lifecycle.restart(a, 'reconnect MCP servers');
  assert.equal(prompts.get(a.id), undefined);
  assert.equal(launches.get(a.id).length, 1);
});

test('the idle sweep never asks for a handoff', async () => {
  const a = agent();
  context.idleSweep();
  assert.equal(handoffAsked(a.id), false);
  assert.equal(events(a.id, 'restart:handoff').length, 0);
});

test('compact_self during the handoff: the compaction relaunch is the restart (reconnect-mcp)', async () => {
  const a = agent();
  await lifecycle.restart(a, 'reconnect MCP servers');
  db.updateAgent(a.id, { activity: 'working' });
  // compact_self, as the MCP tool asks for it
  await lifecycle.requestCompaction(db.getAgent(a.id), { instructions: 'my handoff', prompt: 'carry on', reason: 'requested by the agent' });
  const p = pending(a.id);
  assert.equal(p.type, 'compact');
  assert.deepEqual(p.restart, { reason: 'reconnect MCP servers' }, 'the restart rides along');
  db.updateAgent(a.id, { activity: 'idle' });
  await lifecycle.onIdle(a.id);
  assert.equal(compactions.get(a.id).length, 1);
  // One launch, which reads the MCP config, settings and binary afresh: no second restart.
  assert.equal(launches.get(a.id).length, 1);
  assert.match(launches.get(a.id)[0], /Your harness restarted \(reconnect MCP servers\)/);
  assert.match(launches.get(a.id)[0], /carry on/);
  assert.equal(events(a.id, 'restart:by-compaction').length, 1);
  assert.equal(pending(a.id), null);
});

test('a compaction that keeps the harness up restarts after it, with its prompt', async () => {
  const a = agent();
  relaunches.set(a.id, false);
  await lifecycle.restart(a, 'reconnect MCP servers');
  db.updateAgent(a.id, { activity: 'working' });
  await lifecycle.requestCompaction(db.getAgent(a.id), { instructions: 'my handoff', prompt: 'carry on', reason: 'requested by the agent' });
  db.updateAgent(a.id, { activity: 'idle' });
  await lifecycle.onIdle(a.id);
  assert.equal(compactions.get(a.id).length, 1);
  assert.equal(launches.get(a.id).length, 1);
  assert.match(launches.get(a.id)[0], /Your harness restarted/);
  assert.match(launches.get(a.id)[0], /carry on/);
  assert.equal((prompts.get(a.id) ?? []).filter((t) => t === 'carry on').length, 0, 'the prompt goes with the restart, not before it');
  assert.equal(events(a.id, 'restart:by-compaction').length, 0);
});

test('a failed compaction never holds the restart back', async () => {
  const a = agent();
  compactPlan.set(a.id, 'fail');
  await lifecycle.restart(a, 'reconnect MCP servers');
  db.updateAgent(a.id, { activity: 'working' });
  await lifecycle.requestCompaction(db.getAgent(a.id), { instructions: 'my handoff', reason: 'requested by the agent' });
  db.updateAgent(a.id, { activity: 'idle' });
  await assert.rejects(lifecycle.onIdle(a.id), /compaction failed/);
  assert.equal(launches.get(a.id).length, 1);
  assert.match(launches.get(a.id)[0], /Your harness restarted/);
});

test('a blocker between compact_self and the turn end: the restart runs anyway, the compaction waits', async () => {
  const a = agent();
  await lifecycle.restart(a, 'reconnect MCP servers');
  db.updateAgent(a.id, { activity: 'working' });
  await lifecycle.requestCompaction(db.getAgent(a.id), { instructions: 'my handoff', reason: 'requested by the agent' });
  // A window blocker arrives before the turn ends.
  db.open().prepare('INSERT INTO blockers (agent_id, kind, account, reason, since) VALUES (?, ?, ?, ?, ?)').run(a.id, 'window', 'claude-max', 'five_hour at 100%', new Date().toISOString());
  db.updateAgent(a.id, { activity: 'idle' });
  await lifecycle.onIdle(a.id);
  assert.equal(compactions.get(a.id), undefined, 'no compaction while blocked');
  assert.equal(launches.get(a.id).length, 1, 'restarted at the turn end, not left past the deadline');
  assert.equal(events(a.id, 'restart:compaction-held').length, 1);
  assert.deepEqual(pending(a.id), { type: 'compact', instructions: 'my handoff', reason: 'requested by the agent' }, 'the compaction alone stays pending');
  await lifecycle.runDueRestarts(Date.now() + 3_600_000);
  assert.equal(launches.get(a.id).length, 1, 'nothing left for the deadline');
  db.open().prepare('DELETE FROM blockers WHERE agent_id = ?').run(a.id);
});

test('a failed relaunch puts a mode switch back (compaction relaunch, then restart)', async () => {
  const { failLaunch } = await import('../src/test-hooks.ts');
  const a = agent();
  db.updateAgent(a.id, { permission_mode: 'bypass', permission_source: 'manual' });
  const undo = { mode: 'bypass', source: 'manual', by: 'human', kept: { permission_mode: 'auto', permission_source: null } };
  await lifecycle.restart(db.getAgent(a.id), 'permission mode changed to bypass', undo);
  db.updateAgent(a.id, { activity: 'working' });
  await lifecycle.requestCompaction(db.getAgent(a.id), { instructions: 'my handoff', reason: 'requested by the agent' });
  assert.deepEqual(pending(a.id).restart.permission, undo);
  failLaunch.add(a.name);
  try {
    db.updateAgent(a.id, { activity: 'idle' });
    await assert.rejects(lifecycle.onIdle(a.id), /launch of .* failed/);
  } finally {
    failLaunch.delete(a.name);
  }
  assert.equal(compactions.get(a.id).length, 1);
  assert.equal(events(a.id, 'permission-mode:failed').length, 1);
  assert.equal(db.getAgent(a.id).permission_mode, 'auto', 'the old mode is back');
});

test('a failed relaunch of a plain handoff restart puts a mode switch back', async () => {
  const { failLaunch } = await import('../src/test-hooks.ts');
  const a = agent();
  db.updateAgent(a.id, { permission_mode: 'bypass', permission_source: 'manual' });
  const undo = { mode: 'bypass', source: 'manual', by: 'human', kept: { permission_mode: 'auto', permission_source: null } };
  await lifecycle.restart(db.getAgent(a.id), 'permission mode changed to bypass', undo);
  assert.deepEqual(pending(a.id).permission, undo);
  failLaunch.add(a.name);
  try {
    await assert.rejects(turn(a), /launch of .* failed/);
  } finally {
    failLaunch.delete(a.name);
  }
  assert.equal(events(a.id, 'permission-mode:failed').length, 1);
  assert.equal(db.getAgent(a.id).permission_mode, 'auto');
});

test('an agent that never takes the turn restarts at the deadline', async () => {
  const a = agent();
  await lifecycle.restart(a, 'harness upgraded');
  const { at } = pending(a.id);
  await lifecycle.runDueRestarts(at - 1);
  assert.equal(launches.get(a.id), undefined, 'not before the deadline');
  await lifecycle.runDueRestarts(at);
  assert.equal(launches.get(a.id).length, 1);
  assert.equal(events(a.id, 'restart:handoff-timeout').length, 1);
});

test('a working agent past the deadline restarts at its turn end, not mid-turn', async () => {
  const a = agent();
  await lifecycle.restart(a, 'harness upgraded');
  db.updateAgent(a.id, { activity: 'working' });
  await lifecycle.runDueRestarts(pending(a.id).at + 1);
  assert.equal(launches.get(a.id), undefined);
  db.updateAgent(a.id, { activity: 'idle' });
  await lifecycle.onIdle(a.id);
  assert.equal(launches.get(a.id).length, 1);
});

test('an ask that can not reach an idle agent restarts it now', async () => {
  const a = agent();
  reach.set(a.id, false);
  await lifecycle.restart(a, 'permission mode changed to auto');
  const [e] = events(a.id, 'restart:handoff');
  assert.equal((typeof e.data === 'string' ? JSON.parse(e.data) : e.data).sent, false);
  assert.equal(launches.get(a.id).length, 1);
});

test('a second restart joins the pending handoff: no second ask, the same deadline', async () => {
  const a = agent();
  await lifecycle.restart(a, 'reconnect MCP servers');
  const { at } = pending(a.id);
  await lifecycle.restart(db.getAgent(a.id), 'harness upgraded');
  assert.equal(prompts.get(a.id).length, 1);
  const p = pending(a.id);
  assert.equal(p.at, at);
  assert.equal(p.reason, 'reconnect MCP servers; harness upgraded');
  // Also when compact_self already took the restart along.
  db.updateAgent(a.id, { activity: 'working' });
  await lifecycle.requestCompaction(db.getAgent(a.id), { instructions: 'my handoff', reason: 'requested by the agent' });
  await lifecycle.restart(db.getAgent(a.id), 'reconnect MCP servers');
  assert.equal(prompts.get(a.id).length, 1);
  assert.equal(pending(a.id).restart.reason, 'reconnect MCP servers; harness upgraded', 'a reason already pending is not repeated');
  await turn(a);
  assert.equal(launches.get(a.id).length, 1);
});
