#!/usr/bin/env node
// Unit tests for the janitor's leaked test tmux servers (S-175): which socket names a test made,
// and the decision whether a server is a leak. Pure functions, no daemon and no tmux:
// `node --test test/janitor-tmux.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leakedTmux, socketOwner } from '../src/janitor.ts';

test('socketOwner reads the owner and the folder suffix from a test socket name', () => {
  assert.deepEqual(socketOwner('stam-test-abj8k-BJ6ZiO-ui'), { owner: 'abj8k', rand: 'BJ6ZiO' });
  assert.deepEqual(socketOwner('stam-test-user-Ab3dE5-main'), { owner: 'user', rand: 'Ab3dE5' });
  // The name may hold a six-character segment of its own; the owner is the first segment.
  assert.deepEqual(socketOwner('stam-test-abj8k-sNDh3C-ui-abc123-x'), { owner: 'abj8k', rand: 'sNDh3C' });
});

test('socketOwner ignores anything that is not a test socket', () => {
  assert.equal(socketOwner('stam'), undefined);
  assert.equal(socketOwner('stam-test-abj8k'), undefined);
  assert.equal(socketOwner('stam-test-abj8k-BJ6ZiO'), undefined);
});

test('leakedTmux keeps a server while its test shell is alive', () => {
  assert.equal(leakedTmux({ ownerActive: false, ageMs: 10 * 3600_000, shellAlive: true }), false);
});

test('leakedTmux sweeps a server whose owner is no longer active', () => {
  assert.equal(leakedTmux({ ownerActive: false, ageMs: 60_000, shellAlive: false }), true);
});

test('leakedTmux keeps a young server of an active owner', () => {
  assert.equal(leakedTmux({ ownerActive: true, ageMs: 60_000, shellAlive: false }), false);
});

test('leakedTmux sweeps an active owner\'s server once it is older than two hours', () => {
  assert.equal(leakedTmux({ ownerActive: true, ageMs: 2 * 3600_000, shellAlive: false }), false);
  assert.equal(leakedTmux({ ownerActive: true, ageMs: 2 * 3600_000 + 1, shellAlive: false }), true);
});
