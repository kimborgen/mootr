#!/usr/bin/env node
// headRunSh (src/pr-open.ts) reads the head's test/run.sh for the LIGHT predictions (S-3170). A head with no such file
// is no test list, so runLightTests returns no result; any other git error still throws, so pr_open refuses. Runs against
// a throwaway git repo, starts no daemon. Run with `node --test test/pr-open-run-sh.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmphome.mjs';

const base = tempDir('stam-pr-open-run-sh-test-');
process.env.STAM_HOME = join(base, 'home');
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

const git = (cwd, args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
let repo, noRun, withRun, cfg;
const FAKE = '0123456789abcdef0123456789abcdef01234567';

before(async () => {
  repo = join(base, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'no run.sh']);
  noRun = git(repo, ['rev-parse', 'HEAD']);
  mkdirSync(join(repo, 'test'));
  // Names in LIGHT only: `x` is not listed, so no LIGHT test runs here and the prediction is empty.
  writeFileSync(join(repo, 'test', 'run.sh'), 'LIGHT="\nlight-list-unit\n"\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'with run.sh']);
  withRun = git(repo, ['rev-parse', 'HEAD']);
  cfg = { repo, origin: 'origin', base: 'main' };
});

after(() => rmSync(base, { recursive: true, force: true }));

test('a head with no test/run.sh has no test list: the prediction is empty, nothing throws', async () => {
  const { runLightTests } = await import('../src/pr-open.ts');
  const light = await runLightTests(cfg, noRun, ['light-list-unit'], base);
  assert.equal(light.size, 0);
  // The same for a branch whose run.sh exists: a name it doesn't list is not run, so the result is empty too.
  assert.equal((await runLightTests(cfg, withRun, ['x'], base)).size, 0);
});

test('a git error reading the head is not "no test/run.sh": runLightTests still throws, so pr_open still refuses', async () => {
  const { runLightTests } = await import('../src/pr-open.ts');
  // A sha that is not in the repo: ls-tree fails with a git error, not an empty listing.
  await assert.rejects(runLightTests(cfg, FAKE, ['light-list-unit'], base), /git ls-tree failed/);
});
