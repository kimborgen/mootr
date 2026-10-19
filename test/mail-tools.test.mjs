#!/usr/bin/env node
// The tool calls before a mail an agent sent (S-1643, mailTools and turnTools in src/agent-view.ts): the slice rule over a
// scripted transcript, with the mail the agent sent and received from the daemon's own table. A stub view source stands in
// for a harness; nothing runs and no model answers. `node --test test/mail-tools.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mail-tools-');
process.env.STAM_HOME = home;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

const db = await import('../src/db.ts');
const view = await import('../src/agent-view.ts');

// Times in seconds after T0; each sent mail and each inbound mail is stored at its time through the daemon's table.
const T0 = Date.parse('2026-10-18T10:00:00Z');
const at = (s) => T0 + s * 1000;
const tool = (id) => ({ type: 'tool', id, name: 'Bash', input: { command: `echo ${id}` }, output: 'ok', status: 'done' });
const msg = (id, role, s, parts, extra = {}) => ({ id, role, at: at(s), parts, ...extra });
const text = (t) => ({ type: 'text', text: t });

// The sender's transcript, oldest first. Mail (kind 'mail') comes from the db, not from here.
const TRANSCRIPT = [
  msg('p1', 'user', 0, [text('do the work')]),
  msg('a1', 'assistant', 10, [tool('t1'), tool('t2')], { marks: [at(10), at(12)] }),
  msg('a2', 'assistant', 25, [tool('t3')]),
  msg('a3', 'assistant', 35, [tool('t4'), tool('t5')], { marks: [at(35), at(38)] }),
  msg('a4', 'assistant', 45, [tool('t6')]),
];
// Mail the sender sends and receives, by its time (seconds). Stored with the given created_at.
const MAIL = [
  { id: 's1', from: 'sender', to: ['human'], s: 20 },
  { id: 'i1', from: 'human', to: ['sender'], s: 30 },
  { id: 's2', from: 'sender', to: ['human'], s: 40 },
  { id: 's3', from: 'sender', to: ['human'], s: 50 },
];

// A stub harness: pages of its transcript, newest first by `before`, as a ViewSource pages.
let reads = 0;
const stub = (transcript) => ({
  capabilities: { can_stream: false, can_send: false, can_interrupt: false, can_approve: false },
  unavailable: (a) => (a.id === 'off' ? 'its transcript is gone' : null),
  async page(_a, { limit, before }) {
    reads++;
    const end = before ? transcript.findIndex((m) => m.id === before) : transcript.length;
    const start = Math.max(0, end - limit);
    return { messages: transcript.slice(start, end), older: start > 0 ? transcript[start].id : null };
  },
  async status() { return { running: false, permissions: [] }; },
  follow: () => () => {},
});

const agent = (id, harness = 'stub') => db.createAgent({ id, name: id, role: 'dev', machine: 'x', harness, model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
const mail = (id, from, to, s) => {
  db.createMail({ id, from_id: from, from_name: from, subject: `Mail ${id}`, body: 'b', thread_id: 'th-tools', reply_to: null }, to);
  db.open().prepare('UPDATE mail SET created_at = ? WHERE id = ?').run(new Date(at(s)).toISOString(), id);
};
const ids = (tools) => tools.map((t) => t.id);
const mailTools = async (a, id) => (await view.mailTools(a, id)).tools;

before(() => {
  view.register('stub', stub(TRANSCRIPT));
  for (const id of ['sender', 'off']) agent(id);
  agent('nosrc', 'nosrc');
  for (const m of MAIL) mail(m.id, m.from, m.to, m.s);
  mail('o1', 'off', ['human'], 20);
  mail('n1', 'nosrc', ['human'], 20);
});

after(() => rmSync(home, { recursive: true, force: true }));

test('a mail takes the calls after the prompt that started its turn', async () => {
  assert.deepEqual(ids(await mailTools(db.getAgent('sender'), 's1')), ['t1', 't2']);
});

test('a mail takes the calls after the mail that came in, not the ones before it', async () => {
  assert.deepEqual(ids(await mailTools(db.getAgent('sender'), 's2')), ['t4', 't5']);
});

test('two mails in one turn: the second takes the calls after the first', async () => {
  assert.deepEqual(ids(await mailTools(db.getAgent('sender'), 's3')), ['t6']);
});

test('a first mail with no earlier input runs from the transcript start', async () => {
  const tr = [msg('f0', 'assistant', 5, [tool('f1')]), msg('f00', 'assistant', 10, [tool('f2')])];
  view.register('stub-first', stub(tr));
  db.createAgent({ id: 'first', name: 'first', role: 'dev', machine: 'x', harness: 'stub-first', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  mail('fx1', 'first', ['human'], 20);
  assert.deepEqual(ids(await mailTools(db.getAgent('first'), 'fx1')), ['f1', 'f2']);
});

test('a long transcript is read page by page until its turn starts', async () => {
  const long = [msg('lp', 'user', 0, [text('go')])];
  for (let i = 1; i <= 120; i++) long.push(msg(`la${i}`, 'assistant', i, [tool(`L${i}`)]));
  view.register('stub-long', stub(long));
  db.createAgent({ id: 'long-view', name: 'long-view', role: 'dev', machine: 'x', harness: 'stub-long', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  mail('lx1', 'long-view', ['human'], 121);
  reads = 0;
  const tools = await mailTools(db.getAgent('long-view'), 'lx1');
  assert.equal(tools.length, 120);
  assert.deepEqual(ids(tools).slice(0, 2), ['L1', 'L2']);
  assert.ok(reads >= 3, `read ${reads} pages`);
});

test('a sender whose view is gone answers 409, and quietly so', async () => {
  await assert.rejects(mailTools(db.getAgent('off'), 'o1'), (e) => e.status === 409 && /transcript is gone/.test(e.message));
});

test('a sender with no view source answers 409', async () => {
  await assert.rejects(mailTools(db.getAgent('nosrc'), 'n1'), (e) => e.status === 409);
});

test('a mail the agent did not send, or none at all, answers 404', async () => {
  await assert.rejects(mailTools(db.getAgent('sender'), 'i1'), (e) => e.status === 404);
  await assert.rejects(mailTools(db.getAgent('sender'), 'nope'), (e) => e.status === 404);
});

test('turnTools: no messages, no calls, and no start found yet', () => {
  assert.deepEqual(view.turnTools([], at(50)), { tools: [], done: false });
});

test('turnTools: calls after the prompt are in its turn, and the prompt is the boundary', () => {
  const tr = [msg('x0', 'user', 0, [text('go')]), msg('x1', 'assistant', 10, [tool('y1')], { marks: [at(10)] })];
  assert.deepEqual(view.turnTools(tr, at(20)), { tools: [tool('y1')], done: true });
});

// A mail the agent receives starts its turn when the agent reads it: a call between its creation and its reading
// belongs to the turn before (S-1643 review).
test('a received mail cuts the turn at the time it was read, not sent', async () => {
  const rt = [
    msg('q0', 'user', 0, [text('go')]),
    msg('q1', 'assistant', 10, [tool('r1')], { marks: [at(10)] }),
    msg('q2', 'assistant', 34, [tool('r2')], { marks: [at(34)] }),
    msg('q3', 'assistant', 38, [tool('r3')], { marks: [at(38)] }),
  ];
  view.register('stub-read', stub(rt));
  db.createAgent({ id: 'read', name: 'read', role: 'dev', machine: 'x', harness: 'stub-read', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  mail('ri1', 'human', ['read'], 33);
  db.open().prepare('UPDATE mail_recipients SET read_at = ? WHERE mail_id = ? AND agent_id = ?').run(new Date(at(36)).toISOString(), 'ri1', 'read');
  mail('rs1', 'read', ['human'], 40);
  assert.deepEqual(ids(await mailTools(db.getAgent('read'), 'rs1')), ['r3']);
});

// The page cap ran out before any turn start: the slice says so, and the drawer shows it (S-1643 review).
test('a transcript with no turn start in the cap is truncated, and says so', async () => {
  const cut = [];
  for (let i = 1; i <= 2100; i++) cut.push(msg(`c${i}`, 'assistant', i, [tool(`C${i}`)]));
  view.register('stub-cut', stub(cut));
  db.createAgent({ id: 'cutter', name: 'cutter', role: 'dev', machine: 'x', harness: 'stub-cut', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  mail('cs1', 'cutter', ['human'], 2200);
  const out = await view.mailTools(db.getAgent('cutter'), 'cs1');
  assert.equal(out.truncated, true);
  assert.equal(out.tools.length, 2000);
  const whole = await view.mailTools(db.getAgent('sender'), 's1');
  assert.equal(whole.truncated, false);
});
