#!/usr/bin/env node
// The web/check scripts find playwright-core only in this checkout (web/check/find-playwright.mjs):
// web/node_modules first, then the root node_modules, never another repo, and a missing module fails
// with the hint to run `npm run setup`. A copy of the helper runs in a throwaway tree, so nothing here
// touches the real node_modules. Run with `node --test test/check-playwright-unit.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const helper = join(import.meta.dirname, '..', 'web', 'check', 'find-playwright.mjs');
let base, copy;

// A stub playwright-core in `dir/node_modules`, named so the test can tell which one was found.
const stub = (dir, name) => {
  mkdirSync(join(dir, 'node_modules', 'playwright-core'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'playwright-core', 'package.json'), JSON.stringify({ name: 'playwright-core', main: 'index.js' }));
  writeFileSync(join(dir, 'node_modules', 'playwright-core', 'index.js'), `module.exports = { chromium: '${name}' };\n`);
};
// Runs findPlaywright() from the copy in a child process; returns what it found, or the error text.
const run = () => {
  const code = `import { findPlaywright } from ${JSON.stringify(pathToFileURL(copy).href)};\nconsole.log(findPlaywright().chromium);`;
  try {
    return { ok: true, out: execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_PATH: '' } }).trim() };
  } catch (e) {
    return { ok: false, out: String(e.stderr) };
  }
};

before(() => {
  base = mkdtempSync(join(tmpdir(), 'stam-check-playwright-test-'));
  mkdirSync(join(base, 'web', 'check'), { recursive: true });
  copy = join(base, 'web', 'check', 'find-playwright.mjs');
  copyFileSync(helper, copy);
});
after(() => rmSync(base, { recursive: true, force: true }));

test('nothing installed: a clear hint to run npm run setup', () => {
  const r = run();
  assert.equal(r.ok, false);
  assert.match(r.out, /playwright-core not found in web\/node_modules or node_modules/);
  assert.match(r.out, /npm run setup/);
  assert.match(r.out, /npm run install:chromium/);
});

test('the root node_modules is used when web/node_modules is missing', () => {
  stub(base, 'root');
  assert.deepEqual(run(), { ok: true, out: 'root' });
  rmSync(join(base, 'node_modules'), { recursive: true, force: true });
});

test("web/node_modules comes first, and another checkout's copy is never used", () => {
  stub(base, 'root');
  stub(join(base, 'web'), 'web');
  assert.deepEqual(run(), { ok: true, out: 'web' });
  rmSync(join(base, 'web', 'node_modules'), { recursive: true, force: true });
  rmSync(join(base, 'node_modules'), { recursive: true, force: true });
  // A playwright-core under the home folder or the working directory is not searched.
  const elsewhere = mkdtempSync(join(tmpdir(), 'stam-check-playwright-other-'));
  try {
    stub(elsewhere, 'elsewhere');
    const r = execFileSync(process.execPath, ['--input-type=module', '-e', `import { findPlaywright } from ${JSON.stringify(pathToFileURL(copy).href)};\ntry { console.log(findPlaywright().chromium); } catch (e) { console.log('missing'); }`], { cwd: elsewhere, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } }).trim();
    assert.equal(r, 'missing');
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});
