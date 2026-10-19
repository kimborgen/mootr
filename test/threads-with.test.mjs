#!/usr/bin/env node
// Unit tests for the `with` filter of a mailbox's thread list (S-1121, src/db.ts threads): only the
// threads where that agent sent or received a message, newest first, within the limit.
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
