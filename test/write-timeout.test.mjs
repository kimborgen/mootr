#!/usr/bin/env node
// A write that outlives the client's timeout still delivers once; the retry gets its id, not a
// second delivery (S-1663). A stub server stands in for the daemon's /api/mail route behind
// dedupByClientId; no daemon. `node --test test/write-timeout.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

let release;
const gate = new Promise((r) => (release = r));
let delivered = 0;
let started;
const hasStarted = new Promise((r) => (started = r));
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const body = JSON.parse(raw);
  const { dedupByClientId } = await import('../src/client-dedup.ts');
  const out = await dedupByClientId('agent:a1|/api/mail', body.client_id, async () => {
    started();
    await gate; // the slow mail check
    return { id: `m${++delivered}` };
  });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(out));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.STAM_URL = `http://127.0.0.1:${server.address().port}`;
const { api, writeId } = await import('../src/client.ts');
const { forgetClientIds } = await import('../src/client-dedup.ts');

test.after(() => server.close());

test('writeId is the same for the same write and differs for another', () => {
  assert.equal(writeId('mail', 'a1', ['b'], 's', 'hi'), writeId('mail', 'a1', ['b'], 's', 'hi'));
  assert.notEqual(writeId('mail', 'a1', ['b'], 's', 'hi'), writeId('mail', 'a1', ['b'], 's', 'hi!'));
});

test('a send that times out at the client is delivered once, and its retry gets the same id', async () => {
  forgetClientIds();
  const send = { to: ['b'], body: 'hi', client_id: writeId('mail', 'a1', ['b'], 'hi') };
  const first = api('POST', '/api/mail', send, 200);
  await assert.rejects(first, /timeout|aborted/i);
  await hasStarted;
  const retry = api('POST', '/api/mail', send, 5000);
  release();
  assert.deepEqual(await retry, { id: 'm1' });
  assert.equal(delivered, 1);
});

// The call sites must pass both: the test above builds its own client_id and would stay green
// if a tool stopped sending one or dropped the long timeout.
import { readFileSync } from 'node:fs';
const source = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');

test('send_mail, itsa_post and plusOne pass client_id and WRITE_CALL_MS', () => {
  const mcp = source('mcp.ts');
  const mailCall = mcp.match(/api\('POST', '\/api\/mail',[^\n]*\n/)?.[0] ?? '';
  assert.match(mailCall, /client_id: writeId\('mail'/);
  assert.match(mailCall, /WRITE_CALL_MS\)/);
  const postCall = mcp.match(/api\('POST', `\/api\/itsas\/\$\{encodeURIComponent\(itsaRef\(a, 'itsa'\)\)\}\/post`,[^\n]*\n/)?.[0] ?? '';
  assert.match(postCall, /client_id: writeId\('post'/);
  assert.match(postCall, /WRITE_CALL_MS\)/);
  const plusOne = source('retro.ts').match(/api\('POST', `\/api\/itsas\/\$\{x\.id\}\/post`,[^\n]*\n/)?.[0] ?? '';
  assert.match(plusOne, /client_id: writeId\('post'/);
  assert.match(plusOne, /WRITE_CALL_MS\)/);
});
