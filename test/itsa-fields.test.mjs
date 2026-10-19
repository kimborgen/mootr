#!/usr/bin/env node
// Unit tests for ITSA fields (S-364 step 1, src/itsa.ts): type validation of values and
// definitions, field CRUD, values through `set` (same transaction, events, null clears),
// cascade on remove, reorder, and who may change definitions (the human; the chief of staff
// while one is set; any agent otherwise). Throwaway STAM_HOME, no daemon, no network.
// Run with `node --test test/itsa-fields.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-itsa-fields-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `itsa-fields-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

let db, itsa, settings, x;
const rejects = (p, re) => assert.rejects(p, re);

before(async () => {
  db = await import('../src/db.ts');
  settings = await import('../src/settings.ts');
  itsa = await import('../src/itsa.ts');
  db.open();
  for (const [id, name] of [['a1', 'alice'], ['a2', 'bob']])
    db.createAgent({ id, name, role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  x = await itsa.create({ title: 'X', by: 'human' });
});
after(() => rmSync(home, { recursive: true, force: true }));

const events = () => db.open().prepare("SELECT type, actor, data FROM itsa_events WHERE itsa_id = 'fields' ORDER BY id").all();

test('a field is created with defaults and listed in order', async () => {
  const f = await itsa.createField({ key: 'pr', label: 'PR', type: 'link' }, 'human');
  assert.deepEqual([f.width, f.align, f.card, f.options, f.position], ['m', 'start', 'meta', null, 0]);
  const g = await itsa.createField({ key: 'stage', label: 'Stage', type: 'choice', options: [{ value: 'dev', label: 'Dev', tone: 'accent' }, { value: 'live' }], width: 's', align: 'end', card: 'chip' }, 'human');
  assert.deepEqual(g.options, [{ value: 'dev', label: 'Dev', tone: 'accent' }, { value: 'live', label: 'live', tone: null }]);
  assert.equal(g.position, 1);
  assert.deepEqual(itsa.fields().map((f) => f.key), ['pr', 'stage']);
});

test('definitions are validated', async () => {
  await rejects(itsa.createField({ key: 'Bad Key', label: 'x', type: 'text' }, 'human'), /slug/);
  await rejects(itsa.createField({ key: 'pr', label: 'x', type: 'text' }, 'human'), /exists/);
  await rejects(itsa.createField({ key: 'a', label: '', type: 'text' }, 'human'), /label/);
  await rejects(itsa.createField({ key: 'a', label: 'A', type: 'colour' }, 'human'), /type must be/);
  await rejects(itsa.createField({ key: 'a', label: 'A', type: 'choice' }, 'human'), /options/);
  await rejects(itsa.createField({ key: 'a', label: 'A', type: 'choice', options: [{ value: 'x', tone: 'pink' }] }, 'human'), /tone must be/);
  await rejects(itsa.createField({ key: 'a', label: 'A', type: 'choice', options: [{ value: 'x' }, { value: 'x' }] }, 'human'), /duplicate/);
  await rejects(itsa.createField({ key: 'a', label: 'A', type: 'text', options: [] }, 'human'), /only a choice/);
  await rejects(itsa.createField({ key: 'a', label: 'A', type: 'text', width: '200px' }, 'human'), /width must be/);
  await rejects(itsa.createField({ key: 'a', label: 'A', type: 'text', align: 'middle' }, 'human'), /align must be/);
  await rejects(itsa.createField({ key: 'a', label: 'A', type: 'text', card: 'x' }, 'human'), /card must be/);
  assert.equal(itsa.fields().length, 2);
});

test('values are validated against the field type; null clears', async () => {
  for (const [key, type, opts] of [['t', 'text'], ['n', 'number'], ['d', 'date'], ['c', 'check']])
    await itsa.createField({ key, label: key, type, options: opts }, 'human');
  const set = (fields) => itsa.set(x.key, { fields }, 'human');
  await set({ t: 'hi', n: 2.5, d: '2026-10-13', c: false, pr: 'https://example.com/pr/1', stage: 'live' });
  assert.deepEqual(itsa.get(x.key).fields, { pr: 'https://example.com/pr/1', stage: 'live', t: 'hi', n: 2.5, d: '2026-10-13', c: false });
  for (const bad of [{ t: 1 }, { n: '2' }, { n: NaN }, { d: '2026-02-30' }, { d: '13/10/2026' }, { c: 'yes' }, { pr: 'ftp://x/y' }, { pr: 'nope' }, { stage: 'beta' }, { nokey: 1 }])
    await rejects(set(bad), /field|no field/);
  await set({ t: null, c: null });
  assert.deepEqual(Object.keys(itsa.get(x.key).fields).sort(), ['d', 'n', 'pr', 'stage']);
});

test('a bad value rolls back the whole set, and a set records one event', async () => {
  const before = itsa.get(x.key);
  await rejects(itsa.set(x.key, { title: 'Changed', fields: { n: 'x' } }, 'human'), /number/);
  assert.equal(itsa.get(x.key).title, before.title);
  const r = await itsa.set(x.key, { title: 'X2', fields: { n: 3, stage: 'dev' } }, 'human');
  assert.deepEqual(r.changes.fields, { from: { n: 2.5, stage: 'live' }, to: { n: 3, stage: 'dev' } });
  const last = itsa.get(x.key).events.at(-1);
  assert.equal(last.type, 'fields');
  const same = await itsa.set(x.key, { fields: { n: 3 } }, 'human');
  assert.equal(same.changes.fields, undefined);
});

test('list returns fields for every ITSA', async () => {
  const y = await itsa.create({ title: 'Y', by: 'human' });
  const rows = await itsa.list();
  assert.equal(rows.find((r) => r.id === y.id).fields.stage, undefined);
  assert.equal(rows.find((r) => r.id === x.id).fields.stage, 'dev');
});

test('update: key change stays unique, and a type or option change must hold existing values', async () => {
  await rejects(itsa.updateField('stage', { key: 'pr' }, 'human'), /exists/);
  await rejects(itsa.updateField('stage', { options: [{ value: 'live' }] }, 'human'), /holds a value it would refuse/);
  await rejects(itsa.updateField('n', { type: 'text' }, 'human'), /holds a value/);
  const f = await itsa.updateField('stage', { key: 'phase', label: 'Phase', options: [{ value: 'dev' }, { value: 'live' }], width: 'l' }, 'human');
  assert.deepEqual([f.key, f.label, f.width], ['phase', 'Phase', 'l']);
  assert.equal(itsa.get(x.key).fields.phase, 'dev');
  assert.equal(itsa.get(x.key).fields.stage, undefined);
  const noop = await itsa.updateField('phase', { label: 'Phase' }, 'human');
  assert.equal(noop.label, 'Phase');
});

test('reorder sets positions; unlisted fields follow', async () => {
  const keys = () => itsa.fields().map((f) => f.key);
  const ids = itsa.fields().map((f) => f.id);
  await itsa.reorderFields([ids[3], 'pr'], 'human');
  assert.deepEqual(keys().slice(0, 2), [itsa.fields()[0].key, 'pr']);
  assert.equal(itsa.fields()[0].id, ids[3]);
  await rejects(itsa.reorderFields([ids[0], ids[0]], 'human'), /twice/);
  await rejects(itsa.reorderFields(['nope'], 'human'), /no field/);
});

test('remove deletes the definition and its values', async () => {
  const r = await itsa.removeField('phase', 'human');
  assert.deepEqual(r, { removed: 'phase', values: 1 });
  assert.equal(itsa.findField('phase'), undefined);
  assert.equal(itsa.get(x.key).fields.phase, undefined);
  assert.equal(db.open().prepare('SELECT COUNT(*) AS n FROM itsa_field_values WHERE field_id NOT IN (SELECT id FROM itsa_fields)').get().n, 0);
  await rejects(itsa.removeField('phase', 'human'), /no field/);
});

test('definition changes are recorded as events', () => {
  const types = events().map((e) => e.type);
  assert.ok(types.includes('field_created') && types.includes('field_updated') && types.includes('field_order') && types.includes('field_removed'));
  assert.equal(events().find((e) => e.type === 'field_removed').actor, 'human');
});

test('who may change definitions', async () => {
  // No chief of staff: any agent.
  const a = await itsa.createField({ key: 'free', label: 'Free', type: 'text' }, 'alice');
  assert.equal(a.created_by, 'a1');
  settings.setSetting('chiefOfStaff', 'bob');
  // A chief of staff set: the human and that agent, by name or id; not another agent.
  await itsa.createField({ key: 'byname', label: 'x', type: 'text' }, 'bob');
  await itsa.createField({ key: 'byid', label: 'x', type: 'text' }, 'a2');
  await itsa.createField({ key: 'byhuman', label: 'x', type: 'text' }, 'human');
  for (const op of [
    () => itsa.createField({ key: 'no', label: 'x', type: 'text' }, 'alice'),
    () => itsa.updateField('free', { label: 'x' }, 'a1'),
    () => itsa.removeField('free', 'alice'),
    () => itsa.reorderFields([], 'alice'),
  ])
    await assert.rejects(op(), (e) => e instanceof itsa.ForbiddenError && /chief of staff \(bob\)/.test(e.message) && /mail bob/.test(e.message));
  assert.ok(itsa.findField('free') && !itsa.findField('no'));
  // Values stay open to whoever may patch the ITSA.
  await itsa.set(x.key, { fields: { free: 'ok' } }, 'alice');
  assert.equal(itsa.get(x.key).fields.free, 'ok');
  settings.setSetting('chiefOfStaff', null);
});

test('a key can not equal another field id, and an id is found before a key', async () => {
  const a = await itsa.createField({ key: 'idclash', label: 'A', type: 'text' }, 'human');
  await rejects(itsa.createField({ key: a.id, label: 'B', type: 'text' }, 'human'), /another field's id/);
  await rejects(itsa.updateField('idclash', { key: itsa.findField('pr').id }, 'human'), /another field's id/);
  // A legacy row whose key equals another's id: the id match wins.
  const b = await itsa.createField({ key: 'idclash2', label: 'B', type: 'text' }, 'human');
  db.open().prepare('UPDATE itsa_fields SET key = ? WHERE id = ?').run(a.id, b.id);
  assert.equal(itsa.findField(a.id).id, a.id);
  db.open().prepare('UPDATE itsa_fields SET key = ? WHERE id = ?').run('idclash2', b.id);
});

test('create applies fields in its transaction and records the event; a bad value creates nothing', async () => {
  const n = db.open().prepare('SELECT COUNT(*) AS n FROM itsas').get().n;
  await rejects(itsa.create({ title: 'Bad', by: 'human', fields: { n: 'x' } }), /number/);
  await rejects(itsa.create({ title: 'Bad', by: 'human', fields: { nokey: 1 } }), /no field/);
  assert.equal(db.open().prepare('SELECT COUNT(*) AS n FROM itsas').get().n, n);
  const y = await itsa.create({ title: 'With fields', by: 'human', fields: { n: 7 } });
  assert.deepEqual(itsa.get(y.key).fields, { n: 7 });
  const ev = itsa.get(y.key).events.find((e) => e.type === 'fields');
  assert.deepEqual(JSON.parse(ev.data), { from: { n: null }, to: { n: 7 } });
});
