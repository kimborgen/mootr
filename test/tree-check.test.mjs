#!/usr/bin/env node
// Unit tests for the tree-check schedule (src/tree-check.ts, S-915): on, off, an interval change,
// a template edit and a new chief of staff, each leaving exactly one timer. Free; a throwaway
// STAM_HOME, no daemon: `node --test test/tree-check.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-treecheck-');
process.env.STAM_HOME = home;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let db, settings, tc;
before(async () => {
  db = await import('../src/db.ts');
  settings = await import('../src/settings.ts');
  tc = await import('../src/tree-check.ts');
});
after(() => rmSync(home, { recursive: true, force: true }));

const agent = (id, name) => db.createAgent({ id, name, role: 'test', machine: 'x', harness: 'external', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
const timers = () => [...db.listWaitsByAgent().values()].flat().filter((w) => w.kind === 'timer' && JSON.parse(w.data).tag === 'tree-check');
const set = (v) => settings.setSetting('treeCheck', v);

test('on creates one timer on the chief of staff; syncing again keeps it', () => {
  agent('tc1', 'cos1');
  settings.setSetting('chiefOfStaff', 'cos1');
  set({ enabled: true, everyHours: 2 });
  tc.syncTreeCheck();
  const first = timers()[0].id;
  tc.syncTreeCheck();
  const t = timers();
  assert.equal(t.length, 1);
  assert.equal(t[0].id, first, 'a second sync replaced the timer');
  assert.equal(t[0].agent_id, 'tc1');
  assert.equal(JSON.parse(t[0].data).every_minutes, 120);
  assert.match(t[0].detail, /Blocked or errored agents/);
  assert.match(t[0].detail, /Machine pressure/);
});

test('an interval change replaces the timer', () => {
  const before = timers()[0].id;
  set({ enabled: true, everyHours: 6 });
  tc.syncTreeCheck();
  const t = timers();
  assert.equal(t.length, 1);
  assert.notEqual(t[0].id, before);
  assert.equal(JSON.parse(t[0].data).every_minutes, 360);
});

test('an edited template replaces the timer', () => {
  mkdirSync(join(home, 'templates'), { recursive: true });
  writeFileSync(join(home, 'templates', 'tree-check.md'), 'Custom checklist');
  tc.syncTreeCheck();
  const t = timers();
  assert.equal(t.length, 1);
  assert.equal(t[0].detail, 'Custom checklist');
});

test('an empty template keeps the running timer', () => {
  const id = timers()[0].id;
  writeFileSync(join(home, 'templates', 'tree-check.md'), '  ');
  tc.syncTreeCheck();
  assert.deepEqual(timers().map((w) => w.id), [id]);
  writeFileSync(join(home, 'templates', 'tree-check.md'), 'Custom checklist');
});

test('the interval is clamped to 0.25-168 hours; zero and negative go to the minimum, a non-number falls back', () => {
  const hours = (v) => { set({ enabled: true, everyHours: v }); return settings.settings().treeCheck.everyHours; };
  assert.equal(hours(0), 0.25);
  assert.equal(hours(-3), 0.25);
  assert.equal(hours(0.0001), 0.25);
  assert.equal(hours(1e12), 168);
  assert.equal(hours(Number.MAX_VALUE), 168);
  assert.equal(hours('x'), 4);
  tc.syncTreeCheck();
  assert.equal(timers().length, 1);
  assert.equal(JSON.parse(timers()[0].data).every_minutes, 240);
});

test("an agent's wake_me body can't claim the tree-check tag", async () => {
  const waits = await import('../src/waits.ts');
  const w = waits.wake('tc1', { note: 'mine', every_minutes: 5, tag: 'tree-check' });
  assert.equal(JSON.parse(w.data).tag, undefined);
  db.clearWait(w.id);
});

test('a new chief of staff takes the timer over', () => {
  agent('tc2', 'cos2');
  settings.setSetting('chiefOfStaff', 'cos2');
  tc.syncTreeCheck();
  const t = timers();
  assert.equal(t.length, 1);
  assert.equal(t[0].agent_id, 'tc2');
});

test('off clears the timer', () => {
  set({ enabled: false, everyHours: 6 });
  tc.syncTreeCheck();
  assert.equal(timers().length, 0);
});
