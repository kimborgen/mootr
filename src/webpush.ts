// Phone notifications through Web Push (RFC 8030), sent by the daemon itself: payloads are
// encrypted for each browser (RFC 8291, aes128gcm) and signed with this daemon's VAPID key
// (RFC 8292), so nothing but the browser's own push service sees them, and that only as
// ciphertext. Each device subscribes on the daemon whose page it uses; a daemon that stores
// mail to the human pushes to its own devices and asks its peers to push to theirs, so each
// device hears once whichever machine the mail came from.
import { createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, createCipheriv, sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STAM_HOME, MACHINE } from './config.ts';
import * as db from './db.ts';
import { peers, peerCall } from './peers.ts';
import { peerServeOrigin } from './web-origins.ts';

export const KINDS = ['mail', 'permission'] as const;

export interface Payload {
  // `close` shows nothing: the phone closes the notifications with the same tag (withdrawn mail).
  kind: 'mail' | 'permission' | 'test' | 'close';
  title: string;
  body: string;
  // Notifications with the same tag replace each other: one per thread.
  tag: string;
  thread?: string;
  permission_id?: string;
  // The request's kind (db.PermissionRequest.kind): the service worker offers Approve only where
  // a tap may approve, never for suggested input (S-422), which only the web UI approves.
  perm_kind?: string;
  // The mail this notification stands for; a close names the mails it withdrew and closes only those, so a newer mail in the thread keeps its notification.
  mail_id?: string;
  mail_ids?: string[];
  machine: string;
  // The serve origin of the machine that holds the request, when it is not this one (S-544): the service worker
  // posts Approve and Deny straight there, where that machine's tailscale serve proves the human sent them.
  origin?: string;
}

const b64u = (b: Buffer) => b.toString('base64url');

// The VAPID key pair, made on first use and kept in the daemon's home.
let vapid: { publicKey: string; privateKey: string } | undefined;
export function vapidKeys(): { publicKey: string; privateKey: string } {
  if (vapid) return vapid;
  const file = join(STAM_HOME, 'vapid.json');
  if (existsSync(file)) return (vapid = JSON.parse(readFileSync(file, 'utf8')));
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
  vapid = { publicKey: b64u(raw), privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string };
  writeFileSync(file, JSON.stringify(vapid, null, 2) + '\n', { mode: 0o600 });
  return vapid;
}

// The Authorization header for one push service: a JWT for its origin, signed ES256.
function vapidAuth(endpoint: string, subject: string): string {
  const k = vapidKeys();
  const enc = (o: object) => b64u(Buffer.from(JSON.stringify(o)));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })}`;
  const sig = sign('sha256', Buffer.from(unsigned), { key: createPrivateKey(k.privateKey), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${k.publicKey}`;
}

// RFC 8291: one aes128gcm record, keyed from an ECDH exchange with the browser's key and
// its auth secret.
export function encrypt(payload: Buffer, p256dh: string, authSecret: string): Buffer {
  const uaPublic = Buffer.from(p256dh, 'base64url');
  const ecdh = createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = Buffer.from(hkdfSync('sha256', shared, Buffer.from(authSecret, 'base64url'), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const salt = randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 marks the last (and only) record, with no padding.
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// Apple's push service wants a mailto: or https: subject; the page's own address is one.
const subjectFor = (d: db.PushDevice) => (d.origin?.startsWith('https://') ? d.origin : 'mailto:stam@localhost');

export async function sendTo(d: db.PushDevice, p: Payload): Promise<{ device: string; status: number; error?: string }> {
  try {
    const res = await fetch(d.endpoint, {
      method: 'POST',
      headers: {
        authorization: vapidAuth(d.endpoint, subjectFor(d)),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(24 * 3600),
        urgency: p.kind === 'mail' ? 'normal' : 'high',
      },
      body: new Uint8Array(encrypt(Buffer.from(JSON.stringify(p)), d.p256dh, d.auth)),
      signal: AbortSignal.timeout(10_000),
    });
    const text = res.ok ? '' : (await res.text().catch(() => '')).slice(0, 300);
    // The browser unsubscribed or the subscription expired: the device is gone.
    if (res.status === 404 || res.status === 410) db.deletePushDevice(d.id);
    else if (res.ok) db.updatePushDevice(d.id, { last_ok_at: new Date().toISOString(), last_error: null });
    else db.updatePushDevice(d.id, { last_error: `${res.status} ${text}`.trim() });
    return { device: d.id, status: res.status, ...(res.ok ? {} : { error: text || `HTTP ${res.status}` }) };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    db.updatePushDevice(d.id, { last_error: error });
    return { device: d.id, status: 0, error };
  }
}

// Pushes to this daemon's devices that take this kind (a test goes to the devices named).
export function pushLocal(p: Payload, only?: string[]): Promise<Awaited<ReturnType<typeof sendTo>>[]> {
  const devices = db.listPushDevices().filter((d) => (only ? only.includes(d.id) : p.kind === 'close' || (p.kind !== 'test' && d.kinds.includes(p.kind))));
  return Promise.all(devices.map((d) => sendTo(d, p)));
}

type HumanMail = { id: string; thread_id: string; from_id: string; from_name: string; subject: string; permission_id: string | null; perm_kind?: string };

function payloadFor(m: HumanMail, machine: string, origin?: string): Payload {
  const subject = m.subject.length > 200 ? m.subject.slice(0, 199) + '…' : m.subject;
  return m.permission_id
    ? { kind: 'permission', title: `${m.from_name} asks for permission`, body: subject.replace(/^Permission:\s*/, ''), tag: m.thread_id, thread: m.thread_id, permission_id: m.permission_id, mail_id: m.id, perm_kind: m.perm_kind ?? db.getPermissionRequest(m.permission_id)?.kind, machine, ...(origin ? { origin } : {}) }
    : { kind: 'mail', title: m.from_name, body: subject, tag: m.thread_id, thread: m.thread_id, mail_id: m.id, machine };
}

// Mail to the human, as it is stored: a push here, and each peer is told the mail's id so
// it can push to its own devices. Mail between agents never reaches this, and neither does
// the human's own mail to itself.
export function onHumanMail(m: HumanMail): void {
  if (m.from_id === 'human' || !firstTime(m.id)) return;
  pushLocal(payloadFor(m, MACHINE)).catch(() => {});
  for (const peer of peers()) peerCall(peer, 'POST', '/api/push/notify', { machine: MACHINE, mail_id: m.id, thread_id: m.thread_id }).catch(() => {});
}

// Mail to the human was withdrawn (src/withdraw.ts): the phones close the notifications of
// those mails and show nothing. `holder` is the machine that holds the mail (this one unless
// a peer's withdrawal named it); each peer but the holder is told, and confirms the withdrawal
// with the holder before closing its devices' notifications. A relayed close is never relayed on.
export function closeThread(threadId: string, mailIds: string[], holder?: string): void {
  const h = holder ?? MACHINE;
  pushLocal({ kind: 'close', title: '', body: '', tag: threadId, thread: threadId, mail_ids: mailIds, machine: h }).catch(() => {});
  for (const peer of peers()) if (peer.name !== h) peerCall(peer, 'POST', '/api/push/notify', { machine: MACHINE, holder: h, close: true, thread_id: threadId, mail_ids: mailIds }).catch(() => {});
}

// Closes the notifications of these mails on this daemon's devices only.
export function closeLocal(threadId: string, mailIds: string[]): void {
  pushLocal({ kind: 'close', title: '', body: '', tag: threadId, thread: threadId, mail_ids: mailIds, machine: MACHINE }).catch(() => {});
}

// A peer says it stored mail to the human. Every daemon holds the same token its agents
// do, so the relay itself proves nothing: it carries only ids, and this daemon fetches the
// mail from that peer (with the peer's token from settings), checks it is recent mail to
// the human from someone else, and writes the notification itself. Each id pushes once.
const RELAY_MAX_AGE_MS = 15 * 60_000;
// Mail keeps its id on every daemon, so one id pushes once here, stored or relayed.
const pushed = new Set<string>();
function firstTime(id: string): boolean {
  if (pushed.has(id)) return false;
  pushed.add(id);
  if (pushed.size > 2000) pushed.delete(pushed.values().next().value!);
  return true;
}
export async function onRelay(body: { machine?: unknown; mail_id?: unknown; thread_id?: unknown; close?: unknown; holder?: unknown; mail_ids?: unknown }): Promise<{ pushed: number; duplicate?: boolean }> {
  const peer = peers().find((p) => p.name === String(body.machine ?? ''));
  if (!peer) throw new Error(`no peer machine ${body.machine}`);
  // A close takes notifications away, never shows one, and only for mail its holder says it
  // withdrew: this daemon asks the holder (the sender, or the peer the sender names) itself.
  if (body.close) {
    const t = String(body.thread_id ?? '');
    const ids = Array.isArray(body.mail_ids) ? body.mail_ids.map(String) : [];
    if (!/^[\w-]+$/.test(t) || !ids.length || ids.some((x) => !/^[\w-]+$/.test(x))) throw new Error('a close names a thread_id and mail_ids');
    const holderName = String(body.holder ?? peer.name);
    const holder = peers().find((p) => p.name === holderName);
    if (!holder && holderName !== MACHINE) throw new Error(`no peer machine ${holderName}`);
    const mails = holder
      ? ((await peerCall(holder, 'GET', `/api/threads/${t}?box=human`)).data as (db.ThreadMail & { recipients: { id: string; withdrawn_at?: string | null }[] })[])
      : db.threadMail(t, 'human');
    const withdrawn = new Set((Array.isArray(mails) ? mails : []).filter((m) => m.recipients.some((r) => r.id === 'human' && r.withdrawn_at)).map((m) => m.id));
    const open = ids.filter((x) => !withdrawn.has(x));
    if (open.length) throw new Error(`${holderName} hasn't withdrawn ${open.join(', ')}`);
    return { pushed: (await pushLocal({ kind: 'close', title: '', body: '', tag: t, thread: t, mail_ids: ids, machine: holderName })).length };
  }
  const id = String(body.mail_id ?? ''), tid = String(body.thread_id ?? '');
  if (!/^[\w-]+$/.test(id) || !/^[\w-]+$/.test(tid)) throw new Error('a relay names mail_id and thread_id');
  if (pushed.has(id)) return { pushed: 0, duplicate: true };
  const r = await peerCall(peer, 'GET', `/api/threads/${tid}?box=human`);
  const m = Array.isArray(r.data) ? (r.data as (db.ThreadMail & { from_name: string })[]).find((x) => x.id === id) : undefined;
  if (!m) throw new Error(`${peer.name} has no mail ${id} in thread ${tid}`);
  if (m.from_id === 'human' || !m.recipients.some((x) => x.id === 'human')) throw new Error(`mail ${id} is not to the human`);
  if (Date.now() - Date.parse(m.created_at) > RELAY_MAX_AGE_MS) throw new Error(`mail ${id} is too old to notify`);
  // Marked only once checked, so a failed fetch doesn't swallow the real relay.
  if (!firstTime(id)) return { pushed: 0, duplicate: true };
  const sent = await pushLocal(payloadFor({ ...m, thread_id: m.thread_id ?? m.id, permission_id: m.permission_id ?? null, perm_kind: m.permission?.kind }, peer.name, peerServeOrigin(peer.url)));
  return { pushed: sent.length };
}
