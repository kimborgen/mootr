#!/usr/bin/env node
// Unit tests for src/events.ts (the daemon's SSE stream, S-456), with no daemon and no
// network: emitEvent writes one `event`/`data` pair to every client, addEventStream sends a
// connected comment, agentChanged queues nothing (and arms no timer) with no client, coalesces
// a burst into one flush, and a client that stopped reading is dropped.
// Run with `node --test test/events.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEventStream, agentChanged, emitEvent, pendingCount, streamCount } from '../src/events.ts';

// A stand-in for ServerResponse: it records writes and lets a test model a slow client —
// `full` makes each write return false (the highWaterMark) and `overflow` makes it add that
// many bytes to the buffer (a client that never drains). destroy() emits close, as a real one
// does, so the stream leaves the set.
function fake() {
  const handlers = {};
  return {
    writableLength: 0,
    full: false,
    overflow: 0,
    destroyed: false,
    chunks: [],
    status: 0,
    headers: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    on(event, fn) {
      (handlers[event] ??= []).push(fn);
    },
    emit(event) {
      for (const fn of handlers[event] ?? []) fn();
    },
    write(data) {
      if (this.full) return false;
      this.chunks.push(data);
      if (this.overflow) this.writableLength += this.overflow;
      return true;
    },
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('close');
    },
  };
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('with no client, agentChanged queues nothing and arms no timer', () => {
  assert.equal(streamCount(), 0);
  agentChanged('a', { activity: 'working' });
  assert.equal(pendingCount(), 0);
  // emitEvent to nobody is a no-op too.
  emitEvent('agent.spawned', { id: 'a' });
});

test('a client gets the connected comment, then one event per emitEvent', () => {
  const f = fake();
  addEventStream(f);
  assert.equal(streamCount(), 1);
  assert.deepEqual(f.headers['content-type'], 'text/event-stream');
  assert.equal(f.chunks[0], ': connected\n\n');
  emitEvent('mail.sent', { id: 'm1', to: ['human'] });
  assert.equal(f.chunks.at(-1), 'event: mail.sent\ndata: {"id":"m1","to":["human"]}\n\n');
  f.destroy();
  assert.equal(streamCount(), 0);
});

test('agentChanged coalesces a burst into one agent.changed on the flush', async () => {
  const f = fake();
  addEventStream(f);
  const before = f.chunks.length;
  agentChanged('a', { activity: 'starting' });
  agentChanged('a', { activity: 'working' });
  agentChanged('b', { activity: 'idle' });
  assert.equal(pendingCount(), 2, 'one pending entry per agent, the latest kept');
  await tick(400);
  assert.equal(pendingCount(), 0);
  const emitted = f.chunks.slice(before).filter((c) => c.startsWith('event: agent.changed'));
  assert.equal(emitted.length, 2, 'two agents, one flush');
  assert.ok(emitted.some((c) => c.includes('"id":"a"') && c.includes('"activity":"working"')), 'the latest state wins');
  assert.ok(emitted.some((c) => c.includes('"id":"b"')));
  f.destroy();
});

test('write returning false alone keeps the client (a burst briefly crosses the highWaterMark)', () => {
  const f = fake();
  addEventStream(f);
  f.full = true;
  emitEvent('usage.changed', {});
  assert.equal(f.destroyed, false);
  assert.equal(streamCount(), 1);
  f.destroy();
  assert.equal(streamCount(), 0);
});

test('a write that pushes the buffer over the cap drops the client', () => {
  const f = fake();
  addEventStream(f);
  f.overflow = (1 << 20) + 1;
  emitEvent('usage.changed', {});
  assert.equal(f.destroyed, true);
  assert.equal(streamCount(), 0, 'the close handler removed it');
});

test('a buffer already over the cap is dropped before it is written to', () => {
  const f = fake();
  addEventStream(f);
  const before = f.chunks.length;
  f.writableLength = (1 << 20) + 1;
  emitEvent('usage.changed', {});
  assert.equal(f.destroyed, true);
  assert.equal(f.chunks.length, before, 'nothing was written to a dropped client');
  assert.equal(streamCount(), 0);
});

test('an error after close never reaches the daemon', () => {
  const f = fake();
  addEventStream(f);
  f.destroy();
  assert.doesNotThrow(() => f.emit('error'));
});
