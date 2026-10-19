#!/usr/bin/env node
// Unit tests for daemon-side mail threading: the guessParent rule in src/mail.ts,
// run against a throwaway STAM_HOME, no live agents, no network. Run with
// `node --test test/mail-threading.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mail-thread-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `mail-thread-test-${process.pid}`;
// Nothing here talks to a daemon; drop a parent agent's pointers to the live one anyway.
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let db, mail;
before(async () => {
  db = await import('../src/db.ts');
  mail = await import('../src/mail.ts');
});
after(() => rmSync(home, { recursive: true, force: true }));

const now = () => new Date().toISOString();
const minsAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();

let agentNo = 0;
// A fresh agent (or `for` when one is given), and a human -> agent mail the agent read
// `readMinsAgo` minutes ago, in its own thread `threadId`. Returns { agent, mail }.
function seed(threadId, subject, readMinsAgo, { for: existing } = {}) {
  const id = existing ?? `t-agent-${++agentNo}`;
  if (!existing) db.createAgent({ id, name: `mail-thread-${agentNo}`, role: 'test', machine: 'x', harness: 'opencode', model: 'openrouter/~deepseek/deepseek-v4-flash-latest', effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  const mid = `seed-${id}-${threadId}`;
  db.createMail({ id: mid, from_id: 'human', from_name: 'human', subject, body: 'seed', thread_id: threadId, reply_to: null }, [id]);
  db.open()
    .prepare('UPDATE mail_recipients SET read_at = ? WHERE mail_id = ? AND agent_id = ?')
    .run(minsAgo(readMinsAgo), mid, id);
  return { agent: id, mail: mid };
}

// sendMail from the agent to the human with no reply_to: the daemon threads the answer.
const send = (agent, over = {}) => mail.sendMail({ from: agent, to: ['human'], subject: 'Answer without reply_to', body: 'hello', ...over });

test('guessParent > joins the thread of an unanswered mail read in the last 30 min', async () => {
  const { agent, mail: mid } = seed('t1', 'Build cache cleared', 10);
  const m = await send(agent);
  assert.equal(m.thread_id, 't1');
  assert.equal(m.reply_to, mid);
  assert.equal(m.auto_threaded, 1);
});

test('guessParent > matches a "Re:" subject within 7 days', async () => {
  const { agent } = seed('t2', 'Build cache cleared', 60 * 24 * 2); // read two days ago
  const m = await send(agent, { subject: 'Re: Build cache cleared' });
  assert.equal(m.thread_id, 't2');
});

test('guessParent > a subject naming one recent thread settles it', async () => {
  const { agent } = seed('t3', 'Build cache cleared', 10);
  seed('t3o', 'Deploy the site', 10, { for: agent });
  const m = await send(agent, { subject: 'Re: Build cache cleared' });
  assert.equal(m.thread_id, 't3');
});

test('guessParent > new_thread opts out', async () => {
  const { agent } = seed('t4', 'Build cache cleared', 10);
  const m = await send(agent, { new_thread: true });
  assert.equal(m.thread_id, m.id);
  assert.notEqual(m.thread_id, 't4');
});

test('guessParent > two recent threads: asks the agent, listing both', async () => {
  const { agent } = seed('t5a', 'Thread one', 5);
  seed('t5b', 'Thread two', 20, { for: agent });
  await assert.rejects(
    () => send(agent),
    (err) => err.message.includes('2 threads you read in the last 30 minutes') && err.message.includes('Thread one') && err.message.includes('Thread two') && err.message.includes('reply_to'),
  );
});

test('guessParent > two recent threads, one answered, picks the unanswered one', async () => {
  const { agent, mail: mid } = seed('t6a', 'Thread one', 5);
  db.createMail({ id: 'ans-' + mid, from_id: agent, from_name: 'agent', subject: 'Re: Thread one', body: 'answer', thread_id: 't6a', reply_to: mid }, ['human']);
  // The answer must be stamped after the seed, or the "answered" check misses it.
  db.open().prepare('UPDATE mail SET created_at = ? WHERE id = ?').run(new Date(Date.now() + 1000).toISOString(), 'ans-' + mid);
  seed('t6b', 'Thread two', 10, { for: agent });
  const m = await send(agent);
  assert.equal(m.thread_id, 't6b');
});

test('follow-up > every guess is logged to the agent\'s events', async () => {
  const { agent } = seed('t7', 'Guess me', 10);
  await send(agent);
  const ev = db.listEvents(agent).find((e) => e.type === 'mail:auto_threaded');
  assert.ok(ev, 'expected a mail:auto_threaded event');
  const data = JSON.parse(ev.data);
  assert.equal(data.thread_id, 't7');
  assert.equal(data.reply_to, 'seed-t-agent-7-t7');
  assert.ok(data.id, 'the event names the new mail');
});

test('follow-up > no guess, no event, no flag', async () => {
  const { agent } = seed('t8', 'Not guessed', 10);
  await send(agent, { new_thread: true });
  assert.ok(!db.listEvents(agent).some((e) => e.type === 'mail:auto_threaded'));
});

test('threading shows in the UI data the daemon serves', async () => {
  const { agent } = seed('t9', 'UI thread', 10);
  const m = await send(agent);
  const t = db.threadMail(m.thread_id).find((x) => x.id === m.id);
  assert.equal(t.auto_threaded, 1);
});

test('a non-Re new subject among older mail starts a new thread', async () => {
  const { agent } = seed('t10', 'Older thread', 60 * 24 * 3);
  const m = await send(agent, { subject: 'Brand new topic' });
  assert.equal(m.thread_id, m.id);
  assert.notEqual(m.thread_id, 't10');
});