#!/usr/bin/env node
// Local human login (S-613): codes root vouches for with coreutils (`install -D`) and in-memory sessions. A
// folder in a temporary home stands in for /run/stam-human, and this user's uid stands in for root, except
// where a test checks that a file this user owns is refused. No daemon: `node --test test/local-human.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// A marked test home (src/test-env.ts, S-634): the marker in the home and an owner file beside it, as
// test/lib.sh's daemon_home makes them. Without both the test switches below do nothing.
const tmp = mkdtempSync(join(tmpdir(), 'stam-local-human-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
const home = join(tmp, 'home');
mkdirSync(home);
writeFileSync(join(home, '.stam-test-home'), '');
writeFileSync(join(tmp, 'owner'), 'agent=local-human.test\n');
process.env.STAM_HOME = home;
const dir = join(home, 'codes');
process.env.STAM_TEST_HUMAN_CODE_DIR = dir;
const me = process.getuid();
// A strict umask, which sudo keeps: the command sets the folders' mode itself, so it doesn't matter.
process.umask(0o077);
const asRoot = () => (process.env.STAM_TEST_HUMAN_CODE_ROOT_UID = String(me));
asRoot();
const lh = await import('../src/local-human.ts');

// A page's secret and the name root vouches for, as the login page draws them.
const pair = () => { const secret = randomBytes(16).toString('base64url'); return { secret, name: lh.nameOf(secret) }; };
// What the human runs as root (this user stands in for root): the page's command, coreutils only.
const vouch = (name, uid = me) => {
  const sub = join(dir, String(uid));
  for (const args of [['-d', '-m', '755', dir, sub], ['-m', '644', '/dev/null', join(sub, name)]]) {
    const r = spawnSync('/usr/bin/install', args, { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
};

test('the name is the first 128 bits of the SHA-256, base32 (the web page computes the same)', () => {
  assert.equal(lh.nameOf('AAAAAAAAAAAAAAAAAAAAAA'), 'rjn5wtgbkfsbe3do6jti32o5eq');
  assert.equal(lh.userDir(), join(dir, String(me)));
});

test('a vouched-for secret logs in once; the name alone, which the terminal shows, never does', () => {
  const { secret, name } = pair();
  vouch(name);
  assert.equal(lh.redeemCode(name), 'not a login secret');
  assert.equal(lh.redeemCode(secret), undefined);
  assert.match(lh.redeemCode(secret), /already used/);
});

test('a code older than 5 minutes, one made before the daemon started, another user\'s, and a made-up secret are refused', () => {
  const late = pair();
  vouch(late.name);
  assert.match(lh.redeemCode(late.secret, Date.now() + lh.CODE_TTL_MS + 1000), /expired/);
  const old = pair();
  vouch(old.name);
  assert.match(lh.redeemCode(old.secret, Date.now(), Date.now() + 1000), /before stam started/);
  const other = pair();
  vouch(other.name, me + 1);
  assert.match(lh.redeemCode(other.secret), /no such code/);
  assert.match(lh.redeemCode('A'.repeat(22)), /no such code/);
  assert.match(lh.redeemCode('../../etc/passwd'), /not a login secret/);
  assert.match(lh.redeemCode(undefined), /not a login secret/);
});

test("a code file this user owns, not root, is refused: an agent can't make its own", () => {
  const { secret, name } = pair();
  vouch(name);
  // The file and folders are this user's (the stand-in for root made them); with root back to uid 0 they no longer count.
  process.env.STAM_TEST_HUMAN_CODE_ROOT_UID = '0';
  try {
    assert.match(lh.redeemCode(secret), /only root can write/);
  } finally {
    asRoot();
  }
  // Still unused: the refusal didn't spend it.
  assert.equal(lh.redeemCode(secret), undefined);
});

test("a folder stam can't read says so, and running the command again fixes it", () => {
  const { secret, name } = pair();
  vouch(name);
  chmodSync(lh.userDir(), 0o000);
  try {
    assert.match(lh.redeemCode(secret), /can't read .*run the command again/);
  } finally {
    chmodSync(lh.userDir(), 0o755);
  }
  chmodSync(dir, 0o000);
  try {
    assert.match(lh.redeemCode(secret), /can't read .*run the command again/);
  } finally {
    chmodSync(dir, 0o755);
  }
  chmodSync(lh.userDir(), 0o700);
  vouch(pair().name);
  assert.equal(statSync(lh.userDir()).mode & 0o777, 0o755, 'install -d -m 755 resets an existing folder');
  assert.equal(lh.redeemCode(secret), undefined);
});

test('a folder or file others can write, or a symlinked code file, is refused', () => {
  const { secret, name } = pair();
  vouch(name);
  for (const d of [dir, lh.userDir()]) {
    chmodSync(d, 0o777);
    try {
      assert.match(lh.redeemCode(secret), /only root can write/);
    } finally {
      chmodSync(d, 0o755);
    }
  }
  chmodSync(join(lh.userDir(), name), 0o666);
  assert.match(lh.redeemCode(secret), /isn't root's/);
  writeFileSync(join(home, 'forged'), '');
  const fake = pair();
  symlinkSync(join(home, 'forged'), join(lh.userDir(), fake.name));
  assert.match(lh.redeemCode(fake.secret), /no such code/);
});

test('a session lives 12 hours, until it is ended, or until all end', () => {
  const now = Date.now();
  const a = lh.startSession(now);
  assert.equal(a.expires, now + lh.SESSION_TTL_MS);
  assert.ok(lh.sessionLive(a.token, now + 1));
  assert.ok(!lh.sessionLive(a.token, a.expires));
  assert.ok(!lh.sessionLive(a.token, now + 1), 'an expired session is gone');
  const b = lh.startSession(now);
  assert.ok(!lh.sessionLive(b.token + 'x', now));
  assert.ok(!lh.sessionLive(undefined, now));
  assert.ok(lh.endSession(b.token));
  assert.ok(!lh.sessionLive(b.token, now));
  const c = lh.startSession(now);
  lh.endAll();
  assert.ok(!lh.sessionLive(c.token, now));
});

test('a session token is read from the Bearer, and from ?token= only for an attachment (a terminal socket uses a ticket, S-742)', () => {
  assert.equal(lh.sessionToken('GET', '/api/agents', 'Bearer abc'), 'abc');
  assert.equal(lh.sessionToken('GET', '/api/agents?token=abc', undefined), undefined);
  assert.equal(lh.sessionToken('POST', '/api/mail/m1/attachments/a.png?token=abc', undefined), undefined);
  assert.equal(lh.sessionToken('GET', '/api/mail/m1/attachments/a.png?token=abc', undefined), 'abc');
  assert.equal(lh.sessionToken('GET', '/api/agents/a1/tty?token=abc&cols=80', undefined), undefined);
});

test('outside a marked test home (here the live home) the test folder and root stand-in are ignored', () => {
  const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', "const m = await import('./src/local-human.ts'); console.log(m.codeDir())"], {
    cwd: join(import.meta.dirname, '..'),
    env: (({ STAM_HOME: _h, ...rest }) => rest)(process.env),
    encoding: 'utf8',
  });
  assert.equal(r.stdout.trim(), '/run/stam-human', r.stderr);
});

test('an unmarked home ignores the test folder too', () => {
  const bare = mkdtempSync(join(tmpdir(), 'stam-local-human-'));
  try {
    const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', "const m = await import('./src/local-human.ts'); console.log(m.codeDir())"], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, STAM_HOME: bare },
      encoding: 'utf8',
    });
    assert.equal(r.stdout.trim(), '/run/stam-human', r.stderr);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});
