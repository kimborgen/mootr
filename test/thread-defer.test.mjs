#!/usr/bin/env node
// Unit tests for deferring a thread (S-976, src/db.ts): it leaves the active list and the unread
// counts, a new message to the mailbox brings it back, and archive and defer exclude each other.
// Run with `node --test test/thread-defer.test.mjs`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { tempHome } from './tmphome.mjs';

process.env.STAM_HOME = tempHome('stam-thread-defer-');
process.env.STAM_TMUX_SOCKET = `thread-defer-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let db;
before(async () => {
  db = await import('../src/db.ts');
});

const mail = (id, to = 'human') => ({ id, recipients: [{ id: to }] });
const thread = (thread_id, ...mails) => ({ thread_id, mails });

test('a deferred thread leaves the active list and is listed as deferred', () => {
  const t = thread('t1', mail('a1'));
  db.deferThread('human', 't1', ['a1']);
  const { rest, deferred } = db.splitDeferred('human', [t, thread('t2', mail('b1'))]);
  assert.deepEqual(rest.map((x) => x.thread_id), ['t2']);
  assert.deepEqual(deferred.map((x) => x.thread_id), ['t1']);
  assert.equal(db.deferredCount('human'), 1);
});

test('new mail to the mailbox brings a deferred thread back; the mailbox\'s own mail does not', () => {
  db.deferThread('human', 't3', ['c1']);
  const own = { id: 'c2', recipients: [{ id: 'a9' }] };
  assert.equal(db.splitDeferred('human', [thread('t3', mail('c1'), mail('c3'))]).deferred.length, 0);
  assert.equal(db.splitDeferred('human', [thread('t3', mail('c1'), own)]).deferred.length, 1);
  db.keepDeferred('human', 't3', 'c4');
  assert.equal(db.splitDeferred('human', [thread('t3', mail('c1'), mail('c4'))]).deferred.length, 1);
});

test('a pending permission request can be deferred; a kept thread stays out (S-1068)', () => {
  db.deferThread('human', 't4', ['d1']);
  const pending = { id: 'd1', recipients: [{ id: 'human' }], permission: { status: 'pending' } };
  assert.equal(db.splitDeferred('human', [thread('t4', pending)]).deferred.length, 1);
  assert.equal(db.splitDeferred('human', [thread('t4', mail('d1'))], new Set(['t4'])).deferred.length, 0);
});

test('undeferring returns the thread; archive and defer exclude each other', () => {
  db.deferThread('human', 't5', ['e1']);
  db.undeferThread('human', 't5');
  assert.equal(db.splitDeferred('human', [thread('t5', mail('e1'))]).deferred.length, 0);

  db.archiveThread('human', 't6', ['f1']);
  db.deferThread('human', 't6', ['f1']);
  assert.equal(db.splitArchived('human', [thread('t6', mail('f1'))]).archived.length, 0);
  assert.equal(db.splitDeferred('human', [thread('t6', mail('f1'))]).deferred.length, 1);
  db.archiveThread('human', 't6', ['f1']);
  assert.equal(db.splitDeferred('human', [thread('t6', mail('f1'))]).deferred.length, 0);
  assert.equal(db.splitArchived('human', [thread('t6', mail('f1'))]).archived.length, 1);
});

test('deferred unread mail is skipped by inbox, a read without ids and the idle push, and returns once undeferred (S-1880)', () => {
  const send = (id, thread_id) => db.createMail({ id, from_id: 'a9', from_name: 'a9', subject: id, body: id, thread_id, reply_to: null }, ['agent-d']);
  send('g1', 'tg1');
  send('g2', 'tg2');
  db.deferThread('agent-d', 'tg1', ['g1']);
  const ids = () => db.inbox('agent-d', true, 10).map((m) => m.id);
  assert.deepEqual(ids(), ['g2']);
  assert.deepEqual(db.defaultRead('agent-d'), ['g2']);
  assert.equal(db.unpushedCount('agent-d'), 1);
  // The full mailbox view (unreadOnly false) still lists it, as the web inbox splits deferred itself.
  assert.equal(db.inbox('agent-d', false, 10).length, 2);
  db.markPushed('agent-d');
  db.undeferThread('agent-d', 'tg1');
  assert.deepEqual(ids().sort(), ['g1', 'g2']);
  assert.deepEqual(db.defaultRead('agent-d').sort(), ['g1', 'g2']);
  assert.equal(db.unpushedCount('agent-d'), 1, 'g1 was never pushed');
  // Explicit ids still return deferred mail.
  db.deferThread('agent-d', 'tg1', ['g1']);
  assert.deepEqual(db.readMail('agent-d', ['g1']).map((m) => m.id), ['g1']);
});

test('a reply into a thread an agent deferred brings its older unread mail back too (S-1880)', () => {
  const send = (id, thread_id, to = ['agent-r']) => db.createMail({ id, from_id: 'a9', from_name: 'a9', subject: id, body: id, thread_id, reply_to: null }, to);
  send('h1', 'th1');
  db.deferThread('agent-r', 'th1', ['h1']);
  assert.deepEqual(db.defaultRead('agent-r'), []);
  send('h2', 'th1');
  assert.deepEqual(db.defaultRead('agent-r'), ['h1', 'h2']);
  // The human's box keeps its deferral rows: splitDeferred handles revival there.
  send('h3', 'th2', ['human']);
  db.deferThread('human', 'th2', ['h3']);
  send('h4', 'th2', ['human']);
  assert.equal(db.deferredCount('human') > 0, true);
  assert.equal(db.splitDeferred('human', [thread('th2', mail('h3'), mail('h4'))]).deferred.length, 0);
});

test('a system notice does not revive a deferred thread, on an agent box or the human one; agent mail does (S-1971)', () => {
  const send = (id, thread_id, extra = {}, from_id = 'a9', to = ['agent-n']) => db.createMail({ id, from_id, from_name: from_id, subject: id, body: id, thread_id, reply_to: null, ...extra }, to);
  send('n1', 'tn1');
  db.deferThread('agent-n', 'tn1', ['n1']);
  send('n2', 'tn1', { notice: true }, 'system:deploy');
  send('n3', 'tn1', { notice: true });
  assert.deepEqual(db.inbox('agent-n', true, 10).map((m) => m.id), []);
  assert.equal(db.deferredCount('agent-n'), 1);
  send('n4', 'tn1');
  assert.deepEqual(db.inbox('agent-n', true, 10).map((m) => m.id).sort(), ['n1', 'n2', 'n3', 'n4']);
  assert.equal(db.deferredCount('agent-n'), 0);

  db.deferThread('human', 'tn2', ['p1']);
  const sys = { id: 'p2', from_id: 'system:deploy', recipients: [{ id: 'human' }], notice: 1 };
  assert.equal(db.splitDeferred('human', [thread('tn2', mail('p1'), sys)]).deferred.length, 1);
  assert.equal(db.splitDeferred('human', [thread('tn2', mail('p1'), { ...sys, notice: 0, from_id: 'a9' })]).deferred.length, 0);
});
