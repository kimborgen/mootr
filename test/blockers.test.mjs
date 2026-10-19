#!/usr/bin/env node
// Unit tests for the cost blockers step of docs/cost-policy.md: the persisted blocker set
// per agent, pauses stam owns versus the human's and agents', the resume rule with its
// notice, and launches of held agents. Runs against a throwaway STAM_HOME with its own tmux
// socket and a fake harness that records prompts; no daemon, no network, no models:
// `node --test test/blockers.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-blockers-');
const socket = `blockers-test-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let db, blockers, lifecycle;
// Prompts the fake harness received, per agent id: pushed ones, and first prompts at launch
// (null when it launched without one).
const prompts = new Map();
const launches = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
before(async () => {
  db = await import('../src/db.ts');
  blockers = await import('../src/blockers.ts');
  lifecycle = await import('../src/lifecycle.ts');
  const { adapters } = await import('../src/adapters/index.ts');
  adapters.fake = {
    // Delivery takes a moment, as a real harness's does, so transitions can interleave.
    pushPrompt: async (a, text) => {
      await sleep(30);
      prompts.set(a.id, [...(prompts.get(a.id) ?? []), text]);
      return true;
    },
    launch: async () => ({ argv: ['sleep', '600'], env: {} }),
    afterLaunch: async (a, prompt) => {
      launches.set(a.id, [...(launches.get(a.id) ?? []), prompt ?? null]);
    },
  };
});
after(() => {
  spawnSync('tmux', ['-L', socket, 'kill-server']);
  rmSync(home, { recursive: true, force: true });
});

let n = 0;
function agent(fields = {}) {
  const id = db.newAgentId();
  const a = db.createAgent({ id, name: `b${++n}`, role: '', machine: 'test', harness: 'fake', model: null, effort: null, cwd: home, parent_id: null, session_id: null, ...fields });
  db.updateAgent(id, { activity: 'idle' });
  return db.getAgent(id);
}
const last = (a) => (prompts.get(a.id) ?? []).at(-1) ?? '';
const get = (a) => db.getAgent(a.id);
const owners = (a) => lifecycle.pauseOwners(get(a));
const events = (a, type) => db.listEvents(a.id, 500).filter((e) => e.type === type);

test('two blockers: clearing one keeps the agent paused, clearing both resumes it', async () => {
  const a = agent();
  await blockers.addBlocker(a, { kind: 'window', account: 'claude-max', reason: 'five_hour at 100%', clear: { resets_at: '2026-10-11T18:00:00Z' } });
  assert.equal(get(a).lifecycle, 'paused');
  assert.deepEqual(owners(a), [], 'only stam holds this pause');
  assert.match(last(a), /You are being paused/);
  await blockers.addBlocker(a, { kind: 'budget', account: 'global', reason: 'daily budget $20 spent' });
  assert.equal(blockers.blockers(a).length, 2);
  assert.deepEqual(blockers.blockers(a)[0].clear, { resets_at: '2026-10-11T18:00:00Z' });
  assert.equal(blockers.blockersFor('claude-max').length, 1);

  assert.equal(await blockers.clearBlocker(a, 'window', 'claude-max', 'five_hour reads 12%'), false);
  assert.equal(get(a).lifecycle, 'paused');
  assert.match(last(a), /You are being paused/, 'no resume notice yet');

  assert.equal(await blockers.clearBlocker(a, 'budget', 'global', 'the day rolled over'), true);
  assert.equal(get(a).lifecycle, 'active');
  assert.equal(blockers.blockers(a).length, 0);
});

test('the resume notice names what cleared', async () => {
  const a = agent();
  await blockers.addBlocker(a, { kind: 'credits-out', account: 'openrouter', reason: 'balance $0.00' });
  await blockers.clearBlocker(a, 'credits-out', 'openrouter', 'balance is $12.40');
  const text = last(a);
  assert.match(text, /no longer paused/);
  assert.match(text, /credits-out on openrouter/);
  assert.match(text, /balance \$0\.00/);
  assert.match(text, /balance is \$12\.40/);
});

test("a human pause plus a blocker: clearing the blocker keeps the human's pause", async () => {
  const a = agent();
  await lifecycle.pause(get(a), 'human');
  await blockers.addBlocker(a, { kind: 'error', account: 'claude-max', reason: '529 overloaded' });
  assert.deepEqual(owners(a), ['human']);
  assert.equal(await blockers.clearBlocker(a, 'error', 'claude-max', 'a probe succeeded'), false);
  assert.equal(get(a).lifecycle, 'paused');
  assert.deepEqual(owners(a), ['human']);

  // And the other order: stam pauses first, then the human pauses too.
  const b = agent();
  await blockers.addBlocker(b, { kind: 'billing-unknown', account: 'claude-work', reason: 'no reading for 20 minutes' });
  await lifecycle.pause(get(b), 'human');
  assert.deepEqual(owners(b), ['human']);
  assert.equal(await blockers.clearBlocker(b, 'billing-unknown', 'claude-work'), false);
  assert.equal(get(b).lifecycle, 'paused');
  assert.equal(await lifecycle.unpause(get(b), { by: 'human' }), 'active');
  assert.deepEqual(owners(b), []);
});

test('concurrent pauses keep every owner, and a clear during the first pause resumes the agent (findings 1, 4)', async () => {
  const a = agent();
  // Neither awaits the other: the cost pause is still telling the agent when the human pauses.
  await Promise.all([blockers.addBlocker(a, { kind: 'window', account: 'claude-max', reason: 'five_hour at 100%' }), lifecycle.pause(get(a), 'human')]);
  assert.equal(get(a).lifecycle, 'paused');
  assert.deepEqual(owners(a), ['human'], "the cost pause didn't overwrite the human's");
  await blockers.clearBlocker(a, 'window', 'claude-max');
  assert.equal(get(a).lifecycle, 'paused');

  const b = agent();
  const [, resumed] = await Promise.all([blockers.addBlocker(b, { kind: 'error', account: 'codex-plus', reason: '500' }), blockers.clearBlocker(b, 'error', 'codex-plus', 'a probe succeeded')]);
  assert.equal(resumed, true);
  assert.equal(get(b).lifecycle, 'active', 'not stranded paused with no blockers');
});

test("a parent's unpause releases only its own pause while blockers hold the agent (finding 2)", async () => {
  const p = agent();
  const c = agent({ parent_id: p.id });
  await lifecycle.pause(get(c), p.id);
  await blockers.addBlocker(c, { kind: 'budget', account: 'tree', reason: 'tree budget $5 spent' });
  const msg = await lifecycle.unpause(get(c), { by: p.id });
  assert.match(msg, /stays paused/);
  assert.match(msg, /budget on tree: tree budget \$5 spent/);
  assert.equal(get(c).lifecycle, 'paused');
  assert.deepEqual(owners(c), []);
  // With its pause gone, the clear resumes it.
  assert.equal(await blockers.clearBlocker(c, 'budget', 'tree'), true);
  assert.equal(get(c).lifecycle, 'active');

  // A parent can't lift the human's pause.
  await lifecycle.pause(get(c), 'human');
  assert.match(await lifecycle.unpause(get(c), { by: p.id }), /paused by the human/);
  assert.equal(get(c).lifecycle, 'paused');
  await assert.rejects(lifecycle.unpause(get(c), { by: p.id, force: true }), /only the human/);
});

test("the human's unpause is refused with the reasons while blockers hold the agent, and force overrides (finding 2)", async () => {
  const a = agent();
  await lifecycle.pause(get(a), 'human');
  await blockers.addBlocker(a, { kind: 'credits-out', account: 'openrouter', reason: 'balance $0.00' });
  await assert.rejects(lifecycle.unpause(get(a), { by: 'human' }), /stays paused: credits-out on openrouter: balance \$0\.00.*force/);
  assert.equal(get(a).lifecycle, 'paused');
  assert.deepEqual(owners(a), [], "the human's own pause is released");
  assert.equal(blockers.blockers(a).length, 1);

  assert.equal(await lifecycle.unpause(get(a), { by: 'human', force: true }), 'active');
  assert.equal(get(a).lifecycle, 'active');
  assert.equal(blockers.blockers(a).length, 0);
  const o = events(a, 'cost:override');
  assert.equal(o.length, 1);
  assert.match(o[0].data, /credits-out/);
});

test('restart and resume bring a held agent back paused, without its prompt (finding 3)', async () => {
  // Human-paused, restarted: paused, owner kept, no prompt.
  const a = agent({ session_id: 's-a' });
  await lifecycle.pause(get(a), 'human');
  assert.equal(await lifecycle.restart(get(a), 'testing'), 'done');
  assert.equal(get(a).lifecycle, 'paused');
  assert.deepEqual(owners(a), ['human']);
  assert.deepEqual(launches.get(a.id), [null]);

  // Blocked, shut down, resumed: paused, no prompt; clearing the blocker then resumes it.
  const b = agent({ session_id: 's-b' });
  await blockers.addBlocker(b, { kind: 'window', account: 'claude-max', reason: 'seven_day at 100%' });
  await lifecycle.shutdown(get(b), true);
  assert.equal(get(b).lifecycle, 'shut_down');
  await lifecycle.resume(get(b));
  assert.equal(get(b).lifecycle, 'paused');
  assert.deepEqual(launches.get(b.id), [null]);
  assert.equal(events(b, 'launch-held').length, 1);
  assert.equal(await blockers.clearBlocker(b, 'window', 'claude-max'), true);
  assert.equal(get(b).lifecycle, 'active');

  // Nothing holds it: a restart runs it with its prompt.
  const c = agent({ session_id: 's-c' });
  await lifecycle.restart(get(c), 'testing');
  assert.equal(get(c).lifecycle, 'active');
  assert.match(launches.get(c.id)[0], /testing/);
});

test('archiving drops the blockers (finding 5)', async () => {
  const a = agent();
  await blockers.addBlocker(a, { kind: 'paid-forbidden', account: 'claude-max', reason: 'paid spend on a paid: false account' });
  await lifecycle.archive(get(a));
  assert.equal(get(a).lifecycle, 'archived');
  assert.equal(blockers.blockers(a).length, 0);
});

test('a shut-down agent gets no cost notice for a blocker set on it (S-787)', async () => {
  const mgr = agent();
  const a = agent({ parent_id: mgr.id });
  await lifecycle.shutdown(get(a), true);
  assert.equal(get(a).lifecycle, 'shut_down');
  await blockers.addBlocker(a, { kind: 'credits-out', account: 'openrouter', reason: 'balance $0.00' });
  assert.equal(blockers.blockers(a).length, 1, 'the blocker is kept for a later resume');
  assert.equal(db.listEvents(mgr.id, 50).filter((e) => e.type === 'cost:notice').length, 0, 'no notice to the manager');
});

test('adding a blocker again keeps its since and updates its reason', async () => {
  const a = agent();
  const first = await blockers.addBlocker(a, { kind: 'window', account: 'codex-plus', reason: 'primary at 100%' });
  const again = await blockers.addBlocker(a, { kind: 'window', account: 'codex-plus', reason: 'primary still at 100%' });
  assert.equal(again.since, first.since);
  assert.equal(again.reason, 'primary still at 100%');
  assert.equal(blockers.blockers(a).length, 1);
  await assert.rejects(blockers.addBlocker(a, { kind: 'nonsense', reason: 'x' }), /unknown blocker kind/);
});

test('the blocker set and the pause owners survive a daemon restart', async () => {
  const a = agent();
  await blockers.addBlocker(a, { kind: 'window', account: 'claude-max', reason: 'seven_day at 100%', clear: { resets_at: '2026-10-14T00:00:00Z' } });
  await blockers.addBlocker(a, { kind: 'taken-over', reason: 'b9-t2 took the work' });
  await lifecycle.pause(get(a), 'human');
  // A fresh process opens the same database, as a restarted daemon does.
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', `const b = await import(${JSON.stringify(pathToFileURL(join(root, 'src/blockers.ts')).href)}); const db = await import(${JSON.stringify(pathToFileURL(join(root, 'src/db.ts')).href)}); const a = db.getAgent(${JSON.stringify(a.id)}); console.log(JSON.stringify({ lifecycle: a.lifecycle, paused_by: a.paused_by, blockers: b.blockers(a.id), blocked: b.blocked().map((x) => x.agent) }));`],
    { env: process.env, encoding: 'utf8' },
  );
  const r = JSON.parse(out.trim().split('\n').at(-1));
  assert.equal(r.lifecycle, 'paused');
  assert.deepEqual(JSON.parse(r.paused_by), ['human']);
  assert.deepEqual(r.blockers.map((b) => [b.kind, b.account]), [['window', 'claude-max'], ['taken-over', '']]);
  assert.deepEqual(r.blockers[0].clear, { resets_at: '2026-10-14T00:00:00Z' });
  assert.ok(r.blocked.includes(a.name), 'the Usage summary lists it');
});
