#!/usr/bin/env node
// S-3372: launched_at and resumed_at. A spawn sets launched_at; a resume (a restart, a wake from rest) sets
// resumed_at and leaves launched_at; a re-adopt that doesn't relaunch the harness changes neither; the API row
// carries both as ISO strings, null on a row that never started. Only lifecycle.ts startHarness writes them.
// Runs against a throwaway STAM_HOME and tmux socket with a fake harness; no daemon, no network, no models:
// `node --test test/launch-time.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('launch-time-');
const socket = `launch-time-test-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
process.env.STAM_EMBEDDER = 'stub';
process.env.STAM_MACHINE = 'test';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [], stuckStartMinutes: 15 }));

let db, lifecycle, publicAgent;
before(async () => {
  db = await import('../src/db.ts');
  lifecycle = await import('../src/lifecycle.ts');
  publicAgent = (await import('../src/agent-public.ts')).publicAgent;
  const { adapters } = await import('../src/adapters/index.ts');
  adapters.fake = {
    pushPrompt: async () => true,
    launch: async () => ({ argv: ['sleep', '600'], env: {} }),
    afterLaunch: async () => {},
    atPrompt: () => true,
  };
});
after(() => {
  spawnSync('tmux', ['-L', socket, 'kill-server']);
});

let n = 0;
function agent() {
  const id = db.newAgentId();
  const cwd = join(home, `work-${id}`);
  mkdirSync(cwd);
  db.createAgent({ id, name: `t${++n}`, role: '', machine: 'test', harness: 'fake', model: null, effort: null, cwd, parent_id: null, session_id: `sess-${id}` });
  db.updateAgent(id, { workspace: JSON.stringify({ spec: { kind: 'dir', path: cwd }, cwd }), lifecycle: 'active', activity: 'idle' });
  return db.getAgent(id);
}
const get = (id) => db.getAgent(id);

test('a row that never started reads null in both columns', () => {
  const a = agent();
  assert.equal(get(a.id).launched_at, null);
  assert.equal(get(a.id).resumed_at, null);
});

test('a spawn sets launched_at and leaves resumed_at null', async () => {
  const a = agent();
  const { launched } = await lifecycle.startHarness(get(a.id), 'hello', false);
  await launched;
  assert.match(get(a.id).launched_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(get(a.id).resumed_at, null);
});

test('a resume sets resumed_at, later than launched_at, and leaves launched_at as it was', async () => {
  const a = agent();
  const { launched } = await lifecycle.startHarness(get(a.id), 'hello', false);
  await launched;
  // The spawn's time is set an hour back, so the order does not depend on the clock's milliseconds.
  db.updateAgent(a.id, { launched_at: '2026-10-20T00:00:00.000Z' });
  const spawned = get(a.id).launched_at;
  const r = await lifecycle.startHarness(get(a.id), undefined, true);
  await r.launched;
  assert.equal(get(a.id).launched_at, spawned, 'the resume leaves launched_at');
  assert.ok(get(a.id).resumed_at, 'the resume sets resumed_at');
  assert.ok(Date.parse(get(a.id).resumed_at) > Date.parse(get(a.id).launched_at), 'resumed_at is later than launched_at');
});

test('a fresh-to-fresh recovery leaves launched_at unchanged and sets resumed_at', async () => {
  const a = agent();
  const first = await lifecycle.startHarness(get(a.id), 'hello', false);
  await first.launched;
  const spawned = get(a.id).launched_at;
  // A fresh launch again, as recoverFirstPrompt or a fresh stuck-start restart makes it.
  const again = await lifecycle.startHarness(get(a.id), 'hello again', false, 'spawn');
  await again.launched;
  assert.equal(get(a.id).launched_at, spawned, 'launched_at is the first start only');
  assert.ok(get(a.id).resumed_at, 'the later fresh start sets resumed_at');
});

test('a re-adopt without relaunch leaves both unchanged', async () => {
  const a = agent();
  const { launched } = await lifecycle.startHarness(get(a.id), 'hello', false);
  await launched;
  const r = await lifecycle.startHarness(get(a.id), undefined, true);
  await r.launched;
  const before = { launched: get(a.id).launched_at, resumed: get(a.id).resumed_at };
  assert.ok(before.launched && before.resumed);
  // A live pane found again, with no launch: settleStart only reads its state, it never starts a harness.
  await lifecycle.settleStart(get(a.id), true);
  assert.equal(get(a.id).launched_at, before.launched);
  assert.equal(get(a.id).resumed_at, before.resumed);
});

test('the API row carries both fields as ISO strings', async () => {
  const a = agent();
  const { launched } = await lifecycle.startHarness(get(a.id), 'hello', false);
  await launched;
  const row = publicAgent(get(a.id));
  assert.equal(row.launched_at, get(a.id).launched_at);
  assert.equal(row.resumed_at, null);
  assert.ok('resumed_at' in row, 'resumed_at is served even when null');
  assert.equal(publicAgent(agent()).launched_at, null, 'an agent that never started serves null');
});

test('only lifecycle.ts writes launched_at and resumed_at (db.ts declares them, agent-public.ts serves them)', () => {
  const srcDir = new URL('../src/', import.meta.url);
  const allowed = new Set(['db.ts', 'agent-public.ts', 'lifecycle.ts']);
  const hits = readdirSync(srcDir, { recursive: true }).filter((f) => f.endsWith('.ts') && !allowed.has(f) && /\b(launched_at|resumed_at)\b/.test(readFileSync(new URL(f, srcDir), 'utf8')));
  assert.deepEqual(hits, []);
});
