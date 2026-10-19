#!/usr/bin/env node
// send_mail takes the text as `body`, or as `message` or `content` (S-116), and one recipient as a
// bare string; a mail with no text is refused before it is sent. A fake daemon on loopback records
// the POSTs. Free, no model. `node --test test/mcp-send-mail.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mcp-send-mail-');
process.env.STAM_HOME = home;
for (const k of ['STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

const posts = [];
let reply = { id: 'm1', thread_id: 't1', subject: 's' }; // what the fake daemon answers
const daemon = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    posts.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : undefined });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply));
  });
});
let mcp;
before(async () => {
  await new Promise((r) => daemon.listen(0, '127.0.0.1', r));
  process.env.STAM_URL = `http://127.0.0.1:${daemon.address().port}`;
  mcp = await import('../src/mcp.ts');
});
after(() => {
  daemon.close();
  rmSync(home, { recursive: true, force: true });
});

const self = 'agent-send-mail';
const mails = () => posts.filter((p) => p.method === 'POST' && p.path === '/api/mail');

test('send_mail with body sends it as is', async () => {
  posts.length = 0;
  await mcp.callTool('send_mail', { self, to: ['human-agent'], subject: 's', body: 'hello' });
  assert.equal(mails().length, 1);
  assert.deepEqual(mails()[0].body.to, ['human-agent']);
  assert.equal(mails()[0].body.body, 'hello');
});

test('send_mail with message as the text sends it as the body', async () => {
  posts.length = 0;
  await mcp.callTool('send_mail', { self, to: ['cos'], subject: 's', message: 'from message' });
  assert.equal(mails()[0].body.body, 'from message');
  assert.equal(mails()[0].body.message, undefined);
});

test('send_mail with content as the text sends it as the body', async () => {
  posts.length = 0;
  await mcp.callTool('send_mail', { self, to: ['cos'], subject: 's', content: 'from content' });
  assert.equal(mails()[0].body.body, 'from content');
});

test('send_mail with a string to sends it as a one-item list', async () => {
  posts.length = 0;
  await mcp.callTool('send_mail', { self, to: 'cos', subject: 's', body: 'hi' });
  assert.deepEqual(mails()[0].body.to, ['cos']);
});

test('send_mail with attachments and no text sends the mail with an empty body', async () => {
  posts.length = 0;
  await mcp.callTool('send_mail', { self, to: ['cos'], subject: 'notes.txt', attachments: [{ name: 'notes.txt', content: 'x' }] });
  assert.equal(mails().length, 1);
  assert.equal(mails()[0].body.body, '');
  assert.equal(mails()[0].body.attachments.length, 1);
});

test('send_mail with no text names the body and sends nothing', async () => {
  posts.length = 0;
  await assert.rejects(mcp.callTool('send_mail', { self, to: ['cos'], subject: 's' }), { message: "body is required: the mail's text" });
  await assert.rejects(mcp.callTool('send_mail', { self, to: ['cos'], subject: 's', body: '   ' }), { message: "body is required: the mail's text" });
  assert.equal(mails().length, 0);
});

test('a queued send_mail (storage unreachable) still carries the misses_human hint', async () => {
  reply = { id: 'm2', thread_id: 't2', to: ['cos'], queued: true, misses_human: true };
  const r = await mcp.callTool('send_mail', { self, to: ['cos'], subject: 's', body: 'x' });
  assert.match(r.content[0].text, /^Queued m2 in thread t2/);
  assert.match(r.content[0].text, /add `human` to `to`/);
  reply = { id: 'm3', thread_id: 't3', to: ['cos'], queued: true };
  const plain = await mcp.callTool('send_mail', { self, to: ['cos'], subject: 's', body: 'x' });
  assert.doesNotMatch(plain.content[0].text, /human/);
});
