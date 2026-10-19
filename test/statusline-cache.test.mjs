#!/usr/bin/env node
// Unit tests for the status line throttle (src/statusline-cache.ts, S-171): the user's status
// line runs at most once per 30 s per agent, and a refresh inside that time prints the saved
// output. Fixed clock, a temporary folder, no daemon: `node --test test/statusline-cache.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { throttled, statuslineTtl, STATUSLINE_TTL_MS, STATUSLINE_IDLE_TTL_MS } from '../src/statusline-cache.ts';
import { tempDir } from './tmphome.mjs';

const dir = tempDir('stam-statusline-');
const file = join(dir, 'statusline-agent1.out');
const T = 1_000_000;

test('the status line runs once, then its output is reused for 30 s', () => {
  let runs = 0;
  const run = () => (++runs, `line ${runs}\n`);
  // The first refresh runs it and saves the output.
  assert.equal(throttled(file, run, T), 'line 1\n');
  // Refreshes inside 30 s print the saved output, trailing newline included, and don't run it.
  assert.equal(throttled(file, run, T + 1_000), 'line 1\n');
  assert.equal(throttled(file, run, T + STATUSLINE_TTL_MS - 1), 'line 1\n');
  assert.equal(runs, 1);
  // At 30 s it runs again, and that output is the new saved one.
  assert.equal(throttled(file, run, T + STATUSLINE_TTL_MS), 'line 2\n');
  assert.equal(runs, 2);
  assert.equal(throttled(file, run, T + STATUSLINE_TTL_MS + 5_000), 'line 2\n');
  assert.equal(runs, 2);
});

test('a missing, broken, or future-dated file runs the status line and saves fresh output', () => {
  let runs = 0;
  const run = () => (++runs, 'fresh');
  writeFileSync(file, 'not a time\nold');
  assert.equal(throttled(file, run, T), 'fresh');
  writeFileSync(file, `${T + 60_000}\nfuture`);
  assert.equal(throttled(file, run, T), 'fresh');
  assert.equal(runs, 2);
  assert.equal(readFileSync(file, 'utf8'), `${T}\nfresh`);
});

test('the saved file holds the time and the output, and no temporary file is left behind', () => {
  const other = join(dir, 'statusline-agent2.out');
  throttled(other, () => 'hi', T);
  assert.equal(readFileSync(other, 'utf8'), `${T}\nhi`);
  assert.equal(existsSync(`${other}.tmp`), false);
});

test('an agent nobody views never runs again once it has output, a viewed one runs every 30 s, and an unknown one every 30 s', () => {
  assert.equal(statuslineTtl(false), STATUSLINE_IDLE_TTL_MS);
  assert.equal(statuslineTtl(true), STATUSLINE_TTL_MS);
  assert.equal(statuslineTtl(undefined), STATUSLINE_TTL_MS);
  // The idle agent runs once with no saved output, then its saved output is reused however long it waits.
  const idle = join(dir, 'statusline-idle.out');
  let runs = 0;
  const run = () => (++runs, `idle ${runs}\n`);
  const idleTtl = statuslineTtl(false);
  assert.equal(throttled(idle, run, T, idleTtl), 'idle 1\n');
  assert.equal(throttled(idle, run, T + STATUSLINE_TTL_MS + 1_000, idleTtl), 'idle 1\n');
  const DAY = 86_400_000;
  assert.equal(throttled(idle, run, T + 365 * DAY, idleTtl), 'idle 1\n');
  assert.equal(runs, 1);
  // Once the agent is viewed again, its ttl is 30 s, so the next refresh runs it.
  assert.equal(throttled(idle, run, T + 365 * DAY, statuslineTtl(true)), 'idle 2\n');
  assert.equal(runs, 2);
  // A viewed agent's output is run again after 30 s, as before.
  const seen = join(dir, 'statusline-seen.out');
  let seenRuns = 0;
  const seenRun = () => (++seenRuns, 'seen');
  throttled(seen, seenRun, T, statuslineTtl(true));
  throttled(seen, seenRun, T + STATUSLINE_TTL_MS, statuslineTtl(true));
  assert.equal(seenRuns, 2);
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
