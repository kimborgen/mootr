#!/usr/bin/env node
// settings() is memoized (S-344, src/settings.ts): two reads without a change parse the file once; an
// external change (mtime or size) and a write through stam both show at the next read, and the value
// can't be changed by a caller. Throwaway STAM_HOME, no daemon: `node --test test/settings-memo.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-settings-memo-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `settings-memo-test-${process.pid}`;
const file = join(home, 'settings.json');
const write = (cfg) => writeFileSync(file, JSON.stringify({ peers: [], context: { warnTokens: cfg } }, null, 2));
write(100);
const s = await import('../src/settings.ts');

test('two reads without a change parse the file once', () => {
  const before = s.settingsReads();
  const a = s.settings();
  const b = s.settings();
  assert.equal(s.settingsReads() - before <= 1, true);
  assert.equal(a, b);
  assert.equal(a.context.warnTokens, 100);
});

test('an external change to the file shows at the next read', () => {
  // Same size, a later mtime: the stat key changes, so the file is read again.
  write(200);
  utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  assert.equal(s.settings().context.warnTokens, 200);
});

test('a write through stam shows at once, with no stat change needed', () => {
  s.setSetting('context', { ...s.settings().context, warnTokens: 300 });
  assert.equal(s.settings().context.warnTokens, 300);
});

test('a raw save the daemon makes is seen at once, even with the same size and mtime', () => {
  // The daemon's raw save (PUT /api/config/settings) writes the file and calls settingsChanged; with the
  // stat unchanged, only that call makes the next read see the new value.
  const st = s.settings();
  const at = new Date(Date.now() + 9000);
  writeFileSync(file, JSON.stringify({ peers: [], context: { warnTokens: 400 } }, null, 2).replace('400', '999'));
  utimesSync(file, at, at);
  s.settingsChanged();
  assert.equal(s.settings().context.warnTokens, 999);
  assert.notEqual(st, s.settings());
});

test('a failed read is not cached: once the file is readable again, it shows', () => {
  // chmod changes neither size nor mtime; the ctime and the failed read keep the wrong value out of the cache.
  write(777);
  chmodSync(file, 0o000);
  let during;
  try {
    during = s.settings().context.warnTokens;
  } finally {
    chmodSync(file, 0o644);
  }
  assert.notEqual(during, 777);
  assert.equal(s.settings().context.warnTokens, 777);
});

test('callers cannot change the value the next caller reads', () => {
  const v = s.settings();
  const before = v.context.warnTokens;
  assert.throws(() => {
    'use strict';
    v.context.warnTokens = 1;
  }, TypeError);
  assert.equal(s.settings().context.warnTokens, before);
});
