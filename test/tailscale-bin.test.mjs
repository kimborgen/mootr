#!/usr/bin/env node
// Tailscale is optional (S-2121): with no tailscale binary on PATH, the daemon and `stam web` skip their
// tailscale calls. A fake tailscale on PATH logs each call, so the same command shows it is called only when
// one is there. No daemon, no network: `node --test test/tailscale-bin.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tempDir, tempHome } from './tmphome.mjs';

const { hasTailscale } = await import('../src/tailscale.ts');
const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

test('hasTailscale finds only an executable tailscale on PATH, and keeps the answer a minute', () => {
  const none = tempDir('stam-ts-none-');
  const plain = tempDir('stam-ts-plain-');
  writeFileSync(join(plain, 'tailscale'), '');
  const bin = tempDir('stam-ts-bin-');
  writeFileSync(join(bin, 'tailscale'), '#!/bin/sh\n');
  chmodSync(join(bin, 'tailscale'), 0o755);
  assert.equal(hasTailscale('', 0), false);
  assert.equal(hasTailscale(none, 0), false);
  assert.equal(hasTailscale(`${none}:${plain}`, 0), false, 'a file that is not executable is no binary');
  assert.equal(hasTailscale(`${none}::${bin}`, 0), true);
  // Kept a minute for the same PATH: an uninstall shows up after it, or at once under another PATH.
  rmSync(join(bin, 'tailscale'));
  assert.equal(hasTailscale(`${none}::${bin}`, 59_000), true);
  assert.equal(hasTailscale(`${none}::${bin}`, 61_000), false);
  assert.equal(hasTailscale(bin, 61_000), false);
});

// stam web on PATH=DIR, as the CLI runs it; DIR holds no tailscale, or the logging fake.
function web(dir, ...args) {
  const home = tempHome('stam-ts-web-');
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ auth: { localHuman: true } }));
  const r = spawnSync(process.execPath, ['--no-warnings', CLI, 'web', ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: dir, STAM_HOME: home, STAM_TOKEN: 'tok', STAM_PORT: '7999', STAM_TMUX_SOCKET: `tailscale-bin-test-${process.pid}`, STAM_MACHINE: 'testbox' },
  });
  return { ...r, home };
}

test('stam web with no tailscale prints only this machine, and serve says what it needs', () => {
  const none = tempDir('stam-ts-none-');
  const r = web(none);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^http:\/\/127\.0\.0\.1:7999\/ .*one-time command/m);
  assert.deepEqual(r.stdout.match(/^https?:\/\/[^/ ]+/gm), ['http://127.0.0.1:7999', 'http://127.0.0.1:7999']);
  const s = web(none, 'serve');
  assert.equal(s.status, 1);
  assert.match(s.stderr, /stam web serve needs tailscale on PATH/);
});

test('stam web with a tailscale on PATH asks it for serve and the bind address', () => {
  const bin = tempDir('stam-ts-bin-');
  const log = join(bin, 'calls');
  writeFileSync(join(bin, 'tailscale'), `#!/bin/sh\necho "$*" >>${log}\n[ "$1 $2" = "serve status" ] && echo '{}'\n[ "$1" = ip ] && echo 192.0.2.9\nexit 0\n`);
  chmodSync(join(bin, 'tailscale'), 0o755);
  const r = web(bin);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(log));
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['serve status --json', 'ip -4']);
  assert.match(r.stdout, /^http:\/\/192\.0\.2\.9:7999\/#token=tok/m);
});
