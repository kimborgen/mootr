#!/usr/bin/env node
// Driven by test/e2e-push.sh against two peered throwaway daemons (STAM_URL and STAM_HOME
// for main, FAR_URL and FAR_HOME for far). Plays both the browser and its push service: a
// stub endpoint on 127.0.0.1 records each push, checks its VAPID signature, and decrypts it
// with a browser key pair made here (RFC 8291), so the test sees exactly what a phone would
// show. The human is the request carrying STAM_TEST_HUMAN_KEY (standing in for `tailscale
// serve`); an agent is one with the token and every header it could forge. Exits 1 on the
// first failed check.
import { createServer } from 'node:http';
import { createHash, createECDH, createDecipheriv, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const fail = (m) => { console.log('FAIL: ' + m); process.exit(1); };
const ok = (c, m) => { if (!c) fail(m); console.log('ok: ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const daemon = (url, home) => async (method, path, body, who = 'human', extra = {}) => {
  // A relay carries the peer headers, which only the peer token may send (S-1064).
  const token = readFileSync(join(home, who === 'peer' ? 'peer-token' : 'token'), 'utf8').trim();
  const as = who === 'human' ? { 'x-stam-test-human': process.env.STAM_TEST_HUMAN_KEY, 'x-stam-human': '1' } : who === 'forger' ? { 'x-stam-human': '1', 'tailscale-user-login': OWNER, 'x-forwarded-for': '192.0.2.9', 'x-stam-test-human': 'guess' } : {};
  const r = await fetch(url + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...as, ...extra }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
// The real owner's login, so the forged header is the one serve would send.
let OWNER = 'someone@example.com';
try { const s = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8' })); OWNER = s.User?.[String(s.Self?.UserID)]?.LoginName ?? OWNER; } catch {}
const call = daemon(process.env.STAM_URL, process.env.STAM_HOME);
const far = daemon(process.env.FAR_URL, process.env.FAR_HOME);

// The browser side: a P-256 key pair and an auth secret per device.
const browser = () => {
  const ecdh = createECDH('prime256v1');
  const pub = ecdh.generateKeys();
  return { ecdh, p256dh: pub.toString('base64url'), auth: randomBytes(16).toString('base64url') };
};
function decrypt(body, b) {
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const uaPublic = Buffer.from(b.p256dh, 'base64url');
  const shared = b.ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync('sha256', shared, Buffer.from(b.auth, 'base64url'), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  if (plain[plain.length - 1] !== 2) throw new Error('no last-record delimiter');
  return JSON.parse(plain.subarray(0, -1).toString());
}

// The push service: /gone/ answers 410 (an expired subscription), the rest 201.
const pushes = [];
let echoText = '';
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c)).on('end', () => {
    // /echo/ and /echogone/ answer 500 and 410 with a body that echoes secrets (echoText, set by the test).
    if (req.url.startsWith('/echo')) return void res.writeHead(req.url.startsWith('/echogone/') ? 410 : 500).end(echoText);
    pushes.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(req.url.startsWith('/gone/') ? 410 : 201).end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const until = async (n, what) => {
  for (let i = 0; i < 50 && pushes.length < n; i++) await sleep(100);
  if (pushes.length < n) fail(`no push for ${what}`);
};
const quiet = async (n, what) => { await sleep(800); ok(pushes.length === n, `no push for ${what}`); };

const vapidPrivate = () => JSON.parse(readFileSync(join(process.env.STAM_HOME, 'vapid.json'), 'utf8')).privateKey.replace(/-----[A-Z ]+-----|\s/g, '').slice(60, 100);
// Key and devices.
const info = (await call('GET', '/api/push')).data;
ok(/^[A-Za-z0-9_-]{87}$/.test(info.publicKey), 'GET /api/push gives a P-256 public key');
ok((statSync(join(process.env.STAM_HOME, 'vapid.json')).mode & 0o777) === 0o600, 'the VAPID key is kept in the home, readable only by its owner');
const phone = browser(), tablet = browser();
const sub = (path, b) => ({ endpoint: ORIGIN + path, keys: { p256dh: b.p256dh, auth: b.auth } });
ok((await call('POST', '/api/push/devices', { subscription: sub('/sub/phone', phone), label: 'Android · Chrome' }, 'forger')).status === 403, 'an agent cannot subscribe a device, even forging the human and serve headers');
ok((await call('POST', '/api/push/devices', { subscription: { endpoint: ORIGIN + '/x' } })).status === 400, 'a subscription without keys is refused');
const d1 = (await call('POST', '/api/push/devices', { subscription: sub('/sub/phone', phone), label: 'Android · Chrome', origin: 'https://example.com' })).data;
ok(d1.id && d1.kinds.join() === 'mail,permission', 'a new device gets mail and permission requests');
const again = (await call('POST', '/api/push/devices', { subscription: sub('/sub/phone', phone), label: 'Android · Chrome' })).data;
ok(again.id === d1.id, 'subscribing the same endpoint again keeps the device');
const d2 = (await call('POST', '/api/push/devices', { subscription: sub('/gone/tablet', tablet), label: 'iPad · Safari (app)', kinds: ['permission'] })).data;
const list = (await call('GET', '/api/push')).data.devices;
ok(list.length === 2 && list.every((d) => d.p256dh === undefined && d.auth === undefined), 'the list shows both devices and no keys');
ok((await call('GET', '/api/push')).data.devices.find((d) => d.id === d2.id).kinds.join() === 'permission', 'a device keeps the kinds it picked');
// S-2539: no reply serves a device's endpoint (a capability URL) or its keys, and the page gets endpoint_hash to find its own device.
const leakBodies = JSON.stringify([info, list, d1, again, d2, (await call('GET', '/api/push')).data, (await call('PATCH', `/api/push/devices/${d1.id}`, { label: 'Android · Chrome' })).data]);
for (const secret of [ORIGIN + '/sub/phone', ORIGIN + '/gone/tablet', '/sub/phone', phone.p256dh, phone.auth, tablet.p256dh, tablet.auth, vapidPrivate()]) ok(!leakBodies.includes(secret), `no push reply carries ${secret.slice(0, 24)}`);
ok(list.every((d) => !('endpoint' in d) && /^[0-9a-f]{64}$/.test(d.endpoint_hash)), 'a listed device has endpoint_hash and no endpoint');
ok(d1.endpoint_hash === createHash('sha256').update(ORIGIN + '/sub/phone').digest('hex'), 'endpoint_hash is the SHA-256 of the endpoint');

// Mail from an agent to the human pushes its sender and subject to the device that takes mail.
const reg = async (name) => (await call('POST', '/api/register', { name, role: 'push test' }, 'agent')).data;
const alice = await reg('alice'), bob = await reg('bob');
const m = (await call('POST', '/api/mail', { from: alice.id, to: ['human'], subject: 'Login fails: pick a lifetime', body: 'x', new_thread: true }, 'agent')).data;
await until(1, 'mail to the human');
const p1 = pushes[0];
ok(p1.path === '/sub/phone', 'mail goes only to the device that takes mail');
ok(p1.headers['content-encoding'] === 'aes128gcm' && Number(p1.headers.ttl) > 0, 'the push is aes128gcm with a TTL');
const auth = p1.headers.authorization.match(/^vapid t=([^,]+), k=(.+)$/);
ok(auth && auth[2] === info.publicKey, 'the push carries the VAPID key');
const [h, c, s] = auth[1].split('.');
const claims = JSON.parse(Buffer.from(c, 'base64url'));
const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: Buffer.from(info.publicKey, 'base64url').subarray(1, 33).toString('base64url'), y: Buffer.from(info.publicKey, 'base64url').subarray(33).toString('base64url') }, format: 'jwk' });
ok(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), 'the VAPID JWT is signed with that key');
ok(claims.aud === ORIGIN && claims.sub === 'https://example.com' && claims.exp > Date.now() / 1000, "the JWT names the push service and the page's origin");
const pay1 = decrypt(p1.body, phone);
ok(pay1.kind === 'mail' && pay1.title === 'alice' && pay1.body === 'Login fails: pick a lifetime' && pay1.thread === m.thread_id && pay1.tag === m.thread_id, 'the payload decrypts to sender, subject, and thread');

// Agent-to-agent mail and the human's own mail push nothing.
await call('POST', '/api/mail', { from: alice.id, to: [bob.id], subject: 'between agents', body: 'x', new_thread: true }, 'agent');
await call('POST', '/api/mail', { from: 'human', to: ['human'], subject: 'note to self', body: 'x', new_thread: true });
await quiet(1, 'agent-to-agent mail or the human\'s own mail');

// A permission request pushes to both devices with its id; the expired one is removed.
const perm = (await call('POST', '/api/permissions', { agent: alice.id, action: 'Run the full test suite', reason: 'r', audience: 'human' }, 'agent')).data;
await until(3, 'a permission request');
const byPath = Object.fromEntries(pushes.slice(1).map((p) => [p.path, p]));
const pay2 = decrypt(byPath['/sub/phone'].body, phone), pay3 = decrypt(byPath['/gone/tablet'].body, tablet);
ok(pay2.kind === 'permission' && pay2.permission_id === perm.id && pay2.title === 'alice asks for permission' && pay2.body === 'Run the full test suite' && pay2.thread && pay2.perm_kind === 'request', 'a permission push names the request, its kind, its action, and its thread');
ok(pay3.permission_id === perm.id && byPath['/gone/tablet'].headers.urgency === 'high', 'the permission-only device gets it, marked urgent');
await sleep(300);
ok(!(await call('GET', '/api/push')).data.devices.some((d) => d.id === d2.id), 'a device whose push service answers 410 is removed');

// Picking nothing stops mail; a test still reaches the device; removing it ends pushes.
ok((await call('PATCH', `/api/push/devices/${d1.id}`, { kinds: ['permission'] })).data.kinds.join() === 'permission', 'a device can drop mail');
await call('POST', '/api/mail', { from: alice.id, to: ['human'], subject: 'after dropping mail', body: 'x', new_thread: true }, 'agent');
await quiet(3, 'mail on a device that dropped it');
const t = (await call('POST', '/api/push/test', { device: d1.id })).data;
ok(t.length === 1 && t[0].status === 201, 'a test reports the push service status');
ok(decrypt(pushes[3].body, phone).kind === 'test', 'the test push decrypts');
ok((await call('DELETE', `/api/push/devices/${d1.id}`)).status === 200 && !(await call('GET', '/api/push')).data.devices.length, 'removing the device empties the list');
// S-2683: a push service that errors, 410 included (the row is deleted before the reply), echoes the endpoint and keys; the test reply carries none of it, in any form.
for (const [path, status] of [['/echo/phone', 500], ['/echogone/phone', 410]]) {
  const br = browser();
  const ep = ORIGIN + path;
  const dev = (await call('POST', '/api/push/devices', { subscription: { endpoint: ep, keys: { p256dh: br.p256dh, auth: br.auth } }, label: 'echo' })).data;
  const forms = [ep, encodeURIComponent(ep), Buffer.from(ep).toString('base64url'), Buffer.from(ep).toString('base64'), path, br.p256dh, encodeURIComponent(br.p256dh), Buffer.from(br.p256dh).toString('base64url'), br.auth, Buffer.from(br.auth).toString('base64url'), Buffer.from(br.auth).toString('base64')];
  echoText = 'push service said: ' + forms.join(' ');
  const r = await call('POST', '/api/push/test', { device: dev.id });
  ok(r.status === 200 && r.data.length === 1 && r.data[0].status === status && r.data[0].error, `a ${status} test reply reports the failure`);
  ok(forms.every((f) => !JSON.stringify(r.data).includes(f)), `the ${status} test reply carries no endpoint or key, raw, URL-encoded, or base64`);
}
echoText = '';
await call('POST', '/api/permissions', { agent: alice.id, action: 'after removal', reason: 'r', audience: 'human' }, 'agent');
await quiet(4, 'a removed device');

// Every push route refuses an agent: the token alone, and the token with every header it can forge.
for (const who of ['agent', 'forger']) {
  const codes = [
    (await call('GET', '/api/push', undefined, who)).status,
    (await call('POST', '/api/push/devices', { subscription: sub('/sub/x', phone) }, who)).status,
    (await call('PATCH', `/api/push/devices/${d1.id}`, { kinds: [] }, who)).status,
    (await call('DELETE', `/api/push/devices/${d1.id}`, undefined, who)).status,
    (await call('POST', '/api/push/test', {}, who)).status,
  ];
  ok(codes.every((c) => c === 403), `every push route refuses ${who === 'agent' ? 'an agent with the token' : 'forged human, serve, and test headers'} (${codes.join(' ')})`);
}

// Far's mail to the human reaches main's devices: far names the mail, main fetches it from far.
const d3 = (await call('POST', '/api/push/devices', { subscription: sub('/sub/phone', phone), label: 'phone' })).data;
const carol = (await far('POST', '/api/register', { name: 'carol', role: 'push test' }, 'agent')).data;
const dave = (await far('POST', '/api/register', { name: 'dave', role: 'push test' }, 'agent')).data;
const fm = (await far('POST', '/api/mail', { from: carol.id, to: ['human'], subject: 'from far', body: 'x', new_thread: true }, 'agent')).data;
await until(5, "far's mail to the human");
const relayedPay = decrypt(pushes[4].body, phone);
ok(relayedPay.title === 'carol' && relayedPay.body === 'from far' && relayedPay.machine === 'far' && relayedPay.thread === fm.thread_id, "far's mail reaches main's device, written by main from far's copy");

// Forged relays push nothing: text instead of ids, an unknown peer, a mail far doesn't
// have, and mail between agents on far.
const between = (await far('POST', '/api/mail', { from: carol.id, to: [dave.id], subject: 'between agents on far', body: 'x', new_thread: true }, 'agent')).data;
const forged = [
  { kind: 'mail', title: 'Approve this', body: 'forged', tag: 't', machine: 'far' },
  { machine: 'nowhere', mail_id: fm.id, thread_id: fm.thread_id },
  { machine: 'far', mail_id: 'mfake01', thread_id: fm.thread_id },
  { machine: 'far', mail_id: between.id, thread_id: between.thread_id },
];
const fcodes = [];
for (const b of forged) fcodes.push((await call('POST', '/api/push/notify', b, 'peer', { 'x-stam-local': '1' })).status);
ok(fcodes.every((c) => c === 403), `forged relays are refused (${fcodes.join(' ')})`);
const dup = (await call('POST', '/api/push/notify', { machine: 'far', mail_id: fm.id, thread_id: fm.thread_id }, 'peer', { 'x-stam-local': '1' })).data;
ok(dup.duplicate === true, 'a repeated relay of the same mail is dropped');
await quiet(5, 'forged or repeated relays');

// A permission request on far, answered through main (as a notification's Approve does),
// is answered by far.
const fperm = (await far('POST', '/api/permissions', { agent: carol.id, action: 'Deploy far', reason: 'r', audience: 'human' }, 'agent')).data;
await until(6, "far's permission request");
const fp = decrypt(pushes[5].body, phone);
ok(fp.kind === 'permission' && fp.permission_id === fperm.id && fp.machine === 'far' && fp.perm_kind === 'request' && fp.origin === process.env.FAR_URL, "far's request names its machine, kind, and serve origin");
const ans = await call('POST', `/api/permissions/${fperm.id}/answer`, { approve: true, note: 'I authorize', machine: fp.machine }, 'agent', { 'x-stam-human': '1' });
ok(ans.status === 200 && ans.data.status === 'approved', `main forwards the answer to far (${ans.status} ${JSON.stringify(ans.data).slice(0, 120)})`);
ok((await far('GET', '/api/permissions?status=approved', undefined, 'agent')).data.some((r) => r.id === fperm.id), 'far records the approval');
// Mail keeps its id across daemons and may arrive again (a repeated forward): the human
// gets one push per id.
const fwd = { from: alice.id, to: ['human'], subject: 'forwarded twice', body: 'x', forwarded: { from_name: 'alice' }, mail_id: 'mfwd' + Date.now().toString(36), thread_id: 'tfwd' + Date.now().toString(36) };
await call('POST', '/api/mail', fwd, 'agent');
await until(7, 'a forwarded mail to the human');
ok(decrypt(pushes[6].body, phone).body === 'forwarded twice', 'a forwarded mail to the human pushes');
await call('POST', '/api/mail', fwd, 'agent');
await call('POST', '/api/mail', { ...fwd, mail_id: m.id, thread_id: m.thread_id, subject: 'Login fails: pick a lifetime' }, 'agent');
await quiet(7, 'the same mail arriving again');

// Withdrawn mail (S-413): when someone other than the human answers a request, the phone closes
// its notification and shows nothing. Eve is dave's child on far; dave's denial of her request is
// far's to withdraw, and far relays the close to main's device. The human's own answer closes nothing.
const eve = (await far('POST', '/api/register', { name: 'eve', role: 'push test' }, 'agent')).data;
await far('POST', `/api/agents/${eve.id}/set-parent`, { parent: dave.id }, 'agent');
const eperm = (await far('POST', '/api/permissions', { agent: eve.id, action: 'Delete the cache', reason: 'r', audience: 'human' }, 'agent')).data;
await until(8, "eve's permission request");
const ep = decrypt(pushes[7].body, phone);
ok(ep.kind === 'permission' && ep.permission_id === eperm.id, "eve's request pushes first");
const den = await far('POST', `/api/permissions/${eperm.id}/answer`, { approve: false, by: dave.id, note: 'no' }, 'agent');
ok(den.status === 200 && den.data.status === 'denied', `dave denies eve's request on far (${den.status})`);
await until(9, 'the close for eve\'s request');
const cl = decrypt(pushes[8].body, phone);
ok(cl.kind === 'close' && cl.tag === ep.thread && cl.thread === ep.thread && !cl.title && !cl.body, 'the close names the thread and carries no text');
ok(pushes[8].path === '/sub/phone', 'it reaches main\'s device, relayed by far');
const eveMail = (await far('GET', `/api/threads/${ep.thread}?box=human`, undefined, 'agent')).data;
const hr = eveMail[0].recipients.find((r) => r.id === 'human');
ok(hr.read_at && hr.withdrawn_at && hr.withdrawn_by === dave.id && hr.withdrawn_note === 'Answered by @dave: denied', 'far marks the human\'s copy read and withdrawn, with the note');
// The human answering their own request closes nothing: it is theirs to see.
const hperm = (await far('POST', '/api/permissions', { agent: eve.id, action: 'Rebuild', reason: 'r', audience: 'human' }, 'agent')).data;
await until(10, "eve's second request");
await call('POST', `/api/permissions/${hperm.id}/answer`, { approve: true, note: 'I authorize', machine: 'far' }, 'agent', { 'x-stam-human': '1' });
await quiet(10, "the human's own answer");
// A peer's close names only a thread: it can't show anything, and a stranger can't send one.
ok((await call('POST', '/api/push/notify', { machine: 'nowhere', close: true, thread_id: ep.thread, mail_ids: [eveMail[0].id] }, 'peer', { 'x-stam-local': '1' })).status === 403, 'a close from an unknown peer is refused');
// A close is confirmed with the holder: far hasn't withdrawn the mail the human answered themselves, nor one it doesn't have.
const hthread = (await far('GET', '/api/agents/human/inbox?limit=50', undefined, 'agent')).data.find((x) => x.permission_id === hperm.id || x.subject.includes('Rebuild'));
const unconfirmed = [
  { machine: 'far', close: true, thread_id: hthread.thread_id, mail_ids: [hthread.id] },
  { machine: 'far', close: true, thread_id: ep.thread, mail_ids: ['mnone'] },
  { machine: 'far', close: true, thread_id: ep.thread },
];
const ucodes = [];
for (const b of unconfirmed) ucodes.push((await call('POST', '/api/push/notify', b, 'peer', { 'x-stam-local': '1' })).status);
ok(ucodes.every((c) => c === 403), `a close far hasn't withdrawn is refused (${ucodes.join(' ')})`);
await quiet(10, 'an unconfirmed close');
ok((await call('POST', '/api/mail/withdraw', { ids: ['x'], by: 'x', note: 'x' }, 'agent')).status === 403, 'only a peer may call the withdraw route');
await call('DELETE', `/api/push/devices/${d3.id}`);
server.close();
console.log('PASS');
