#!/usr/bin/env node
// The statusline route asks whether a tmux client is attached on every refresh (S-1025). clientWatch answers from
// the last whole-server list and refreshes it in the background once it is a TTL old, so the route never waits on
// tmux (S-4851). Checked with a fake list and a fake clock: no tmux, no timers.
// Run with `node --test test/tmux-clients.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientWatch } from '../src/tmux-clients.ts';

// A list whose answers the test releases by hand.
function fakeList() {
  const calls = [];
  const list = () => new Promise((resolve, reject) => calls.push({ resolve, reject }));
  return { calls, list };
}
const settle = () => new Promise((r) => setImmediate(r));

test('every session reads as open until the first list answers, and a burst lists once', async () => {
  let t = 0;
  const { calls, list } = fakeList();
  const open = clientWatch(list, 5000, () => t);
  for (let i = 0; i < 20; i++) assert.equal(open('a1'), true);
  assert.equal(open('a2'), true);
  assert.equal(calls.length, 1, 'one list for the burst, whatever the agent');
  calls[0].resolve(new Set(['a1']));
  await settle();
  assert.equal(open('a1'), true);
  assert.equal(open('a2'), false);
  assert.equal(calls.length, 1, 'answered from the list inside the TTL');
});

test('a list a TTL old is refreshed in the background, the old answer kept meanwhile', async () => {
  let t = 0;
  const { calls, list } = fakeList();
  const open = clientWatch(list, 5000, () => t);
  open('a1');
  calls[0].resolve(new Set(['a1']));
  await settle();
  t = 4999;
  assert.equal(open('a1'), true);
  assert.equal(calls.length, 1, 'still fresh just before the TTL');
  t = 5000;
  assert.equal(open('a1'), true, 'the old answer while the refresh runs');
  assert.equal(calls.length, 2);
  open('a1');
  assert.equal(calls.length, 2, 'one refresh in flight at a time');
  calls[1].resolve(new Set());
  await settle();
  assert.equal(open('a1'), false, 'the detach is seen once the refresh answers');
});

test('a failed list reads every session as open, as a tmux timeout does', async () => {
  let t = 0;
  const { calls, list } = fakeList();
  const open = clientWatch(list, 5000, () => t);
  open('a1');
  calls[0].resolve(new Set());
  await settle();
  assert.equal(open('a1'), false);
  t = 5000;
  open('a1');
  calls[1].resolve(null);
  await settle();
  assert.equal(open('a1'), true, 'no answer reads as attached');
  t = 10000;
  open('a1');
  calls[2].reject(new Error('spawn failed'));
  await settle();
  assert.equal(open('a1'), true, 'a thrown list reads as attached too');
});
