#!/usr/bin/env node
// The mailbox lists' shared build (S-4356, src/shared-build.ts, src/db.ts changeMark): a web refresh's three
// concurrent list reads share one build in flight, and none is kept once it settles; any database write, by this
// connection or another, makes the next read start its own build; and each reader keys its own lists. Runs against
// a throwaway STAM_HOME; no daemon, no timers: `node --test test/shared-build.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-shared-build-');
process.env.STAM_HOME = home;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
const db = await import('../src/db.ts');
const { createSharedBuild, createWriteCount, countingWrites, boxThreadsKey } = await import('../src/shared-build.ts');

// A build that settles when the test says so, and counts how often it started.
function builder(values) {
  let calls = 0;
  const pending = [];
  const build = () => {
    calls++;
    return new Promise((resolve, reject) => pending.push({ resolve, reject, value: values[calls - 1] }));
  };
  return {
    build,
    get calls() {
      return calls;
    },
    answer: (i = pending.length - 1) => pending[i].resolve(pending[i].value),
    fail: (i = pending.length - 1) => pending[i].reject(new Error('peer down')),
  };
}

const send = (subject) => {
  const id = db.newMailId();
  db.createMail({ id, from_id: 'a1', from_name: 'a1', subject, body: 'b', thread_id: id, reply_to: null }, ['human']);
};
const key = boxThreadsKey({ kind: 'shared' }, { box: 'human', limit: 60 });

test('changeMark stays put across reads and moves on a write by this connection or another', () => {
  db.open();
  const before = db.changeMark();
  db.threads('human', 60);
  db.archivedCount('human');
  db.deferredCount('human');
  assert.equal(db.changeMark(), before, 'a read is not a write');
  send('one');
  const afterOwn = db.changeMark();
  assert.notEqual(afterOwn, before, 'a write here moves the mark');
  const other = new DatabaseSync(join(home, 'stam.db'));
  other.exec("UPDATE mail SET subject = 'edited' WHERE subject = 'one'");
  other.close();
  assert.notEqual(db.changeMark(), afterOwn, 'a commit by another connection (a hook, the CLI) moves it too');
});

test('a refresh shares one build in flight, and keeps none after it', async () => {
  const shared = createSharedBuild(db.changeMark);
  const b = builder(['first', 'second']);
  const reads = [shared.get(key, b.build), shared.get(key, b.build), shared.get(key, b.build)];
  assert.equal(b.calls, 1, 'active, archived and deferred share one build');
  b.answer();
  assert.deepEqual(await Promise.all(reads), ['first', 'first', 'first']);
  assert.equal(shared.size(), 0, 'nothing is kept');
  const later = shared.get(key, b.build);
  assert.equal(b.calls, 2, 'a read after the build settles builds again, so a mail stored on a peer shows');
  b.answer();
  assert.equal(await later, 'second');
});

test('a read after a write does not join a build from before it', async () => {
  const shared = createSharedBuild(db.changeMark);
  const b = builder(['before the answer', 'after the answer']);
  const inflight = shared.get(key, b.build);
  send('the human answers');
  const next = shared.get(key, b.build);
  assert.equal(b.calls, 2, 'the read after the write starts its own build');
  b.answer(0);
  b.answer(1);
  assert.equal(await inflight, 'before the answer');
  assert.equal(await next, 'after the answer');
  assert.equal(shared.size(), 0, 'the older build settling does not leave the newer one behind');
});

test('a write request that starts after a build splits it, though it writes nothing here', async () => {
  const writes = createWriteCount();
  const shared = createSharedBuild(() => `${db.changeMark()}:${writes.mark()}`);
  const b = builder(['old', 'new']);
  const inflight = shared.get(key, b.build);
  writes.begin();
  const next = shared.get(key, b.build);
  assert.equal(b.calls, 2, 'a write forwarded to a peer writes nothing here, but still starts a new build');
  b.answer(0);
  b.answer(1);
  assert.deepEqual(await Promise.all([inflight, next]), ['old', 'new']);
});

// A request handler that forwards a write to a peer and waits for it, as the permission answer does; the response's
// close (the client disconnecting) changes nothing, since only the handler's completion counts.
function forwardingHandler() {
  let peerDone;
  const peer = new Promise((resolve, reject) => (peerDone = { resolve, reject }));
  const res = new EventEmitter();
  return { res, peerDone, handler: async () => { await peer; } };
}

test('a build that starts while a forwarded write is pending is not joined once the handler completes, though the client left', async () => {
  const writes = createWriteCount();
  const shared = createSharedBuild(() => `${db.changeMark()}:${writes.mark()}`);
  const b = builder(['before the answer', 'after the answer']);
  const f = forwardingHandler();
  const request = countingWrites(writes, f.handler)({ method: 'POST' }, f.res);
  f.res.emit('close');
  const during = shared.get(key, b.build);
  assert.equal(shared.get(key, b.build), during, 'reads while the write is pending share one build');
  f.peerDone.resolve();
  await request;
  const after = shared.get(key, b.build);
  assert.equal(b.calls, 2, 'the read after the handler completes starts its own build, the first still pending');
  b.answer(0);
  b.answer(1);
  assert.deepEqual(await Promise.all([during, after]), ['before the answer', 'after the answer']);
});

test('a write handler that fails still counts its completion, and reads count nothing', async () => {
  const writes = createWriteCount();
  const f = forwardingHandler();
  const request = countingWrites(writes, f.handler)({ method: 'DELETE' }, f.res);
  assert.equal(writes.mark(), '1');
  f.peerDone.reject(new Error('peer down'));
  await assert.rejects(request, /peer down/);
  assert.equal(writes.mark(), '2');
  await countingWrites(writes, async () => {})({ method: 'GET' }, null);
  await countingWrites(writes, async () => {})({ method: 'HEAD' }, null);
  assert.equal(writes.mark(), '2', 'GET and HEAD are not writes');
  const settle = writes.begin();
  settle();
  settle();
  assert.equal(writes.mark(), '4', 'a settle counts once');
});

test('a failed build fails its readers and is not kept', async () => {
  const shared = createSharedBuild(db.changeMark);
  const b = builder([undefined, 'ok']);
  const reads = [shared.get(key, b.build), shared.get(key, b.build)];
  b.fail();
  for (const r of reads) await assert.rejects(r, /peer down/);
  const retry = shared.get(key, b.build);
  assert.equal(b.calls, 2);
  b.answer();
  assert.equal(await retry, 'ok');
});

test('the key holds the whole caller and every argument, so no reader gets another reader’s lists', async () => {
  const args = { box: 'human', limit: 60 };
  const keys = [
    boxThreadsKey({ kind: 'shared' }, args),
    boxThreadsKey({ kind: 'owner' }, args),
    boxThreadsKey({ kind: 'agent', agent: 'a1', scope: 'tree' }, args),
    boxThreadsKey({ kind: 'agent', agent: 'a2', scope: 'tree' }, args),
    boxThreadsKey({ kind: 'agent', agent: 'a1', scope: 'foreign' }, args),
    boxThreadsKey({ kind: 'agent', agent: 'a1', boss: true, scope: 'tree' }, args),
    boxThreadsKey({ kind: 'opencode' }, { ...args, box: 'a3' }),
    boxThreadsKey({ kind: 'shared' }, { ...args, limit: 50 }),
    boxThreadsKey({ kind: 'shared' }, { ...args, withId: 'a1' }),
    boxThreadsKey({ kind: 'shared' }, { ...args, via: { agent: 'a1', boss: false } }),
    boxThreadsKey({ kind: 'shared' }, { ...args, viaDecisions: { agent: 'a1', boss: false } }),
  ];
  assert.equal(new Set(keys).size, keys.length, 'every reader and page has its own key');
  assert.equal(boxThreadsKey({ kind: 'shared' }, args), keys[0], 'the same reader and page share one key');
  const shared = createSharedBuild(db.changeMark);
  const b = builder(['for a1', 'for a2']);
  const a1 = shared.get(keys[2], b.build);
  const a2 = shared.get(keys[3], b.build);
  assert.equal(b.calls, 2, 'two readers at once get two builds');
  b.answer(0);
  b.answer(1);
  assert.deepEqual(await Promise.all([a1, a2]), ['for a1', 'for a2']);
});
