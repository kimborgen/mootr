#!/usr/bin/env node
// Unit tests for the admission gate of docs/cost-policy.md (build step 5): admit() before
// every model turn stam starts. One test per path: mail, stam's own prompts (pushPrompt),
// the human's direct prompt, ring turns, compaction, resume, restart, unpause, and spawn,
// plus delivery of queued mail once the blockers clear. Runs against a throwaway STAM_HOME
// with its own tmux socket and a fake harness that records prompts; no daemon, no network,
// no models: `node --test test/admission.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-admission-');
const socket = `admission-test-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
// One account for the spawn gate; settings() reads the file.
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [], cost: { accounts: { 'claude-max': { match: { harness: 'claude' } } } } }));

let db, blockers, lifecycle, mail, ring, admission;
// What the fake harness received, per agent id: pushed prompts, first prompts at launch
// (null when it launched without one), and compactions.
const prompts = new Map();
const launches = new Map();
const compactions = new Map();
let launchHold = Promise.resolve();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Mail and notices go out after a 2 s debounce (mail.ts PUSH_DEBOUNCE_MS).
const PUSHED = 2400;
before(async () => {
  db = await import('../src/db.ts');
  blockers = await import('../src/blockers.ts');
  lifecycle = await import('../src/lifecycle.ts');
  mail = await import('../src/mail.ts');
  ring = await import('../src/ring.ts');
  admission = await import('../src/admission.ts');
  const { adapters } = await import('../src/adapters/index.ts');
  const push = (map, id, v) => map.set(id, [...(map.get(id) ?? []), v]);
  adapters.fake = {
    pushPrompt: async (a, text) => (push(prompts, a.id, text), true),
    launch: async () => ({ argv: ['sleep', '600'], env: {} }),
    // Like a real harness: asks the gate right before it delivers the prompt. A test can
    // hold the launch open (launchHold) to change things mid-launch.
    afterLaunch: async (a, prompt, opts = {}) => {
      await launchHold;
      push(launches, a.id, prompt && opts.admit && !opts.admit() ? 'refused' : (prompt ?? null));
    },
    compact: async (a, instructions) => (push(compactions, a.id, instructions ?? ''), { relaunch: false }),
  };
});
after(() => {
  spawnSync('tmux', ['-L', socket, 'kill-server']);
  rmSync(home, { recursive: true, force: true });
});

let n = 0;
function agent(fields = {}) {
  const id = db.newAgentId();
  const a = db.createAgent({ id, name: `g${++n}`, role: '', machine: 'test', harness: 'fake', model: null, effort: null, cwd: home, parent_id: null, session_id: null, ...fields });
  db.updateAgent(id, { activity: 'idle' });
  return db.getAgent(id);
}
const all = (a) => prompts.get(a.id) ?? [];
const get = (a) => db.getAgent(a.id);
const events = (id, type) => db.listEvents(id, 500).filter((e) => e.type === type).map((e) => JSON.parse(e.data ?? 'null'));
const refused = (a, kind) => events(a.id, 'cost:refused').filter((e) => e.kind === kind);
const block = (a, account = 'claude-max') => blockers.addBlocker(a, { kind: 'window', account, reason: 'five_hour at 100%' });

test('mail: a blocked agent is not prompted, its mail stays unread, and it arrives once the blocker clears', async () => {
  const a = agent();
  await block(a);
  const before = all(a).length;
  await mail.sendMail({ from: 'human', to: [a.id], subject: 'while blocked', body: 'hello' });
  await sleep(PUSHED);
  assert.equal(all(a).length, before, 'no prompt while blocked');
  assert.equal(db.unreadCount(a.id), 1);
  assert.equal(db.unpushedCount(a.id), 1);
  assert.match(refused(a, 'mail')[0].reason, /window on claude-max: five_hour at 100%/);

  assert.equal(await blockers.clearBlocker(a, 'window', 'claude-max', 'five_hour reads 12%'), true);
  assert.match(all(a).at(-1), /no longer paused/);
  await sleep(PUSHED);
  assert.match(all(a).at(-1), /while blocked/, 'the queued mail is pushed after the clear');
  assert.equal(db.unpushedCount(a.id), 0);
});

test('mail: a human- or parent-paused agent without blockers still gets its mail as a prompt', async () => {
  const p = agent();
  const a = agent({ parent_id: p.id });
  const b = agent();
  await lifecycle.pause(get(a), p.id);
  await lifecycle.pause(get(b), 'human');
  await mail.sendMail({ from: 'human', to: [a.id, b.id], subject: 'while paused', body: 'hello' });
  await sleep(PUSHED);
  for (const x of [a, b]) {
    assert.equal(get(x).lifecycle, 'paused');
    assert.match(all(x).at(-1), /while paused/);
    assert.equal(db.unpushedCount(x.id), 0);
    assert.equal(refused(x, 'mail').length, 0);
  }
});

test("pushPrompt: stam's own prompt to a blocked agent is refused; the pause notice itself still goes in", async () => {
  const a = agent();
  await block(a);
  assert.match(all(a).at(-1), /You are being paused/, 'the pause notice is not gated');
  // Still finishing its step: the shutdown waits, and its wrap-up prompt is refused.
  db.updateAgent(a.id, { activity: 'working' });
  const before = all(a).length;
  assert.match(await lifecycle.shutdown(get(a)), /waiting/);
  assert.equal(all(a).length, before);
  assert.equal(refused(a, 'prompt').length, 1);
  assert.equal(JSON.parse(get(a).pending_action).type, 'shutdown', 'the shutdown still runs when the turn ends');
});

test("the human's direct prompt into a blocked agent is admitted with a cost:override event", async () => {
  const a = agent();
  await block(a);
  assert.deepEqual(admission.admit(get(a), 'human'), { ok: true });
  const o = events(a.id, 'cost:override');
  assert.equal(o.length, 1);
  assert.equal(o[0].kind, 'human');
  assert.match(o[0].held, /window on claude-max/);
  // Nothing holds a free agent: no event.
  const b = agent();
  assert.deepEqual(admission.admit(get(b), 'human'), { ok: true });
  assert.equal(events(b.id, 'cost:override').length, 0);
});

test('ring turn: a blocked member gets its turn only after the clear; the others get theirs at once', async () => {
  const a = agent();
  const b = agent();
  await block(a);
  const before = all(a).length;
  ring.createRing({ name: 'gate-ring', format: 'rounds', topic: 'admission', members: [a.id, b.id], createdBy: 'human' });
  await sleep(PUSHED);
  assert.match(all(b).at(-1), /gate-ring/);
  assert.equal(all(a).length, before);
  assert.equal(refused(a, 'ring').length, 1);
  await blockers.clearBlocker(a, 'window', 'claude-max');
  await sleep(PUSHED);
  assert.match(all(a).at(-1), /gate-ring/);
});

test('compaction: a blocked agent is not compacted; it stays pending and runs after the clear', async () => {
  const a = agent();
  await block(a);
  const r = await lifecycle.requestCompaction(get(a), { instructions: 'keep the plan', reason: 'test' });
  assert.match(r, /blocked .*compacts after it runs again/);
  assert.equal(compactions.get(a.id), undefined);
  assert.equal(refused(a, 'compact').length, 1);
  assert.equal(JSON.parse(get(a).pending_action).type, 'compact');
  await blockers.clearBlocker(a, 'window', 'claude-max');
  // The unpause prompt starts a turn; the compaction runs when that turn ends.
  await lifecycle.onIdle(a.id);
  assert.deepEqual(compactions.get(a.id), ['keep the plan']);
  assert.equal(get(a).pending_action, null);
});

test('resume: a blocked shut-down agent comes back paused without its prompt (cost:refused resume)', async () => {
  const a = agent({ session_id: 's-resume' });
  await block(a);
  await lifecycle.shutdown(get(a), true);
  await lifecycle.resume(get(a), 'carry on');
  assert.equal(get(a).lifecycle, 'paused');
  assert.deepEqual(launches.get(a.id), [null]);
  assert.equal(refused(a, 'resume').length, 1);
});

test('restart: a blocked agent restarts paused without its prompt (cost:refused restart)', async () => {
  const a = agent({ session_id: 's-restart' });
  await block(a);
  assert.equal(await lifecycle.restart(get(a), 'testing'), 'done');
  assert.equal(get(a).lifecycle, 'paused');
  assert.deepEqual(launches.get(a.id), [null]);
  assert.equal(refused(a, 'restart').length, 1);
});

test('unpause: refused while a blocker holds the agent, by the human or on the resume path itself', async () => {
  const a = agent();
  await block(a);
  const before = all(a).length;
  await assert.rejects(lifecycle.unpause(get(a), { by: 'human' }), /stays paused: window on claude-max/);
  await assert.rejects(lifecycle.serial(a.id, () => lifecycle.resumeNow(a.id, 'go')), /stays paused/);
  assert.equal(get(a).lifecycle, 'paused');
  assert.equal(all(a).length, before);
  assert.equal(refused(a, 'unpause').length, 2);
});

test('spawn: an account-wide blocker refuses a new agent on that account; only the human may force it', () => {
  // Earlier tests leave window blockers on claude-max; start from none.
  db.open().prepare('DELETE FROM blockers').run();
  const holder = agent();
  db.open().prepare('INSERT INTO blockers (agent_id, kind, account, reason, since) VALUES (?, ?, ?, ?, ?)').run(holder.id, 'credits-out', 'claude-max', 'balance $0.00', new Date().toISOString());
  const p = agent();
  assert.throws(() => admission.admitSpawn({ name: 'kid', harness: 'claude', model: 'claude-haiku-5-5', by: p.id, human: false }), /can't spawn kid: account claude-max is blocked: credits-out \(balance \$0\.00\)/);
  assert.equal(refused(p, 'spawn').length, 1);
  assert.equal(refused(p, 'spawn')[0].account, 'claude-max');
  // An agent's force counts for nothing; the human's goes through, for the caller to record.
  assert.throws(() => admission.admitSpawn({ name: 'kid', harness: 'claude', by: p.id, human: false, force: true }), /blocked/);
  assert.throws(() => admission.admitSpawn({ name: 'kid', harness: 'claude', human: true }), /blocked/);
  assert.equal(events('human', 'cost:refused').length, 1);
  assert.match(admission.admitSpawn({ name: 'kid', harness: 'claude', human: true, force: true }).reason, /credits-out/);
  // Another account, or no account, or a blocker that isn't account-wide: admitted.
  assert.equal(admission.admitSpawn({ name: 'kid', harness: 'codex', human: false }), null);
  db.open().prepare('DELETE FROM blockers WHERE agent_id = ?').run(holder.id);
  db.open().prepare('INSERT INTO blockers (agent_id, kind, account, reason, since) VALUES (?, ?, ?, ?, ?)').run(holder.id, 'budget', 'claude-max', 'tree budget spent', new Date().toISOString());
  assert.equal(admission.admitSpawn({ name: 'kid', harness: 'claude', human: false }), null);
});

test('launch: a blocker added during the launch keeps the prompt back, and it goes in after the clear (review P1)', async () => {
  const a = agent({ session_id: 's-launch' });
  let release;
  launchHold = new Promise((r) => (release = r));
  await lifecycle.startHarness(get(a), 'your first task: write the gate', false, 'spawn');
  assert.equal(get(a).lifecycle, 'active', 'nothing held it at the start');
  await block(a);
  release();
  await sleep(50);
  launchHold = Promise.resolve();
  assert.deepEqual(launches.get(a.id), ['refused']);
  assert.equal(refused(a, 'spawn').length, 1);
  assert.ok(!all(a).some((t) => /first task/.test(t)));
  await blockers.clearBlocker(a, 'window', 'claude-max');
  await sleep(PUSHED);
  assert.match(all(a).at(-1), /your first task: write the gate/);
});

test('mail held by a blocker goes in when the last blocker clears, though a human pause stays (review P2)', async () => {
  const a = agent();
  await lifecycle.pause(get(a), 'human');
  await block(a);
  await mail.sendMail({ from: 'human', to: [a.id], subject: 'stranded?', body: 'hello' });
  await sleep(PUSHED);
  assert.equal(db.unpushedCount(a.id), 1);
  assert.equal(await blockers.clearBlocker(a, 'window', 'claude-max'), false);
  await sleep(PUSHED);
  assert.equal(get(a).lifecycle, 'paused');
  assert.deepEqual(lifecycle.pauseOwners(get(a)), ['human']);
  assert.match(all(a).at(-1), /stranded\?/);
  assert.equal(db.unpushedCount(a.id), 0);
});

test('a deferred compaction survives the relaunch when the blocker clears without a terminal (review P2)', async () => {
  const a = agent({ session_id: 's-recover' });
  db.updateAgent(a.id, { workspace: JSON.stringify({ kind: 'dir', cwd: home }) });
  await block(a);
  assert.match(await lifecycle.requestCompaction(get(a), { instructions: 'keep it', reason: 'test' }), /blocked/);
  assert.equal(compactions.get(a.id), undefined);
  // Its terminal went down while it was blocked: the clear relaunches it.
  assert.equal(get(a).activity, 'idle');
  await blockers.clearBlocker(a, 'window', 'claude-max');
  assert.equal(get(a).lifecycle, 'active');
  assert.match(launches.get(a.id).at(-1), /no longer paused/);
  assert.equal(JSON.parse(get(a).pending_action).type, 'compact', 'kept across the launch');
  await lifecycle.onIdle(a.id);
  assert.deepEqual(compactions.get(a.id), ['keep it']);
});
