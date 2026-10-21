#!/usr/bin/env node
// `stam events AGENT --type GLOB --limit N` (S-2451): the reader keeps an event past the default 50 when a type is
// asked for, so input:screen events stay readable for days, and the CLI passes both filters to the daemon. The
// default read is still the latest 50 of every type. No daemon: the reader runs on a throwaway STAM_HOME, and the
// CLI talks to a stub daemon that records each request. Run with `node --test test/event-log.test.mjs`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { tempHome, tempDir } from './tmphome.mjs';

const home = tempHome('stam-event-log-');
process.env.STAM_HOME = home;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let db;
before(async () => {
  db = await import('../src/db.ts');
});

// An input:screen event eight days old, then 60 newer events of other types: past the default window of 50.
function seed(agent) {
  db.open().prepare('INSERT INTO events (agent_id, ts, type, data) VALUES (?, ?, ?, ?)')
    .run(agent, new Date(Date.now() - 8 * 86400_000).toISOString(), 'input:screen', JSON.stringify({ what: 'suggest_input failed' }));
  for (let i = 0; i < 60; i++) db.addEvent(agent, i % 2 ? 'hook:Stop' : 'state', { i });
}

test('the default read is the latest 50 events of every type', () => {
  seed('a1');
  const got = db.listEvents('a1');
  assert.equal(got.length, 50);
  assert.ok(!got.some((e) => e.type === 'input:screen'));
  assert.equal(JSON.parse(got.at(-1).data).i, 59);
});

test('a type GLOB reads its events past the default window, oldest first', () => {
  seed('a2');
  const got = db.listEvents('a2', 50, 'input:*');
  assert.equal(got.length, 1);
  assert.equal(got[0].type, 'input:screen');
  assert.match(got[0].data, /suggest_input failed/);
  assert.ok(Date.parse(got[0].ts) < Date.now() - 7 * 86400_000);
});

test('a type GLOB and a limit cap the matches, and other agents are not read', () => {
  for (let i = 0; i < 5; i++) db.addEvent('a3', 'input:screen', { i });
  db.addEvent('a3', 'hook:Stop', {});
  db.addEvent('other', 'input:screen', { i: 99 });
  const got = db.listEvents('a3', 3, 'input:*').map((e) => JSON.parse(e.data).i);
  assert.deepEqual(got, [2, 3, 4]);
  assert.deepEqual(db.listEvents('a3', 2, 'hook:*').map((e) => e.type), ['hook:Stop']);
});

// Runs `stam ...args` against a stub daemon that answers every request with an empty list; resolves with the requests.
function cli(args) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' }).end('[]');
  });
  const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const cliHome = tempDir('stam-event-log-cli-');
      const env = { ...process.env, STAM_HOME: cliHome, STAM_URL: `http://127.0.0.1:${server.address().port}`, STAM_TOKEN: 'test' };
      const child = spawn(process.execPath, ['--no-warnings', CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      child.stderr.on('data', (c) => (err += c));
      child.on('error', reject);
      child.on('close', (code) => {
        server.close();
        resolve({ code, err, seen });
      });
    });
  });
}

test('stam events sends --type and --limit to the daemon', async () => {
  const r = await cli(['events', 'agent1', '--type', 'input:*', '--limit', '20']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.seen, ['/api/agents/agent1/events?type=input%3A*&limit=20']);
});

test('stam events with no filter reads the default window', async () => {
  const r = await cli(['events', 'agent1']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.seen, ['/api/agents/agent1/events']);
});
