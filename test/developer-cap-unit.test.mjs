#!/usr/bin/env node
// The developer slot cap (S-2008): a developer spawn over `developerCap` is refused with the holders
// named; reviewers (which also default to a worktree) and other types are never capped, a paused
// developer holds no slot, and a cap of 0 turns it off. Pure functions, no daemon, no model:
// `node --test test/developer-cap-unit.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { developerCapRefusal, developerHolders, reserveSlot, releaseSlot } = await import('../src/developer-cap.ts');

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
