#!/usr/bin/env node
// Unit test for `stam mcp` re-exec'ing onto releases/current while idle (S-811, mcp.ts
// reexecWhenIdle): a server started from release A, once `current` moves to B, replaces itself
// with B's server in the same process, keeping stdin/stdout and the initialized session. A
// request in flight, or a line half read, holds the exec back until it is done. The exec goes only
// to a release that adopts a session (ADOPTS_SESSION) and whose server answered as a canary.
// Releases are copies of this checkout under a throwaway STAM_HOME, with a fake daemon for the
// stream and read_mail; no network, no models:
// `node --test test/mcp-reexec.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempHome } from './tmphome.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A release that adds one tool to the catalogue.
function release(R, name, tool, edit = (src) => src) {
  const dir = join(R, name);
  mkdirSync(dir, { recursive: true });
  for (const d of ['bin', 'src', 'templates', 'package.json']) cpSync(join(root, d), join(dir, d), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
  const src = edit(readFileSync(join(dir, 'src/mcp.ts'), 'utf8')).replace('export const tools: Tool[] = [\n', `export const tools: Tool[] = [\n  ${tool},\n`);
  assert.notEqual(src, readFileSync(join(root, 'src/mcp.ts'), 'utf8'));
  writeFileSync(join(dir, 'src/mcp.ts'), src);
  return dir;
}
// Says which process, started from which release, answers.
const WHERE = "{ name: 'where', group: 'agents', description: 'Where this server runs.', inputSchema: { type: 'object', properties: {} }, run: async () => json({ pid: process.pid, argv1: process.argv[1], session: process.env.STAM_MCP_SESSION ?? null }) }";
// Writes `started` in STAM_HOME, then answers once `go` exists there.
const SLOW =
  "{ name: 'slow', group: 'agents', description: 'Waits for go.', inputSchema: { type: 'object', properties: {} }, run: async () => { const fs = await import('node:fs'); fs.writeFileSync(process.env.STAM_HOME + '/started', ''); while (!fs.existsSync(process.env.STAM_HOME + '/go')) await new Promise((r) => setTimeout(r, 20)); return json({ argv1: process.argv[1] }); } }";

// A daemon with just what the shim calls: the agent's event stream, read_mail, and step checks.
async function fakeDaemon(t) {
  const d = { streams: [], connects: 0, reads: [] };
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const reply = (v) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v));
      if (req.url === '/api/agents/ag1/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(':\n\n');
        d.connects++;
        d.streams.push(res);
        res.on('close', () => d.streams.splice(d.streams.indexOf(res), 1));
      } else if (req.url === '/api/agents/ag1/read') {
        d.reads.push(JSON.parse(body));
        reply([]);
      } else if (req.url === '/api/steps/check') reply({ allow: true });
      else reply({});
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => {
    for (const s of d.streams) s.destroy();
    srv.close();
  });
  d.url = `http://127.0.0.1:${srv.address().port}`;
  return d;
}

function server({ edit, daemon } = {}) {
  const home = tempHome('stam-mcp-reexec-');
  const R = join(home, 'releases');
  const A = release(R, 'A', SLOW);
  const B = release(R, 'B', WHERE, edit);
  const point = (name) => spawnSync('ln', ['-sfn', name, join(R, 'current')]);
  point('A');
  const env = { ...process.env, STAM_HOME: home, STAM_PORT: '1', STAM_URL: daemon?.url ?? 'http://127.0.0.1:1', STAM_MCP_REEXEC_MS: '50', STAM_TOKEN: 't' };
  for (const k of ['STAM_AGENT_ID', 'STAM_RELEASE_ID', 'STAM_MCP_SESSION', 'STAM_MCP_READ_ACK', 'STAM_MCP_CANARY']) delete env[k];
  if (daemon) env.STAM_AGENT_ID = 'ag1';
  const child = spawn(join(R, 'current/bin/stam'), ['mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const notices = [];
  const channel = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (m.method) notices.push(m.method);
      if (m.method === 'notifications/claude/channel') channel.push(m.params.content);
      else pending.get(m.id)?.(m);
    }
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  let next = 1;
  const request = (method, params = {}) =>
    new Promise((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const call = async (name) => JSON.parse((await request('tools/call', { name, arguments: {} })).result.content[0].text);
  const cmdline = () => readFileSync(`/proc/${child.pid}/cmdline`, 'utf8');
  const until = async (what, ok) => {
    const deadline = Date.now() + 20_000;
    while (!ok()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; stderr: ${stderr}`);
      await sleep(20);
    }
  };
  return { home, A, B, point, child, request, call, notices, channel, cmdline, until, stderr: () => stderr };
}

const onB = (s) => /\/releases\/B\/bin\/\.\.\/src\/cli\.ts/.test(s.cmdline());

test('an idle server whose release is no longer current re-execs onto it and keeps its session', async (t) => {
  const daemon = await fakeDaemon(t);
  const s = server({ daemon });
  t.after(() => s.child.kill());
  const init = await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: { roots: {} }, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.match(s.cmdline(), /\/releases\/A\//);
  await s.until('the stream to open', () => daemon.streams.length === 1);
  await s.request('tools/call', { name: 'read_mail', arguments: {} });
  assert.equal(daemon.reads.length, 1);

  s.point('B');
  await s.until('the exec onto B', () => onB(s));
  // Same process, same pipes, no second initialize: B answers tool calls straight away.
  const where = await s.call('where');
  assert.equal(where.pid, s.child.pid);
  assert.equal(where.argv1, join(s.B, 'src/cli.ts'));
  assert.equal(where.session, null, 'the handed-over session is not left in the environment');
  assert.ok(s.notices.includes('notifications/tools/list_changed'), 'the new server tells the harness to list its tools again');
  const names = (await s.request('tools/list')).result.tools.map((x) => x.name);
  assert.ok(names.includes('where') && !names.includes('slow'), "B's catalogue");
  assert.match(s.stderr(), /moving from .*releases\/A to .*releases\/B/);

  // The new server opens the stream again (the canary never did), and its events reach the harness.
  await s.until('the stream to reopen', () => daemon.connects === 2 && daemon.streams.length === 1);
  daemon.streams[0].write(`data: ${JSON.stringify({ content: 'after the exec', meta: {} })}\n\n`);
  await s.until('the channel notice', () => s.channel.includes('after the exec'));
  // The read acknowledgement crossed the exec: the next read acks the batch read before it.
  await s.request('tools/call', { name: 'read_mail', arguments: {} });
  assert.equal(daemon.reads[1].ack, daemon.reads[0].batch);
  assert.ok(daemon.reads[0].batch);
});

test('a release that does not adopt a session is not exec\'d onto', async (t) => {
  const s = server({ edit: (src) => src.replace('export const ADOPTS_SESSION = 1;\n', '') });
  t.after(() => s.child.kill());
  assert.doesNotMatch(readFileSync(join(s.B, 'src/mcp.ts'), 'utf8'), /export const ADOPTS_SESSION/);
  await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  s.point('B');
  await s.until('the refusal', () => /doesn't adopt a running session/.test(s.stderr()));
  assert.match(s.cmdline(), /\/releases\/A\//);
  // B's tools still serve, from this process.
  assert.equal((await s.call('where')).argv1, join(s.A, 'src/cli.ts'));
});

test("a release whose server fails as a canary leaves the shim on its own, until it answers", async (t) => {
  const s = server();
  t.after(() => s.child.kill());
  await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  // B's tools load, but its server doesn't start.
  const bin = join(s.B, 'bin/stam');
  writeFileSync(bin, '#!/bin/sh\nexit 1\n');
  s.point('B');
  await s.until('the failed canary', () => /didn't answer \(try 1\)/.test(s.stderr()));
  assert.match(s.cmdline(), /\/releases\/A\//);
  assert.equal((await s.call('where')).argv1, join(s.A, 'src/cli.ts'), 'the shim keeps working');
  // Fixed, it is tried again (after 1 s, then backing off) and the shim moves.
  cpSync(join(root, 'bin/stam'), bin);
  chmodSync(bin, 0o755);
  await s.until('the exec onto B', () => onB(s));
  assert.equal((await s.call('where')).argv1, join(s.B, 'src/cli.ts'));
});

test('a request in flight, or a half-read line, holds the exec until it is done', async (t) => {
  const s = server();
  t.after(() => s.child.kill());
  await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });

  const slow = s.call('slow');
  // The call reached A's tool before `current` moves (it waits on `go`).
  await s.until("A's slow tool to start", () => existsSync(join(s.home, 'started')));
  s.point('B');
  // Many re-exec checks (every 50 ms) pass while the call is in flight; none may exec.
  await sleep(500);
  assert.match(s.cmdline(), /\/releases\/A\//, 'no exec while a request is in flight');
  // Half a line on stdin also holds it.
  const id = 99;
  const line = JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });
  s.child.stdin.write(line.slice(0, 10));
  writeFileSync(join(s.home, 'go'), '');
  const done = await slow;
  assert.equal(done.argv1, join(s.A, 'src/cli.ts'), "the in-flight call finished on A, and its answer arrived");
  await sleep(500);
  assert.match(s.cmdline(), /\/releases\/A\//, 'no exec in the middle of a line');
  const listed = new Promise((resolve) => {
    // The rest of the line completes the request; its answer comes from either side of the exec.
    s.child.stdout.on('data', (d) => String(d).includes(`"id":${id}`) && resolve());
  });
  s.child.stdin.write(line.slice(10) + '\n');
  await listed;

  await s.until('the exec onto B', () => onB(s));
  assert.equal((await s.call('where')).argv1, join(s.B, 'src/cli.ts'));
});
