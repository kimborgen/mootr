#!/usr/bin/env node
// The shell fast path for `stam hook` and `stam statusline` (bin/stam-fast, reached through
// bin/stam) against the node CLI it replaces: the same stdout bytes, the same exit code,
// and the same request body, and no node started at all. A stub daemon in this process
// answers the two routes, so nothing touches the live daemon. The children are spawned
// asynchronously, so the stub keeps answering while they run. Free, no daemon, no models.
// Run with `node --test test/fastpath.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmphome.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STAM = join(ROOT, 'bin', 'stam');
const CLI = join(ROOT, 'src', 'cli.ts');
const TOKEN = 'test-token';
// Quotes, tabs, a backslash, and trailing newlines: the bytes jq or python3 must not mangle.
const NOTICE = 'line one\nline "two"\ttab\\back\nuni ✓ end\n\n';

let home, url, requests, reply;
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    requests.push({ method: req.method, path: req.url, body: Buffer.concat(chunks).toString('utf8'), auth: req.headers.authorization });
    const r = reply() ?? { status: 200, body: '{}' };
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(r.body);
  });
});

before(async () => {
  home = tempDir('stam-fastpath-');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  rmSync(home, { recursive: true, force: true });
});

// A spawn environment pointing at the stub, with the caller's own (live) STAM_* dropped.
function env(extra = {}) {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (k.startsWith('STAM_')) delete e[k];
  Object.assign(e, { STAM_URL: url, STAM_TOKEN: TOKEN, STAM_HOME: home, STAM_AGENT_ID: 'agent1' }, extra);
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete e[k];
  return e;
}
const invoke = (bin, args, input, extra) =>
  new Promise((resolve) => {
    const child = spawn(bin, args, { env: env(extra), cwd: ROOT });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (d) => stdout.push(d));
    child.stderr.on('data', (d) => stderr.push(d));
    child.on('close', (status) => resolve({ status, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
    child.stdin.end(input);
  });
const oldPath = (args, input, extra) => invoke(process.execPath, ['--no-warnings', CLI, ...args], input, extra);
const fastPath = (args, input, extra) => invoke(STAM, args, input, extra);
// The payloads the stub received, as a daemon would parse them.
const bodies = () => requests.map((r) => JSON.parse(r.body));

test('hook: the notice comes out byte for byte', async () => {
  requests = [];
  reply = () => ({ status: 200, body: JSON.stringify({ stdout: NOTICE }) });
  const input = Buffer.from(JSON.stringify({ hook_event_name: 'Stop', tool_input: { note: 'hello\nworld' } }));
  const old = await oldPath(['hook', 'claude'], input);
  const fast = await fastPath(['hook', 'claude'], input);
  assert.equal(old.status, 0);
  assert.equal(fast.status, 0);
  assert.deepEqual(fast.stdout, old.stdout);
  assert.deepEqual(fast.stdout, Buffer.from(NOTICE));
  assert.deepEqual(old.stderr, Buffer.alloc(0));
  assert.deepEqual(fast.stderr, Buffer.alloc(0));
  assert.equal(requests.length, 2);
  for (const r of requests) {
    assert.equal(r.method, 'POST');
    assert.equal(r.path, '/api/hook/claude/agent1');
    assert.equal(r.auth, `Bearer ${TOKEN}`);
  }
  assert.deepEqual(bodies()[0], bodies()[1]);
});

test('hook: no notice means no output', async () => {
  requests = [];
  reply = () => ({ status: 200, body: '{}' });
  const input = Buffer.from('{"hook_event_name":"PreToolUse"}');
  const old = await oldPath(['hook', 'claude'], input);
  const fast = await fastPath(['hook', 'claude'], input);
  assert.equal(fast.status, 0);
  assert.deepEqual(fast.stdout, old.stdout);
  assert.deepEqual(fast.stdout, Buffer.alloc(0));
  assert.equal(requests.length, 2);
});

test('hook: a daemon error is silent and exits 0', async () => {
  requests = [];
  reply = () => ({ status: 500, body: '{"error":"boom"}' });
  const input = Buffer.from('{"hook_event_name":"Stop"}');
  const fast = await fastPath(['hook', 'claude'], input);
  assert.equal(fast.status, 0);
  assert.deepEqual(fast.stdout, Buffer.alloc(0));
  assert.deepEqual(fast.stderr, Buffer.alloc(0));
});

test('hook: no STAM_AGENT_ID never reaches the daemon', async () => {
  requests = [];
  reply = () => ({ status: 200, body: JSON.stringify({ stdout: NOTICE }) });
  const input = Buffer.from('{"hook_event_name":"Stop"}');
  const old = await oldPath(['hook', 'claude'], input, { STAM_AGENT_ID: undefined });
  const fast = await fastPath(['hook', 'claude'], input, { STAM_AGENT_ID: undefined });
  assert.equal(fast.status, 0);
  assert.deepEqual(fast.stdout, old.stdout);
  assert.deepEqual(fast.stdout, Buffer.alloc(0));
  assert.equal(requests.length, 0);
});

test('statusline: the user status line is forwarded byte for byte', async () => {
  requests = [];
  reply = () => ({ status: 200, body: '{}' });
  const input = Buffer.from('{"session_id":"s","context_window":{"used_percentage":7}}');
  const extra = { STAM_USER_STATUSLINE: "printf 'hello\\nworld\\n'" };
  const old = await oldPath(['statusline', 'claude'], input, extra);
  const fast = await fastPath(['statusline', 'claude'], input, extra);
  assert.equal(fast.status, 0);
  assert.deepEqual(fast.stdout, old.stdout);
  assert.deepEqual(fast.stdout, Buffer.from('[stam agent1] hello\nworld\n'));
  assert.deepEqual(bodies()[0], bodies()[1]);
  assert.equal(requests[0].path, '/api/statusline/claude/agent1');
});

test('statusline: no user status line leaves the stam prefix', async () => {
  requests = [];
  reply = () => ({ status: 200, body: '{}' });
  const input = Buffer.from('{"session_id":"s"}');
  const old = await oldPath(['statusline', 'claude'], input);
  const fast = await fastPath(['statusline', 'claude'], input);
  assert.deepEqual(fast.stdout, old.stdout);
  assert.deepEqual(fast.stdout, Buffer.from('[stam agent1] '));
});

test('statusline: no STAM_AGENT_ID reports nothing and prints "?"', async () => {
  requests = [];
  reply = () => ({ status: 200, body: '{}' });
  const input = Buffer.from('{"session_id":"s"}');
  const extra = { STAM_AGENT_ID: undefined, STAM_USER_STATUSLINE: 'printf x' };
  const old = await oldPath(['statusline', 'claude'], input, extra);
  const fast = await fastPath(['statusline', 'claude'], input, extra);
  assert.deepEqual(fast.stdout, old.stdout);
  assert.deepEqual(fast.stdout, Buffer.from('[stam ?] x'));
  assert.equal(requests.length, 0);
});

test('statusline: the user command’s stderr is discarded, as the node path did', async () => {
  requests = [];
  reply = () => ({ status: 200, body: '{}' });
  const input = Buffer.from('{"session_id":"s"}');
  const extra = { STAM_USER_STATUSLINE: "sh -c 'echo oops >&2; printf ok'" };
  const old = await oldPath(['statusline', 'claude'], input, extra);
  const fast = await fastPath(['statusline', 'claude'], input, extra);
  assert.deepEqual(fast.stdout, old.stdout);
  assert.deepEqual(fast.stderr, Buffer.alloc(0));
  assert.deepEqual(fast.stdout, Buffer.from('[stam agent1] ok'));
});

// The whole point: the two commands must not start node at all. A fake `node` first on PATH
// fails loudly, so the fast path is proven to be the one that ran.
const haveFast =
  spawnSync('sh', ['-c', 'command -v curl >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1 && { command -v jq >/dev/null 2>&1 || command -v python3 >/dev/null 2>&1; }']).status === 0;
test('the fast path never starts node', { skip: !haveFast && 'curl, timeout, or a JSON parser is missing' }, async () => {
  const fake = join(home, 'fakebin');
  mkdirSync(fake, { recursive: true });
  writeFileSync(join(fake, 'node'), '#!/bin/sh\necho "NODE WAS STARTED" >&2\nexit 99\n');
  chmodSync(join(fake, 'node'), 0o755);
  const path = `${fake}:${process.env.PATH}`;
  reply = () => ({ status: 200, body: JSON.stringify({ stdout: NOTICE }) });
  const hook = await fastPath(['hook', 'claude'], Buffer.from('{}'), { PATH: path });
  assert.equal(hook.status, 0);
  assert.ok(!hook.stderr.toString().includes('NODE WAS STARTED'), hook.stderr.toString());
  assert.deepEqual(hook.stdout, Buffer.from(NOTICE));
  // Its own agent id: the user status line's output is saved per agent for 30 s (S-171), and the
  // tests above already saved agent1's.
  const line = await fastPath(['statusline', 'claude'], Buffer.from('{}'), { PATH: path, STAM_AGENT_ID: 'agent-node', STAM_USER_STATUSLINE: 'printf hi' });
  assert.equal(line.status, 0);
  assert.ok(!line.stderr.toString().includes('NODE WAS STARTED'), line.stderr.toString());
  assert.deepEqual(line.stdout, Buffer.from('[stam agent-node] hi'));
});

// With no JSON parser on PATH the fast path steps aside for the node CLI, and the output is
// still the notice. The whole PATH is rebuilt from a few symlinks, so jq and python3 are
// genuinely absent.
test('without jq or python3 it falls back to the node CLI', async () => {
  const bin = join(home, 'minbin');
  mkdirSync(bin, { recursive: true });
  const tools = ['readlink', 'dirname', 'mktemp', 'cat', 'rm', 'curl', 'node'];
  const paths = tools.map((t) => spawnSync('sh', ['-c', `command -v ${t}`]).stdout.toString().trim());
  if (paths.some((p) => !p)) return; // one of them isn't installed here; nothing to prove
  for (let i = 0; i < tools.length; i++) symlinkSync(paths[i], join(bin, tools[i]));
  requests = [];
  reply = () => ({ status: 200, body: JSON.stringify({ stdout: NOTICE }) });
  const fast = await fastPath(['hook', 'claude'], Buffer.from('{}'), { PATH: bin });
  assert.equal(fast.status, 0);
  assert.deepEqual(fast.stdout, Buffer.from(NOTICE));
});
