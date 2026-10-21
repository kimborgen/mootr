#!/usr/bin/env node
// The merge failure list (S-1071, scripts/merge-failures.mjs): reads the jsonl the merge script writes, prints a
// table and a count line, filters with --since, and prints raw entries with --json. Run with
// `node --test test/merge-failures.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmphome.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/merge-failures.mjs');
const home = tempDir('stam-merge-failures-');
mkdirSync(home, { recursive: true });
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const entry = (at, prs, isolated, step, tests = [], kind = 'gate') => ({
  at, baseSha: 'a'.repeat(40), prs: prs.map((pr) => ({ pr, head: 'b'.repeat(40) })), gateRuns: 3, gateFailed: kind === 'gate',
  outcomes: prs.map((pr) => ({ pr, state: 'failed', kind, message: 'm' })), failing: step ? [{ step, tests }] : [], logDir: '/x/logs/train-1', isolated,
});
writeFileSync(join(home, 'merge-train-failures.jsonl'), [
  JSON.stringify(entry(ago(86_400_000 * 30), ['1', '2'], ['2'], 'run old')),
  'not json',
  JSON.stringify(entry(ago(3_600_000), ['7', '8'], ['8'], 'run alpha', ['alpha: broke'])),
  JSON.stringify(entry(ago(60_000), ['9', '10', '11'], null, 'stories')),
  JSON.stringify(entry(ago(30_000), ['12'], [], null, [], 'preflight')),
].join('\n') + '\n');

const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, STAM_HOME: home }, encoding: 'utf8' });

test('lists every failed train with a count line', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /#7 #8 +gate +run alpha: alpha: broke +#8/);
  assert.match(r.stdout, /#9 #10 #11 +gate +stories +unknown/);
  assert.match(r.stdout, /#12 +preflight +- +-/);
  assert.match(r.stdout, /^3 failed trains, 2 culprit PRs, since the start of the log; 1 without a gate failure \(1 preflight\)$/m);
});

test('--since keeps only recent trains', () => {
  const r = run('--since', '7d');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /run old/);
  assert.match(r.stdout, /^2 failed trains, 1 culprit PRs, since the last 7d; 1 without a gate failure \(1 preflight\)$/m);
});

test('--json prints the entries, and a missing log is an empty list', () => {
  assert.equal(JSON.parse(run('--json').stdout).length, 4);
  const empty = spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, STAM_HOME: join(home, 'none') }, encoding: 'utf8' });
  assert.match(empty.stdout, /^0 failed trains, 0 culprit PRs/);
});

test('a flaky train gets a flaky column and count, even when it merged', () => {
  const flakyHome = tempDir('stam-merge-failures-flaky-');
  mkdirSync(flakyHome, { recursive: true });
  const merged = { ...entry(ago(60_000), ['20', '21'], [], null), gateFailed: false, outcomes: [{ pr: 20, state: 'merged', kind: 'merged', message: 'm' }, { pr: 21, state: 'merged', kind: 'merged', message: 'm' }], flaky: ['run alpha'] };
  const plain = entry(ago(30_000), ['22'], [], null, [], 'preflight');
  writeFileSync(join(flakyHome, 'merge-train-failures.jsonl'), [JSON.stringify(merged), JSON.stringify(plain)].join('\n') + '\n');
  const r = spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, STAM_HOME: flakyHome }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^time +prs +kind +failing +culprit +flaky$/m);
  assert.match(r.stdout, /#20 #21 +- +- +- +run alpha$/m);
  assert.match(r.stdout, /#22 +preflight +- +- +-$/m);
  assert.match(r.stdout, /^0 failed trains, 0 culprit PRs, since the start of the log; 2 without a gate failure \(1 preflight\); 1 flaky$/m);
});

test('a bad, missing or empty --since is a usage error', () => {
  assert.equal(run('--since', 'soon').status, 2);
  const missing = run('--since');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /usage: node scripts\/merge-failures\.mjs/);
  assert.equal(run('--since', '').status, 2);
  assert.equal(run('--bogus').status, 2);
});
