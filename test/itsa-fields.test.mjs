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

// Field kinds (S-3180): a field limited to some ITSA kinds applies only to those.
test('kinds are validated: a list of labels, an empty list is every kind', async () => {
  await rejects(itsa.createField({ key: 'kk', label: 'K', type: 'text', kinds: 'issue' }, 'human'), /list of ITSA kinds/);
  await rejects(itsa.createField({ key: 'kk', label: 'K', type: 'text', kinds: ['issue', '  '] }, 'human'), /needs a label/);
  const every = await itsa.createField({ key: 'kk', label: 'K', type: 'text', kinds: [] }, 'human');
  assert.equal(every.kinds, null);
  const dedup = await itsa.updateField('kk', { kinds: [' Issue ', 'issue'] }, 'human');
  assert.deepEqual(dedup.kinds, ['Issue']);
  assert.equal((await itsa.updateField('kk', { kinds: null }, 'human')).kinds, null);
  await itsa.removeField('kk', 'human');
});

test('a field limited to kinds applies to those kinds, matching the kind ignoring case', async () => {
  const f = await itsa.createField({ key: 'scope', label: 'Scope', type: 'text', kinds: ['issue'] }, 'human');
  assert.deepEqual(f.kinds, ['issue']);
  const issue = await itsa.create({ title: 'An issue', kind: 'Issue', by: 'human', fields: { scope: 'core' } });
  assert.equal(itsa.get(issue.key).fields.scope, 'core');
  const project = await itsa.create({ title: 'A project', kind: 'project', by: 'human' });
  await rejects(itsa.set(project.key, { fields: { scope: 'core' } }, 'human'), /scope applies only to issue ITSAs, not project ones/);
  const bare = await itsa.create({ title: 'No kind', by: 'human' });
  await rejects(itsa.set(bare.key, { fields: { scope: 'core' } }, 'human'), /not ITSAs with no kind/);
  assert.equal(itsa.get(project.key).fields.scope, undefined);
});

test('a refused field writes none of the other fields in the same call', async () => {
  const p = await itsa.create({ title: 'Mixed', kind: 'project', by: 'human', fields: { pr: 'https://example.com/p/1' } });
  await rejects(itsa.set(p.key, { title: 'Changed', fields: { pr: 'https://example.com/p/2', scope: 'core' } }, 'human'), /scope/);
  assert.equal(itsa.get(p.key).title, 'Mixed');
  assert.equal(itsa.get(p.key).fields.pr, 'https://example.com/p/1');
  await rejects(itsa.create({ title: 'Mixed new', kind: 'project', by: 'human', fields: { pr: 'https://example.com/p/3', scope: 'core' } }), /scope/);
  assert.equal((await itsa.list()).find((r) => r.title === 'Mixed new'), undefined);
});

test('clearing a value on a kind it does not apply to is allowed; a value there is refused', async () => {
  const p = await itsa.create({ title: 'Cleared', kind: 'project', by: 'human', fields: { pr: 'https://example.com/p/4' } });
  await rejects(itsa.set(p.key, { fields: { scope: 'x' } }, 'human'), /applies only/);
  const r = await itsa.set(p.key, { fields: { pr: null } }, 'human');
  assert.deepEqual(r.changes.fields, { from: { pr: 'https://example.com/p/4' }, to: { pr: null } });
  assert.equal(itsa.get(p.key).fields.pr, undefined);
});

test('narrowing kinds keeps existing values but hides them; widening shows them again', async () => {
  const kept = itsa.get(x.key).fields.pr;
  assert.ok(kept, 'X holds a pr value from the earlier tests');
  await itsa.updateField('pr', { kinds: ['issue'] }, 'human');
  assert.equal(itsa.get(x.key).fields.pr, undefined);
  const row = db.open().prepare('SELECT value FROM itsa_field_values WHERE itsa_id = ? AND field_id = ?').get(x.id, itsa.findField('pr').id);
  assert.equal(JSON.parse(row.value), kept);
  await itsa.updateField('pr', { kinds: null }, 'human');
  assert.equal(itsa.get(x.key).fields.pr, kept);
});

test('a stage limited to issue refuses a project, and an issue keeps its stage', async () => {
  const stage = await itsa.createField({ key: 'stage', label: 'Stage', type: 'choice', options: [{ value: 'dev' }, { value: 'live' }], kinds: ['issue'] }, 'human');
  try {
    const project = await itsa.create({ title: 'Staged project', kind: 'project', by: 'human' });
    await rejects(itsa.set(project.key, { fields: { stage: 'dev' } }, 'human'), /stage applies only to issue ITSAs, not project ones/);
    const issue = await itsa.create({ title: 'Staged issue', kind: 'issue', by: 'human', fields: { stage: 'dev' } });
    assert.equal(itsa.get(issue.key).fields.stage, 'dev');
  } finally {
    await itsa.removeField(stage.id, 'human');
  }
});

test('closing a project writes no stage when stage is limited to issues; closing an issue still sets it', async () => {
  const stage = await itsa.createField({ key: 'stage', label: 'Stage', type: 'choice', options: [{ value: 'dev' }, { value: 'live' }], kinds: ['issue'] }, 'human');
  itsa.setCloseStage(() => 'live');
  try {
    const project = await itsa.create({ title: 'Closing project', kind: 'project', by: 'human' });
    const closed = await itsa.set(project.key, { status: 'done' }, 'human');
    assert.equal(closed.changes.status.to, 'done');
    assert.equal(itsa.get(project.key).status, 'done');
    assert.equal(itsa.get(project.key).fields.stage, undefined);
    const issue = await itsa.create({ title: 'Closing issue', kind: 'issue', by: 'human' });
    await itsa.set(issue.key, { status: 'done' }, 'human');
    assert.equal(itsa.get(issue.key).fields.stage, 'live');
  } finally {
    itsa.setCloseStage(null);
    await itsa.removeField(stage.id, 'human');
  }
});

test('a kind change in the same set is checked against the new kind', async () => {
  const stage = await itsa.createField({ key: 'stage', label: 'Stage', type: 'choice', options: [{ value: 'dev' }, { value: 'live' }], kinds: ['issue'] }, 'human');
  try {
    const becomes = await itsa.create({ title: 'Becomes an issue', kind: 'project', by: 'human' });
    await itsa.set(becomes.key, { kind: 'issue', fields: { stage: 'dev' } }, 'human');
    assert.equal(itsa.get(becomes.key).kind, 'issue');
    assert.equal(itsa.get(becomes.key).fields.stage, 'dev');
    const issue = await itsa.create({ title: 'Stops being an issue', kind: 'issue', by: 'human' });
    await rejects(itsa.set(issue.key, { kind: 'project', fields: { stage: 'dev' } }, 'human'), /stage applies only to issue ITSAs, not project ones/);
    assert.equal(itsa.get(issue.key).kind, 'issue');
    assert.equal(itsa.get(issue.key).fields.stage, undefined);
  } finally {
    await itsa.removeField(stage.id, 'human');
  }
});

test('backfill skips a kind the stage field does not apply to; an issue still gets its end node', async () => {
  const stage = await itsa.createField({ key: 'stage', label: 'Stage', type: 'choice', options: [{ value: 'dev' }, { value: 'live' }] }, 'human');
  try {
    // Written before the field was limited to issues: a closed project holding a stage.
    const project = await itsa.create({ title: 'Old project', kind: 'project', by: 'human' });
    await itsa.set(project.key, { status: 'done', fields: { stage: 'dev' } }, 'human');
    const issue = await itsa.create({ title: 'Old issue', kind: 'issue', by: 'human' });
    await itsa.set(issue.key, { status: 'done', fields: { stage: 'dev' } }, 'human');
    await itsa.updateField('stage', { kinds: ['issue'] }, 'human');
    assert.equal(itsa.backfillClosedStage(() => 'live', ['project', 'issue']), 1);
    const raw = db.open().prepare('SELECT value FROM itsa_field_values WHERE itsa_id = ? AND field_id = ?').get(project.id, stage.id);
    assert.equal(raw.value, '"dev"');
    assert.equal(itsa.get(issue.key).fields.stage, 'live');
  } finally {
    await itsa.removeField(stage.id, 'human');
  }
});
