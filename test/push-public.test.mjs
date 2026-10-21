#!/usr/bin/env node
// S-2539: a push device row is served through the publicPushDevice allowlist. The endpoint (a capability
// URL), the keys, and any column added later never reach a body; the page gets endpoint_hash instead. The
// sender still reads the full row from the store and posts to the endpoint. No daemon, no models:
// `node --test test/push-public.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createECDH, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-push-public-');
process.env.STAM_HOME = home;
process.env.STAM_EMBEDDER = 'stub';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [] }));

let db, pub, webpush, hits;
const realFetch = globalThis.fetch;
const ENDPOINT_BASE = 'http://127.0.0.1:9';
const browser = createECDH('prime256v1');
const P256DH = browser.generateKeys().toString('base64url');
const AUTH = randomBytes(16).toString('base64url');
before(async () => {
  hits = [];
  // The push service is a stub fetch: no socket, no network.
  globalThis.fetch = async (url) => { hits.push(String(url)); return new Response(null, { status: 201 }); };
  db = await import('../src/db.ts');
  pub = await import('../src/push-public.ts');
  webpush = await import('../src/webpush.ts');
});
after(() => { globalThis.fetch = realFetch; });

test('a served device carries no endpoint, keys, or unlisted column', async () => {
  const endpoint = `${ENDPOINT_BASE}/capability-SECRET-token`;
  const d = db.savePushDevice({ endpoint, p256dh: P256DH, auth: AUTH, label: 'Phone', origin: 'https://example.com', kinds: ['mail'] });
  // The page needs to know "this one": the hash of the endpoint, not the endpoint.
  const served = pub.publicPushDevice({ ...d, last_error: `410 gone ${endpoint} ${AUTH}`, future_secret_column: 'FUTURE-SECRET' });
  const body = JSON.stringify(served);
  for (const secret of [endpoint, 'capability-SECRET-token', P256DH, AUTH, 'FUTURE-SECRET']) assert.ok(!body.includes(secret), `served body leaks ${secret}`);
  for (const k of ['endpoint', 'p256dh', 'auth', 'keys', 'future_secret_column']) assert.ok(!(k in served), `${k} is served`);
  assert.equal(served.endpoint_hash, createHash('sha256').update(endpoint).digest('hex'));
  assert.deepEqual(Object.keys(served).sort(), ['created_at', 'endpoint_hash', 'id', 'kinds', 'label', 'last_error', 'last_ok_at']);
});

test('the sender still reads the endpoint and keys from the store', async () => {
  const [d] = db.listPushDevices();
  assert.match(d.endpoint, /capability-SECRET-token$/);
  assert.equal(d.p256dh, P256DH);
  assert.equal(d.auth, AUTH);
  const r = await webpush.sendTo(d, { kind: 'test', title: 't', body: 'b', tag: 't', machine: 'm' });
  assert.equal(r.status, 201);
  assert.deepEqual(hits, [`${ENDPOINT_BASE}/capability-SECRET-token`]);
});

test('error text is redacted: the endpoint in any form, any URL, the keys', () => {
  const d = { endpoint: `${ENDPOINT_BASE}/capability-SECRET-token`, p256dh: P256DH, auth: AUTH };
  const forms = [d.endpoint, encodeURIComponent(d.endpoint), Buffer.from(d.endpoint).toString('base64url'), Buffer.from(d.endpoint).toString('base64'), 'https://fcm.example.com/send/abc123', AUTH, encodeURIComponent(P256DH)];
  const out = pub.redactPushError(`410 ${forms.join(' | ')}`, d);
  for (const f of forms) assert.ok(!out.includes(f), `kept ${f}`);
  assert.ok(!out.includes('abc123') && !out.includes('capability-SECRET'));
  assert.match(out, /^410 /);
});
