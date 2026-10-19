#!/usr/bin/env node
// `stam activity --classify-model` (S-252): starts the backfill, then polls its progress every 3 s
// until it stops, printing each line; a 403 keeps the human-only message. A stub daemon answers
// the POST and two GETs (running, then stopped), so no daemon, no network, no model.
// Run with `node --test test/activity-classify-cli.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDir } from './tmphome.mjs';

const running = { running: true, labelled: 2, failed: 0, remaining: 3, stopped: null, capped: false, concurrency: 4, lastError: null };
const stopped = { ...running, running: false, labelled: 5, remaining: 0, stopped: 'done' };

// Runs the CLI against a stub that answers `gets` in order (the last one repeats) and `postStatus`.
function run(gets, postStatus = 200) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.method === 'POST') return res.writeHead(postStatus, { 'content-type': 'application/json' }).end(postStatus === 200 ? '{"started":true}' : '{"error":"only the human can classify activity with the model"}');
    const body = gets.length > 1 ? gets.shift() : gets[0];
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const home = tempDir('stam-classify-cli-');
      const env = { ...process.env, STAM_HOME: home, STAM_URL: `http://127.0.0.1:${server.address().port}`, STAM_TOKEN: 'test' };
      const child = spawn(process.execPath, ['--no-warnings', 'src/cli.ts', 'activity', '--classify-model'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (err += c));
      child.on('close', (code) => {
        server.close();
        rmSync(home, { recursive: true, force: true });
        resolve({ code, out, err, seen });
      });
    });
  });
}

test('activity --classify-model > starts, then prints progress until it stops', async () => {
  const r = await run([running, stopped]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.out.trim().split('\n'), ['started', '2 labelled · 3 left', '5 labelled · 0 left · stopped: done']);
  assert.equal(r.seen[0], 'POST /api/activity/classify-model');
});

test('activity --classify-model > a 403 keeps the human-only message', async () => {
  const r = await run([running], 403);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /only the human can start it/);
  assert.equal(r.seen.length, 1);
});
