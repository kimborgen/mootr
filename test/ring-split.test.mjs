#!/usr/bin/env node
// A PR review ring whose members' verdicts split never ends as agreement (S-1824): each member's
// agree is about its own verdict. It runs another round, or ends as "split" at the round cap and
// names each verdict. Throwaway STAM_HOME, no daemon: `node --test test/ring-split.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-ring-split-');
process.env.STAM_HOME = home;
const db = await import('../src/db.ts');
const ring = await import('../src/ring.ts');

let n = 0;
const agent = () => db.createAgent({ id: db.newAgentId(), name: `m${++n}`, role: '', machine: 'test', harness: 'fake', model: null, effort: null, cwd: home, parent_id: null, session_id: null });
const start = (members, maxRounds, topic = 'review PR 603') =>
  ring.createRing({ name: `r${n}`, format: 'rounds', topic, members: members.map((m) => m.name), maxRounds, createdBy: 'human' });
// The ring's result mail; the system sender writes it after a few ticks.
async function resultMail(r) {
  for (let i = 0; i < 50; i++) {
    const m = db.open().prepare('SELECT body, from_id, from_name FROM mail WHERE subject = ?').get(`Ring ${r.name} ended`);
    if (m) {
      assert.equal(m.from_id, 'system:ring', 'the result mail is from the ring system sender, not a stand-in agent');
      assert.equal(m.from_name, 'ring');
      return m.body;
    }
    await new Promise((res) => setImmediate(res));
  }
  assert.fail('the creator gets the result mail');
}
const turnNotice = (r, a) => ring.turnPrompt(db.open().prepare('SELECT * FROM rings WHERE id = ?').get(r.id), a.id);

test('approve plus request_changes, both agreeing, starts another round instead of ending', () => {
  const [a, b] = [agent(), agent()];
  const r = start([a, b], 2);
  ring.submit(r.id, a.id, 'Missing test for the empty case.', true, 'request_changes');
  ring.submit(r.id, b.id, 'Looks good.', true, 'approve');
  const s = ring.status(r.id);
  assert.equal(s.status, 'running');
  assert.equal(s.round, 2);
});

test('a split at the round cap ends as split and names each verdict', async () => {
  const [a, b] = [agent(), agent()];
  const r = start([a, b], 1);
  ring.submit(r.id, a.id, 'Missing test.', true, 'request_changes');
  ring.submit(r.id, b.id, 'Looks good.', true, 'approve');
  const s = ring.status(r.id);
  assert.equal(s.status, 'done');
  assert.match(s.result, new RegExp(`### ${a.name} \\(request_changes\\)`));
  assert.match(s.result, new RegExp(`### ${b.name} \\(approve\\)`));
  const body = await resultMail(r);
  assert.match(body, /ended after round 1: split \(/);
  assert.doesNotMatch(body, /all members agreed/);
  assert.match(body, new RegExp(`${a.name}: request_changes`));
  assert.match(body, new RegExp(`${b.name}: approve`));
});

test('matching verdicts with agree end the ring as agreement', () => {
  const [a, b] = [agent(), agent()];
  const r = start([a, b], 3);
  ring.submit(r.id, a.id, 'Fine.', true, 'approve');
  ring.submit(r.id, b.id, 'Fine too.', true, 'approve');
  const s = ring.status(r.id);
  assert.equal(s.status, 'done');
  assert.equal(s.round, 1);
});

test('a member without the verdict parameter has it read from its text', () => {
  const [a, b] = [agent(), agent()];
  const r = start([a, b], 2);
  ring.submit(r.id, a.id, "I can't approve this yet: request changes for the missing test.", true);
  ring.submit(r.id, b.id, 'Clean change.\n  verdict: APPROVE  ', true);
  assert.equal(ring.status(r.id).round, 2);
  const verdicts = Object.fromEntries(ring.status(r.id).submissions.map((s) => [s.agent_id, s.verdict]));
  assert.deepEqual(verdicts, { [a.id]: 'request_changes', [b.id]: 'approve' });
});

test('the next round tells the members their verdicts split', () => {
  const [a, b] = [agent(), agent()];
  const r = start([a, b], 2);
  ring.submit(r.id, a.id, 'Missing test.', true, 'request_changes');
  ring.submit(r.id, b.id, 'Looks good.', true, 'approve');
  const body = turnNotice(r, a);
  assert.match(body, /Your agree is about your own verdict/);
  assert.match(body, /round 2 of at most 2/);
  assert.match(body, /### The verdicts don't all match in round 1\n/);
  assert.match(body, new RegExp(`${a.name}: request_changes`));
  assert.match(body, new RegExp(`${b.name}: approve`));
});

test('the reason line names each verdict, and a missing one blocks agreement', () => {
  const pr = { topic: 'review PR 1' };
  const line = (...vs) => ring.splitLine(pr, vs.map((verdict, i) => ({ agent_id: `m${i}`, verdict })), (id) => id);
  assert.equal(line('request_changes', 'approve'), 'm0: request_changes, m1: approve');
  assert.equal(line('approve', 'approve'), '');
  assert.equal(line('approve', null), 'm0: approve, m1: no verdict');
  assert.equal(line(null, null), 'm0: no verdict, m1: no verdict');
  assert.equal(ring.splitLine({ topic: 'design the ring format' }, [{ agent_id: 'x', verdict: null }, { agent_id: 'y', verdict: null }]), '');
});

test('approval is read only from a standalone verdict line, never from prose', () => {
  const v = (text) => ring.verdictOf('review PR 1', text);
  assert.equal(v('Not approved.'), null);
  assert.equal(v("I can't approve this until the missing test is added."), null);
  assert.equal(v('I can’t approve this.'), null);
  assert.equal(v('I cannot\napprove this.'), null);
  assert.equal(v('I would approve once the race is fixed.'), null);
  assert.equal(v('Approved. Clean change.'), null);
  assert.equal(v('Verdict: approve, mostly'), null);
  assert.equal(v('Clean change.\nVerdict: approve'), 'approve');
  assert.equal(v('Verdict: request_changes'), 'request_changes');
});

test('a prose-only approval next to a real approve, both agreeing, does not end as agreement', () => {
  const [a, b] = [agent(), agent()];
  const r = start([a, b], 2);
  ring.submit(r.id, a.id, 'I can’t approve this.', true);
  ring.submit(r.id, b.id, 'Fine.', true, 'approve');
  assert.equal(ring.status(r.id).status, 'running');
  assert.equal(ring.status(r.id).round, 2);
});

test('approve plus a missing verdict, both agreeing, does not end as agreement', () => {
  const [a, b] = [agent(), agent()];
  const r = start([a, b], 2);
  ring.submit(r.id, a.id, 'Fine.', true, 'approve');
  ring.submit(r.id, b.id, 'Looks fine to me.', true);
  assert.equal(ring.status(r.id).status, 'running');
  assert.equal(ring.status(r.id).round, 2);
});

test('all missing verdicts, both agreeing, end as split at the cap, not as agreement', async () => {
  const [a, b] = [agent(), agent()];
  const r = start([a, b], 1);
  ring.submit(r.id, a.id, 'Seems fine.', true);
  ring.submit(r.id, b.id, 'Seems fine too.', true);
  assert.match(await resultMail(r), /ended after round 1: split \(/);
});

test('a ring with no PR still ends on agree alone', () => {
  const [a, b] = [agent(), agent()];
  const r = start([a, b], 2, 'name the tool');
  ring.submit(r.id, a.id, 'Swarmyard.', true);
  ring.submit(r.id, b.id, 'Swarmyard.', true);
  assert.equal(ring.status(r.id).status, 'done');
  assert.equal(ring.status(r.id).round, 1);
});

test('a moderated ring split at the round cap ends as split through decide', async () => {
  const [a, b, mod] = [agent(), agent(), agent()];
  const r = ring.createRing({ name: `r${n}`, format: 'rounds', topic: 'review PR 603', members: [a.name, b.name], moderator: mod.name, maxRounds: 1, createdBy: 'human' });
  ring.submit(r.id, a.id, 'Missing test.', true, 'request_changes');
  ring.submit(r.id, b.id, 'Looks good.', true, 'approve');
  assert.equal(ring.status(r.id).status, 'moderating');
  ring.decide(r.id, mod.id, true, 'Done.');
  const body = await resultMail(r);
  assert.match(body, /ended after round 1: split \(/);
  assert.match(body, new RegExp(`${a.name}: request_changes`));
});

test('a ring with no PR keeps no verdict, and a bad verdict is refused', () => {
  assert.equal(ring.verdictOf('design the ring format', 'I approve', 'approve'), null);
  assert.throws(() => ring.verdictOf('review PR 1', 'x', 'maybe'), /approve or request_changes/);
});

// Ring r8dc834 (S-4182, S-4199): the topic named the PR under review and its base PR, so the ring
// counted as no PR review, kept no verdicts and ended "all members agreed" on request_changes plus approve.
const TWO_PRS = 'Review PR #1300 (owner/repo), branch `stam/go-reqring-dev-6`, head 467ed631. Its base PR #1299 has merged, so diff against origin/main.';

test('r8dc834: request_changes in prose plus approve, both agreeing, on a topic naming a base PR, ends as split', async () => {
  const [a, b] = [agent(), agent()];
  const r = start([a, b], 1, TWO_PRS);
  assert.match(turnNotice(r, a), /Give your verdict on the PR/);
  ring.submit(r.id, a.id, 'Request changes at head 467ed631. P1: peer rows pass through unchanged.', true);
  ring.submit(r.id, b.id, 'Verdict: approve. No blocking findings.', true, 'approve');
  const body = await resultMail(r);
  assert.doesNotMatch(body, /all members agreed/);
  assert.match(body, /ended after round 1: split \(/);
  assert.match(body, new RegExp(`${a.name}: request_changes`));
  assert.match(body, new RegExp(`${b.name}: approve`));
});

// Every verdict combination for a 2- and 3-member PR ring (S-4199): only identical recognised verdicts
// with every member agreeing end the ring early; a split, a missing or unreadable verdict, a member that
// never submitted or one that doesn't agree keeps it running. Mirrored in go/internal/server/rings_test.go.
const KINDS = {
  approve: { text: 'Fine.', verdict: 'approve', is: 'approve' },
  request_changes: { text: 'Missing test.', verdict: 'request_changes', is: 'request_changes' },
  prose_changes: { text: 'Request changes at head abc: the empty case has no test.', is: 'request_changes' },
  line_approve: { text: 'Clean change.\nVerdict: approve', is: 'approve' },
  prose_approve: { text: 'Looks good, I approve.', is: null },
  none: { text: 'Seems fine.', is: null },
  skip: null,
};
const seats = (kinds) => kinds.flatMap((k) => (KINDS[k] ? [[k, true], [k, false]] : [[k, false]]));
const product = (opts, n) => (n === 0 ? [[]] : product(opts, n - 1).flatMap((rest) => opts.map((o) => [o, ...rest])));

for (const [size, topic, kinds] of [
  [2, 'review PR 603', Object.keys(KINDS)],
  [2, TWO_PRS, Object.keys(KINDS)],
  [3, TWO_PRS, ['approve', 'request_changes', 'prose_changes', 'none', 'skip']],
]) {
  test(`every verdict combination of a ${size}-member ring on ${topic === TWO_PRS ? 'a topic naming a base PR' : 'one PR'}`, () => {
    const combos = product(seats(kinds), size);
    for (const combo of combos) {
      const ms = combo.map(() => agent());
      const r = start(ms, 2, topic);
      combo.forEach(([k, agree], i) => KINDS[k] && ring.submit(r.id, ms[i].id, KINDS[k].text, agree, KINDS[k].verdict));
      const all = combo.every(([k]) => KINDS[k]);
      const agreed = all && combo.every(([k, agree]) => agree && KINDS[k].is && KINDS[k].is === KINDS[combo[0][0]].is);
      const s = ring.status(r.id);
      const want = agreed ? 'done 1' : all ? 'running 2' : 'running 1';
      assert.equal(`${s.status} ${s.round}`, want, JSON.stringify(combo));
    }
    assert.ok(combos.length >= (size === 2 ? 169 : 729));
  });
}
