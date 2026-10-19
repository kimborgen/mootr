#!/usr/bin/env node
// A ring that fails after its INSERT leaves nothing behind (S-412 review): no ring row, no
// ring:joined events, no queued turn notices. Throwaway STAM_HOME, no daemon:
// `node --test test/ring-create-rollback.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-ring-rollback-');
process.env.STAM_HOME = home;
const db = await import('../src/db.ts');
const ring = await import('../src/ring.ts');
const mail = await import('../src/mail.ts');

let n = 0;
const agent = () => db.createAgent({ id: db.newAgentId(), name: `m${++n}`, role: '', machine: 'test', harness: 'fake', model: null, effort: null, cwd: home, parent_id: null, session_id: null });
const input = (members) => ({ name: 'r', format: 'rounds', topic: 't', members, createdBy: 'human' });

test('a failure after the INSERT removes the ring, its events, and its notices', () => {
  const [a, b] = [agent(), agent()];
  db.open().exec(`CREATE TRIGGER fail_join BEFORE INSERT ON events WHEN NEW.type = 'ring:joined' AND NEW.agent_id = '${b.id}' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
  assert.throws(() => ring.createRing(input([a.name, b.name])), /boom/);
  assert.equal(db.open().prepare('SELECT COUNT(*) AS c FROM rings').get().c, 0);
  assert.equal(db.open().prepare("SELECT COUNT(*) AS c FROM events WHERE type = 'ring:joined'").get().c, 0);
  assert.equal(mail.queuedNoticeCount(a.id), 0);
  db.open().exec('DROP TRIGGER fail_join');
  const r = ring.createRing(input([a.name, b.name]));
  assert.equal(r.status, 'running');
  assert.equal(mail.queuedNoticeCount(a.id), 1);
});
