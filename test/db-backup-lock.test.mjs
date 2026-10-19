#!/usr/bin/env node
// The migrations' database copies (stam.db.pre-withdraw, stam.db.pre-audience) keep the daemon's
// SQLite locks (S-453). A copy made through another file descriptor dropped this process's POSIX
// locks on stam.db when that descriptor closed. Another client closing its connection then took the
// database for itself, checkpointed, and deleted the WAL and shm the daemon was still writing to, so
// the daemon's later writes were lost. Node's own SQLite also checks the shm and holds back; SQLite
// 3.46 (Python's here) doesn't. A child process plays the daemon: it opens a fresh STAM_HOME (both
// migrations copy) and writes; this process checks that it still holds its lock on stam.db, lets a
// Python SQLite client read and close, then the daemon writes again and is killed without closing.
// Both writes must be there. Linux (/proc/locks). Throwaway STAM_HOME, no daemon:
// `node --test test/db-backup-lock.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tempHome } from './tmphome.mjs';

const DAEMON = `
const db = (await import('../src/db.ts')).open();
const put = (k) => db.prepare('INSERT INTO migrations (name, done_at) VALUES (?, ?)').run(k, 'now');
put('before');
console.log('ready');
const { createInterface } = await import('node:readline');
for await (const line of createInterface({ input: process.stdin })) {
  // A crash, not a clean close: a clean close would checkpoint even a deleted WAL back in.
  if (line === 'write') { put('after'); process.kill(process.pid, 'SIGKILL'); }
}
`;

const python = spawnSync('python3', ['-c', 'import sqlite3'], { encoding: 'utf8' }).status === 0;

test('the daemon keeps its lock on stam.db through the migration copies, and an outside client loses none of its writes', async () => {
  const home = tempHome('stam-backup-lock-');
  writeFileSync(join(home, 'settings.json'), '{}');
  const child = spawn(process.execPath, ['--input-type=module', '-e', DAEMON], { cwd: import.meta.dirname, env: { ...process.env, STAM_HOME: home, STAM_EMBEDDER: 'stub' }, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  try {
    assert.equal((await lines.next()).value, 'ready');
    assert.ok(existsSync(join(home, 'stam.db.pre-withdraw')) && existsSync(join(home, 'stam.db.pre-audience')), 'both migrations kept a copy');
    // A /proc/locks line: "N: POSIX ADVISORY READ PID MAJ:MIN:INODE START END".
    const inode = statSync(join(home, 'stam.db')).ino;
    const held = readFileSync('/proc/locks', 'utf8').split('\n').filter((l) => l.split(/\s+/)[4] === String(child.pid) && l.split(/\s+/)[5]?.endsWith(`:${inode}`));
    assert.ok(held.length, 'the daemon holds a lock on stam.db');
    if (python) {
      const r = spawnSync('python3', ['-c', 'import sqlite3, sys; d = sqlite3.connect(sys.argv[1]); d.execute("SELECT COUNT(*) FROM migrations").fetchone(); d.close()', join(home, 'stam.db')], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.ok(existsSync(join(home, 'stam.db-wal')), 'the daemon\'s WAL is still there');
    }
    const exited = new Promise((r) => (child.exitCode !== null || child.signalCode ? r() : child.on('exit', r)));
    child.stdin.write('write\n');
    await exited;
    assert.equal(child.signalCode, 'SIGKILL');
  } finally {
    child.kill();
  }
  const after = new DatabaseSync(join(home, 'stam.db'));
  const names = after.prepare("SELECT name FROM migrations WHERE name IN ('before', 'after') ORDER BY name").all().map((r) => r.name);
  after.close();
  assert.deepEqual(names, ['after', 'before']);
  const copy = new DatabaseSync(join(home, 'stam.db.pre-audience'));
  assert.ok(!copy.prepare('PRAGMA table_info(permission_requests)').all().some((c) => c.name === 'audience'), 'the copy is the database as it was');
  copy.close();
});
