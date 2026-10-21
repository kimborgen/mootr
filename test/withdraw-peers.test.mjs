#!/usr/bin/env node
// Withdrawing across machines, against stub peers and a stub push service (S-413 review):
//  - a reply that arrives while a peer is being asked keeps its thread open and its notification:
//    archive records the mail the holder had at settlement by id, never by timestamp, and the close
//    names only the mails withdrawn;
//  - when the mail sits on peer b and the withdrawal starts here, this daemon's devices get the
//    close too, peer c is told with b named as the holder, and b isn't told (it closed its own);
//  - a relayed close is confirmed with the holder before it closes anything, and isn't relayed on;
//  - a relayed mail is pushed only when it is recent mail to the human from someone else.
// Throwaway STAM_HOME, no daemon: `node --test test/withdraw-peers.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createECDH, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const listen = (handler) => new Promise((r) => { const s = createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); });
const url = (s) => `http://127.0.0.1:${s.address().port}`;
const raw = (req) => new Promise((r) => { const c = []; req.on('data', (x) => c.push(x)).on('end', () => r(Buffer.concat(c))); });
const body = async (req) => (await raw(req)).toString();

// The browser side of the push service: records each push and decrypts it with this key pair.
const ecdh = createECDH('prime256v1'); const p256dh = ecdh.generateKeys().toString('base64url'); const auth = randomBytes(16).toString('base64url');
const pushes = [];
const push = await listen(async (req, res) => {
  const buf = await raw(req);
  const salt = buf.subarray(0, 16), idlen = buf[20], asPublic = buf.subarray(21, 21 + idlen), ct = buf.subarray(21 + idlen);
  const ikm = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(asPublic), Buffer.from(auth, 'base64url'), Buffer.concat([Buffer.from('WebPush: info\0'), Buffer.from(p256dh, 'base64url'), asPublic]), 32));
  const d = createDecipheriv('aes-128-gcm', Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)), Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)));
  d.setAuthTag(ct.subarray(ct.length - 16));
  pushes.push(JSON.parse(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).subarray(0, -1).toString()));
  res.writeHead(201).end();
});

// The peers: b holds mail `mx` in thread tx and says so; c only listens. Each records what it was sent.
const calls = { b: [], c: [] };
let holdWithdraw = null; // a promise the next POST /api/mail/withdraw on b waits for
// tx also holds `my`, a reply on b's clock, which runs a second behind: its timestamp predates every settlement here.
const bThreads = { t1: [{ id: 'm1', created_at: '2000-01-01T00:00:00.000Z', recipients: [] }], tx: [{ id: 'mx', created_at: '2000-01-01T00:00:00.000Z', recipients: [{ id: 'human', read_at: 'x', withdrawn_at: 'x' }] }, { id: 'my', created_at: '2000-01-01T00:00:01.000Z', recipients: [{ id: 'human', read_at: null }] }] };
const b = await listen(async (req, res) => {
  const text = await body(req);
  calls.b.push(`${req.method} ${req.url} ${text}`);
  const send = (d) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(d));
  if (req.url === '/api/mail/withdraw') {
    if (holdWithdraw) await holdWithdraw;
    return send({ withdrawn: JSON.parse(text).ids.includes('mx') ? [{ id: 'mx', thread_id: 'tx', ids: ['mx'] }] : [] });
  }
  const m = req.url.match(/^\/api\/threads\/(\w+)/);
  if (m && req.method === 'GET') return send(bThreads[m[1]] ?? []);
  send({});
});
const c = await listen(async (req, res) => {
  calls.c.push(`${req.method} ${req.url} ${await body(req)}`);
  res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
});

const home = tempHome('stam-withdraw-peers-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `withdraw-peers-test-${process.pid}`;
writeFileSync(join(home, 'settings.json'), JSON.stringify({ cost: { subscriptionWarnPercent: [80, 95], dailyWarnUsd: null, global: null, onError: 'soft-stop', accounts: {} }, peers: [{ name: 'b', url: url(b), token: 'tb' }, { name: 'c', url: url(c), token: 'tc' }] }));
const db = await import('../src/db.ts');
const { withdrawFromHuman } = await import('../src/withdraw.ts');
const webpush = await import('../src/webpush.ts');
db.savePushDevice({ endpoint: url(push) + '/sub', p256dh, auth, label: 'phone', origin: null, kinds: ['mail', 'permission'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (n) => { for (let i = 0; i < 60 && pushes.length < n; i++) await sleep(50); await sleep(100); };
const store = (id, thread) => db.createMail({ id, from_id: 'a1', from_name: 'a1', subject: 's', body: 'b', thread_id: thread, reply_to: null }, ['human']);

test('a reply that arrives here while the peers are asked keeps its thread open and its notification', async () => {
  store('m1', 't1');
  let release; holdWithdraw = new Promise((r) => (release = r));
  // m9 isn't held here, so the call waits on b (the held request) before it finishes.
  const done = withdrawFromHuman(['m1', 'm9'], 'boss', 'Answered by @boss: approved');
  store('m2', 't1'); // the reply, after the settlement
  release(); holdWithdraw = null;
  await done; await settle(1);
  const { active } = db.splitArchived('human', [{ thread_id: 't1', mails: [{ id: 'm1' }, { id: 'm2' }] }]);
  assert.equal(active.length, 1, 'the reply keeps the thread open');
  const close = pushes.find((p) => p.kind === 'close' && p.tag === 't1');
  assert.deepEqual(close.mail_ids, ['m1'], 'the close names only the withdrawn mail');
});

test('mail held by b: this daemon closes its own devices and tells c with b as holder, and not b', async () => {
  pushes.length = 0; calls.b.length = 0; calls.c.length = 0;
  const out = await withdrawFromHuman(['mx'], 'boss', 'Answered by @boss: denied');
  assert.deepEqual(out, [{ id: 'mx', thread_id: 'tx', ids: ['mx'] }]);
  await settle(1);
  const close = pushes.find((p) => p.kind === 'close' && p.tag === 'tx');
  assert.ok(close && close.mail_ids.join() === 'mx', 'this daemon\'s device gets the close for mail it doesn\'t hold');
  const told = calls.c.find((x) => x.includes('/api/push/notify'));
  assert.ok(told && /"holder":"b"/.test(told) && /"close":true/.test(told), `c is told, naming b: ${told}`);
  assert.ok(!calls.b.some((x) => x.includes('/api/push/notify')), 'b is not told');
  assert.ok(db.splitArchived('human', [{ thread_id: 'tx', mails: [{ id: 'mx' }] }]).archived.length === 1, 'the thread is archived here too');
  // b's reply `my` carries an older timestamp than this settlement, yet isn't in b's snapshot: it keeps the thread open.
  assert.equal(db.splitArchived('human', [{ thread_id: 'tx', mails: [{ id: 'mx' }, { id: 'my' }] }]).active.length, 1, 'a peer reply outside the snapshot keeps the thread active, whatever its clock');
});

test('a relayed close is confirmed with the holder first, and isn\'t relayed on', async () => {
  pushes.length = 0; calls.b.length = 0; calls.c.length = 0;
  // b says tx's mx is withdrawn: the close goes through.
  const ok = await webpush.onRelay({ machine: 'c', holder: 'b', close: true, thread_id: 'tx', mail_ids: ['mx'] });
  assert.equal(ok.pushed, 1);
  await settle(1);
  assert.equal(pushes.filter((p) => p.kind === 'close').length, 1);
  assert.equal(calls.c.length, 0, 'a relayed close is not relayed on');
  // b holds m1 but has not withdrawn it: nothing closes.
  pushes.length = 0;
  await assert.rejects(webpush.onRelay({ machine: 'c', holder: 'b', close: true, thread_id: 't1', mail_ids: ['m1'] }), /hasn't withdrawn m1/);
  await assert.rejects(webpush.onRelay({ machine: 'c', holder: 'nowhere', close: true, thread_id: 'tx', mail_ids: ['mx'] }), /no peer machine/);
  await assert.rejects(webpush.onRelay({ machine: 'c', close: true, thread_id: 'tx' }), /mail_ids/);
  await sleep(200);
  assert.equal(pushes.length, 0);
});

test('a relay is pushed only for recent mail to the human from someone else (webpush guard)', async () => {
  pushes.length = 0;
  const fresh = new Date().toISOString();
  bThreads.tr = [{ id: 'mr', from_id: 'a1', from_name: 'a1', subject: 'fresh', created_at: fresh, recipients: [{ id: 'human', read_at: null }] }];
  bThreads.tn = [{ id: 'mn', from_id: 'a1', from_name: 'a1', subject: 'not ours', created_at: fresh, recipients: [{ id: 'a2', read_at: null }] }];
  bThreads.th = [{ id: 'mh', from_id: 'human', from_name: 'human', subject: 'own mail', created_at: fresh, recipients: [{ id: 'human', read_at: null }] }];
  // Mail addressed to another agent, and the human's own mail to itself, are refused and push nothing.
  await assert.rejects(webpush.onRelay({ machine: 'b', mail_id: 'mn', thread_id: 'tn' }), /mail mn is not to the human/);
  await assert.rejects(webpush.onRelay({ machine: 'b', mail_id: 'mh', thread_id: 'th' }), /mail mh is not to the human/);
  await sleep(200);
  assert.equal(pushes.length, 0, 'a refused relay pushes nothing');
  // Mail to the human from an agent passes, and its one notification names that mail.
  const ok = await webpush.onRelay({ machine: 'b', mail_id: 'mr', thread_id: 'tr' });
  assert.equal(ok.pushed, 1);
  await settle(1);
  assert.equal(pushes.length, 1, 'the relayed mail pushes once');
  assert.equal(pushes[0].kind, 'mail');
  assert.equal(pushes[0].mail_id, 'mr');
});

test.after(() => { push.close(); b.close(); c.close(); });

test('keepThread with closeKept (a superseded mail, S-1304) closes the old notification by id and keeps the thread open', async () => {
  pushes.length = 0;
  store('ms1', 'ts1');
  await withdrawFromHuman(['ms1'], 'a1', 'Superseded by ms2', { keepThread: true, closeKept: true });
  await settle(1);
  const close = pushes.find((p) => p.kind === 'close' && p.tag === 'ts1');
  assert.deepEqual(close?.mail_ids, ['ms1'], 'the old mail\'s notification closes');
  assert.equal(db.splitArchived('human', [{ thread_id: 'ts1', mails: [{ id: 'ms1' }] }]).archived.length, 0, 'the thread is not archived');
  pushes.length = 0;
  store('ms3', 'ts3');
  await withdrawFromHuman(['ms3'], 'a1', 'plain keep', { keepThread: true });
  await sleep(300);
  assert.equal(pushes.filter((p) => p.kind === 'close').length, 0, 'plain keepThread still closes nothing');
});
