#!/usr/bin/env node
// The daemon's database runs with synchronous = NORMAL (S-1025). Every hook and statusline write is
// its own commit, and under FULL each commit fsyncs the WAL, which stalled the event loop under load.
// Checks the pragma on a throwaway STAM_HOME, and that a burst of autocommit writes stays consistent.
// Run with `node --test test/db-synchronous.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-synchronous-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `synchronous-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), '{}');

test('the database commits in WAL mode with synchronous = NORMAL', async () => {
  const db = (await import('../src/db.ts')).open();
  assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 1);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
});

test('a burst of autocommit writes all lands', async () => {
  const db = (await import('../src/db.ts')).open();
  db.exec('CREATE TABLE IF NOT EXISTS sync_probe (n INTEGER PRIMARY KEY, v TEXT)');
  const ins = db.prepare('INSERT INTO sync_probe (n, v) VALUES (?, ?)');
  for (let i = 0; i < 500; i++) ins.run(i, `row ${i}`);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sync_probe').get().c, 500);
});
