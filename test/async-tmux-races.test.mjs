#!/usr/bin/env node
// S-3841: what an async tmux call may do after it awaits. A fake tmux runner (setTmuxRunner) and a fake adapter stand in
// for tmux and the harness: no tmux, no network, no models. `node --test test/async-tmux-races.test.mjs`.
//  - settleStart: a relaunch during the screen read settles nothing.
//  - reconcileStaleWorking: an empty prompt read before a fresh hook doesn't end the turn that hook started.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-async-races-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `stam-test-async-races-${process.pid}`;
process.env.STAM_EMBEDDER = 'stub';
process.env.STAM_MACHINE = 'test';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [], staleWorkingMinutes: 5 }));

let db, tmux, daemon, adapters, lifecycle;
before(async () => {
  db = await import('../src/db.ts');
  tmux = await import('../src/tmux.ts');
  daemon = await import('../src/daemon.ts');
  lifecycle = await import('../src/lifecycle.ts');
  ({ adapters } = await import('../src/adapters/index.ts'));
});
after(() => {
  tmux.setTmuxRunner(null);
  rmSync(home, { recursive: true, force: true });
});

let n = 0;
function agent(activity) {
  const id = db.newAgentId();
  const cwd = join(home, `w-${id}`);
  mkdirSync(cwd);
  db.createAgent({ id, name: `r${++n}`, role: '', machine: 'test', harness: 'claude', model: null, effort: null, cwd, parent_id: null, session_id: `sess-${id}` });
  db.updateAgent(id, { workspace: JSON.stringify({ spec: { kind: 'dir', path: cwd }, cwd }), lifecycle: 'active', activity });
  return db.getAgent(id);
}

// Pushes the agent's last hook two hours back, so it is stale by the 5-minute setting.
function stale(a) {
  db.addEvent(a.id, 'hook:UserPromptSubmit', {});
  db.open().prepare("UPDATE events SET ts = ? WHERE agent_id = ? AND type LIKE 'hook:%'").run(new Date(Date.now() - 2 * 3600_000).toISOString(), a.id);
}
const reconciled = (id) => db.listEvents(id, 100).filter((e) => e.type === 'activity:reconciled');

test('reconcileStaleWorking: a stale turn at an empty prompt goes idle', async () => {
  const a = agent('working');
  stale(a);
  adapters.claude = { ...adapters.claude, atPrompt: async () => true, __orig: adapters.claude };
  try {
    await daemon.reconcileStaleWorking();
    assert.equal(db.getAgent(a.id).activity, 'idle');
    assert.equal(reconciled(a.id).length, 1);
  } finally {
    adapters.claude = adapters.claude.__orig;
  }
});

test('reconcileStaleWorking: a fresh hook, or a new session, while the screen is read leaves the new turn alone', async () => {
  const orig = adapters.claude;
  try {
    for (const change of [(a) => db.addEvent(a.id, 'hook:UserPromptSubmit', {}), (a) => db.updateAgent(a.id, { session_id: 'sess-restarted' })]) {
      const a = agent('working');
      stale(a);
      let release;
      adapters.claude = { ...orig, atPrompt: () => new Promise((r) => (release = r)) };
      const sweep = daemon.reconcileStaleWorking();
      await new Promise((r) => setTimeout(r, 20));
      change(a);
      release(true);
      await sweep;
      assert.equal(db.getAgent(a.id).activity, 'working', 'the new turn kept running');
      assert.equal(reconciled(a.id).length, 0);
    }
  } finally {
    adapters.claude = orig;
  }
});

test('settleStart: a relaunch during the screen read leaves the agent starting', async () => {
  const orig = adapters.claude;
  try {
    for (const relaunch of [false, true]) {
      const a = agent('idle');
      db.updateAgent(a.id, { activity: 'starting', activity_detail: 'resuming' });
      let release;
      adapters.claude = { ...orig, atPrompt: () => new Promise((r) => (release = r)) };
      const settling = lifecycle.settleStart(db.getAgent(a.id), true);
      await new Promise((r) => setTimeout(r, 20));
      if (relaunch) lifecycle.invalidateLaunch(a.id);
      release(true);
      assert.equal(await settling, !relaunch);
      assert.equal(db.getAgent(a.id).activity, relaunch ? 'starting' : 'idle');
    }
  } finally {
    adapters.claude = orig;
  }
});
