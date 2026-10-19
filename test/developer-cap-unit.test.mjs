#!/usr/bin/env node
// The developer slot cap (S-2008): a developer spawn over `developerCap` is refused with the holders
// named; reviewers (which also default to a worktree) and other types are never capped, a paused
// developer holds no slot, and a cap of 0 turns it off. Pure functions, no daemon, no model:
// `node --test test/developer-cap-unit.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { developerCapRefusal, developerHolders, reserveSlot, releaseSlot, enqueueWaiter, grantSlots, queuedWaiters, queuePlace, dropWaiter, restoreQueue, saveQueueFile, loadQueueFile, QUEUE_MAX_WAIT_MS } = await import('../src/developer-cap.ts');

const types = {
  developer: { worktree: true },
  reviewer: { worktree: true, review: { ring: false } },
  manager: {},
};
const wt = JSON.stringify({ worktree: { branch: 'b' } });
const dev = (name, lifecycle = 'active', machine = 'm1') => ({ name, type: 'developer', workspace: wt, lifecycle, machine });
const full = [dev('a'), dev('b'), dev('c')];

test('a developer is refused at the cap, and the refusal names the holders', () => {
  const r = developerCapRefusal(full, types, types.developer, true, 3, 'm1');
  assert.match(r, /3 of 3/);
  for (const n of ['a', 'b', 'c']) assert.match(r, new RegExp(`\\b${n}\\b`));
  assert.match(r, /wait_for/);
  assert.equal(developerCapRefusal(full, types, types.developer, true, 4, 'm1'), null);
});

test('a reviewer or a manager spawns at the cap', () => {
  assert.equal(developerCapRefusal(full, types, types.reviewer, true, 3, 'm1'), null);
  assert.equal(developerCapRefusal(full, types, types.manager, false, 3, 'm1'), null);
  assert.equal(developerCapRefusal(full, types, undefined, false, 3, 'm1'), null);
});

test('reviewers do not hold developer slots', () => {
  const agents = [...full, { name: 'r', type: 'reviewer', workspace: wt, lifecycle: 'active', machine: 'm1' }];
  assert.deepEqual(developerHolders(agents, types, 'm1'), ['a', 'b', 'c']);
});

test('paused, shut down, archived and other-machine developers do not count', () => {
  const agents = [dev('a'), dev('b', 'paused'), dev('c', 'shut_down'), dev('d', 'archived'), dev('e', 'active', 'm2')];
  assert.deepEqual(developerHolders(agents, types, 'm1'), ['a']);
  assert.equal(developerCapRefusal(agents, types, types.developer, true, 2, 'm1'), null);
});

test('developerCap 0 disables the cap', () => {
  assert.equal(developerCapRefusal(full, types, types.developer, true, 0, 'm1'), null);
});

test('a spawn in flight holds a slot until released', () => {
  const two = [dev('a'), dev('b')];
  assert.equal(developerCapRefusal(two, types, types.developer, true, 3, 'm1'), null);
  reserveSlot('c');
  const r = developerCapRefusal(two, types, types.developer, true, 3, 'm1');
  assert.match(r, /c \(starting\)/);
  releaseSlot('c');
  assert.equal(developerCapRefusal(two, types, types.developer, true, 3, 'm1'), null);
});

test('a reserved name that is already a holder counts once', () => {
  reserveSlot('a');
  assert.equal(developerCapRefusal([dev('a'), dev('b')], types, types.developer, true, 3, 'm1'), null);
  releaseSlot('a');
});

test('an untyped worktree spawn is capped and counted; an untyped plain directory is not', () => {
  const untyped = { name: 'u', type: null, workspace: wt, lifecycle: 'active', machine: 'm1' };
  assert.deepEqual(developerHolders([untyped, { ...untyped, name: 'p', workspace: JSON.stringify({}) }], types, 'm1'), ['u']);
  assert.match(developerCapRefusal([untyped], types, undefined, true, 1, 'm1'), /1 of 1/);
  assert.equal(developerCapRefusal([untyped], types, undefined, false, 1, 'm1'), null);
});

// The slot queue (S-2053).
const waiter = (name, extra = {}) => ({ name, body: {}, at: Date.now(), ...extra });
const alive = () => true;
const clear = () => queuedWaiters().map((w) => w.name).forEach(dropWaiter);

test('urgent waiters queue ahead of normal ones, first come first served within each class', () => {
  clear();
  assert.equal(enqueueWaiter(waiter('n1')), 1);
  assert.equal(enqueueWaiter(waiter('n2')), 2);
  assert.equal(enqueueWaiter(waiter('u1', { urgent: 'red-main' })), 1);
  assert.equal(enqueueWaiter(waiter('u2', { urgent: 'approved-pr' })), 2);
  assert.deepEqual(queuedWaiters().map((w) => w.name), ['u1', 'u2', 'n1', 'n2']);
  assert.equal(queuePlace('n2'), 4);
  clear();
});

test('two waiters and one free slot: the head gets the slot, reserved, and a newer spawn sees it full', () => {
  clear();
  enqueueWaiter(waiter('w1'));
  enqueueWaiter(waiter('w2'));
  const two = [dev('a'), dev('b')];
  const { granted } = grantSlots(two, types, 3, 'm1', alive);
  assert.deepEqual(granted.map((w) => w.name), ['w1']);
  // Between the grant and the agent row, the slot is held: a spawn arriving now is refused, w2 stays queued.
  assert.match(developerCapRefusal(two, types, types.developer, true, 3, 'm1'), /w1 \(starting\)/);
  assert.deepEqual(grantSlots(two, types, 3, 'm1', alive).granted, []);
  assert.deepEqual(queuedWaiters().map((w) => w.name), ['w2']);
  // The agent row exists: w1 holds through the row, and w2 waits for the next free slot.
  releaseSlot('w1');
  const three = [...two, dev('w1')];
  assert.deepEqual(grantSlots(three, types, 3, 'm1', alive).granted, []);
  assert.deepEqual(grantSlots([dev('a'), dev('w1')], types, 3, 'm1', alive).granted.map((w) => w.name), ['w2']);
  releaseSlot('w2');
  clear();
});

test('a dead waiter is dropped and does not hold the queue; so is one past the wait limit', () => {
  clear();
  enqueueWaiter(waiter('dead', { by: 'gone' }));
  enqueueWaiter(waiter('old', { at: 0 }));
  enqueueWaiter(waiter('live', { by: 'ok', at: QUEUE_MAX_WAIT_MS }));
  const { granted, dropped } = grantSlots([dev('a')], types, 2, 'm1', (w) => w.by !== 'gone', QUEUE_MAX_WAIT_MS + 1);
  assert.deepEqual(dropped.map((w) => w.name), ['dead', 'old']);
  assert.deepEqual(granted.map((w) => w.name), ['live']);
  assert.equal(queuedWaiters().length, 0);
  releaseSlot('live');
});

test('a restored queue goes ahead of new waiters, keeps its order, and skips names already queued', () => {
  clear();
  enqueueWaiter(waiter('new'));
  restoreQueue([waiter('r1'), waiter('r2'), waiter('new')]);
  assert.deepEqual(queuedWaiters().map((w) => w.name), ['r1', 'r2', 'new']);
  clear();
});

test('the saved queue is written whole by rename; a failed save throws and leaves the old file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slotq-'));
  const file = join(dir, 'q.json');
  saveQueueFile(file, [waiter('a')]);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).map((w) => w.name), ['a']);
  assert.deepEqual(readdirSync(dir), ['q.json']);
  assert.throws(() => saveQueueFile(join(dir, 'missing', 'q.json'), [waiter('b')]));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).map((w) => w.name), ['a']);
});

test('loading: no file is an empty queue, a corrupt file throws, a launched waiter is not queued again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slotq-'));
  const file = join(dir, 'q.json');
  assert.deepEqual(loadQueueFile(file, () => false), { waiting: [], started: [] });
  writeFileSync(file, '[{"name":"a"');
  assert.throws(() => loadQueueFile(file, () => false));
  saveQueueFile(file, [waiter('launched'), waiter('waiting')]);
  const r = loadQueueFile(file, (n) => n === 'launched');
  assert.deepEqual(r.waiting.map((w) => w.name), ['waiting']);
  assert.deepEqual(r.started.map((w) => w.name), ['launched']);
});
