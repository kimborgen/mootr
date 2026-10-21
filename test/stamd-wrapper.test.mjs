#!/usr/bin/env node
// bin/stamd and the stamd unit's ExecStart (S-2278, src/unit.ts): a release starts through its wrapper, a
// release without one (a rollback target built before the wrapper) starts through the unit's fallback, an
// older unit is rewritten in place, and a daemon started through the wrapper is found by prune's
// pinned-release check. No systemd, no daemon: node is a stub that records its argv.
// Run with `node --test test/stamd-wrapper.test.mjs`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import './scrub-env.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const { unitText, migrateUnit } = await import(join(ROOT, 'src/unit.ts'));
const home = mkdtempSync(join(tmpdir(), 'stam-stamd-test-'));
const started = [];
after(() => {
  for (const p of started) try { process.kill(p, 'SIGKILL'); } catch {}
  rmSync(home, { recursive: true, force: true });
});

const R = join(home, 'releases');
// A stub node that writes its argv to a file named by STUB_OUT and exits.
const node = join(home, 'node-stub');
writeFileSync(node, '#!/bin/sh\nprintf "%s\\n" "$@" > "$STUB_OUT"\n');
chmodSync(node, 0o755);

function release(name, { wrapper }) {
  const dir = join(R, name);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.release.json'), JSON.stringify({ release: name, commit: name, subject: name, repo: '', built_at: new Date().toISOString(), deps: [] }));
  if (wrapper) {
    copyFileSync(join(ROOT, 'bin/stamd'), join(dir, 'bin/stamd'));
    chmodSync(join(dir, 'bin/stamd'), 0o755);
  }
  return dir;
}
const link = (name) => {
  rmSync(join(R, 'current'), { force: true });
  symlinkSync(name, join(R, 'current'));
};
const unit = () => unitText({ dir: join(R, 'current'), node, path: '/usr/bin:/bin', env: '', log: join(home, 'daemon.log') });
// Runs the unit through systemd itself (a transient one-shot copy in the user manager), so ExecStart is parsed
// as systemd parses it, then by the shell. `base` is the directory the release and the stub live under.
const hasSystemd = spawnSync('systemctl', ['--user', 'is-system-running'], { encoding: 'utf8' }).stdout.trim().match(/^(running|degraded)$/);
const UNITS = join(process.env.HOME, '.config', 'systemd', 'user');
let seq = 0;
function start(opts = {}) {
  const name = `stam-stamd-test-${process.pid}-${seq++}`;
  const out = join(home, `${name}.argv`);
  const text = unitText({ dir: opts.dir ?? join(R, 'current'), node: opts.node ?? node, path: '/usr/bin:/bin', env: `Environment=STUB_OUT=${out}\n`, log: '/dev/null' })
    .replace('Restart=always', 'Type=oneshot\nRestart=no');
  mkdirSync(UNITS, { recursive: true });
  const file = join(UNITS, `${name}.service`);
  writeFileSync(file, text);
  try {
    spawnSync('systemctl', ['--user', 'daemon-reload']);
    const r = spawnSync('systemctl', ['--user', 'start', name], { encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr, argv: existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n') : undefined };
  } finally {
    spawnSync('systemctl', ['--user', 'reset-failed', name]);
    rmSync(file, { force: true });
    spawnSync('systemctl', ['--user', 'daemon-reload']);
  }
}

release('new', { wrapper: true });
release('old', { wrapper: false });

const sd = { skip: hasSystemd ? false : 'no systemd user manager' };
test('a release with bin/stamd starts through it, running its own cli.ts as a daemon', sd, () => {
  link('new');
  const r = start();
  assert.equal(r.status, 0, r.stderr);
  // The wrapper resolves its own release, so the daemon names the release's real path, not `current`.
  assert.deepEqual(r.argv, ['--no-warnings', `${join(R, 'new')}/bin/../src/cli.ts`, 'daemon', 'run']);
});

test('a rollback to a release without bin/stamd starts through the fallback, and forward again', sd, () => {
  link('old');
  let r = start();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.argv, ['--no-warnings', join(R, 'current', 'src', 'cli.ts'), 'daemon', 'run']);
  link('new');
  r = start();
  assert.match(r.argv[1], /releases\/new\/bin\/\.\.\/src\/cli\.ts$/);
});

test('a daemon that fails through the wrapper is not started a second time by the fallback', sd, () => {
  link('new');
  const failing = join(home, 'node-fail');
  writeFileSync(failing, '#!/bin/sh\necho x >> "$STUB_OUT"\nexit 3\n');
  chmodSync(failing, 0o755);
  const r = start({ node: failing });
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.argv, ['x']);
});

test('paths with $, a space, a quote, a backtick and % reach the right binary through systemd and sh', sd, () => {
  const odd = join(home, "o d$c `touch pwned` 'q' 100%");
  const dir = join(odd, 'releases', 'new');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  copyFileSync(join(ROOT, 'bin/stamd'), join(dir, 'bin/stamd'));
  chmodSync(join(dir, 'bin/stamd'), 0o755);
  const oddNode = join(odd, 'node stub');
  copyFileSync(node, oddNode);
  chmodSync(oddNode, 0o755);
  // Through the wrapper.
  let r = start({ dir, node: oddNode });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.argv, ['--no-warnings', `${dir}/bin/../src/cli.ts`, 'daemon', 'run']);
  // And through the fallback, for a release without the wrapper.
  rmSync(join(dir, 'bin/stamd'));
  r = start({ dir, node: oddNode });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.argv, ['--no-warnings', `${dir}/src/cli.ts`, 'daemon', 'run']);
  assert.ok(!existsSync(join(process.cwd(), 'pwned')) && !existsSync('/pwned'));
});

test('an older unit is rewritten to the wrapper form, keeping its node, PATH, and settings, once', () => {
  const old = `[Unit]
Description=stam daemon

[Service]
ExecStart=/home/u/.nvm/node --no-warnings /h/releases/current/src/cli.ts daemon run
Environment=PATH=/p/a:/p/b
Environment=STAM_HOME=/x
Restart=always
`;
  const next = migrateUnit(old, '/h/releases/current');
  assert.ok(next);
  assert.match(next, /^ExecStart=\/bin\/sh -c "if \[ -x '\/h\/releases\/current\/bin\/stamd' \]/m);
  assert.match(next, /exec '\/home\/u\/\.nvm\/node' --no-warnings '\/h\/releases\/current\/src\/cli\.ts' daemon run/);
  assert.match(next, /^Environment="STAM_NODE=\/home\/u\/\.nvm\/node"$/m);
  for (const keep of ['Environment=PATH=/p/a:/p/b', 'Environment=STAM_HOME=/x', 'Restart=always']) assert.ok(next.includes(keep), keep);
  assert.equal(migrateUnit(next, '/h/releases/current'), undefined);
  assert.equal(migrateUnit('[Service]\nExecStart=/bin/sleep 300\n', '/h/releases/current'), undefined);
});

test('a freshly written unit is already in the form migrateUnit leaves alone', () => {
  assert.equal(migrateUnit(unit(), join(R, 'current')), undefined);
});

test('prune finds a daemon started through the wrapper by its release path', async () => {
  link('new');
  // A node stub that stays up with the wrapper's argv on its command line, as the daemon would.
  const sleeper = join(home, 'node-sleep');
  writeFileSync(sleeper, '#!/bin/sh\nexec sh -c "sleep 300" "$@"\n');
  chmodSync(sleeper, 0o755);
  const held = spawn(join(R, 'new', 'bin', 'stamd'), { env: { PATH: '/usr/bin:/bin', STAM_NODE: sleeper }, stdio: 'ignore' });
  started.push(held.pid);
  // Releases a prune would remove: six newer ones keep it from `new`, which only the process pins.
  for (const n of ['n1', 'n2', 'n3', 'n4', 'n5', 'n6']) release(n, { wrapper: true });
  const meta = (n, t) => writeFileSync(join(R, n, '.release.json'), JSON.stringify({ release: n, commit: n, subject: n, repo: '', built_at: new Date(Date.UTC(2026, 0, 1, 0, t)).toISOString(), deps: [] }));
  meta('new', 0);
  meta('old', 1);
  ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'].forEach((n, i) => meta(n, 10 + i));
  link('n6');
  for (let i = 0; i < 50 && !readFileSync(`/proc/${held.pid}/cmdline`, 'utf8').includes('sh'); i++) await new Promise((r) => setTimeout(r, 50));
  const r = spawnSync(process.execPath, [join(ROOT, 'src/cli.ts'), 'prune'], { env: { ...process.env, STAM_HOME: home, NODE_COMPILE_CACHE: join(home, 'cc') }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(R, 'new')), 'the release the wrapper-started daemon runs from was pruned');
  assert.ok(!existsSync(join(R, 'old')), 'an unpinned old release was kept');
});
