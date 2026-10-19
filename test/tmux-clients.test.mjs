#!/usr/bin/env node
// The statusline route asks whether a tmux client is attached on every refresh (S-1025), and each ask
// spawns tmux synchronously. clientCache answers from a short-lived cache per agent, so a burst of
// refreshes spawns once. Checked with a fake check and a fake clock: no tmux, no timers.
// Run with `node --test test/tmux-clients.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientCache } from '../src/tmux-clients.ts';

test('a burst of asks within the TTL checks once per agent', () => {
  let t = 0;
  const calls = [];
  const open = clientCache((id) => (calls.push(id), id === 'a1'), 5000, () => t);
  for (let i = 0; i < 20; i++) assert.equal(open('a1'), true);
  for (let i = 0; i < 20; i++) assert.equal(open('a2'), false);
  assert.deepEqual(calls, ['a1', 'a2']);
});

test('an answer is asked again once the TTL passes', () => {
  let t = 0;
  let attached = true;
  const open = clientCache(() => attached, 5000, () => t);
  assert.equal(open('a1'), true);
  attached = false;
  t = 4999;
  assert.equal(open('a1'), true, 'still cached just before the TTL');
  t = 5000;
  assert.equal(open('a1'), false, 'asked again at the TTL');
});
