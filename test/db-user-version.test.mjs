#!/usr/bin/env node
// The database carries a schema version for the Go daemon's migration runner (S-2194): open() sets
// user_version to 1 when it reads 0, and never lowers a higher value, since a Go daemon may have
// written a later one. open() is a per-process singleton on STAM_HOME, so each case opens the
// database in its own child process, after the test has seeded the file.
// Run with `node --test test/db-user-version.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { tempHome } from './tmphome.mjs';

const dbModule = pathToFileURL(new URL('../src/db.ts', import.meta.url).pathname).href;

function childEnv(home) {
  const env = { ...process.env, STAM_HOME: home, STAM_TMUX_SOCKET: `user-version-${process.pid}` };
  for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete env[k];
  return env;
}

// Opens the database under `home` in a child process and returns what it reads back.
function openInChild(home) {
  const script = `
    const db = (await import(${JSON.stringify(dbModule)})).open();
    console.log(JSON.stringify({
      user_version: db.prepare('PRAGMA user_version').get().user_version,
      busy_timeout: db.prepare('PRAGMA busy_timeout').get().timeout,
    }));
    db.close();
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: childEnv(home), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

// A database file as another writer left it: one table of its own, at the given user_version.
function seed(home, version) {
  const file = new DatabaseSync(join(home, 'stam.db'));
  file.exec(`CREATE TABLE other_writer (n INTEGER); INSERT INTO other_writer VALUES (7); PRAGMA user_version = ${version};`);
  file.close();
}

// Lines from a child's stdout, one at a time.
function lines(child) {
  return createInterface({ input: child.stdout })[Symbol.asyncIterator]();
}

function exited(child) {
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

test('a fresh database opens at user_version 1', () => {
  const home = tempHome('stam-user-version-fresh-');
  writeFileSync(join(home, 'settings.json'), '{}');
  assert.deepEqual(openInChild(home), { user_version: 1, busy_timeout: 5000 });
});

test('an existing database at user_version 0 moves to 1 and keeps its rows', () => {
  const home = tempHome('stam-user-version-zero-');
  writeFileSync(join(home, 'settings.json'), '{}');
  seed(home, 0);
  assert.deepEqual(openInChild(home), { user_version: 1, busy_timeout: 5000 });
  const file = new DatabaseSync(join(home, 'stam.db'));
  assert.equal(file.prepare('SELECT n FROM other_writer').get().n, 7);
  file.close();
});

test('an existing database at user_version 2 stays at 2', () => {
  const home = tempHome('stam-user-version-two-');
  writeFileSync(join(home, 'settings.json'), '{}');
  seed(home, 2);
  assert.deepEqual(openInChild(home), { user_version: 2, busy_timeout: 5000 });
});

test('an open that waits on another writer keeps the version that writer commits', async () => {
  const home = tempHome('stam-user-version-race-');
  writeFileSync(join(home, 'settings.json'), '{}');
  seed(home, 0);
  const env = childEnv(home);
  // The other writer takes the write lock, sets version 2, and holds the lock until it reads a line.
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    const { DatabaseSync } = await import('node:sqlite');
    const file = new DatabaseSync(${JSON.stringify(join(home, 'stam.db'))});
    file.exec('BEGIN IMMEDIATE; PRAGMA user_version = 2;');
    console.log('locked');
    process.stdin.once('data', () => {
      file.exec('COMMIT');
      file.close();
      console.log('committed');
      process.stdin.destroy();
    });
  `], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const holderOut = lines(holder);
  const holderExit = exited(holder);
  assert.equal((await holderOut.next()).value, 'locked');
  // open() runs in a second child. It prints 'started' first, so the holder releases the lock only
  // after the open has begun (state-coordinated, no sleeps).
  const opener = spawn(process.execPath, ['--input-type=module', '-e', `
    console.log('started');
    const db = (await import(${JSON.stringify(dbModule)})).open();
    console.log(JSON.stringify({
      user_version: db.prepare('PRAGMA user_version').get().user_version,
      busy_timeout: db.prepare('PRAGMA busy_timeout').get().timeout,
    }));
    db.close();
  `], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  const openerOut = lines(opener);
  const openerExit = exited(opener);
  assert.equal((await openerOut.next()).value, 'started');
  holder.stdin.write('go\n');
  assert.equal((await holderOut.next()).value, 'committed');
  assert.equal(await holderExit, 0);
  assert.deepEqual(JSON.parse((await openerOut.next()).value), { user_version: 2, busy_timeout: 5000 });
  assert.equal(await openerExit, 0);
  const file = new DatabaseSync(join(home, 'stam.db'));
  assert.equal(file.prepare('PRAGMA user_version').get().user_version, 2);
  file.close();
});
