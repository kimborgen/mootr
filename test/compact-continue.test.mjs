#!/usr/bin/env node
// What a resumed agent is told after a compaction (S-4304). A compaction that cut into work (compact_self,
// the enforcement threshold) ends with a continue prompt even when the agent gave none, else the agent sits
// idle and rests; an idle compaction ("before a long rest", the cache lifetime) has no work to continue and
// gets none. A prompt the agent gave is kept. Runs against a throwaway STAM_HOME and tmux socket with a fake
// harness; no daemon, no network, no models: `node --test test/compact-continue.test.mjs`.
import { test, before, after } from 'node:test';
import { killTmuxServer } from '../src/tmux-socket.ts';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-compact-continue-');
const socket = `compact-continue-test-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
process.on('exit', () => killTmuxServer(socket));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(130));
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_COMPACTOR']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [] }));
globalThis.fetch = async () => ({ ok: true });

let db, lifecycle;
// The prompt each agent's relaunch after its compaction was given.
const delivered = new Map();
before(async () => {
  db = await import('../src/db.ts');
  lifecycle = await import('../src/lifecycle.ts');
  const { adapters } = await import('../src/adapters/index.ts');
  adapters.fake = {
    pushPrompt: async () => true,
    launch: async () => ({ argv: ['sleep', '600'], env: {} }),
    afterLaunch: async (a, prompt) => {
      delivered.set(a.id, prompt);
    },
    compact: async () => ({ relaunch: true }),
    compactQuits: true,
  };
});
after(() => {
  killTmuxServer(socket);
  rmSync(home, { recursive: true, force: true });
});

let n = 0;
function agent() {
  const id = db.newAgentId();
  const cwd = join(home, `work-${id}`);
  mkdirSync(cwd);
  db.createAgent({ id, name: `c${++n}`, role: '', machine: 'test', harness: 'fake', model: null, effort: null, cwd, parent_id: null, session_id: `sess-${id}` });
  db.updateAgent(id, { lifecycle: 'active', activity: 'idle' });
  return db.getAgent(id);
}
const events = (id, type) => db.listEvents(id, 500).filter((e) => e.type === type);

for (const reason of ['requested by the agent', 'enforcement threshold']) {
  test(`a compaction for "${reason}" without a prompt ends with the continue prompt`, async () => {
    const a = agent();
    await lifecycle.requestCompaction(a, { reason });
    assert.equal(events(a.id, 'compact:done').length, 1);
    assert.equal(delivered.get(a.id), lifecycle.COMPACT_CONTINUE_PROMPT);
  });
}

test('a prompt the agent gave is kept', async () => {
  const a = agent();
  await lifecycle.requestCompaction(a, { reason: 'requested by the agent', prompt: 'carry on with PR 6' });
  assert.equal(delivered.get(a.id), 'carry on with PR 6');
});

for (const reason of ['before a long rest', 'idle past the cache lifetime']) {
  test(`a compaction "${reason}" gets no prompt`, async () => {
    const a = agent();
    await lifecycle.requestCompaction(a, { reason });
    assert.equal(events(a.id, 'compact:done').length, 1);
    assert.equal(delivered.get(a.id), undefined);
  });
}

test('a held agent keeps the continue prompt as a notice', async () => {
  const a = agent();
  db.updateAgent(a.id, { paused_by: JSON.stringify(['human']) });
  await lifecycle.requestCompaction(db.getAgent(a.id), { reason: 'requested by the agent' });
  assert.equal(delivered.get(a.id), undefined);
  assert.ok(events(a.id, 'notice:queued').some((e) => JSON.stringify(e.data).includes('context was compacted')));
});

test('a held agent keeps the prompt compact_self gave, as in S-4317 (reconcile:held after compact)', async () => {
  const a = agent();
  db.updateAgent(a.id, { paused_by: JSON.stringify(['human']) });
  await lifecycle.requestCompaction(db.getAgent(a.id), { reason: 'requested by the agent', prompt: 'carry on with PR 6' });
  assert.equal(delivered.get(a.id), undefined, 'not typed into a held harness');
  assert.ok(events(a.id, 'notice:queued').some((e) => JSON.stringify(e.data).includes('carry on with PR 6')), 'kept for when the agent is idle again');
});
