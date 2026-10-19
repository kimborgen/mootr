#!/usr/bin/env node
// The service worker's close push (S-413 review): it closes the notifications of the mails named,
// and a newer mail in the same thread, which replaced the notification under the same tag, stays.
// Runs web/public/sw.js against a fake registration: `node --test test/sw-close.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function worker() {
  const live = new Map();
  const listeners = {};
  const registration = {
    async showNotification(title, o) { live.set(o.tag, { tag: o.tag, data: o.data, close: () => live.delete(o.tag) }); },
    async getNotifications(f) { return [...live.values()].filter((n) => !f?.tag || n.tag === f.tag); },
  };
  const self = { registration, addEventListener: (t, fn) => (listeners[t] = fn), skipWaiting() {}, clients: { claim() {} }, location: { origin: 'http://x' }, Notification: { maxActions: 2 } };
  vm.runInNewContext(readFileSync(new URL('../web/public/sw.js', import.meta.url), 'utf8'), { self, caches: {}, fetch() {}, URL, Response });
  return { live, push: async (p) => { let done; await listeners.push({ data: { json: () => p }, waitUntil: (x) => (done = x) }); await done; } };
}

test('a close closes the named mail\'s notification', async () => {
  const { push, live } = worker();
  await push({ kind: 'mail', title: 'kid', body: 'asks', tag: 't1', thread: 't1', mail_id: 'm1', machine: 'm' });
  await push({ kind: 'close', tag: 't1', thread: 't1', mail_ids: ['m1'], machine: 'm' });
  assert.equal(live.size, 0);
});

test('a newer mail in the thread, which replaced the notification under the same tag, stays', async () => {
  const { push, live } = worker();
  await push({ kind: 'mail', title: 'kid', body: 'asks', tag: 't1', thread: 't1', mail_id: 'm1', machine: 'm' });
  await push({ kind: 'mail', title: 'kid', body: 'a reply', tag: 't1', thread: 't1', mail_id: 'm2', machine: 'm' });
  await push({ kind: 'close', tag: 't1', thread: 't1', mail_ids: ['m1'], machine: 'm' });
  assert.deepEqual([...live.keys()], ['t1']);
  assert.equal(live.get('t1').data.mail_id, 'm2');
  await push({ kind: 'close', tag: 't1', thread: 't1', mail_ids: ['m2'], machine: 'm' });
  assert.equal(live.size, 0);
});
