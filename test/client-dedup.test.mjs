#!/usr/bin/env node
// A retried send tagged with a client_id (src/client-dedup.ts) runs once. No daemon.
// `node --test test/client-dedup.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { dedupByClientId, forgetClientIds } = await import('../src/client-dedup.ts');

test('a repeat with the same id gets the first answer and does not run again', async () => {
  forgetClientIds();
  let runs = 0;
  const run = async () => ({ n: ++runs });
  const a = await dedupByClientId('/api/mail', 'c1', run);
  const b = await dedupByClientId('/api/mail', 'c1', run);
  assert.equal(runs, 1);
  assert.deepEqual(b, a);
});

test('a repeat while the first is still running waits for it', async () => {
  forgetClientIds();
  let runs = 0, release;
  const gate = new Promise((r) => (release = r));
  const run = async () => { runs++; await gate; return 'ok'; };
  const p1 = dedupByClientId('/p', 'c2', run);
  const p2 = dedupByClientId('/p', 'c2', run);
  release();
  assert.deepEqual(await Promise.all([p1, p2]), ['ok', 'ok']);
  assert.equal(runs, 1);
});

test('a failed first request is forgotten, so the retry runs', async () => {
  forgetClientIds();
  let runs = 0;
  await assert.rejects(dedupByClientId('/p', 'c3', async () => { runs++; throw new Error('no'); }));
  await new Promise((r) => setImmediate(r));
  assert.equal(await dedupByClientId('/p', 'c3', async () => { runs++; return 'ok'; }), 'ok');
  assert.equal(runs, 2);
});

test('different paths, different ids, no id, and expired ids all run', async () => {
  forgetClientIds();
  let runs = 0;
  const run = async () => ++runs;
  await dedupByClientId('/a', 'x', run);
  await dedupByClientId('/b', 'x', run);
  await dedupByClientId('/a', 'y', run);
  await dedupByClientId('/a', undefined, run);
  await dedupByClientId('/a', undefined, run);
  assert.equal(runs, 5);
  await dedupByClientId('/a', 'x', run, { now: Date.now() + 6 * 60_000 });
  assert.equal(runs, 6);
});

test('a result the route wrote itself is not handed to a repeat: the repeat runs', async () => {
  forgetClientIds();
  const HANDLED = Symbol('handled');
  let runs = 0;
  const run = async () => { runs++; return HANDLED; };
  const keep = (r) => r !== HANDLED;
  await dedupByClientId('/stream', 'h1', run, { keep });
  await dedupByClientId('/stream', 'h1', run, { keep });
  assert.equal(runs, 2);
  // Also while the first is still running.
  let release;
  const gate = new Promise((r) => (release = r));
  const slow = async () => { runs++; await gate; return HANDLED; };
  const a = dedupByClientId('/stream', 'h2', slow, { keep });
  const b = dedupByClientId('/stream', 'h2', slow, { keep });
  release();
  await Promise.all([a, b]);
  assert.equal(runs, 4);
});

test('a route that returns nothing is still deduplicated', async () => {
  forgetClientIds();
  let runs = 0;
  const run = async () => { runs++; };
  await dedupByClientId('/p', 'u1', run);
  await dedupByClientId('/p', 'u1', run);
  assert.equal(runs, 1);
});

test('the scope (caller and path) is part of the key', async () => {
  forgetClientIds();
  let runs = 0;
  const run = async () => ++runs;
  await dedupByClientId('shared:|/api/mail', 'k', run);
  await dedupByClientId('agent:a1|/api/mail', 'k', run);
  assert.equal(runs, 2);
});
