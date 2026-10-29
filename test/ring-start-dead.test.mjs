#!/usr/bin/env node
// S-3070: a ring member that never starts (no harness process past settings.startingTimeoutMinutes)
// used to stall its ring: lifecycle marked the agent stopped and told only its parent. Now the ring
// is decided at once: it ends on its type's single-reviewer fallback when one is recorded and allowed,
// else incomplete (S-3862). A ring decides only on verdicts from every member it was created with, so a
// missing member never reads as agreement. The ring state and the member's 'starting:dead' event live in
// the DB, so a restart's sweep finishes what a crash between the two steps left. A dropped member is no
// longer a member and a ring that is done takes no submission, so a late start can't post a verdict.
// Throwaway STAM_HOME and tmux socket with a fake harness; no daemon, no network, no models:
// `node --test test/ring-start-dead.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-ring-start-dead-');
const socket = `ring-start-dead-test-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
process.env.STAM_EMBEDDER = 'stub';
process.env.STAM_MACHINE = 'test';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [] }));
writeFileSync(join(home, 'registry.json'), JSON.stringify({ types: { cdx: { description: 'codex reviewer', harness: 'codex', model: null, effort: null, review: { fallback: null, ring: null } }, solo: { description: 'single reviewer', harness: 'fake', model: null, effort: null, review: { fallback: null, ring: null } } } }));

let db, lifecycle, ring, daemon, mail;
before(async () => {
  db = await import('../src/db.ts');
  lifecycle = await import('../src/lifecycle.ts');
  ring = await import('../src/ring.ts');
  daemon = await import('../src/daemon.ts');
  mail = await import('../src/mail.ts');
  const { adapters } = await import('../src/adapters/index.ts');
  adapters.fake = {
    pushPrompt: async () => true,
    launch: async () => ({ argv: ['sleep', '600'], env: {} }),
    afterLaunch: async () => {},
    turnRunning: async () => false,
  };
});
after(() => {
  spawnSync('tmux', ['-L', socket, 'kill-server']);
  // A fallback spawn starts a background dependency fill in the home; retry while it's still writing.
  rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

let n = 0;
const longAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
function agent({ stuck = false, type = null, harness = 'other' } = {}) {
  const id = db.newAgentId();
  const cwd = join(home, `work-${id}`);
  mkdirSync(cwd);
  db.createAgent({ id, name: `m${++n}`, role: '', machine: 'test', harness, model: null, effort: null, cwd, parent_id: null, session_id: `sess-${id}` });
  db.updateAgent(id, { type, workspace: JSON.stringify({ spec: { kind: 'dir', path: cwd }, cwd }), lifecycle: 'active', activity: stuck ? 'starting' : 'idle', created_at: stuck ? longAgo(20) : new Date().toISOString() });
  return db.getAgent(id);
}
const start = (format, members, opts = {}) => ring.createRing({ name: `r${++n}`, format, topic: 'Review PR 972', members: members.map((m) => m.name), maxRounds: 2, createdBy: 'human', ...opts });
const row = (r) => ring.status(r.id);
const ids = (r) => JSON.parse(db.open().prepare('SELECT members FROM rings WHERE id = ?').get(r.id).members);
const events = (id, type) => db.listEvents(id, 500).filter((e) => e.type === type);
const submitText = (r, a) => ring.submit(r.id, a.id, 'ok', true, 'approve');

test('a member that never started makes the ring incomplete, even when every other member approved', async () => {
  const [a, b, dead] = [agent(), agent(), agent({ stuck: true })];
  const r = start('rounds', [a, b, dead]);
  submitText(r, a);
  submitText(r, b);
  assert.equal(row(r).status, 'running', 'the round waits on the member that never started');
  await lifecycle.markStartingDead(db.getAgent(dead.id));
  assert.equal(row(r).status, 'done');
  assert.match(row(r).result, /^Incomplete: m\d+ never submitted/, 'the result leads with the incomplete notice, naming the missing member');
  assert.doesNotMatch(row(r).result, /all members agreed/);
  assert.equal(events(dead.id, 'ring:dropped').length, 1);
  assert.equal(events(dead.id, 'ring:missing').length, 1);
});

test('a dropped member that starts late cannot submit', async () => {
  const [a, b, dead] = [agent(), agent(), agent({ stuck: true })];
  const r = start('rounds', [a, b, dead]);
  await lifecycle.markStartingDead(db.getAgent(dead.id));
  assert.equal(row(r).status, 'done');
  assert.throws(() => submitText(r, dead), /is done/);
  assert.throws(() => submitText(r, a), /is done/);
});

test('a fire ring whose current turn is the dead member is incomplete, and nobody gets a second turn', async () => {
  const [dead, a, b] = [agent({ stuck: true }), agent(), agent()];
  const r = start('fire', [dead, a, b]);
  const before = [a, b].map((x) => mail.queuedNoticeCount(x.id));
  await lifecycle.markStartingDead(db.getAgent(dead.id));
  assert.equal(row(r).status, 'done');
  assert.match(row(r).result, /Incomplete/);
  assert.deepEqual([a, b].map((x) => mail.queuedNoticeCount(x.id)), before, 'no turn prompt for the members');
  assert.throws(() => submitText(r, a), /is done/);
});

test('a dead moderator is dropped and the members decide the ring', async () => {
  const [a, b, mod] = [agent(), agent(), agent({ stuck: true })];
  const r = start('rounds', [a, b], { moderator: mod.name });
  submitText(r, a);
  submitText(r, b);
  assert.equal(row(r).status, 'moderating');
  await lifecycle.markStartingDead(db.getAgent(mod.id));
  assert.equal(row(r).moderator_id, null);
  assert.equal(row(r).status, 'done');
});

const allowed = (fb, dead) => daemon.fallbackAllowed(fb, [].concat(dead));

test('a recorded fallback the dead member\'s own type can\'t supply leaves the ring incomplete, and the survivor is not retired', async () => {
  // A mixed review-ring whose fallback type is the dead member's own type: no new reviewer is spawned.
  const [a, dead] = [agent({ type: 'reviewer-opus' }), agent({ stuck: true, type: 'reviewer' })];
  const r = start('rounds', [a, dead]);
  ring.recordFallback(r, { type: 'reviewer', body: { prompt: 't' } });
  await lifecycle.markStartingDead(db.getAgent(dead.id));
  await Promise.all([...daemon.ringReactions]);
  assert.equal(row(r).status, 'done', 'the ring is decided at once, not left for the survivor');
  assert.match(row(r).result, /^Incomplete: /);
  assert.equal(db.getAgent(r.name), undefined, 'no fallback reviewer is spawned');
  assert.equal(db.getAgent(a.id).lifecycle, 'active', 'an incomplete ring retires no one');
  assert.throws(() => submitText(r, a), /is done/, 'the survivor can no longer post a verdict into it');
});

test('a survivor that had already submitted does not make the ring agree', async () => {
  const [a, dead] = [agent(), agent({ stuck: true })];
  const r = start('rounds', [a, dead]);
  ring.submit(r.id, a.id, 'ok', false, 'approve');
  await lifecycle.markStartingDead(db.getAgent(dead.id));
  assert.equal(row(r).status, 'done');
  assert.match(row(r).result, /^Incomplete: /);
});

test('a ring whose member never started falls back on its type\'s fallback, spawned from the spawn-time body, and no second verdict is possible', async () => {
  const [a, b] = [agent({ stuck: true, type: 'reviewer' }), agent({ stuck: true, type: 'reviewer' })];
  const r = start('rounds', [a, b]);
  ring.recordFallback(r, { type: 'solo', body: { prompt: 'raw task', brief_vars: { pr: '972' }, cwd: home } });
  await lifecycle.markStartingDead(db.getAgent(a.id));
  await Promise.all([...daemon.ringReactions]);
  assert.equal(row(r).status, 'done');
  assert.match(row(r).result, /fell back to a single solo reviewer/);
  assert.throws(() => submitText(r, b), /is done/);
  const fb = db.getAgent(r.name);
  assert.equal(fb?.type, 'solo', 'the single reviewer runs in its place');
  assert.match(fb.first_prompt ?? '', /raw task/, 'spawned from the spawn-time prompt');
  await lifecycle.markStartingDead(db.getAgent(b.id));
  await Promise.all([...daemon.ringReactions]);
  assert.equal(db.getAgent(r.name).id, fb.id, 'the second death spawns no second reviewer');
});

test('a fallback retires the ring\'s other live members, and the incomplete case retires no one', async () => {
  const [a, b, dead] = [agent({ type: 'reviewer-opus' }), agent({ type: 'reviewer-opus' }), agent({ stuck: true, type: 'reviewer' })];
  const r = start('rounds', [a, b, dead]);
  ring.recordFallback(r, { type: 'solo', body: { prompt: 'raw task', cwd: home } });
  await lifecycle.markStartingDead(db.getAgent(dead.id));
  await Promise.all([...daemon.ringReactions]);
  assert.equal(db.getAgent(a.id).lifecycle, 'archived');
  assert.equal(db.getAgent(b.id).lifecycle, 'archived');
  assert.equal(db.getAgent(r.name).type, 'solo');
});

test('the fallback is refused for the dead member\'s own type or harness', () => {
  assert.equal(allowed({ type: 'reviewer', body: {} }, { type: 'reviewer', harness: 'x' }), false);
  assert.equal(allowed({ type: 'solo', body: {} }, { type: 'reviewer', harness: 'fake' }), false, 'same harness');
  assert.equal(allowed({ type: 'solo', body: {} }, { type: 'reviewer', harness: 'codex' }), true);
});

test('a fallback is refused when any member that died shares its type or harness, not only the last', async () => {
  // Codex dies first, Opus last: a Codex fallback is still refused.
  const [codex, opus] = [agent({ stuck: true, type: 'reviewer', harness: 'codex' }), agent({ stuck: true, type: 'reviewer-opus', harness: 'claude' })];
  const r = start('rounds', [codex, opus]);
  ring.recordFallback(r, { type: 'cdx', body: { prompt: 'x', cwd: home } });
  await lifecycle.markStartingDead(db.getAgent(codex.id));
  await lifecycle.markStartingDead(db.getAgent(opus.id));
  await Promise.all([...daemon.ringReactions]);
  assert.equal(db.getAgent(r.name), undefined, 'no fallback reviewer');
  assert.equal(row(r).status, 'done');
  const both = [{ type: 'reviewer', harness: 'codex' }, { type: 'reviewer-opus', harness: 'claude' }];
  assert.equal(daemon.fallbackAllowed({ type: 'cdx', body: {} }, both), false, 'the first to die shares the harness');
  assert.equal(daemon.fallbackAllowed({ type: 'cdx', body: {} }, both.slice(1)), true, 'it would pass if only the last were checked');
});

test('with no fallback the ring ends incomplete, with what it has, and the missing member is named', async () => {
  const dead = agent({ stuck: true });
  const other = agent({ stuck: true });
  const r = start('rounds', [dead, other]);
  await lifecycle.markStartingDead(db.getAgent(dead.id));
  await lifecycle.markStartingDead(db.getAgent(other.id));
  assert.equal(row(r).status, 'done');
  assert.match(row(r).result, /^Incomplete: .* never submitted/);
  assert.match(row(r).result, /Final submissions/);
});

test('a dead member that is off the turn in a fire ring makes the ring incomplete and prompts nobody', async () => {
  const [a, dead, b] = [agent(), agent({ stuck: true }), agent()];
  const r = start('fire', [a, dead, b]);
  await lifecycle.markStartingDead(db.getAgent(dead.id));
  assert.equal(row(r).status, 'done');
  assert.match(row(r).result, /^Incomplete: /);
  assert.deepEqual(ids(r), [a.id, b.id]);
  assert.throws(() => submitText(r, a), /is done/);
});

test('the restart sweep decides a ring whose member never started, and prompts nobody', () => {
  const [a, dead, b] = [agent(), agent(), agent()];
  const r = start('fire', [dead, a, b]);
  db.updateAgent(dead.id, { lifecycle: 'shut_down' });
  db.addEvent(dead.id, 'starting:dead', {});
  const before = mail.queuedNoticeCount(a.id);
  assert.equal(ring.sweepDeadMembers().length, 1);
  assert.equal(row(r).status, 'done', 'the sweep finished the ring as incomplete');
  assert.match(row(r).result, /^Incomplete: /);
  assert.equal(mail.queuedNoticeCount(a.id), before, 'no turn prompt is queued for the member on the turn');
  assert.equal(events(a.id, 'ring:missing').length, 0, 'the survivor was not dropped');
});

test('a restart between marking the member dead and telling the ring is finished by the sweep', async () => {
  const [a, b, dead] = [agent(), agent(), agent({ stuck: true })];
  const r = start('rounds', [a, b, dead]);
  // What markStartingDead wrote before the daemon went down.
  db.updateAgent(dead.id, { lifecycle: 'shut_down', activity: 'unknown', activity_detail: 'never started: no harness process' });
  db.addEvent(dead.id, 'starting:dead', {});
  assert.deepEqual(ids(r), [a.id, b.id, dead.id]);
  assert.equal(ring.sweepDeadMembers().length, 1);
  assert.deepEqual(ids(r), [a.id, b.id]);
  assert.equal(row(r).status, 'done');
  assert.match(row(r).result, /^Incomplete: /);
  assert.equal(ring.sweepDeadMembers().length, 0, 'a second sweep finds nothing');
});

test('a ring the old code dropped, with only ring:dropped, is incomplete when its survivor approves', async () => {
  const [a, dead] = [agent(), agent({ stuck: true })];
  const r = start('rounds', [a, dead]);
  // The shape the pre-S-3862 code left: the dead member off the list, max_rounds at the round, and no ring:missing.
  db.addEvent(dead.id, 'ring:dropped', { ring: r.id, why: 'never started: no harness process' });
  db.open().prepare('UPDATE rings SET members = ?, max_rounds = ? WHERE id = ?').run(JSON.stringify([a.id]), 1, r.id);
  submitText(r, a);
  assert.equal(row(r).status, 'done');
  assert.match(row(r).result, /^Incomplete: /, 'the survivor\'s approval is not the ring\'s verdict');
  assert.doesNotMatch(row(r).result, /all members agreed/);
  // The result mail is written asynchronously: wait for its row to exist, then read it.
  const mailRows = () => db.open().prepare('SELECT body FROM mail WHERE subject = ?').all(`Ring ${r.name} ended`);
  for (let i = 0; i < 1000 && !mailRows().length; i++) await new Promise((done) => setImmediate(done));
  const mailed = mailRows().map((x) => x.body).join('\n');
  assert.match(mailed, /Incomplete: /, 'the ring\'s result mail was written');
  assert.doesNotMatch(mailed, /pr_review/, 'the ring\'s mail names no verdict line');
});

test('a dead moderator of a ring the old code dropped does not make it incomplete', () => {
  const [a, b, mod] = [agent(), agent(), agent()];
  const r = start('rounds', [a, b], { moderator: mod.name });
  db.addEvent(mod.id, 'ring:dropped', { ring: r.id, why: 'never started: no harness process' });
  db.open().prepare('UPDATE rings SET moderator_id = NULL WHERE id = ?').run(r.id);
  submitText(r, a);
  submitText(r, b);
  assert.equal(row(r).status, 'done');
  assert.match(row(r).result, /Final submissions/);
  assert.doesNotMatch(row(r).result, /^Incomplete: /);
});

test('a 3-member ring with one dead member and two approves is not agreed', async () => {
  const [a, b, dead] = [agent(), agent(), agent({ stuck: true })];
  const r = start('rounds', [a, b, dead]);
  submitText(r, a);
  submitText(r, b);
  await lifecycle.markStartingDead(db.getAgent(dead.id));
  assert.equal(row(r).status, 'done');
  assert.match(row(r).result, /^Incomplete: /);
  assert.doesNotMatch(row(r).result, /all members agreed/);
});

test('a moderated ring with a dead member is never told the members agree', async () => {
  const [a, b, dead, mod] = [agent(), agent(), agent({ stuck: true }), agent()];
  const r = start('rounds', [a, b, dead], { moderator: mod.name });
  const before = mail.queuedNoticeCount(mod.id);
  submitText(r, a);
  submitText(r, b);
  assert.equal(row(r).status, 'running', 'the round waits on the member that never started, so the moderator is not asked yet');
  await lifecycle.markStartingDead(db.getAgent(dead.id));
  assert.equal(row(r).status, 'done');
  assert.equal(mail.queuedNoticeCount(mod.id), before, 'the moderator is not prompted to moderate');
  assert.doesNotMatch(JSON.stringify(events(mod.id, 'notice:queued')), /All members agree/);
  assert.match(row(r).result, /^Incomplete: /);
});

test('a member marked dead before it joined the ring, or revived since, is not swept', () => {
  const [a, b, old, revived] = [agent(), agent(), agent(), agent()];
  db.updateAgent(old.id, { lifecycle: 'shut_down' });
  db.addEvent(old.id, 'starting:dead', {});
  db.updateAgent(revived.id, { lifecycle: 'shut_down' });
  const r = start('rounds', [a, b, old, revived]);
  db.addEvent(revived.id, 'starting:dead', {});
  db.addEvent(revived.id, 'resume', {});
  assert.equal(ring.sweepDeadMembers().length, 0);
  assert.equal(ids(r).length, 4);
});

test('a moderator marked dead before the ring existed is not swept', () => {
  const [a, b, mod] = [agent(), agent(), agent()];
  db.updateAgent(mod.id, { lifecycle: 'shut_down' });
  db.addEvent(mod.id, 'starting:dead', {});
  const past = new Date(Date.now() - 60_000).toISOString();
  db.open().prepare("UPDATE events SET ts = ? WHERE agent_id = ? AND type = 'starting:dead'").run(past, mod.id);
  const r = start('rounds', [a, b], { moderator: mod.name });
  assert.equal(ring.sweepDeadMembers().length, 0);
  assert.equal(row(r).moderator_id, mod.id);
});

test('a taken-over member and a member that did start are not swept', () => {
  const [a, b, held] = [agent(), agent(), agent()];
  const r = start('rounds', [a, b, held]);
  db.updateAgent(held.id, { lifecycle: 'shut_down', forwarded_to: a.id });
  db.addEvent(held.id, 'starting:dead', {});
  assert.equal(ring.sweepDeadMembers().length, 0);
  assert.equal(ids(r).length, 3);
});

test('an agent in no ring is marked dead as before', async () => {
  const dead = agent({ stuck: true });
  await lifecycle.markStartingDead(db.getAgent(dead.id));
  assert.equal(db.getAgent(dead.id).lifecycle, 'shut_down');
  assert.equal(events(dead.id, 'ring:dropped').length, 0);
});
