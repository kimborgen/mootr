#!/usr/bin/env node
// Unit tests for the measured effort split (S-227, src/activity-stats.ts): the category mapping,
// the review-fix windows from ITSA events (review to active opens, leaving active or a new owner
// closes), and the split of timed items (review_fixes takes the overlap; other.* and NULL are
// unclassified, outside the six). Pure: no database, no daemon. Run with
// `node --test test/measured-effort.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { effortKey, fixWindowsFrom, measuredFromItems, wallShares } = await import('../src/activity-stats.ts');

const T0 = Date.parse('2026-10-12T10:00:00Z');
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const item = (kind, category, startMin, endMin) => ({ kind, category, start: at(startMin), end: at(endMin) });
const categoryOf = new Map([
  ['in_progress', 'active'],
  ['in_review', 'review'],
  ['done', 'closed'],
  ['todo', 'ready'],
]);

test('categories map to the six keys by top level', () => {
  assert.equal(effortKey('tool', 'understand.material'), 'reading');
  assert.equal(effortKey('model', 'plan.design'), 'reading');
  assert.equal(effortKey('tool', 'produce.code'), 'implementing');
  assert.equal(effortKey('tool', 'integrate.merge'), 'implementing');
  assert.equal(effortKey('tool', 'operate.deploy'), 'implementing');
  assert.equal(effortKey('tool', 'diagnose.debug'), 'implementing');
  assert.equal(effortKey('tool', 'verify.test'), 'testing');
  assert.equal(effortKey('tool', 'communicate.mail'), 'coordination');
  assert.equal(effortKey('tool', 'track.itsa'), 'coordination');
  assert.equal(effortKey('tool', 'delegate.spawn'), 'coordination');
  assert.equal(effortKey('tool', 'self.note'), 'coordination');
  assert.equal(effortKey('tool', 'wait.poll'), 'waiting');
});

test('gap items are waiting whatever their category, and other.* or NULL is unclassified', () => {
  assert.equal(effortKey('gap', null), 'waiting');
  assert.equal(effortKey('gap', 'produce.code'), 'waiting');
  assert.equal(effortKey('tool', 'other.unclear'), null);
  assert.equal(effortKey('tool', 'other.error'), null);
  assert.equal(effortKey('tool', null), null);
  assert.equal(effortKey('model', 'mystery.x'), null);
});

test('windows open on a review-to-active move and close on the next move out of active', () => {
  const events = [
    { itsa_id: 'I1', ts: at(30), type: 'status', data: JSON.stringify({ from: 'in_progress', to: 'in_review' }) },
    { itsa_id: 'I1', ts: at(40), type: 'status', data: JSON.stringify({ from: 'in_review', to: 'in_progress' }) },
    { itsa_id: 'I1', ts: at(50), type: 'status', data: JSON.stringify({ from: 'in_progress', to: 'in_review' }) },
    { itsa_id: 'I1', ts: at(55), type: 'status', data: JSON.stringify({ from: 'in_review', to: 'done' }) },
  ];
  const w = fixWindowsFrom(events, new Map([['I1', 'W']]), categoryOf);
  // Back to active at +40 opens the window; the next move out of active, to review at +50, closes it.
  assert.deepEqual(w.get('W'), [[T0 + 40 * 60_000, T0 + 50 * 60_000]]);
  const again = [
    ...events.slice(0, 2),
    { itsa_id: 'I1', ts: at(45), type: 'status', data: JSON.stringify({ from: 'in_progress', to: 'todo' }) },
  ];
  const w2 = fixWindowsFrom(again, new Map([['I1', 'W']]), categoryOf);
  assert.deepEqual(w2.get('W'), [[T0 + 40 * 60_000, T0 + 45 * 60_000]]);
});

test('an owner change hands an open window to the new owner, and the old one keeps its share up to then', () => {
  const events = [
    { itsa_id: 'I2', ts: at(10), type: 'owner', data: JSON.stringify({ from: 'A', to: 'B' }) },
    { itsa_id: 'I2', ts: at(20), type: 'status', data: JSON.stringify({ from: 'in_review', to: 'in_progress' }) },
    { itsa_id: 'I2', ts: at(30), type: 'owner', data: JSON.stringify({ from: 'B', to: 'C' }) },
  ];
  const w = fixWindowsFrom(events, new Map([['I2', 'C']]), categoryOf);
  // Owned by A before the first change, so no window there; B from 20 to 30; C from 30 on, still open.
  assert.deepEqual(w.get('B'), [[T0 + 20 * 60_000, T0 + 30 * 60_000]]);
  assert.deepEqual(w.get('C'), [[T0 + 30 * 60_000, Infinity]]);
  assert.equal(w.get('A'), undefined);
});

test('without owner events the current owner counts, and overlapping windows merge', () => {
  const events = [
    { itsa_id: 'I3', ts: at(0), type: 'status', data: JSON.stringify({ from: 'in_review', to: 'in_progress' }) },
    { itsa_id: 'I4', ts: at(5), type: 'status', data: JSON.stringify({ from: 'in_review', to: 'in_progress' }) },
    { itsa_id: 'I3', ts: at(10), type: 'status', data: JSON.stringify({ from: 'in_progress', to: 'done' }) },
  ];
  const w = fixWindowsFrom(events, new Map([['I3', 'W'], ['I4', 'W']]), categoryOf);
  assert.deepEqual(w.get('W'), [[T0, Infinity]]);
});

test('the split: review_fixes takes the overlap of non-gap items, the rest goes to its key', () => {
  // A 60 min tool item and a 60 min gap, concurrent. Minutes 0-30 are shared evenly (tool implementing,
  // gap waiting); minutes 30-60 are in a fix window, so the tool's half is review_fixes.
  const windows = [[T0 + 30 * 60_000, T0 + 60 * 60_000]];
  const items = [item('tool', 'produce.code', 0, 60), item('gap', null, 0, 60)];
  const m = measuredFromItems(items, windows);
  assert.equal(m.seconds.review_fixes, 900);
  assert.equal(m.seconds.implementing, 900);
  assert.equal(m.seconds.waiting, 1800);
  assert.equal(m.split.review_fixes, 25);
  assert.equal(m.split.implementing, 25);
  assert.equal(m.split.waiting, 50);
  assert.equal(m.unclassified, 0);
});

test('two concurrent produce tools and a testing tool: each wall stretch counts once', () => {
  // 0-60 two produce tools share the stretch (30 min each, 60 min implementing in all); 60-120 testing.
  const items = [item('tool', 'produce.code', 0, 60), item('tool', 'produce.write', 0, 60), item('tool', 'verify.test', 60, 120)];
  const m = measuredFromItems(items, []);
  assert.equal(m.seconds.implementing, 3600);
  assert.equal(m.seconds.testing, 3600);
  assert.equal(m.split.implementing, 50);
  assert.equal(m.split.testing, 50);
});

test('S-212 working and waiting never exceed the wall time: concurrent spans split it', () => {
  // Two working spans over 0-60 and one over 60-120: 120 min of wall time, shares sum to it.
  const spans = [[T0, T0 + 60 * 60_000], [T0, T0 + 60 * 60_000], [T0 + 60 * 60_000, T0 + 120 * 60_000]];
  const shares = wallShares(spans);
  assert.deepEqual(shares.map((x) => Math.round(x)), [1800, 1800, 3600]);
  assert.equal(Math.round(shares.reduce((n, x) => n + x, 0)), 7200);
});

test('unclassified time sits outside the six, which still sum to 100 of classified time', () => {
  const items = [item('tool', 'verify.test', 0, 30), item('tool', 'other.unclear', 30, 90), item('tool', null, 90, 100)];
  const m = measuredFromItems(items, []);
  // 30 min of testing is all the classified time; 60 min of other.* and 10 min of NULL are unclassified.
  assert.equal(m.split.testing, 100);
  assert.equal(m.seconds.unclassified, 4200);
  // 4200 of 6000 seconds of all time are unclassified.
  assert.equal(m.unclassified, 70);
});

test('a bad or null event data row is read as empty, not thrown', () => {
  const events = [
    { itsa_id: 'I5', ts: at(0), type: 'status', data: 'not json' },
    { itsa_id: 'I5', ts: at(5), type: 'status', data: 'null' },
    { itsa_id: 'I5', ts: at(10), type: 'status', data: JSON.stringify({ from: 'in_review', to: 'in_progress' }) },
  ];
  const w = fixWindowsFrom(events, new Map([['I5', 'W']]), categoryOf);
  assert.deepEqual(w.get('W'), [[T0 + 10 * 60_000, Infinity]]);
});

test('a window clips items to the request and no time gives null', () => {
  const items = [item('tool', 'understand.material', 0, 60)];
  const m = measuredFromItems(items, [], T0 + 30 * 60_000, Infinity);
  assert.equal(m.seconds.reading, 1800);
  assert.equal(measuredFromItems([], []), null);
  assert.equal(measuredFromItems([item('tool', 'verify.test', 0, 10)], [], T0 + 60 * 60_000), null);
});
