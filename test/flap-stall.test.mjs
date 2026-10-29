#!/usr/bin/env node
// S-2369: a fleet-wide cost pause or unpause must not hold the event loop for the sum of the agents' work
// (the daemon stalled ~36 s per cycle and MCP calls timed out), and quick flaps must still end in the right
// state. Agents are tmux-backed (a workspace and a session), so a resume asks tmux per agent, as in the
// daemon. Runs against a throwaway STAM_HOME with stubbed harness prompts; no daemon, no models:
// `node --test test/flap-stall.test.mjs`.
import { test, before, after } from 'node:test';
import { killTmuxServer } from '../src/tmux-socket.ts';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-flap-stall-');
const socket = `flap-stall-test-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [], cost: { subscriptionWarnPercent: [], accounts: { 'claude-max': { match: { harness: 'claude' }, paid: false } } } }));

const N = 40;
let db, blockers, rules, usage;
before(async () => {
  db = await import('../src/db.ts');
  blockers = await import('../src/blockers.ts');
  rules = await import('../src/rules.ts');
  usage = await import('../src/usage.ts');
  const { adapters } = await import('../src/adapters/index.ts');
  adapters.claude.pushPrompt = async () => true;
  // Archived rows, as the live db carries them: a read of every agent is not free.
  for (let i = 0; i < 600; i++) {
    const id = db.newAgentId();
    db.createAgent({ id, name: `old${i}`, role: '', machine: 'test', harness: 'claude', model: null, effort: null, cwd: home, parent_id: null, session_id: null });
    db.updateAgent(id, { lifecycle: 'archived' });
  }
});
after(() => {
  killTmuxServer(socket);
  rmSync(home, { recursive: true, force: true });
});

const fleet = [];
function addFleet() {
  for (let i = 0; i < N; i++) {
    const id = db.newAgentId();
    db.createAgent({ id, name: `f${i}`, role: '', machine: 'test', harness: 'claude', model: null, effort: null, cwd: home, parent_id: null, session_id: null });
    db.updateAgent(id, { activity: 'idle', workspace: 'w', session_id: 's' });
    spawnSync('tmux', ['-L', socket, 'new-session', '-d', '-s', id, 'sleep 600']);
    fleet.push(id);
  }
}
const lifecycles = () => fleet.map((id) => db.getAgent(id).lifecycle);
const held = () => fleet.filter((id) => blockers.blockers(id).some((b) => b.kind === 'window')).length;
function reading(now, five) {
  const resets = Math.floor(now / 1000) + 3600;
  usage.reportSubscription('claude', { five_hour: { used_percentage: five, resets_at: resets }, seven_day: { used_percentage: 40, resets_at: resets + 86400 } }, now);
  return rules.evaluateRules('claude-max', {}, now);
}

// The longest the loop is held between two turns of a setImmediate loop, while `work` runs.
async function longestBlock(work) {
  let longest = 0;
  let last = performance.now();
  let stop = false;
  const spin = () => {
    const t = performance.now();
    longest = Math.max(longest, t - last);
    last = t;
    if (!stop) setImmediate(spin);
  };
  setImmediate(spin);
  const t0 = performance.now();
  await work();
  const total = performance.now() - t0;
  stop = true;
  await new Promise((r) => setImmediate(r));
  return { longest, total };
}

test('a fleet pause and unpause hold the event loop for a fraction of the cycle, not all of it', async () => {
  addFleet();
  const t0 = Date.now();
  const pause = await longestBlock(() => reading(t0, 100));
  assert.equal(held(), N);
  assert.deepEqual([...new Set(lifecycles())], ['paused']);
  const resume = await longestBlock(() => reading(t0 + 1000, 10));
  assert.equal(held(), 0);
  assert.deepEqual([...new Set(lifecycles())], ['active']);
  // The pause is cheap per agent, so only a bound; the resume asks tmux per agent, which held the loop for the sum
  // of the asks. A pass that yields between agents holds it for about one agent's work.
  assert.ok(pause.longest < 250, `pause held the loop ${Math.round(pause.longest)} ms`);
  assert.ok(resume.longest < resume.total / 4, `resume held the loop ${Math.round(resume.longest)} ms of ${Math.round(resume.total)} ms`);
  assert.ok(resume.longest < 250, `resume held the loop ${Math.round(resume.longest)} ms`);
});

test('a tmux that times out during a resume is not read as a missing session (no relaunch of a live harness)', async () => {
  const tmux = await import('../src/tmux.ts');
  const { pause, unpause } = await import('../src/lifecycle.ts');
  // A workspace agent with no session id: a relaunch would throw "has no session to resume".
  const id = db.newAgentId();
  db.createAgent({ id, name: 'slowtmux', role: '', machine: 'test', harness: 'claude', model: null, effort: null, cwd: home, parent_id: null, session_id: null });
  db.updateAgent(id, { activity: 'idle', workspace: 'w' });
  await pause(db.getAgent(id), 'human');
  tmux.setTmuxRunner(async () => ({ status: null, stdout: '', stderr: '' }));
  try {
    await unpause(db.getAgent(id), { by: 'human' });
  } finally {
    tmux.setTmuxRunner(null);
  }
  assert.equal(db.getAgent(id).lifecycle, 'active');
  // Exit code 1 is the one answer that means gone: it still goes the relaunch path.
  await pause(db.getAgent(id), 'human');
  tmux.setTmuxRunner(async () => ({ status: 1, stdout: '', stderr: '' }));
  try {
    await assert.rejects(unpause(db.getAgent(id), { by: 'human' }), /no session to resume/);
  } finally {
    tmux.setTmuxRunner(null);
  }
  db.updateAgent(id, { lifecycle: 'archived' });
});

test('flaps: pause, unpause, pause in quick succession ends paused, with every agent held once and awaited', async () => {
  const t0 = Date.now() + 10_000;
  const a = reading(t0, 100);
  const b = reading(t0 + 1000, 10);
  const c = reading(t0 + 2000, 100);
  await Promise.all([a, b, c]); // cleanup waits for the passes in flight
  assert.equal(held(), N);
  assert.deepEqual([...new Set(lifecycles())], ['paused']);
  // The blockers are rows, so a restart reads the same: who is held and why.
  const rows = db.open().prepare("SELECT agent_id FROM blockers WHERE kind = 'window'").all();
  assert.equal(new Set(rows.map((r) => r.agent_id)).size, N);
});
