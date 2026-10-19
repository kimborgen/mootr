#!/usr/bin/env node
// The daemon's database runs with synchronous = NORMAL (S-1025). Every hook and statusline write is
// its own commit, and under FULL each commit fsyncs the WAL, which stalled the event loop under load.
// Checks the pragma on a throwaway STAM_HOME, and that a burst of autocommit writes stays consistent.
// Run with `node --test test/db-synchronous.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

test('the database reads through a memory map and a 64 MB page cache (S-2122)', async () => {
  const db = (await import('../src/db.ts')).open();
  assert.equal(db.prepare('PRAGMA mmap_size').get().mmap_size, 536870912);
  assert.equal(db.prepare('PRAGMA cache_size').get().cache_size, -65536);
});

test('repeated scans of a 10 MB table stay off read syscalls (S-2122)', { skip: !existsSync('/proc/self/io') }, async () => {
  const db = (await import('../src/db.ts')).open();
  db.exec('CREATE TABLE IF NOT EXISTS scan_probe (n INTEGER PRIMARY KEY, v TEXT)');
  const ins = db.prepare('INSERT INTO scan_probe (n, v) VALUES (?, ?)');
  db.exec('BEGIN');
  for (let i = 0; i < 10_000; i++) ins.run(i, 'x'.repeat(1000));
  db.exec('COMMIT');
  // Move the rows from the WAL into the main file, where the map covers them, and shrink the page
  // cache below the table, so the scans can only stay off syscalls through the map.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec('PRAGMA cache_size = -1024');
  try {
    const syscr = () => Number(/^syscr: (\d+)$/m.exec(readFileSync('/proc/self/io', 'utf8'))[1]);
    const scan = db.prepare('SELECT * FROM scan_probe');
    const before = syscr();
    for (let i = 0; i < 20; i++) scan.all();
    // Without the map each scan re-reads ~2,500 pages: ~50,000 reads for 20 scans.
    assert.ok(syscr() - before < 2_000, `read syscalls: ${syscr() - before}`);
  } finally {
    db.exec('PRAGMA cache_size = -65536');
  }
});

test('a burst of autocommit writes all lands', async () => {
  const db = (await import('../src/db.ts')).open();
  db.exec('CREATE TABLE IF NOT EXISTS sync_probe (n INTEGER PRIMARY KEY, v TEXT)');
  const ins = db.prepare('INSERT INTO sync_probe (n, v) VALUES (?, ?)');
  for (let i = 0; i < 500; i++) ins.run(i, `row ${i}`);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sync_probe').get().c, 500);
});
