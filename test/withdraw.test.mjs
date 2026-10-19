#!/usr/bin/env node
// Withdrawing mail from the human (S-413, src/withdraw.ts): the human's copy turns read and carries who
// withdrew it and why, once; the thread is archived here and a later reply brings it back; the human's
// own answer is refused. Throwaway STAM_HOME, no daemon, no peers: `node --test test/withdraw.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome, tempDir } from './tmphome.mjs';

const home = tempHome('stam-withdraw-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `withdraw-test-${process.pid}`;
writeFileSync(join(home, 'settings.json'), JSON.stringify({ cost: { subscriptionWarnPercent: [80, 95], dailyWarnUsd: null, global: null, onError: 'soft-stop', accounts: {} } }));
const db = await import('../src/db.ts');
const { withdrawFromHuman } = await import('../src/withdraw.ts');

const store = (id, thread, extra = {}) => db.createMail({ id, from_id: 'a1', from_name: 'a1', subject: 'Permission: x', body: 'b', thread_id: thread, reply_to: null, ...extra }, ['human']);
const recipient = (id) => db.threadMail(db.mailThreadId(id)).find((m) => m.id === id).recipients.find((r) => r.id === 'human');

test('a withdrawn mail is read, recorded once, and its thread archived', async () => {
  store('m1', 't1', { permission_id: 'p1' });
  store('m2', 't2');
  assert.equal(db.unreadCount('human'), 2);
  assert.deepEqual(await withdrawFromHuman(['m1'], 'boss', 'Answered by @boss: approved'), [{ id: 'm1', thread_id: 't1', ids: ['m1'] }]);
  assert.equal(db.unreadCount('human'), 1);
  const r = recipient('m1');
  assert.ok(r.read_at && r.withdrawn_at);
  assert.equal(r.withdrawn_by, 'boss');
  assert.equal(r.withdrawn_note, 'Answered by @boss: approved');
  assert.equal(recipient('m2').withdrawn_at ?? null, null);
  const { archived, active } = db.splitArchived('human', [{ thread_id: 't1', mails: [{ id: 'm1' }] }, { thread_id: 't2', mails: [{ id: 'm2' }] }]);
  assert.deepEqual([archived.map((t) => t.thread_id), active.map((t) => t.thread_id)], [['t1'], ['t2']]);
  // Again: nothing more to withdraw, and the first note stands.
  assert.deepEqual(await withdrawFromHuman(['m1'], 'other', 'later'), []);
  assert.equal(recipient('m1').withdrawn_by, 'boss');
});

test('a reply brings the thread back', async () => {
  store('m3', 't3');
  await withdrawFromHuman(['m3'], 'boss', 'done');
  store('m4', 't3');
  const { active } = db.splitArchived('human', [{ thread_id: 't3', mails: [{ id: 'm3' }, { id: 'm4' }] }]);
  assert.equal(active.length, 1);
  assert.equal(db.unreadCount('human'), 2, 'm2 and the reply m4 are unread');
});

test('the human\'s own answer is never withdrawn', async () => {
  store('m5', 't5');
  await assert.rejects(withdrawFromHuman(['m5'], 'human', 'x'), /own answer/);
  assert.equal(recipient('m5').withdrawn_at ?? null, null);
});

test('mail the human doesn\'t hold is left alone', async () => {
  db.createMail({ id: 'm6', from_id: 'a1', from_name: 'a1', subject: 's', body: 'b', thread_id: 't6', reply_to: null }, ['a2']);
  assert.deepEqual(await withdrawFromHuman(['m6', 'nope'], 'boss', 'x'), []);
});

test('adding the columns to an older database keeps a copy of it first', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const old = tempDir('stam-withdraw-old-');
  const d = new DatabaseSync(join(old, 'stam.db'));
  d.exec('CREATE TABLE mail_recipients (mail_id TEXT NOT NULL, agent_id TEXT NOT NULL, read_at TEXT, pushed_at TEXT, PRIMARY KEY (mail_id, agent_id)); INSERT INTO mail_recipients (mail_id, agent_id) VALUES (\'mx\', \'human\');');
  d.close();
  writeFileSync(join(old, 'settings.json'), '{}');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', "const db = await import('../src/db.ts'); db.open(); console.log(JSON.stringify(db.open().prepare('PRAGMA table_info(mail_recipients)').all().map((c) => c.name)))"], { cwd: join(import.meta.dirname), env: { ...process.env, STAM_HOME: old }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(JSON.parse(r.stdout.trim().split('\n').at(-1)).includes('withdrawn_note'));
  const copy = new DatabaseSync(join(old, 'stam.db.pre-withdraw'));
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM mail_recipients').get().n, 1);
  assert.ok(!copy.prepare('PRAGMA table_info(mail_recipients)').all().some((c) => c.name === 'withdrawn_at'), 'the copy is the database as it was');
});

test('a database with only some of the columns gets the rest, and an earlier copy stays', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const part = tempDir('stam-withdraw-part-');
  const d = new DatabaseSync(join(part, 'stam.db'));
  d.exec("CREATE TABLE mail_recipients (mail_id TEXT NOT NULL, agent_id TEXT NOT NULL, read_at TEXT, pushed_at TEXT, withdrawn_at TEXT, PRIMARY KEY (mail_id, agent_id))");
  d.close();
  writeFileSync(join(part, 'stam.db.pre-withdraw'), 'an earlier copy');
  writeFileSync(join(part, 'settings.json'), '{}');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', "const db = await import('../src/db.ts'); console.log(JSON.stringify(db.open().prepare('PRAGMA table_info(mail_recipients)').all().map((c) => c.name)))"], { cwd: join(import.meta.dirname), env: { ...process.env, STAM_HOME: part }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const cols = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.ok(['withdrawn_at', 'withdrawn_by', 'withdrawn_note'].every((c) => cols.includes(c)), cols.join());
  assert.equal(cols.filter((c) => c === 'withdrawn_at').length, 1);
  assert.equal((await import('node:fs')).readFileSync(join(part, 'stam.db.pre-withdraw'), 'utf8'), 'an earlier copy');
});

test('a copy that cannot be made stops the migration instead of adding the columns without one', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const bad = tempDir('stam-withdraw-bad-');
  const d = new DatabaseSync(join(bad, 'stam.db'));
  d.exec('CREATE TABLE mail_recipients (mail_id TEXT NOT NULL, agent_id TEXT NOT NULL, read_at TEXT, pushed_at TEXT, PRIMARY KEY (mail_id, agent_id))');
  d.close();
  // The copy's name is a link into a folder that isn't there: no copy exists yet, and making one fails.
  symlinkSync(join(bad, 'missing', 'stam.db'), join(bad, 'stam.db.pre-withdraw'));
  writeFileSync(join(bad, 'settings.json'), '{}');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', "const db = await import('../src/db.ts'); db.open()"], { cwd: join(import.meta.dirname), env: { ...process.env, STAM_HOME: bad }, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /can't keep a copy of stam\.db/);
  const cols = new DatabaseSync(join(bad, 'stam.db')).prepare('PRAGMA table_info(mail_recipients)').all().map((c) => c.name);
  assert.ok(!cols.includes('withdrawn_at'), 'no column was added without a copy');
});

test('a reply stored in the same millisecond as the settlement keeps the thread open', async () => {
  const RealDate = Date;
  const frozen = new RealDate('2026-10-13T12:00:00.000Z').getTime();
  globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [frozen])); } static now() { return frozen; } };
  try {
    store('mf1', 'tf');
    const done = withdrawFromHuman(['mf1'], 'boss', 'done');
    store('mf2', 'tf'); // after the settlement, with the identical timestamp
    await done;
    assert.equal(db.getMail('mf1').created_at, db.getMail('mf2').created_at);
    const { active } = db.splitArchived('human', [{ thread_id: 'tf', mails: [{ id: 'mf1' }, { id: 'mf2' }] }]);
    assert.equal(active.length, 1, 'the reply keeps the thread active');
  } finally {
    globalThis.Date = RealDate;
  }
});
