#!/usr/bin/env node
// The startup's decision-mail read (decisionMails, src/db.ts) checks each decision mail against the
// pending human requests of its sender. Without an index that is a scan of every request per mail, and
// startup grew with the requests (S-1025: 4.2 s at 5k decision mails and 20k requests). The partial index
// permission_requests_pending keys them by agent. Against a throwaway STAM_HOME with 20k requests, check
// the index exists and the check uses it, and that the read still excludes a mail whose request is pending.
// Run with `node --test test/permission-requests-index.test.mjs`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-requests-index-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `requests-index-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), '{}');

let d;
let dbm;
before(async () => {
  dbm = await import('../src/db.ts');
  d = dbm.open();
  const now = '2026-10-15T00:00:00Z';
  d.exec('BEGIN');
  const reqIns = d.prepare("INSERT INTO permission_requests (id, agent_id, action, reason, details, status, created_at, audience) VALUES (?, ?, 'act', 'why', '{}', ?, ?, 'human')");
  for (let i = 0; i < 20_000; i++) reqIns.run(`p${i}`, `a${i % 30}`, i === 0 ? 'pending' : 'approved', now);
  // Decision mail from a0 that names the pending request p0: the read leaves it out.
  d.prepare("INSERT INTO mail (id, from_id, from_name, subject, body, created_at) VALUES ('dm-named', 'a0', 'seed', 'about p0', 'body', ?)").run(now);
  d.prepare("INSERT INTO decision_mails (mail_id, thread_id) VALUES ('dm-named', 'dm-named')").run();
  d.prepare("INSERT INTO mail (id, from_id, from_name, subject, body, created_at) VALUES ('dm-other', 'a1', 'seed', 'nothing pending', 'body', ?)").run(now);
  d.prepare("INSERT INTO decision_mails (mail_id, thread_id) VALUES ('dm-other', 'dm-other')").run();
  d.exec('COMMIT');
});

test('the pending-request index is partial on pending, keyed by agent', () => {
  const sql = d.prepare("SELECT sql FROM sqlite_master WHERE name = 'permission_requests_pending'").get();
  assert.ok(sql, 'permission_requests_pending exists');
  assert.match(sql.sql, /ON permission_requests \(agent_id\) WHERE status = 'pending'/);
});

test('the decision-mail check plans a search of the pending index', () => {
  const plan = d.prepare(`EXPLAIN QUERY PLAN SELECT p.id FROM permission_requests p WHERE p.agent_id = ? AND p.status = 'pending' AND p.audience = 'human'`).all('a0').map((r) => r.detail).join('\n');
  assert.match(plan, /permission_requests_pending/);
});

test('a decision mail naming a pending request is left out of the waiting list', () => {
  const ids = dbm.decisionMails().map((r) => r.mail_id);
  assert.ok(!ids.includes('dm-named'), 'the mail naming the pending request is not listed');
  assert.ok(ids.includes('dm-other'), 'the mail naming no pending request is listed');
});
