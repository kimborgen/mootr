#!/usr/bin/env node
// A ring member that cost_switch took over (S-2485): its successor NAME-t2 submits for the member
// and the ring completes; a chain (-t2 to -t3) works; anything the takeover record doesn't link
// to a live member is refused. Throwaway STAM_HOME, no daemon: `node --test test/ring-takeover.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-ring-takeover-');
process.env.STAM_HOME = home;
const db = await import('../src/db.ts');
const ring = await import('../src/ring.ts');
const mail = await import('../src/mail.ts');

let n = 0;
const agent = (name = `m${++n}`) => db.createAgent({ id: db.newAgentId(), name, role: '', machine: 'test', harness: 'fake', model: null, effort: null, cwd: home, parent_id: null, session_id: null });
// The takeover record cost_switch writes: the predecessor forwards to its successor.
const takeOver = (from, to) => db.updateAgent(from.id, { forwarded_to: to.id });
const start = (format, members, maxRounds = 1) => ring.createRing({ name: `r${++n}`, format, topic: 'review the change', members: members.map((m) => m.name), maxRounds, createdBy: 'human' });
const submitterIds = (r) => ring.status(r.id).submissions.map((s) => s.agent_id);

test("a taken-over member's successor submits for it, and the ring completes", () => {
  const [a, b] = [agent(), agent()];
  const a2 = agent(`${a.name}-t2`);
  takeOver(a, a2);
  const r = start('rounds', [a, b]);
  assert.equal(mail.queuedNoticeCount(a.id), 0, 'the held predecessor gets no turn');
  assert.equal(mail.queuedNoticeCount(a2.id), 1, 'the successor gets the turn');
  assert.match(ring.submit(r.id, a2.id, 'Looks fine.', true, 'approve'), /Waiting for the other members/);
  ring.submit(r.id, b.id, 'Fine too.', true, 'approve');
  const s = ring.status(r.id);
  assert.equal(s.status, 'done');
  assert.deepEqual(submitterIds(r).sort(), [a.id, b.id].sort(), 'the submission is the member\'s');
  assert.deepEqual(s.members, [a.name, b.name], 'the ring still names the member');
});

test('a successor takes its member\'s turn in a fire ring, and the round names the member', () => {
  const [a, b] = [agent(), agent()];
  const a2 = agent(`${a.name}-t2`);
  takeOver(a, a2);
  const r = start('fire', [a, b], 2);
  assert.throws(() => ring.submit(r.id, b.id, 'Too early.', true), /it is .*'s turn/);
  ring.submit(r.id, a2.id, 'First findings.', false);
  ring.submit(r.id, b.id, 'Second findings.', true);
  const s = ring.status(r.id);
  assert.equal(s.round, 2, 'the first round did not agree, so the second starts');
  assert.deepEqual(submitterIds(r).sort(), [a.id, b.id].sort());
  assert.equal(s.submissions.find((x) => x.agent_id === a.id).text, 'First findings.');
});

test('a successor of a successor submits for the original member (-t2 to -t3)', () => {
  const [a, b] = [agent(), agent()];
  const a2 = agent(`${a.name}-t2`);
  const a3 = agent(`${a.name}-t3`);
  takeOver(a, a2);
  takeOver(a2, a3);
  const r = start('fire', [a, b]);
  assert.equal(mail.queuedNoticeCount(a3.id), 1, 'the end of the chain gets the turn');
  assert.throws(() => ring.submit(r.id, a2.id, 'Middle of the chain.', true), /not a member of this ring/);
  ring.submit(r.id, a3.id, 'Last of the chain.', true);
  ring.submit(r.id, b.id, 'Mine.', true);
  const s = ring.status(r.id);
  assert.equal(s.status, 'done');
  assert.deepEqual(submitterIds(r).sort(), [a.id, b.id].sort(), 'the submission is the original member\'s');
});

test('a non-successor is refused: a similar name, an unlinked agent, or an archived successor', () => {
  const [a, b] = [agent(), agent()];
  const r = start('rounds', [a, b]);
  assert.throws(() => ring.submit(r.id, agent(`${a.name}-t2`).id, 'Not taken over.', true), /not a member of this ring/);
  const a3 = agent(`${a.name}-t3`);
  takeOver(a, a3);
  db.updateAgent(a3.id, { lifecycle: 'archived' });
  assert.throws(() => ring.submit(r.id, a3.id, 'Archived successor.', true), /not a member of this ring/);
  assert.equal(ring.status(r.id).status, 'running');
});

test('a successor of a member outside the ring is refused', () => {
  const [a, b] = [agent(), agent()];
  const outsider = agent();
  const outsiderSuccessor = agent(`${outsider.name}-t2`);
  takeOver(outsider, outsiderSuccessor);
  const r = start('rounds', [a, b]);
  assert.throws(() => ring.submit(r.id, outsiderSuccessor.id, 'Not my seat.', true), /not a member of this ring/);
});

test('a member that is also a successor of another member keeps its own seat (S-2490)', () => {
  const [x, y] = [agent(), agent()];
  takeOver(x, y);
  const r = start('rounds', [x, y]);
  assert.match(ring.submit(r.id, y.id, 'My own findings.', true, undefined, undefined, y.name), /Waiting for the other members/);
  assert.deepEqual(submitterIds(r), [y.id], 'y submits for itself, not for x');
});

test('a moderator successor calls decide, and the ring-moderate notice reaches it (S-2490)', () => {
  const [a, b, mod] = [agent(), agent(), agent()];
  const mod2 = agent(`${mod.name}-t2`);
  const r = ring.createRing({ name: `r${++n}`, format: 'rounds', topic: 'design the ring', members: [a.name, b.name], moderator: mod.name, maxRounds: 2, createdBy: 'human' });
  ring.submit(r.id, a.id, 'Fine.', false);
  ring.submit(r.id, b.id, 'Fine too.', false);
  assert.equal(ring.status(r.id).status, 'moderating');
  assert.equal(mail.queuedNoticeCount(mod.id), 1, 'the moderator holds the ring-moderate notice');
  // The switch: the predecessor is taken over, and its queued ring turn moves to the successor.
  takeOver(mod, mod2);
  assert.equal(mail.moveRingNotices(mod.id, mod2.id), 1);
  assert.equal(mail.queuedNoticeCount(mod.id), 0);
  assert.equal(mail.queuedNoticeCount(mod2.id), 1);
  const queued = db.listEvents(mod2.id, 50).filter((e) => e.type === 'notice:queued').map((e) => JSON.parse(e.data ?? 'null').text);
  assert.match(queued[0], /moderat/i);
  ring.decide(r.id, mod2.id, false, 'Ends here.');
  assert.equal(ring.status(r.id).status, 'done');
});

test('after a restart each open seat is prompted again once, and a submitted seat is not (S-2490)', () => {
  const [a, b, c] = [agent(), agent(), agent()];
  const r = start('rounds', [a, b, c]);
  ring.submit(r.id, a.id, 'Done already.', true);
  // A restart empties the in-memory queue; the durable ring state still has the open seats.
  for (const m of [a, b, c]) mail.truncateNotices(m.id, 0);
  // Other rings of this test file are still running, so the sweep prompts them too.
  ring.promptOpenSeats();
  assert.equal(mail.queuedNoticeCount(a.id), 0, 'a seat that submitted is not prompted');
  assert.equal(mail.queuedNoticeCount(b.id), 1);
  assert.equal(mail.queuedNoticeCount(c.id), 1);
});

test('a predecessor and its successor both in a rounds ring: the successor fills the predecessor\'s seat once its own is in (S-2646)', () => {
  const x = agent();
  const x2 = agent(`${x.name}-t2`);
  takeOver(x, x2);
  const r = start('rounds', [x, x2]);
  assert.match(ring.submit(r.id, x2.id, 'Own findings.', true, undefined, undefined, x2.name), /Waiting for the other members/);
  assert.match(ring.submit(r.id, x2.id, 'Findings for the predecessor\'s seat.', true), /The round is complete/);
  const s = ring.status(r.id);
  assert.equal(s.status, 'done', 'the ring completes instead of waiting for the predecessor\'s seat');
  assert.deepEqual(submitterIds(r).sort(), [x.id, x2.id].sort());
  assert.equal(s.submissions.find((z) => z.agent_id === x.id).text, 'Findings for the predecessor\'s seat.');
});

test('a predecessor and its successor both in a fire ring: the successor takes the predecessor\'s turn when that is its seat\'s turn (S-2646)', () => {
  const x = agent();
  const x2 = agent(`${x.name}-t2`);
  takeOver(x, x2);
  const r = start('fire', [x, x2]);
  ring.submit(r.id, x2.id, 'For the predecessor, whose turn it is.', true);
  ring.submit(r.id, x2.id, 'Its own turn, next.', true);
  const s = ring.status(r.id);
  assert.equal(s.status, 'done');
  assert.deepEqual(submitterIds(r).sort(), [x.id, x2.id].sort());
});

test('a submit naming a round the ring has moved past is refused and writes nothing (S-2646)', () => {
  const [a, b] = [agent(), agent()];
  const r = start('rounds', [a, b], 2);
  ring.submit(r.id, a.id, 'Round one, a.', false, undefined, 1);
  ring.submit(r.id, b.id, 'Round one, b.', false, undefined, 1);
  assert.equal(ring.status(r.id).round, 2);
  assert.throws(() => ring.submit(r.id, a.id, 'Written for round one.', true, undefined, 1), /is on round 2, not 1/);
  assert.deepEqual(ring.status(r.id).submissions.filter((s) => s.round === 2), [], 'the stale submit wrote nothing');
  assert.equal(ring.submit(r.id, a.id, 'Round two.', true, undefined, 2), 'Submitted. Waiting for the other members.');
});

test('a submit naming a round the ring has not reached is refused too (S-2646)', () => {
  const [a, b] = [agent(), agent()];
  const r = start('rounds', [a, b], 2);
  assert.throws(() => ring.submit(r.id, a.id, 'Ahead.', true, undefined, 2), /is on round 1, not 2/);
  assert.deepEqual(ring.status(r.id).submissions, []);
});

test('a rollback after moveRingNotices gives the predecessor its turn back, once (S-2646)', () => {
  const [a, b] = [agent(), agent()];
  const a2 = agent(`${a.name}-t2`);
  start('fire', [a, b]);
  assert.equal(mail.queuedNoticeCount(a.id), 1);
  takeOver(a, a2);
  assert.equal(mail.moveRingNotices(a.id, a2.id), 1, 'the switch moves the turn to the successor');
  assert.equal(mail.moveRingNotices(a2.id, a.id), 1, 'the rollback moves it back');
  assert.equal(mail.queuedNoticeCount(a.id), 1, 'the predecessor has its one turn');
  assert.equal(mail.queuedNoticeCount(a2.id), 0);
  assert.equal(mail.moveRingNotices(a2.id, a.id), 0, 'a second rollback moves nothing');
  assert.equal(mail.queuedNoticeCount(a.id), 1);
});

test('the restart sweep prompts a fire ring\'s next seat, and a successor when that seat was taken over (S-2646)', () => {
  const [a, b] = [agent(), agent()];
  const a2 = agent(`${a.name}-t2`);
  start('fire', [a, b], 2);
  takeOver(a, a2);
  for (const m of [a, a2, b]) mail.truncateNotices(m.id, 0);
  ring.promptOpenSeats();
  assert.equal(mail.queuedNoticeCount(a.id), 0, 'the held predecessor is not prompted');
  assert.equal(mail.queuedNoticeCount(a2.id), 1, 'the successor gets the one turn');
  assert.equal(mail.queuedNoticeCount(b.id), 0, 'b is not prompted before its turn');
});

test('the restart sweep prompts a fire ring only at its current seat, once (S-2646)', () => {
  const [a, b, c] = [agent(), agent(), agent()];
  const r = start('fire', [a, b, c], 2);
  ring.submit(r.id, a.id, 'First.', false);
  for (const m of [a, b, c]) mail.truncateNotices(m.id, 0);
  ring.promptOpenSeats();
  assert.equal(mail.queuedNoticeCount(a.id), 0);
  assert.equal(mail.queuedNoticeCount(b.id), 1);
  assert.equal(mail.queuedNoticeCount(c.id), 0);
});

test('the restart sweep prompts a moderating ring\'s moderator, or its successor once taken over (S-2646)', () => {
  const [a, b, mod] = [agent(), agent(), agent()];
  const mod2 = agent(`${mod.name}-t2`);
  const r = ring.createRing({ name: `r${++n}`, format: 'rounds', topic: 'design the ring', members: [a.name, b.name], moderator: mod.name, maxRounds: 2, createdBy: 'human' });
  ring.submit(r.id, a.id, 'Fine.', false);
  ring.submit(r.id, b.id, 'Fine too.', false);
  assert.equal(ring.status(r.id).status, 'moderating');
  takeOver(mod, mod2);
  for (const m of [a, b, mod, mod2]) mail.truncateNotices(m.id, 0);
  ring.promptOpenSeats();
  assert.equal(mail.queuedNoticeCount(mod.id), 0, 'the held moderator is not prompted');
  assert.equal(mail.queuedNoticeCount(mod2.id), 1, 'the successor gets the ring-moderate notice');
});
