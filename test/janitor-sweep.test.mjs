#!/usr/bin/env node
// The janitor's systemd units (S-354): a unit whose stop times out keeps its unit file and its
// folder, and only a unit systemd reports inactive is removed. A stub `systemctl` on PATH stands in
// for systemd, so no real unit is made. The janitor reads its unit folder from $HOME when it loads,
// so the test sets HOME, TMPDIR, and PATH before importing it: `node --test test/janitor-sweep.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync, lutimesSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const TMP = new URL('../tmp/', import.meta.url).pathname;
const UNIT = 'stamd-test-zzunit';

let base;
let dir;
let unitFile;
let hangFile;
let activeErrFile;
let noUnitFile;
let log;
let sweep;
let sweepHookFiles;
const saved = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PATH: process.env.PATH };

before(async () => {
  mkdirSync(TMP, { recursive: true });
  base = mkdtempSync(join(TMP, 'janitor-sweep-'));
  const home = join(base, 'home');
  const bin = join(base, 'bin');
  mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
  mkdirSync(bin);
  // A test folder whose owner is gone: its unit runs a daemon under dir/home.
  dir = join(base, 'stam-test.zzunit.Uu1234');
  mkdirSync(join(dir, 'home'), { recursive: true });
  const dead = spawnSync('true').pid;
  writeFileSync(join(dir, 'owner'), `agent=zzunit\npid=${dead}\nstarted=${new Date().toISOString()}\n`);
  unitFile = join(home, '.config', 'systemd', 'user', `${UNIT}.service`);
  writeFileSync(unitFile, `[Service]\nExecStart=/bin/sleep 300\nEnvironment=STAM_HOME=${join(dir, 'home')}\n`);
  // The stub: `stop` hangs while hangFile exists, `is-active` fails (exit 1) while activeErrFile
  // exists, and every call is logged.
  hangFile = join(base, 'hang');
  activeErrFile = join(base, 'active-err');
  noUnitFile = join(base, 'no-unit');
  log = join(base, 'systemctl.log');
  writeFileSync(hangFile, '');
  const stub = join(bin, 'systemctl');
  writeFileSync(
    stub,
    `#!/bin/sh\necho "$*" >>'${log}'\ncase "$2" in\n  stop) if [ -f '${hangFile}' ]; then exec sleep 30; fi; exit 0 ;;\n  is-active) if [ -f '${activeErrFile}' ]; then exit 1; fi; if [ -f '${noUnitFile}' ]; then echo inactive; exit 4; fi; echo inactive; exit 3 ;;\nesac\nexit 0\n`,
  );
  chmodSync(stub, 0o755);
  process.env.HOME = home;
  process.env.TMPDIR = base;
  process.env.PATH = `${bin}:${saved.PATH}`;
  ({ sweep, sweepHookFiles } = await import('../src/janitor.ts'));
});

after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (base) rmSync(base, { recursive: true, force: true });
});

test('a unit whose stop times out keeps its unit file and its folder', async () => {
  const r = await sweep({ only: [dir] });
  assert.ok(r.kept.some((k) => k.path === UNIT && k.why.includes('did not stop')), JSON.stringify(r.kept));
  assert.ok(r.kept.some((k) => k.path === dir && k.why.includes('systemd unit')), JSON.stringify(r.kept));
  assert.equal(r.actions.filter((a) => a.kind === 'unit' || a.kind === 'dir').length, 0, JSON.stringify(r.actions));
  assert.ok(existsSync(unitFile), 'the unit file was removed');
  assert.ok(existsSync(join(dir, 'home')), 'the folder was removed');
  // Nothing after the failed stop: no disable, no unit removal, no daemon-reload.
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['--user stop ' + UNIT]);
});

test('a unit systemd reports inactive is removed with its folder', async () => {
  rmSync(hangFile);
  rmSync(log, { force: true });
  const r = await sweep({ only: [dir] });
  assert.ok(r.actions.some((a) => a.kind === 'unit' && a.target === UNIT), JSON.stringify(r.actions));
  assert.ok(r.actions.some((a) => a.kind === 'dir' && a.target === dir), JSON.stringify(r.actions));
  assert.equal(r.kept.filter((k) => k.path === UNIT || k.path === dir).length, 0, JSON.stringify(r.kept));
  assert.ok(!existsSync(unitFile), 'the unit file survived');
  assert.ok(!existsSync(dir), 'the folder survived');
  const calls = readFileSync(log, 'utf8').trim().split('\n');
  assert.ok(calls.includes('--user disable ' + UNIT), JSON.stringify(calls));
});

test('a unit whose is-active fails with an undocumented status is kept with its folder', async () => {
  // The folder and unit are made again: the previous test removed them.
  mkdirSync(join(dir, 'home'), { recursive: true });
  writeFileSync(join(dir, 'owner'), `agent=zzunit\npid=${spawnSync('true').pid}\nstarted=${new Date().toISOString()}\n`);
  writeFileSync(unitFile, `[Service]\nExecStart=/bin/sleep 300\nEnvironment=STAM_HOME=${join(dir, 'home')}\n`);
  writeFileSync(activeErrFile, '');
  rmSync(log, { force: true });
  const r = await sweep({ only: [dir] });
  assert.ok(r.kept.some((k) => k.path === UNIT && k.why.includes('did not stop')), JSON.stringify(r.kept));
  assert.equal(r.actions.filter((a) => a.kind === 'unit' || a.kind === 'dir').length, 0, JSON.stringify(r.actions));
  assert.ok(existsSync(unitFile), 'the unit file was removed');
  assert.ok(existsSync(dir), 'the folder was removed');
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['--user stop ' + UNIT, '--user is-active ' + UNIT]);
  rmSync(activeErrFile);
});

test('a unit systemd reports as no such unit (is-active exit 4, inactive) is cleaned up', async () => {
  mkdirSync(join(dir, 'home'), { recursive: true });
  writeFileSync(join(dir, 'owner'), `agent=zzunit\npid=${spawnSync('true').pid}\nstarted=${new Date().toISOString()}\n`);
  writeFileSync(unitFile, `[Service]\nExecStart=/bin/sleep 300\nEnvironment=STAM_HOME=${join(dir, 'home')}\n`);
  writeFileSync(noUnitFile, '');
  rmSync(log, { force: true });
  const r = await sweep({ only: [dir] });
  assert.ok(r.actions.some((a) => a.kind === 'unit' && a.target === UNIT), JSON.stringify(r.actions));
  assert.ok(r.actions.some((a) => a.kind === 'dir' && a.target === dir), JSON.stringify(r.actions));
  assert.ok(!existsSync(unitFile), 'the unit file survived');
  assert.ok(!existsSync(dir), 'the folder survived');
  rmSync(noUnitFile);
});

test('a stam-test folder that became a symlink is not discovered or read', async () => {
  // The check/use race the scope preflight cannot time: the path was missing (or a folder) when the
  // scope was checked, and a symlink to a wider folder is there when the sweep runs. Following it
  // would read that folder's children and schedule their tmux servers (S-764).
  const wider = join(base, 'wider');
  const victim = join(wider, 'stam-test.zzvictim.Vv1234');
  mkdirSync(victim, { recursive: true });
  writeFileSync(join(victim, 'test.env'), 'export STAM_TMUX_SOCKET=stam-test-zzvictim-Vv1234-twin\n');
  writeFileSync(join(wider, 'owner'), `agent=zzwider\npid=${spawnSync('true').pid}\nstarted=${new Date().toISOString()}\n`);
  const alias = join(base, 'stam-test.zzalias.Aa1234');
  symlinkSync(wider, alias);
  const r = await sweep({ only: [alias] });
  assert.deepEqual(r.actions, [], JSON.stringify(r.actions));
  assert.ok(existsSync(victim), 'the sweep followed the symlink into the wider folder');
  assert.ok(existsSync(alias), 'the sweep removed the symlink as if it were a test folder');
  rmSync(alias, { force: true });
});

test('an hour-old stam-hook file is removed; fresh files, folders, and symlinks are kept', async () => {
  // A hook killed before its trap leaves its payload file behind (bin/stam-fast). Only plain files
  // that are an hour old go; the rest of the root is left alone.
  const root = join(base, 'hook-root');
  mkdirSync(root);
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const fresh = new Date(Date.now() - 10 * 60 * 1000);
  const oldFile = join(root, 'stam-hook.OldOld');
  const freshFile = join(root, 'stam-hook.NewNew');
  const oldDir = join(root, 'stam-hook.DirDir');
  const target = join(base, 'hook-target');
  const link = join(root, 'stam-hook.LnLnLn');
  const other = join(root, 'other.tmp');
  writeFileSync(oldFile, '{}');
  writeFileSync(freshFile, '{}');
  mkdirSync(oldDir);
  writeFileSync(target, '{}');
  symlinkSync(target, link);
  writeFileSync(other, '{}');
  utimesSync(oldFile, old, old);
  utimesSync(freshFile, fresh, fresh);
  utimesSync(oldDir, old, old);
  utimesSync(target, old, old);
  lutimesSync(link, old, old);
  utimesSync(other, old, old);

  const dry = await sweepHookFiles([root], { dryRun: true });
  assert.deepEqual(dry.map((a) => a.target), [oldFile], JSON.stringify(dry));
  assert.ok(existsSync(oldFile), 'a dry run removed the file');

  const r = await sweepHookFiles([root]);
  assert.deepEqual(r, [{ kind: 'hook', target: oldFile, dir: root }], JSON.stringify(r));
  assert.ok(!existsSync(oldFile), 'the old file survived');
  assert.ok(existsSync(freshFile), 'the fresh file was removed');
  assert.ok(existsSync(oldDir), 'the folder was removed');
  assert.ok(existsSync(link) && existsSync(target), 'the symlink or its target was removed');
  assert.ok(existsSync(other), 'a file outside the stam-hook.* name was removed');
});

test('an unscoped sweep removes an old stam-hook file under TMPDIR; a scoped sweep leaves it (S-2266 wiring)', async () => {
  // sweep() is the caller of sweepHookFiles: the sweep's own roots include TMPDIR (base). A dry run
  // keeps the test from deleting stale files in the real /tmp, which the unscoped sweep also scans.
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const hookFile = join(base, 'stam-hook.WireWi');
  writeFileSync(hookFile, '{}');
  utimesSync(hookFile, old, old);
  const hooks = (r) => r.actions.filter((a) => a.kind === 'hook').map((a) => a.target);
  const scoped = await sweep({ dryRun: true, only: [join(base, 'stam-test.zzgone.Gg1234')] });
  assert.ok(!hooks(scoped).includes(hookFile), JSON.stringify(scoped.actions));
  const unscoped = await sweep({ dryRun: true });
  assert.ok(hooks(unscoped).includes(hookFile), JSON.stringify(unscoped.actions));
  assert.ok(existsSync(hookFile), 'a dry run removed the file');
  rmSync(hookFile);
});
