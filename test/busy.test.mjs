#!/usr/bin/env node
// The activities that touch STAM_HOME/busy (daemon.ts): a waiting agent counts, so a machine
// that shuts itself down when idle stays up under it. Fixed list, no daemon:
// `node --test test/busy.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-busy-');
process.env.STAM_HOME = home;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let db;
before(async () => { db = await import('../src/db.ts'); });
after(() => rmSync(home, { recursive: true, force: true }));

test('a waiting agent touches the busy file, like a working one', () => {
  for (const a of ['starting', 'working', 'waiting', 'blocked']) assert.ok(db.BUSY_ACTIVITIES.includes(a), a);
});

test('an idle, errored, or unknown agent does not touch it', () => {
  for (const a of ['idle', 'errored', 'unknown']) assert.ok(!db.BUSY_ACTIVITIES.includes(a), a);
});
