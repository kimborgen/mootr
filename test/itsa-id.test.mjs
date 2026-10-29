#!/usr/bin/env node
// Unit tests for ITSA id collisions (S-4067): a draw that hits a taken id is redrawn, never
// overwriting the row or failing UNIQUE; a table that takes every draw gives a clear error and
// leaves no rows; a UNIQUE failure on another column (the key) is not retried. The id source is
// forced, so no chance involved. Run with `node --test test/itsa-id.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './scrub-env.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STAM_HOME = mkdtempSync(join(tmpdir(), 'stam-itsa-id-unit-'));
const itsa = await import('../src/itsa.ts');
const { idSource, randomId, ID_TRIES } = await import('../src/short-id.ts');
const db = await import('../src/db.ts');

const draws = (...ids) => {
  const seen = [];
  idSource.draw = (prefix) => { seen.push(prefix); return prefix + (ids.shift() ?? 'iaaaa').slice(1); };
  return seen;
};
const count = () => db.open().prepare('SELECT COUNT(*) AS n FROM itsas').get().n;

test('a first draw that is taken is redrawn, and the held row is untouched', async () => {
  const first = await itsa.create({ title: 'Held' });
  const heldId = first.id;
  const seen = draws(heldId, 'izzzz');
  const second = await itsa.create({ title: 'Second' });
  assert.equal(second.id, 'izzzz');
  assert.equal(seen.length, 2);
  assert.equal(itsa.find(heldId).title, 'Held');
  assert.equal(count(), 2);
});

test('every draw taken: a clear error, and no row left', async () => {
  const held = await itsa.create({ title: 'Held again' });
  const before = count();
  draws(...Array(ID_TRIES).fill(held.id));
  await assert.rejects(() => itsa.create({ title: 'Never' }), /could not pick a free ITSA id/);
  assert.equal(count(), before);
});

test('a field id collision is redrawn too', async () => {
  const a = await itsa.createField({ key: 'one', label: 'One', type: 'text' }, 'human');
  draws(a.id, 'fyyyy');
  const b = await itsa.createField({ key: 'two', label: 'Two', type: 'text' }, 'human');
  assert.equal(b.id, 'fyyyy');
});

test('a duplicate key is a plain UNIQUE error: one draw, no row, no event, no counter move', async () => {
  const d = db.open();
  idSource.draw = randomId;
  const held = await itsa.create({ title: 'Key holder' });
  const counter = () => d.prepare("SELECT value FROM itsa_counter WHERE name = 'key'").get().value;
  const events = () => d.prepare('SELECT COUNT(*) AS n FROM itsa_events').get().n;
  // Wind the counter back so the next key is the holder's.
  d.prepare("UPDATE itsa_counter SET value = value - 1 WHERE name = 'key'").run();
  const rows = count(), ev = events(), at = counter();
  const seen = draws('ifree');
  await assert.rejects(() => itsa.create({ title: 'Duplicate key' }), /UNIQUE constraint failed: itsas\.key/);
  assert.equal(seen.length, 1, 'the id is drawn once, not retried');
  assert.equal(count(), rows);
  assert.equal(events(), ev);
  assert.equal(counter(), at, 'the counter rolls back with the failed create');
  assert.equal(itsa.find(held.id).title, 'Key holder');
  d.prepare("UPDATE itsa_counter SET value = value + 1 WHERE name = 'key'").run();
});

test('a requirement id that is taken is redrawn, with the key and row in one transaction', async () => {
  idSource.draw = randomId;
  const settings = await import('../src/settings.ts');
  settings.setSetting('requirements', { ...settings.settings().requirements, enabled: true, approval: 'any' });
  const req = await import('../src/requirements.ts');
  const d = db.open();
  const a = await req.create({ title: 'First', by: 'human' });
  const seen = draws(a.id, 'rzzzz');
  const b = await req.create({ title: 'Second', by: 'human' });
  assert.equal(b.id, 'rzzzz');
  assert.equal(seen.length, 2);
  assert.equal(req.must(a.id).title, 'First');
  // Every draw taken: a clear error, no row, and the key counter where it was.
  const counter = () => d.prepare("SELECT value FROM req_counter WHERE name = 'key'").get().value;
  const rows = d.prepare('SELECT COUNT(*) AS n FROM requirements').get().n, at = counter();
  draws(...Array(ID_TRIES).fill(a.id));
  await assert.rejects(() => req.create({ title: 'Never', by: 'human' }), /could not pick a free requirement id/);
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM requirements').get().n, rows);
  assert.equal(counter(), at);
  idSource.draw = randomId;
});
