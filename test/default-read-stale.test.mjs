#!/usr/bin/env node
// A read_mail without ids (db.defaultRead) hands out owed mail first (S-357), but not FYI or day-old owed
// mail (S-1091): system senders, "No action needed" mail, and mail older than a few hours stay read and
// are not served again. Run with `node --test test/default-read-stale.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-default-read-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `default-read-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), '{}');

test('owed mail that is FYI or stale is not served again; real owed and unread mail is', async () => {
  const db = await import('../src/db.ts');
  const d = db.open();
  const ago = (h) => new Date(Date.now() - h * 3600_000).toISOString();
  const add = (id, from, body, at, read) => {
    d.prepare('INSERT INTO mail (id, from_id, subject, body, created_at) VALUES (?, ?, ?, ?, ?)').run(id, from, id, body, at);
    d.prepare('INSERT INTO mail_recipients (mail_id, agent_id, read_at) VALUES (?, ?, ?)').run(id, 'r', read ? at : null);
    if (read) d.prepare('INSERT INTO mail_deliveries (agent_id, mail_id, batch) VALUES (?, ?, ?)').run('r', id, 'b1');
  };
  add('stale', 'a1', 'real but a day old', ago(24), true);
  add('sys', 'system:deploy-watch', 'deployed', ago(1), true);
  add('fyi', 'a1', 'Done. No action needed.', ago(1), true);
  add('owed', 'a1', 'please reply', ago(1), true);
  add('unread', 'a1', 'new', ago(0), false);
  add('mid', 'a1', 'Is no action needed here? Please answer.\nThanks', ago(1), true);
  // Old unread mail read just now with the reply lost is still owed: age counts from the read.
  add('ask', 'a1', 'old ask', ago(7), false);
  assert.deepEqual(db.defaultRead('r'), ['owed', 'mid', 'ask', 'unread']);
  db.readMail('r', ['ask'], 'b2');
  assert.deepEqual(db.defaultRead('r'), ['ask', 'owed', 'mid', 'unread']);
  assert.equal(d.prepare("SELECT COUNT(*) AS n FROM mail_deliveries WHERE mail_id IN ('stale','sys','fyi')").get().n, 0);
});
