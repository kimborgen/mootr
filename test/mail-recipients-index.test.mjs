#!/usr/bin/env node
// The unread-mail counts the hook path reads (S-1025) use the mail_recipients_unread index, not a scan of
// every recipient row: a PostToolUse hook counts an agent's unread mail on each tool call, and the table
// grows with every mail. Against a throwaway STAM_HOME with 50k recipient rows, check the index exists, the
// query plans search it, and the counts stay right. Run with `node --test test/mail-recipients-index.test.mjs`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-recipients-index-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `recipients-index-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), '{}');

let db;
let d;
const AGENTS = 5;
const ROWS = 50_000;

before(async () => {
  db = await import('../src/db.ts');
  d = db.open();
  // Agent a0 has 3 unread rows, one of them pushed; every other row is read and pushed.
  const ins = d.prepare('INSERT INTO mail_recipients (mail_id, agent_id, read_at, pushed_at, quiet) VALUES (?, ?, ?, ?, 0)');
  d.exec('BEGIN');
  for (let i = 0; i < ROWS; i++) {
    const agent = i < 3 ? 'a0' : `a${1 + (i % (AGENTS - 1))}`;
    const unread = i < 3;
    const pushed = i === 0 || !unread ? '2026-10-01T00:00:00Z' : null;
    ins.run(`m${i}`, agent, unread ? null : '2026-10-01T00:00:00Z', pushed);
  }
  d.exec('COMMIT');
});

test('the unread index is partial on read_at, keyed by agent', () => {
  const idx = d.prepare("PRAGMA index_list(mail_recipients)").all().find((i) => i.name === 'mail_recipients_unread');
  assert.ok(idx, 'mail_recipients_unread exists');
  assert.equal(idx.partial, 1);
  const cols = d.prepare('PRAGMA index_info(mail_recipients_unread)').all().map((c) => c.name);
  assert.deepEqual(cols, ['agent_id']);
  const sql = d.prepare("SELECT sql FROM sqlite_master WHERE name = 'mail_recipients_unread'").get().sql;
  assert.match(sql, /WHERE read_at IS NULL/);
});

test('the unread counts search the index and return the right numbers', () => {
  // The same WHERE clauses as db.unreadCount (loud), db.unpushedCount and db.unreadCounts.
  const plans = {
    unread: d.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM mail_recipients WHERE agent_id = ? AND read_at IS NULL AND quiet = 0").all('a0'),
    unpushed: d.prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM mail_recipients WHERE agent_id = ? AND read_at IS NULL AND pushed_at IS NULL').all('a0'),
  };
  for (const [name, rows] of Object.entries(plans)) {
    const detail = rows.map((r) => r.detail).join('\n');
    assert.match(detail, /USING INDEX mail_recipients_unread/, `${name} plan: ${detail}`);
    assert.doesNotMatch(detail, /SCAN mail_recipients(?! USING INDEX)/, `${name} plan: ${detail}`);
  }
  assert.equal(db.unreadCount('a0', true), 3);
  assert.equal(db.unpushedCount('a0'), 2);
  assert.equal(db.unreadCounts().get('a0'), 3);
  assert.equal(db.unreadCount('a1'), 0);
});
