#!/usr/bin/env node
// The main guard (S-3011, scripts/main-guard.mjs): a script started through a symlink (releases/current, a symlinked
// script file) runs main, importing a script runs nothing, and the helper never throws. The probes live in a temp
// folder and go-catchup.mjs is run with a module name that doesn't exist, so nothing touches the repo or git.
// Run with `node --test test/main-guard-unit.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './tmphome.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const SCRIPTS = join(ROOT, 'scripts');
const CATCHUP = join(SCRIPTS, 'go-catchup.mjs');
const GUARD = pathToFileURL(join(SCRIPTS, 'main-guard.mjs')).href;

const run = (file, args = []) => spawnSync(process.execPath, [file, ...args], { encoding: 'utf8' });

test('a script started through a symlinked directory runs main', () => {
  // releases/current: a symlink to the folder the units start scripts from.
  const dir = tempDir('stam-main-guard-');
  symlinkSync(SCRIPTS, join(dir, 'current'), 'dir');
  const r = run(join(dir, 'current', 'go-catchup.mjs'), ['nosuch']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /no module named nosuch/);
});

test('a script started through a symlinked file runs main', () => {
  const dir = tempDir('stam-main-guard-');
  symlinkSync(CATCHUP, join(dir, 'catchup.mjs'));
  const r = run(join(dir, 'catchup.mjs'), ['nosuch']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /no module named nosuch/);
});

test('importing a script runs nothing', () => {
  const dir = tempDir('stam-main-guard-');
  const probe = join(dir, 'probe.mjs');
  writeFileSync(probe, `await import(${JSON.stringify(pathToFileURL(CATCHUP).href)});\nconsole.log('imported');\n`);
  const r = run(probe, ['nosuch']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'imported\n');
  assert.equal(r.stderr, '');
});

test('the helper is true for the script it is called from, and false, without throwing, for anything else', () => {
  const dir = tempDir('stam-main-guard-');
  const probe = join(dir, 'probe.mjs');
  writeFileSync(probe, [
    `const { isMain } = await import(${JSON.stringify(GUARD)});`,
    'console.log(isMain(import.meta.url));',
    "console.log(isMain('file:///stam-no-such-folder/x.mjs'));",
    "console.log(isMain('not a url'));",
    '',
  ].join('\n'));
  const r = run(probe);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'true\nfalse\nfalse\n');
});
