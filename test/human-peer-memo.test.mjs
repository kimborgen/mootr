#!/usr/bin/env node
// The human's peer fan-out memo (S-4356, src/human-peer-memo.ts): concurrent loads share one fan-out, an answer
// is kept for the TTL per reader, and a write (invalidate) shows at the next read, even when a load was in flight.
// No daemon and no timers: the clock is passed in and every load is a deferred promise.
// Run: `node --test test/human-peer-memo.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHumanPeerMemo } from '../src/human-peer-memo.ts';

// A load that resolves when the test says so, and counts how often it started.
function loader(values) {
  let calls = 0;
  const pending = [];
  const load = () => {
    calls++;
    return new Promise((resolve, reject) => pending.push({ resolve, reject, value: values[calls - 1] }));
  };
  return {
    load,
    get calls() {
      return calls;
    },
    answer: (i = pending.length - 1) => pending[i].resolve(pending[i].value),
    fail: (i = pending.length - 1) => pending[i].reject(new Error('peer down')),
  };
}

test('concurrent loads for one reader share one fan-out', async () => {
  const memo = createHumanPeerMemo(5_000);
  const l = loader(['a']);
  const a = memo.get('human', l.load, 0);
  const b = memo.get('human', l.load, 0);
  assert.equal(l.calls, 1);
  l.answer();
  assert.deepEqual(await Promise.all([a, b]), ['a', 'a']);
});

test('an answer is kept for the TTL, then reloaded', async () => {
  const memo = createHumanPeerMemo(5_000);
  const l = loader(['first', 'second']);
  const first = memo.get('human', l.load, 0);
  l.answer();
  assert.equal(await first, 'first');
  assert.equal(await memo.get('human', l.load, 4_999), 'first');
  assert.equal(l.calls, 1);
  const again = memo.get('human', l.load, 5_000);
  assert.equal(l.calls, 2);
  l.answer();
  assert.equal(await again, 'second');
});

test('readers keep their own answers', async () => {
  const memo = createHumanPeerMemo(5_000);
  const l = loader(['for-a', 'for-b']);
  const a = memo.get('via-a', l.load, 0);
  const b = memo.get('via-b', l.load, 0);
  assert.equal(l.calls, 2);
  l.answer(0);
  l.answer(1);
  assert.deepEqual(await Promise.all([a, b]), ['for-a', 'for-b']);
});

test('a write shows at the next read, even over a memo that is fresh', async () => {
  const memo = createHumanPeerMemo(5_000);
  const l = loader(['ask open', 'ask answered']);
  const before = memo.get('human', l.load, 0);
  l.answer();
  assert.equal(await before, 'ask open');
  memo.invalidate();
  const after = memo.get('human', l.load, 1);
  assert.equal(l.calls, 2);
  l.answer();
  assert.equal(await after, 'ask answered');
});

test('a load in flight across a write does not store its older answer', async () => {
  const memo = createHumanPeerMemo(5_000);
  const l = loader(['stale', 'fresh']);
  const inflight = memo.get('human', l.load, 0);
  memo.invalidate();
  const next = memo.get('human', l.load, 1);
  assert.equal(l.calls, 2, 'the read after the write starts its own load, not the old one');
  l.answer(0);
  assert.equal(await inflight, 'stale');
  l.answer(1);
  assert.equal(await next, 'fresh');
  assert.equal(await memo.get('human', l.load, 2), 'fresh');
  assert.equal(l.calls, 2, 'the fresh answer is what is kept');
});

test('a failed load is not kept', async () => {
  const memo = createHumanPeerMemo(5_000);
  const l = loader([undefined, 'ok']);
  const failed = memo.get('human', l.load, 0);
  l.fail();
  await assert.rejects(failed, /peer down/);
  const retry = memo.get('human', l.load, 1);
  assert.equal(l.calls, 2);
  l.answer();
  assert.equal(await retry, 'ok');
});

test('a partial answer is handed out but not kept', async () => {
  const memo = createHumanPeerMemo(5_000, (v) => !v.unreachable);
  const l = loader([{ rows: [], unreachable: true }, { rows: ['full'], unreachable: false }]);
  const partial = memo.get('human', l.load, 0);
  l.answer();
  assert.deepEqual(await partial, { rows: [], unreachable: true });
  assert.equal(memo.size(), 0);
  const full = memo.get('human', l.load, 1);
  assert.equal(l.calls, 2);
  l.answer();
  assert.deepEqual(await full, { rows: ['full'], unreachable: false });
  assert.deepEqual(await memo.get('human', l.load, 2), { rows: ['full'], unreachable: false });
  assert.equal(l.calls, 2, 'the full answer is what is kept');
});
