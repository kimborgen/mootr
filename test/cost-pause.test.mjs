#!/usr/bin/env node
// Unit tests for build step 12 of docs/cost-policy.md: a manager pauses a tree until a
// subscription window resets or a set time, and stam lifts the pause by itself; an early
// clear; a spawn into a paused tree is held; permissions; and the ack of the tree's open
// cost notices. Runs against a throwaway STAM_HOME with a stubbed harness: no daemon, no
// network, no models: `node --test test/cost-pause.test.mjs`.
import { test, before, after, beforeEach } from 'node:test';
import { killTmuxServer } from '../src/tmux-socket.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-cost-pause-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `cost-pause-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

function writeSettings() {
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify({
      chiefOfStaff: 'cos',
      humanMail: { when: 'necessary' },
      cost: { subscriptionWarnPercent: [], accounts: { 'claude-max': { match: { harness: 'claude' }, paid: false } } },
    }),
  );
}
writeSettings();

let db, blockers, costPause, costAuth, costNotices, usage;
const prompts = new Map();
before(async () => {
  db = await import('../src/db.ts');
  blockers = await import('../src/blockers.ts');
  costPause = await import('../src/cost-pause.ts');
  costAuth = await import('../src/cost-auth.ts');
  costNotices = await import('../src/cost-notices.ts');
  usage = await import('../src/usage.ts');
  const { adapters } = await import('../src/adapters/index.ts');
  adapters.claude.pushPrompt = async (a, text) => {
    prompts.set(a.id, [...(prompts.get(a.id) ?? []), text]);
    return true;
  };
});
after(() => {
  killTmuxServer(process.env.STAM_TMUX_SOCKET);
  rmSync(home, { recursive: true, force: true });
});

let n = 0;
function agent(name, parent_id = null, fields = {}) {
  const id = db.newAgentId();
  db.createAgent({ id, name, role: '', machine: 'test', harness: 'claude', model: null, effort: null, cwd: home, parent_id, session_id: null, ...fields });
  db.updateAgent(id, { activity: 'idle' });
  return db.getAgent(id);
}
const get = (a) => db.getAgent(a.id);
const manual = (a) => blockers.blockers(a).find((b) => b.kind === 'manual');
const settle = () => new Promise((r) => setTimeout(r, 50));
const R = () => Math.floor(Date.now() / 1000) + 3600;

let cos, mgr, other;
beforeEach(() => {
  costNotices.notices(0); // create the cost_notices table before clearing it
  const d = db.open();
  for (const t of ['cost_notices', 'blockers', 'agent_parents', 'agents', 'window_readings', 'usage_samples', 'subscriptions', 'mail_recipients', 'mail', 'events']) d.exec(`DELETE FROM ${t}`);
  writeSettings();
  cos = agent('cos');
  mgr = agent('mgr', cos.id);
  other = agent('other'); // not in mgr's tree
  costPause.reschedule(); // drop the previous tests' timers
});

test('pause until reset: every agent in the tree is held, and a fresh reading below the old percentage clears it', async () => {
  const root = agent('root', mgr.id);
  const child = agent('child', root.id);
  const t0 = Date.now();
  const resets = R();
  usage.reportSubscription('claude', { five_hour: { used_percentage: 90, resets_at: resets } }, t0);
  await settle();

  const r = await costPause.costPause({ root: root.id, by: mgr.id, until: 'reset' });
  assert.equal(r.action, 'paused');
  assert.deepEqual(r.agents.sort(), ['child', 'root']);
  for (const a of [root, child]) {
    const b = manual(a);
    assert.ok(b, `${a.name} carries the manual pause`);
    assert.equal(get(a).lifecycle, 'paused');
    assert.match(b.reason, /mgr paused the tree until claude-max's five_hour \(at 90%\) resets/);
    assert.equal(b.clear.kind, 'reset');
    assert.equal(b.clear.account, 'claude-max');
    assert.equal(b.clear.window, 'five_hour');
    assert.equal(b.clear.pct, 90);
    assert.equal(b.clear.resets_at, resets);
  }

  // A fresh reading taken after the pause, below the old percentage, confirms the reset.
  usage.reportSubscription('claude', { five_hour: { used_percentage: 40, resets_at: resets } }, t0 + 5000);
  await settle();
  for (const a of [root, child]) {
    assert.equal(manual(a), undefined);
    assert.equal(get(a).lifecycle, 'active');
  }
});

test('pause until a time is cleared by the timer when the time passes', async () => {
  const root = agent('root', mgr.id);
  const at = new Date(Date.now() + 150).toISOString();
  const r = await costPause.costPause({ root: root.id, by: mgr.id, until: at, reason: 'quiet hours' });
  assert.equal(r.action, 'paused');
  assert.equal(manual(root).clear.kind, 'time');
  assert.equal(get(root).lifecycle, 'paused');
  // Let the timer fire, then evaluate once more so the assertion is deterministic.
  await new Promise((res) => setTimeout(res, 400));
  await costPause.evaluatePauses();
  await settle();
  assert.equal(manual(root), undefined);
  assert.equal(get(root).lifecycle, 'active');
});

test('an agent spawned into a paused tree is held, and the clear releases it too', async () => {
  const root = agent('root', mgr.id);
  await costPause.costPause({ root: root.id, by: mgr.id, until: new Date(Date.now() + 3600_000).toISOString() });
  // As daemon.spawn does: a new child created under the paused root.
  const late = agent('late', root.id);
  await costPause.attachSpawn(get(late));
  assert.ok(manual(late), 'the spawn inherited the pause');
  assert.equal(get(late).lifecycle, 'paused');

  await costPause.costPause({ root: root.id, by: mgr.id, clear: true });
  assert.equal(manual(root), undefined);
  assert.equal(manual(late), undefined);
  assert.equal(get(late).lifecycle, 'active');
});

test('clear removes the pause early, on the whole tree', async () => {
  const root = agent('root', mgr.id);
  const child = agent('child', root.id);
  await costPause.costPause({ root: root.id, by: mgr.id, until: new Date(Date.now() + 86_400_000).toISOString() });
  assert.ok(manual(root) && manual(child));

  const r = await costPause.costPause({ root: root.id, by: mgr.id, clear: true });
  assert.equal(r.action, 'cleared');
  assert.deepEqual(r.agents.sort(), ['child', 'root']);
  assert.equal(manual(root), undefined);
  assert.equal(manual(child), undefined);
  assert.equal(get(root).lifecycle, 'active');
  assert.equal(get(child).lifecycle, 'active');
});

test('permissions: the human, the chief of staff, an ancestor, and the root itself; no one else', async () => {
  const root = agent('root', mgr.id);
  const child = agent('child', root.id);
  assert.equal(costAuth.mayManageTree('human', root), true);
  assert.equal(costAuth.mayManageTree(cos.id, root), true);
  assert.equal(costAuth.mayManageTree(mgr.id, root), true, 'the manager of the tree');
  assert.equal(costAuth.mayManageTree(root.id, root), true, 'the root manages its own tree');
  assert.equal(costAuth.mayManageTree(other.id, root), false, 'an unrelated agent');
  assert.equal(costAuth.mayManageTree(child.id, root), false, "a child can't manage its ancestor's tree");

  await assert.rejects(costPause.costPause({ root: root.id, by: other.id, until: 'reset' }), /may not manage/);
  assert.equal(blockers.blockers(root).length, 0);
});

test('calling it acknowledges the tree\'s open cost notices', async () => {
  const root = agent('root', mgr.id);
  agent('child', root.id);
  db.updateAgent(root.id, { activity: 'working' });
  const resets = R();
  usage.reportSubscription('claude', { five_hour: { used_percentage: 82, resets_at: resets } }, Date.now());
  costNotices.windowWarning('claude', 'five_hour', 82, 80, resets, Date.now());
  const notice = costNotices.notices().find((x) => x.kind === 'window');
  assert.ok(notice, 'a window notice was raised');
  assert.equal(notice.acked_at, null);

  const r = await costPause.costPause({ root: root.id, by: mgr.id, until: 'reset' });
  assert.ok(r.acked.includes(notice.id), 'the notice was acknowledged');
  assert.equal(costNotices.notice(notice.id).acked_by, mgr.id);
});
