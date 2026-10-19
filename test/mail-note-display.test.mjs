#!/usr/bin/env node
// A mail's routing note (S-1462) shows as "[stam] NOTE" under its body in the rendered read_mail and read_thread
// text and in `stam mail read` (S-1764). A fake daemon on loopback answers; free, no model.
// `node --test test/mail-note-display.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mail-note-display-');
process.env.STAM_HOME = home;
for (const k of ['STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

const NOTE = 'Routing was uncertain: Kim typed this without picking a recipient.';
const mail = (note) => ({ id: 'm1', thread_id: 'm1', subject: 'Q', from_id: 'human', from_name: 'Kim', created_at: '2026-10-18T00:00:00Z', body: 'what is up?', recipients: [{ id: 'a1' }], attachments: [], ...(note ? { note } : {}) });
let withNote = true;
const daemon = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([mail(withNote ? NOTE : undefined)]));
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

const textOf = (r) => r.content.map((c) => c.text).join('\n');
const cli = () => new Promise((resolve) => {
  const child = spawn(process.execPath, ['--no-warnings', 'src/cli.ts', 'mail', 'read', 'a1'], { env: { ...process.env, STAM_TOKEN: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.on('close', () => resolve(out));
});

test('read_mail, read_thread and `stam mail read` show the note under the body', async () => {
  withNote = true;
  const want = `what is up?\n\n[stam] ${NOTE}`;
  assert.ok(textOf(await mcp.callTool('read_mail', { self: 'a1' })).includes(want));
  assert.ok(textOf(await mcp.callTool('read_thread', { self: 'a1', thread_id: 'm1' })).includes(want));
  assert.ok((await cli()).includes(want));
});

test('without a note, none of them shows a [stam] line', async () => {
  withNote = false;
  assert.ok(!textOf(await mcp.callTool('read_mail', { self: 'a1' })).includes('[stam]'));
  assert.ok(!textOf(await mcp.callTool('read_thread', { self: 'a1', thread_id: 'm1' })).includes('[stam]'));
  assert.ok(!(await cli()).includes('[stam]'));
});
