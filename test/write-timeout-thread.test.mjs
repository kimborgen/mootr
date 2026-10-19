#!/usr/bin/env node
// The dedup of a retried send (S-1663) must not swallow a different send with the same words: an
// unthreaded "Done." after reading other mail threads elsewhere. src/mail.ts readEpoch is part of
// the daemon's dedup scope. Throwaway STAM_HOME, no daemon. `node --test test/write-timeout-thread.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-write-timeout-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `write-timeout-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let db, mail, dedup;
before(async () => {
  db = await import('../src/db.ts');
  mail = await import('../src/mail.ts');
  dedup = await import('../src/client-dedup.ts');
});
after(() => rmSync(home, { recursive: true, force: true }));

const minsAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();
const agent = 'wt-agent-1';
const readMail = (threadId, readMinsAgo) => {
  const mid = `seed-${threadId}`;
  db.createMail({ id: mid, from_id: 'human', from_name: 'human', subject: `Thread ${threadId}`, body: 'seed', thread_id: threadId, reply_to: null }, [agent]);
  db.open().prepare('UPDATE mail_recipients SET read_at = ? WHERE mail_id = ? AND agent_id = ?').run(minsAgo(readMinsAgo), mid, agent);
};

test('the same unthreaded words sent after reading other mail are another send, a retry is the same', async () => {
  db.createAgent({ id: agent, name: 'wt-1', role: 'test', machine: 'x', harness: 'opencode', model: 'openrouter/~deepseek/deepseek-v4-flash-latest', effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  dedup.forgetClientIds();
  const scope = () => `agent:${agent}|/api/mail|${mail.readEpoch(agent)}`;
  let delivered = 0;
  const send = () => dedup.dedupByClientId(scope(), 'done-1', async () => ({ id: `m${++delivered}` }));

  readMail('A', 10);
  assert.deepEqual(await send(), { id: 'm1' });
  assert.deepEqual(await send(), { id: 'm1' }); // a retry: nothing read in between
  readMail('B', 1);
  assert.deepEqual(await send(), { id: 'm2' }); // read thread B, then "Done." again: not dropped
  assert.equal(delivered, 2);
});

test('reading an old mail (created long before) changes the epoch too, past 50 other mails', () => {
  const before = mail.readEpoch(agent);
  // 60 mails the agent read earlier, then one created 2 days ago and read just now.
  for (let i = 0; i < 60; i++) readMail(`bulk-${i}`, 20);
  const mid = 'seed-old';
  db.createMail({ id: mid, from_id: 'human', from_name: 'human', subject: 'Old', body: 'seed', thread_id: 'old', reply_to: null }, [agent]);
  db.open().prepare('UPDATE mail_recipients SET read_at = ?, mail_id = mail_id WHERE mail_id = ? AND agent_id = ?').run(new Date().toISOString(), mid, agent);
  db.open().prepare('UPDATE mail SET created_at = ? WHERE id = ?').run(minsAgo(60 * 48), mid);
  assert.notEqual(mail.readEpoch(agent), before);
});

test('the daemon adds readEpoch to the dedup scope of an unthreaded mail', () => {
  const src = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
  assert.match(src, /path === '\/api\/mail' && body && !body\.reply_to && !body\.new_thread[\s\S]{0,120}mail\.readEpoch\(body\.from\)/);
});
