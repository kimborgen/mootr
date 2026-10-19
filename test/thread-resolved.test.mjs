#!/usr/bin/env node
// Unit tests for when a thread in the human's inbox is resolved (S-637, src/thread-resolved.ts):
// each clause of the definition, and the edge cases. Run with `node --test test/thread-resolved.test.mjs`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { tempHome } from './tmphome.mjs';

process.env.STAM_HOME = tempHome('stam-thread-resolved-');
process.env.STAM_TMUX_SOCKET = `thread-resolved-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let threadResolved;
before(async () => {
  ({ threadResolved } = await import('../src/thread-resolved.ts'));
});

let n = 0;
const at = () => `2026-10-14T06:${String(10 + n++).padStart(2, '0')}:00.000Z`;
// An agent's mail to the human, read by them unless `unread`.
const agentMail = (o = {}) => ({ id: `m${n}`, from_id: 'a1', created_at: at(), kind: 'comment', body: 'Done: PR #61 merged and deployed.', itsa_id: 'i1',
  recipients: [{ id: 'human', read_at: o.unread ? null : '2026-10-14T07:00:00Z', withdrawn_at: o.withdrawn ? '2026-10-14T07:00:00Z' : null }], ...o });
const humanMail = (o = {}) => ({ id: `m${n}`, from_id: 'human', created_at: at(), kind: 'comment', body: 'It works', itsa_id: 'i1', recipients: [{ id: 'a1', read_at: null }], ...o });
// Mail between agents in the thread: the human isn't a recipient.
const between = (o = {}) => ({ id: `m${n}`, from_id: 'a2', created_at: at(), kind: 'comment', body: 'Can you check this?', itsa_id: 'i1', recipients: [{ id: 'a1', read_at: null }], ...o });
// An ITSA in `closed` closes at `closedAt` (after every mail, by default) when true, is open when false, and unknown when absent.
const ctx = (o = {}) => ({
  itsaClosedAt: (id) => { const v = (o.closed ?? { i1: true })[id]; return v === true ? (o.closedAt ?? '2026-10-14T23:00:00.000Z') : v === false ? null : undefined; },
  decisionOpen: (id) => (o.open ?? []).includes(id),
  humanWaited: () => !!o.waited,
});
const verdict = (mails, c = ctx()) => threadResolved({ thread_id: 't1', mails }, c);

test("a closed ITSA's thread whose last mail is the human's is resolved (S-426's \"It works\")", () => {
  assert.deepEqual(verdict([agentMail(), humanMail()]), { resolved: true, kind: 'itsa' });
});

test("a closed ITSA's thread whose last mail to the human is an agent's end result, read, is resolved", () => {
  assert.deepEqual(verdict([humanMail(), agentMail()]), { resolved: true, kind: 'itsa' });
});

test('mail between agents after the human\'s last mail doesn\'t count (S-461\'s complaint, handled by others)', () => {
  assert.deepEqual(verdict([agentMail(), humanMail(), between(), between({ from_id: 'a1', recipients: [{ id: 'a2', read_at: null }] })]), { resolved: true, kind: 'itsa' });
});

test('plain mail about no ITSA and holding no request is never resolved', () => {
  const v = verdict([agentMail({ itsa_id: null }), humanMail({ itsa_id: null })]);
  assert.equal(v.resolved, false);
  assert.match(v.why, /no ITSA and holds no request/);
});

// cos's clause for request threads (S-637): every request settled, and every mail to the human read.
const req = (status, o = {}) => agentMail({ itsa_id: null, permission_id: `p${n}`, permission: { status }, kind: null, body: 'Permission: push the branch', ...o });
test('a request thread about no ITSA is resolved once every request is settled and read', () => {
  assert.deepEqual(verdict([req('approved'), req('withdrawn'), req('expired'), req('denied')]), { resolved: true, kind: 'request' });
});

test('a request thread whose every mail to the human was withdrawn (answered by someone else) is resolved', () => {
  assert.deepEqual(verdict([req('approved', { unread: true, withdrawn: true })]), { resolved: true, kind: 'request' });
});

test('a request thread with one request pending is not resolved', () => {
  assert.match(verdict([req('approved'), req('pending')]).why, /isn't settled/);
});

test('a request thread with one unread mail to the human is not resolved', () => {
  assert.match(verdict([req('approved'), req('denied', { unread: true })]).why, /hasn't read/);
});

test("a request thread whose last mail is the human's own, unanswered, is not resolved", () => {
  assert.match(verdict([req('approved'), humanMail({ itsa_id: null })]).why, /isn't a request/);
});

test("a request thread with an agent's question after the requests, read but unanswered, is not resolved", () => {
  assert.match(verdict([req('approved'), agentMail({ itsa_id: null, body: 'Shall I also push the tag?' })]).why, /isn't a request/);
});

test("the human's own follow-up written after the ITSA closed keeps the thread", () => {
  const a = agentMail(), h = humanMail({ body: 'This still fails on my phone.' });
  assert.match(verdict([a, h], ctx({ closedAt: '2026-10-14T00:00:00.000Z' })).why, /after the ITSA closed/);
});

test("the human's own last mail written before the ITSA closed is answered by the closing", () => {
  assert.deepEqual(verdict([agentMail(), humanMail()], ctx({ closedAt: '2026-10-14T23:00:00.000Z' })), { resolved: true, kind: 'itsa' });
});

test('an about_itsa mail counts as the thread\'s ITSA', () => {
  assert.deepEqual(verdict([agentMail({ itsa_id: null, about_itsa: 'i1' }), humanMail({ itsa_id: null })]), { resolved: true, kind: 'itsa' });
});

test('an open ITSA, or one this daemon doesn\'t know, keeps it unresolved', () => {
  assert.match(verdict([agentMail(), humanMail()], ctx({ closed: { i1: false } })).why, /ITSA i1 is open/);
  assert.match(verdict([agentMail(), humanMail()], ctx({ closed: {} })).why, /ITSA i1 is open/);
});

test('every ITSA the thread is about must be closed', () => {
  const v = verdict([agentMail(), humanMail({ about_itsa: 'i2', itsa_id: null })], ctx({ closed: { i1: true, i2: false } }));
  assert.match(v.why, /ITSA i2 is open/);
});

test('a pending permission request keeps it unresolved; a settled one does not', () => {
  const ask = agentMail({ permission_id: 'p1', permission: { status: 'pending' } });
  assert.match(verdict([ask, humanMail()]).why, /request p1/);
  for (const status of ['approved', 'denied', 'withdrawn', 'expired', 'held', 'failed']) {
    assert.deepEqual(verdict([agentMail({ permission_id: 'p1', permission: { status } }), humanMail()]), { resolved: true, kind: 'itsa' }, status);
  }
});

test("a request whose state isn't known here counts as pending", () => {
  assert.match(verdict([agentMail({ permission_id: 'p9' }), humanMail()]).why, /request p9/);
});

test('an open decision mail keeps it unresolved, even after the human wrote', () => {
  const d = agentMail({ body: '```yesno\nShip?\n```' });
  assert.match(verdict([d, humanMail()], ctx({ open: [d.id] })).why, /decision/);
});

test('an unread mail to the human keeps it unresolved', () => {
  assert.match(verdict([humanMail(), agentMail({ unread: true })]).why, /hasn't read/);
  assert.match(verdict([agentMail({ unread: true }), humanMail()]).why, /hasn't read/);
});

test('a mail withdrawn from the human counts as handled, read or not', () => {
  assert.deepEqual(verdict([humanMail(), agentMail({ unread: true, withdrawn: true, kind: 'ask' })]), { resolved: true, kind: 'itsa' });
});

test('the last mail to the human asking something keeps it unresolved: an ITSA ask, a decision block', () => {
  assert.match(verdict([humanMail(), agentMail({ kind: 'ask' })]).why, /asks them/);
  assert.match(verdict([humanMail(), agentMail({ body: 'Which?\n\n```pick\nA\nB\n```' })]).why, /asks them/);
});

test("a request the human answered on its card is the thread's last mail and asks nothing more", () => {
  assert.deepEqual(verdict([humanMail(), agentMail({ permission_id: 'p2', permission: { status: 'approved' } })]), { resolved: true, kind: 'itsa' });
});

test('an agent\'s question after the human\'s mail keeps it, even once read and the ITSA closed', () => {
  assert.match(verdict([humanMail(), agentMail({ body: 'Anything else?' })]).why, /asks them a question/);
});

test('an earlier ask the human answered after does not count', () => {
  assert.deepEqual(verdict([agentMail({ kind: 'ask' }), humanMail()]), { resolved: true, kind: 'itsa' });
});

test('order is by time, not by the order given', () => {
  const a = agentMail({ kind: 'ask' }), h = humanMail();
  assert.deepEqual(verdict([h, a]), { resolved: true, kind: 'itsa' }, "the human's mail is the later one");
});

test("an agent's plain question with an open wait_for on the human keeps the thread (S-637, m6d0b925)", () => {
  const q = agentMail({ body: '@requirements is waiting on m93fcaaf', kind: 'comment' });
  assert.match(verdict([humanMail({ body: 'Thanks' }), q], ctx({ waited: true })).why, /waits on the human/);
  assert.match(verdict([agentMail(), humanMail()], ctx({ waited: true })).why, /waits on the human/);
});

test("an agent's question written after the ITSA closed keeps the thread: the closing didn't answer it", () => {
  assert.match(verdict([humanMail({ created_at: '2026-10-14T06:01:00.000Z' }), agentMail({ body: 'Which build should I use?' })], ctx({ closedAt: '2026-10-14T06:02:00.000Z' })).why, /asks them a question/);
});

test("an agent's end result written after the ITSA closed, read, is resolved", () => {
  assert.deepEqual(verdict([humanMail({ created_at: '2026-10-14T06:01:00.000Z' }), agentMail({ body: 'Also done: the docs.' })], ctx({ closedAt: '2026-10-14T06:02:00.000Z' })), { resolved: true, kind: 'itsa' });
});
