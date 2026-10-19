#!/usr/bin/env node
// Unit tests for reconnecting agents' MCP servers after stam's tools change (S-178,
// lifecycle.reconnectMcpWhenIdle): never mid-turn, the pending reconnect runs when the agent
// goes idle (also when a turn starts while the adapter awaits, or the reload fails, up to
// five tries with backoff), and agents sharing one MCP client (OpenCode's, per directory) reconnect once,
// only when all of them are idle. Fake harnesses, a throwaway STAM_HOME; no daemon, no
// network, no models: `node --test test/mcp-reconnect.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mcp-reconnect-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `mcp-reconnect-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [] }));

let db, lifecycle;
const calls = []; // [harness, agent id] per reconnect
const ctl = { reconnect: async () => true };
before(async () => {
  db = await import('../src/db.ts');
  lifecycle = await import('../src/lifecycle.ts');
  const { adapters } = await import('../src/adapters/index.ts');
  const fake = (name, shared) => ({
    name,
    pushPrompt: async () => true,
    reconnectMcp: async (a) => (calls.push([name, a.id]), true),
    ...(shared ? { mcpScope: (a) => a.cwd } : {}),
  });
  adapters['fake-own'] = fake('fake-own', false);
  adapters['fake-shared'] = fake('fake-shared', true);
  adapters['fake-none'] = { name: 'fake-none', pushPrompt: async () => true };
  // Does what `ctl.reconnect` says, as Codex would: awaits (its app-server), then proceeds.
  adapters['fake-ctl'] = { name: 'fake-ctl', pushPrompt: async () => true, reconnectMcp: (a, opts) => ctl.reconnect(a, opts) };
});
after(() => rmSync(home, { recursive: true, force: true }));

let n = 0;
function agent(harness, activity, dir = `d${n}`) {
  const id = db.newAgentId();
  const cwd = join(home, 'work', dir);
  mkdirSync(cwd, { recursive: true });
  db.createAgent({ id, name: `a${n++}`, role: 'r', machine: 'test', harness, model: null, effort: null, cwd, parent_id: null, session_id: null });
  db.updateAgent(id, { activity });
  return id;
}
const pending = (id) => db.getAgent(id).pending_action;
async function goIdle(id) {
  db.updateAgent(id, { activity: 'idle' });
  await lifecycle.onIdle(id);
}

test('an idle agent reconnects now; a working one when its turn ends, never before', async () => {
  calls.length = 0;
  const idle = agent('fake-own', 'idle');
  const busy = agent('fake-own', 'working');
  await lifecycle.reconnectMcpWhenIdle([idle, busy]);
  assert.deepEqual(calls, [['fake-own', idle]]);
  assert.equal(pending(idle), null);
  assert.match(pending(busy), /reconnect-mcp/);
  await goIdle(busy);
  assert.deepEqual(calls, [['fake-own', idle], ['fake-own', busy]]);
  assert.equal(pending(busy), null);
});

test('an agent that goes idle after it was marked, before the loop reaches it, still reconnects', async () => {
  calls.length = 0;
  const a = agent('fake-own', 'working');
  const b = agent('fake-own', 'working');
  const run = lifecycle.reconnectMcpWhenIdle([a, b]);
  // Both are marked before the first reconnect runs; b's turn ends while the loop works.
  db.updateAgent(b, { activity: 'idle' });
  await run;
  assert.deepEqual(calls, [['fake-own', b]]);
  await goIdle(a);
  assert.deepEqual(calls, [['fake-own', b], ['fake-own', a]]);
});

test('agents sharing a client reconnect once, after the last of them goes idle', async () => {
  calls.length = 0;
  const a = agent('fake-shared', 'idle', 'shared');
  const b = agent('fake-shared', 'working', 'shared');
  const other = agent('fake-shared', 'idle', 'elsewhere');
  await lifecycle.reconnectMcpWhenIdle([a, b, other]);
  assert.deepEqual(calls, [['fake-shared', other]], 'the shared client waits for b');
  await goIdle(a);
  assert.equal(calls.length, 1, "a's idle doesn't reconnect while b works");
  await goIdle(b);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], 'fake-shared');
  assert.equal(pending(a), null);
  assert.equal(pending(b), null);
  await goIdle(b);
  assert.equal(calls.length, 2, 'once per scope');
});

test('another pending action stays; a harness without reconnect is left alone', async () => {
  calls.length = 0;
  const a = agent('fake-own', 'working');
  db.updateAgent(a, { pending_action: JSON.stringify({ type: 'recover', reason: 'x' }) });
  const c = agent('fake-none', 'idle');
  await lifecycle.reconnectMcpWhenIdle([a, c]);
  assert.match(pending(a), /recover/);
  assert.equal(pending(c), null);
  assert.deepEqual(calls, []);
});

test('a turn that starts while the adapter awaits defers the reload to the next idle', async () => {
  const a = agent('fake-ctl', 'idle');
  let release;
  const gate = new Promise((r) => (release = r));
  let reloads = 0;
  ctl.reconnect = async (_a, opts) => {
    await gate;
    if (opts?.proceed && !opts.proceed()) return true;
    reloads++;
    return true;
  };
  const run = lifecycle.reconnectMcpWhenIdle([a]);
  db.updateAgent(a, { activity: 'working' }); // its turn starts during the adapter's await
  release();
  await run;
  assert.equal(reloads, 0, 'no reload mid-turn');
  assert.match(pending(a), /reconnect-mcp/, 'put back for the next idle');
  await goIdle(a);
  assert.equal(reloads, 1);
  assert.equal(pending(a), null);
});

test('a failed reload is retried at a later idle with backoff, five tries at most', async () => {
  const a = agent('fake-ctl', 'idle');
  let tries = 0;
  ctl.reconnect = async () => {
    tries++;
    throw new Error('app-server gone');
  };
  // Lets the backoff pass, as if the time had come.
  const due = () => {
    const p = JSON.parse(pending(a));
    db.updateAgent(a, { pending_action: JSON.stringify({ ...p, after: 0 }) });
  };
  await lifecycle.reconnectMcpWhenIdle([a]);
  assert.equal(tries, 1);
  const p = JSON.parse(pending(a));
  assert.equal(p.tries, 1);
  assert.ok(p.after > Date.now(), 'backs off');
  await goIdle(a);
  assert.equal(tries, 1, 'not before the backoff');
  for (let i = 2; i <= 5; i++) {
    due();
    await goIdle(a);
    assert.equal(tries, i);
  }
  assert.equal(pending(a), null, 'gives up after five tries');
  ctl.reconnect = async () => true;
});
