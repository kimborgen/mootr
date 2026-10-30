#!/usr/bin/env node
// Unit tests for the `with` filter of a mailbox's thread list (S-1121, src/db.ts threads): only the
// threads where that agent sent or received a message, newest first, within the limit. Also the light thread list and
// the page load by id that the mailbox route builds on (S-4520).
// Run with `node --test test/threads-with.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-threads-with-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `threads-with-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let db;
before(async () => { db = await import('../src/db.ts'); });
after(() => rmSync(home, { recursive: true, force: true }));

let n = 0;
// A mail from `from` to `to` in thread `tid`, `min` minutes into the day.
function send(tid, from, to, min) {
  const created_at = new Date(Date.UTC(2026, 9, 15, 0, min)).toISOString();
  db.createMail({ id: `m${++n}`, from_id: from, from_name: from, subject: 's' + tid, body: 'b', thread_id: tid, reply_to: null }, [to]);
  db.open().prepare('UPDATE mail SET created_at = ? WHERE id = ?').run(created_at, `m${n}`);
}

test('with= keeps only the threads where that agent wrote or received', () => {
  // 70 threads with others make the agent's old threads unreachable through a plain page of 60.
  send('old-a', 'human', 'dev', 1);
  send('old-a', 'dev', 'human', 2);
  send('old-b', 'dev', 'human', 3);
  for (let i = 0; i < 70; i++) send('x' + i, 'human', 'ops', 10 + i);
  assert.ok(!db.threads('human', 60).some((t) => t.thread_id.startsWith('old-')));
  assert.deepEqual(db.threads('human', 60, 'dev').map((t) => t.thread_id), ['old-b', 'old-a']);
  assert.equal(db.threads('human', 60, 'dev')[1].mails.length, 2);
});

test('with= pages by agent, newest first, and without it nothing changes', () => {
  assert.deepEqual(db.threads('human', 1, 'dev').map((t) => t.thread_id), ['old-b']);
  assert.equal(db.threads('human', 100).length, 72);
  assert.deepEqual(db.threads('human', 5, 'nobody'), []);
});

test('with= also finds a thread where the agent only received a cc', () => {
  send('cc', 'ops', 'human', 200);
  db.createMail({ id: 'mcc', from_id: 'ops', from_name: 'ops', subject: 'cc', body: 'b', thread_id: 'cc', reply_to: null }, ['dev']);
  assert.ok(db.threads('human', 60, 'dev').some((t) => t.thread_id === 'cc'));
});

// The fields a light list (db.threadList) carries, from a whole mail or a light one.
const light = (m) => ({ id: m.id, thread_id: m.thread_id, from_id: m.from_id, created_at: m.created_at, notice: m.notice, permission_id: m.permission_id, kind: m.kind, itsa_id: m.itsa_id,
  permission: m.permission ? m.permission.status : undefined, recipients: m.recipients.map((r) => ({ id: r.id, read_at: r.read_at })) });

test('threadList lists what threads() lists, without bodies, with each permission status', () => {
  const p = db.createPermissionRequest('dev', 'push', 'r', 'd');
  db.createMail({ id: 'mperm', from_id: 'dev', from_name: 'dev', subject: 'ask', body: 'a long body', thread_id: 'old-a', reply_to: null, permission_id: p.id }, ['human', 'ops']);
  db.markRead('ops', ['mperm']);
  const full = db.threads('human', 100);
  const list = db.threadList('human', 100);
  assert.deepEqual(list.map((t) => t.thread_id), full.map((t) => t.thread_id));
  assert.deepEqual(list.map((t) => t.mails.map(light)), full.map((t) => t.mails.map(light)));
  assert.ok(list.every((t) => t.mails.every((m) => m.body === undefined && m.attachments === undefined)));
  const perm = list.find((t) => t.thread_id === 'old-a').mails.find((m) => m.id === 'mperm');
  assert.equal(perm.permission.status, 'pending');
  assert.ok(perm.recipients.find((r) => r.id === 'ops').read_at);
  assert.deepEqual(db.threadList('human', 3, 'dev').map((t) => t.thread_id), db.threads('human', 3, 'dev').map((t) => t.thread_id));
  assert.deepEqual(db.threadList('nobody', 5), []);
});

test('threadsById loads the named threads whole, and only those the box takes part in', () => {
  send('elsewhere', 'ops', 'dev', 300);
  const got = db.threadsById('human', ['x3', 'old-b', 'elsewhere', 'missing']);
  // Newest first, as threads() orders them; a thread the box isn't in, or that doesn't exist, isn't there.
  assert.deepEqual(got.map((t) => t.thread_id), ['x3', 'old-b']);
  assert.deepEqual(got[1], db.threads('human', 100).find((t) => t.thread_id === 'old-b'));
  assert.deepEqual(db.threadsById('human', ['x3', 'old-b'], 'dev').map((t) => t.thread_id), ['old-b']);
  assert.deepEqual(db.threadsById('human', []), []);
});

test('foldListMails joins copies of a mail from several daemons', () => {
  const a = { id: 'm', from_id: 'dev', created_at: 't', recipients: [{ id: 'human', read_at: null }] };
  const b = { id: 'm', from_id: 'dev', created_at: 't', permission: { status: 'pending' }, recipients: [{ id: 'human', read_at: 'r' }, { id: 'ops', read_at: null }] };
  assert.deepEqual(db.foldListMails([a, b]), [{ ...a, permission: { status: 'pending' }, recipients: [{ id: 'human', read_at: 'r' }, { id: 'ops', read_at: null }] }]);
});

test("threadList's index form keeps the page's threads and adds subject, title, sender name and a snippet", () => {
  const long = 'y'.repeat(db.SNIPPET_CHARS + 50);
  db.createMail({ id: 'mlong', from_id: 'dev', from_name: 'Dev', subject: 'Long one', body: long, thread_id: 'long', reply_to: null }, ['human']);
  const [t, ...rest] = db.threadList('human', 0, undefined, { only: ['long', 'elsewhere'], index: true });
  assert.deepEqual(rest, []);
  assert.equal(t.thread_id, 'long');
  const m = t.mails[0];
  assert.equal(m.subject, 'Long one');
  assert.equal(m.from_name, 'Dev');
  assert.equal(m.title, null);
  assert.equal(m.snippet, long.slice(0, db.SNIPPET_CHARS));
  assert.equal(m.body, undefined);
  // A mail with no linked ITSAs or attached agents carries both empty, so a peer reads it as of this release.
  assert.deepEqual(m.itsas, []);
  assert.deepEqual(m.agents, []);
  assert.deepEqual(db.threadList('human', 5, undefined, { only: [] }), []);
  assert.equal(db.threadList('human', 100).find((x) => x.thread_id === 'long').mails[0].snippet, undefined);
});

test("threadList's index form names a sender stored without a name, as a whole mail does, in its own query", () => {
  db.createAgent({ id: 'id-named', name: 'Named Agent', role: '', machine: 'test', harness: 'claude', model: null, effort: null, cwd: '', parent_id: null, session_id: null });
  db.createMail({ id: 'mn1', from_id: 'id-named', from_name: null, subject: 'Names', body: 'b', thread_id: 'names', reply_to: null }, ['human']);
  db.createMail({ id: 'mn2', from_id: 'human', from_name: null, subject: 'Re', body: 'b', thread_id: 'names', reply_to: 'mn1' }, ['id-named']);
  db.createMail({ id: 'mn3', from_id: 'gone', from_name: null, subject: 'Re', body: 'b', thread_id: 'names', reply_to: 'mn1' }, ['human']);
  const ms = db.threadList('human', 0, undefined, { only: ['names'], index: true })[0].mails;
  const whole = db.threadMail('names');
  assert.deepEqual(ms.map((m) => m.from_name), ['Named Agent', 'human', 'gone']);
  assert.deepEqual(ms.map((m) => m.from_name), whole.map((m) => m.from_name));
});

test("threadList's index form carries what a card and tab show: summary, verdict, ITSA, linked ITSAs and attached agents", () => {
  const now = new Date().toISOString();
  db.open().prepare("INSERT INTO itsas (id, key, title, status, created_by, created_at, updated_at) VALUES ('i1', 'S-1', 'Card chip', 'todo', 'human', ?, ?)").run(now, now);
  db.createMail({ id: 'mcard', from_id: 'dev', from_name: 'Dev', subject: 'Card', body: 'the body', thread_id: 'card', reply_to: null, about_itsa: 'i1' }, ['human']);
  db.setMailSummary('mcard', 'the summary');
  db.setMailVerdict('mcard', { follows: true, score: 0.9, concise: null, fluff: null, value: null, kind: 'done', at: now });
  db.linkMailItsas('mcard', [{ itsa_id: 'i1', source: 'named' }]);
  db.attachMailAgents('mcard', ['rev', 'ops'], 'dev');
  const m = db.threadList('human', 0, undefined, { only: ['card'], index: true })[0].mails[0];
  assert.equal(m.summary, 'the summary');
  assert.equal(m.verdict.kind, 'done');
  assert.equal(m.about_itsa, 'i1');
  assert.deepEqual(m.itsas, [{ id: 'i1', key: 'S-1', title: 'Card chip', status: 'todo' }]);
  assert.deepEqual(m.agents, ['rev', 'ops']);
  // The snippet starts at the body's first character that isn't whitespace as JavaScript's trim counts it, however
  // much comes before it: NBSP, form feed, the Unicode spaces and the BOM too.
  db.createMail({ id: 'mpad', from_id: 'dev', from_name: 'Dev', subject: 'Pad', body: ' \n\t\r\v\f\u00a0\u1680\u2000\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'.repeat(40) + 'hi', thread_id: 'pad', reply_to: null }, ['human']);
  assert.equal(' \n\t\r\v\f\u00a0\u1680\u2000\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'.trim(), '');
  assert.equal(db.threadList('human', 0, undefined, { only: ['pad'], index: true })[0].mails[0].snippet, 'hi');
  // The light form, the list's pass, carries none of it.
  const l = db.threadList('human', 100).find((x) => x.thread_id === 'card').mails[0];
  assert.equal(l.summary, undefined);
  assert.equal(l.itsas, undefined);
  assert.equal(l.agents, undefined);
});

test('foldListMails keeps a summary, verdict, linked ITSAs and attached agents only one copy carries', () => {
  const a = { id: 'm', from_id: 'dev', created_at: 't', recipients: [] };
  const b = { ...a, summary: 's', verdict: { kind: 'done' }, itsas: [{ id: 'i1', key: 'S-1', title: 'T', status: 'todo' }], agents: ['rev'] };
  assert.deepEqual(db.foldListMails([a, b]), [b]);
});

test("a tab's agents follow web threadAgents: attached first, then senders, then recipients, newest mail first, once each", async () => {
  const tab = await import('../src/thread-tab.ts');
  const ms = [
    { from_id: 'a', recipients: [{ id: 'human' }, { id: 'b' }], agents: ['x'] },
    { from_id: 'human', recipients: [{ id: 'a' }, { id: 'c' }], agents: ['y', 'x'] },
    { from_id: 'b', recipients: [{ id: 'human' }, { id: 'd' }] },
    { from_id: 'c', recipients: [{ id: 'a' }, { id: 'e' }], agents: [] },
  ];
  // Attached x, y; senders c, b, a (newest first; the human left out); recipients e, d (a, c, b already in).
  assert.deepEqual(tab.threadAgents(ms), ['x', 'y', 'c', 'b', 'a', 'e', 'd']);
  assert.deepEqual(tab.threadAgents([{ from_id: 'human', recipients: [{ id: 'human' }] }]), []);
});

test("a tab's ITSA links are each linked ITSA once, in the order they first appear", async () => {
  const tab = await import('../src/thread-tab.ts');
  const i1 = { id: 'i1', key: 'S-1', title: 'One', status: 'todo' };
  const i2 = { id: 'i2', key: 'S-2', title: 'Two', status: 'done', source: 'named' };
  const ms = [{ from_id: 'a', recipients: [], itsas: [i2] }, { from_id: 'a', recipients: [] }, { from_id: 'a', recipients: [], itsas: [i1, i2] }];
  assert.deepEqual(tab.itsaLinks(ms), [{ id: 'i2', key: 'S-2', title: 'Two', status: 'done' }, i1]);
});
