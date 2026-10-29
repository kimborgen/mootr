#!/usr/bin/env node
// S-3817: a tmux that stops answering no longer holds the daemon's event loop. Every synchronous tmux call gives up after
// the timeout (STAM_TMUX_TIMEOUT_MS here, 5 s by default). Where no answer must not read as gone, it reads as unknown:
// hasSession as present, isDead as alive, hasClients as attached, so a slow tmux never makes the daemon relaunch or rest a
// live harness, and killSession still stops the agent's processes. A fake tmux
// on PATH that hangs; no tmux server, no daemon: `node --test test/tmux-timeout.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmphome.mjs';

process.env.STAM_TMUX_SOCKET = `stam-test-timeout-${process.pid}`;
process.env.STAM_TMUX_TIMEOUT_MS = '300';
const dir = tempDir('stam-tmux-timeout-');
let tmux;
let path;
before(async () => {
  writeFileSync(join(dir, 'tmux'), '#!/bin/sh\nexec sleep 30\n');
  chmodSync(join(dir, 'tmux'), 0o755);
  path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  tmux = await import('../src/tmux.ts');
});
after(() => {
  process.env.PATH = path;
  rmSync(dir, { recursive: true, force: true });
});

// The call's result and how long it held the caller, in ms.
function timedCall(fn) {
  const at = Date.now();
  let out;
  try {
    out = { value: fn() };
  } catch (e) {
    out = { error: e };
  }
  return { ...out, ms: Date.now() - at };
}

test('a session tmux gives no answer about reads as present, alive and attached, within the timeout', () => {
  for (const [name, fn, want] of [['hasSession', () => tmux.hasSession('a1'), true], ['isDead', () => tmux.isDead('a1'), false], ['hasClients', () => tmux.hasClients('a1'), true]]) {
    const r = timedCall(fn);
    assert.equal(r.value, want, name);
    assert.ok(r.ms < 5000, `${name} held the caller ${r.ms} ms`);
  }
});

test('the other synchronous calls give up within the timeout', () => {
  const calls = {
    serverId: () => tmux.serverId(),
    capturePane: () => tmux.capturePane('a1'),
    sendKeys: () => tmux.sendKeys('a1', 'Enter'),
    paste: () => tmux.paste('a1', 'text'),
    cursor: () => tmux.cursor('a1'),
    snapshot: () => tmux.snapshot(),
    paneOwner: () => tmux.paneOwner('%1'),
    setWindowSize: () => tmux.setWindowSize('a1', 'latest'),
    resizeWindow: () => tmux.resizeWindow('a1', 80, 24),
    listShells: () => tmux.listShells(),
  };
  for (const [name, fn] of Object.entries(calls)) {
    const r = timedCall(fn);
    assert.ok(r.ms < 5000, `${name} held the caller ${r.ms} ms`);
  }
});

test('killSession gives up on a tmux that gives no answer and still finishes, without throwing', () => {
  const r = timedCall(() => tmux.killSession(`tmux-timeout-none-${process.pid}`));
  assert.equal(r.error, undefined, String(r.error));
  assert.ok(r.ms < 10000, `killSession held the caller ${r.ms} ms`);
});

// S-3841: the async twins give up in the same time, read no answer the same way, and leave the event loop free meanwhile.
test('the async tmux calls read no answer as the sync ones do, and never hold the event loop', async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 20);
  try {
    const at = Date.now();
    assert.equal(await tmux.hasSessionAsync('a1'), true, 'hasSessionAsync: present');
    for (const [name, fn] of Object.entries({
      capturePaneByNameAsync: () => tmux.capturePaneByNameAsync('a1'),
      capturePaneAnsiAsync: () => tmux.capturePaneAnsiAsync('a1'),
    }))
      await assert.rejects(fn(), /no answer/, `${name} fails rather than succeeding`);
    assert.ok(Date.now() - at < 9 * 300 + 3000, 'each call gave up within its timeout');
    assert.ok(ticks > 10, `the loop ran ${ticks} ticks while tmux hung`);
  } finally {
    clearInterval(timer);
  }
});
