#!/usr/bin/env node
// Phone notification grouping (S-416): runs web/public/sw.js against a fake service worker
// registration that keeps notifications by tag, as the browser does. Mail notifications stack
// into one summary from three threads on; the close push takes a thread out of it and brings the
// rest back as their own; permission requests never group.
// `node --test test/sw-group.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The browser's notification calls take time, so overlapping pushes interleave.
const tick = () => new Promise((r) => setTimeout(r, 1));

function worker() {
  const live = new Map(); // tag -> notification
  const shown = []; // every showNotification call, in order
  const listeners = {};
  const registration = {
    async showNotification(title, o) {
      await tick();
      shown.push({ title, ...o });
      live.set(o.tag, { tag: o.tag, title, data: o.data, close: () => live.delete(o.tag) });
    },
    async getNotifications(f) { await tick(); return [...live.values()].filter((n) => !f?.tag || n.tag === f.tag); },
  };
  const self = { registration, addEventListener: (t, fn) => (listeners[t] = fn), skipWaiting() {}, clients: { claim() {} }, location: { origin: 'http://x' }, Notification: { maxActions: 2 } };
  vm.runInNewContext(readFileSync(new URL('../web/public/sw.js', import.meta.url), 'utf8'), { self, caches: {}, fetch() {}, URL, Response });
  const push = async (p) => { let done; await listeners.push({ data: { json: () => p }, waitUntil: (x) => (done = x) }); await done; };
  // Pushes that arrive together: all dispatched before any finishes.
  const pushAll = async (ps) => { const dones = []; for (const p of ps) listeners.push({ data: { json: () => p }, waitUntil: (x) => dones.push(x) }); await Promise.all(dones); };
  return { push, pushAll, live, shown, tags: () => [...live.keys()].sort() };
}
const mail = (thread, title = 'kid', body = `subject ${thread}`) => ({ kind: 'mail', title, body, tag: thread, thread, machine: 'm' });

test('two threads show one notification each; the third makes a summary', async () => {
  const w = worker();
  await w.push(mail('t1')); await w.push(mail('t2'));
  assert.deepEqual(w.tags(), ['t1', 't2']);
  await w.push(mail('t3'));
  assert.deepEqual(w.tags(), ['stam-mail-summary']);
  const s = w.live.get('stam-mail-summary');
  assert.equal(s.title, '3 mails waiting');
  assert.equal(s.data.threads.length, 3);
  await w.push(mail('t4'));
  assert.equal(w.live.get('stam-mail-summary').title, '4 mails waiting');
  assert.match(w.shown.at(-1).body, /\+1 more$/);
});

test('a new mail in a known thread replaces it and does not grow the count', async () => {
  const w = worker();
  for (const t of ['t1', 't2', 't3']) await w.push(mail(t));
  await w.push(mail('t2', 'kid', 'newer subject'));
  const s = w.live.get('stam-mail-summary');
  assert.equal(s.title, '3 mails waiting');
  assert.equal(s.data.threads.find((t) => t.thread === 't2').body, 'newer subject');
});

test('a close takes one thread out of the summary, and the rest come back as their own below three', async () => {
  const w = worker();
  for (const t of ['t1', 't2', 't3', 't4']) await w.push(mail(t));
  await w.push({ kind: 'close', tag: 't4', thread: 't4' });
  assert.equal(w.live.get('stam-mail-summary').title, '3 mails waiting');
  await w.push({ kind: 'close', tag: 't1', thread: 't1' });
  assert.deepEqual(w.tags(), ['t2', 't3']);
  assert.ok(w.shown.slice(-2).every((n) => n.silent === true), 'bringing them back makes no sound');
  assert.equal(w.live.get('t2').title, 'kid');
  await w.push({ kind: 'close', tag: 't2', thread: 't2' });
  await w.push({ kind: 'close', tag: 't3', thread: 't3' });
  assert.deepEqual(w.tags(), []);
});

test('a close for a thread with no notification shows nothing', async () => {
  const w = worker();
  await w.push({ kind: 'close', tag: 'nope', thread: 'nope' });
  assert.equal(w.shown.length, 0);
});

test('permission requests never group and stay until answered', async () => {
  const w = worker();
  for (const t of ['t1', 't2', 't3']) await w.push(mail(t));
  await w.push({ kind: 'permission', title: 'kid asks for permission', body: 'Run it', tag: 'tp', thread: 'tp', permission_id: 'p1', perm_kind: 'request', machine: 'm' });
  assert.deepEqual(w.tags(), ['stam-mail-summary', 'tp']);
  assert.equal(w.shown.at(-1).requireInteraction, true);
  assert.equal(w.shown.at(-1).actions.length, 2);
  await w.push({ kind: 'close', tag: 'tp', thread: 'tp' });
  assert.deepEqual(w.tags(), ['stam-mail-summary']);
});

const perm = { kind: 'permission', title: 'kid asks for permission', body: 'Run it', tag: 'tp', thread: 'tp', permission_id: 'p1', perm_kind: 'request', machine: 'm' };

test('a pending permission request survives the mail grouping that comes after it', async () => {
  const w = worker();
  await w.push(perm);
  for (const t of ['t1', 't2', 't3', 't4']) await w.push(mail(t));
  assert.deepEqual(w.tags(), ['stam-mail-summary', 'tp']);
  await w.push({ kind: 'close', tag: 't4', thread: 't4' });
  await w.push({ kind: 'close', tag: 't1', thread: 't1' });
  assert.deepEqual(w.tags(), ['t2', 't3', 'tp'], 'the request is still there when the summary dissolves');
});

test('pushes that arrive together lose no thread', async () => {
  const w = worker();
  await w.pushAll(['t1', 't2', 't3', 't4', 't5'].map((t) => mail(t)));
  assert.deepEqual(w.tags(), ['stam-mail-summary']);
  const s = w.live.get('stam-mail-summary');
  assert.equal(s.title, '5 mails waiting');
  assert.deepEqual(Array.from(s.data.threads, (t) => t.thread).sort(), ['t1', 't2', 't3', 't4', 't5']);
});

test('closes that overlap pushes and each other keep the right threads', async () => {
  const w = worker();
  await w.pushAll(['t1', 't2', 't3', 't4'].map((t) => mail(t)));
  await w.pushAll([mail('t5'), { kind: 'close', tag: 't1', thread: 't1' }, mail('t6'), { kind: 'close', tag: 't2', thread: 't2' }]);
  const s = w.live.get('stam-mail-summary');
  assert.deepEqual(Array.from(s.data.threads, (t) => t.thread).sort(), ['t3', 't4', 't5', 't6']);
  await w.pushAll(['t3', 't4', 't5'].map((t) => ({ kind: 'close', tag: t, thread: t })));
  assert.deepEqual(w.tags(), ['t6']);
});
