#!/usr/bin/env node
// Unit tests for test/openrouter-credit.sh, the credit read that decides whether the reboot smoke test
// runs its OpenCode agent: positive credit, zero, negative, and errors (a failed call, a bad body, a
// missing key). A stub curl on PATH answers the GET; no network, no daemon:
// `node --test test/openrouter-credit.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import './scrub-env.mjs';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = join(ROOT, 'test', 'openrouter-credit.sh');
const KEY = 'sk-or-v1-unit-test-key-0042';

let dir, bin, keyFile;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'stam-or-credit-'));
  bin = join(dir, 'bin');
  mkdirSync(bin);
  // The stub records what curl was given: its argv, and its stdin (where the key goes).
  writeFileSync(
    join(bin, 'curl'),
    '#!/bin/sh\ncat >"$STUB_DIR/stdin"\nprintf \'%s\\n\' "$*" >"$STUB_DIR/argv"\nprintf \'%s\' "$STUB_BODY"\nexit "${STUB_EXIT:-0}"\n',
  );
  chmodSync(join(bin, 'curl'), 0o755);
  keyFile = join(dir, 'opencode.env');
  writeFileSync(keyFile, `OPENROUTER_API_KEY=${KEY}\nXDG_DATA_HOME=${dir}\n`);
});
after(() => rmSync(dir, { recursive: true, force: true }));

// Runs the helper against KEYFILE with the stub answering BODY (and exiting EXIT); returns the run.
function credit({ body = '', exit = 0, file = keyFile } = {}) {
  rmSync(join(dir, 'stdin'), { force: true });
  rmSync(join(dir, 'argv'), { force: true });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_DIR: dir, STUB_BODY: body, STUB_EXIT: String(exit) };
  return spawnSync('sh', ['-c', '. "$1"; openrouter_credit "$2"; exit $?', 'sh', HELPER, file], { env, encoding: 'utf8' });
}
const answer = (total, usage) => JSON.stringify({ data: { total_credits: total, total_usage: usage } });

test('positive credit exits 0', () => {
  const r = credit({ body: answer(60, 0.03) });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('zero credit exits 1', () => {
  assert.equal(credit({ body: answer(60, 60) }).status, 1);
});

test('negative credit exits 1', () => {
  assert.equal(credit({ body: answer(1, 2.5) }).status, 1);
});

test('a failed call exits 2 (unreadable)', () => {
  assert.equal(credit({ body: '', exit: 22 }).status, 2);
});

test('a body that is not JSON exits 2 (unreadable)', () => {
  assert.equal(credit({ body: '<html>Bad gateway</html>' }).status, 2);
});

test('an answer without both figures exits 2 (unreadable)', () => {
  assert.equal(credit({ body: JSON.stringify({ data: { total_credits: 60 } }) }).status, 2);
});

test('a positive body with a nonzero curl exit exits 2 (truncated or HTTP error)', () => {
  assert.equal(credit({ body: answer(60, 0.03), exit: 22 }).status, 2);
});

test('figures that are not finite JSON numbers exit 2 (unreadable)', () => {
  const bodies = [
    `{"data":{"total_credits":true,"total_usage":0}}`,
    `{"data":{"total_credits":"Infinity","total_usage":0}}`,
    `{"data":{"total_credits":Infinity,"total_usage":0}}`,
    `{"data":{"total_credits":60,"total_usage":NaN}}`,
    `{"data":{"total_credits":null,"total_usage":0}}`,
    `{"data":{"total_credits":60,"total_usage":"0"}}`,
  ];
  for (const body of bodies) assert.equal(credit({ body }).status, 2, body);
});

test('a missing key exits 2 and calls nothing', () => {
  const none = join(dir, 'no-key.env');
  writeFileSync(none, 'XDG_DATA_HOME=/x\n');
  assert.equal(credit({ body: answer(60, 0), file: none }).status, 2);
  assert.equal(existsSync(join(dir, 'argv')), false);
});

test('the key goes to curl on stdin, never on its command line or output', () => {
  const r = credit({ body: answer(60, 0.03) });
  assert.equal(readFileSync(join(dir, 'stdin'), 'utf8').includes(`authorization: Bearer ${KEY}`), true);
  assert.equal(readFileSync(join(dir, 'argv'), 'utf8').includes(KEY), false);
  assert.equal(r.stdout.includes(KEY) || r.stderr.includes(KEY), false);
  assert.match(readFileSync(join(dir, 'argv'), 'utf8'), /-K - --max-time 10 https:\/\/openrouter\.ai\/api\/v1\/credits/);
});

test('a failed call never prints the key', () => {
  const r = credit({ body: '', exit: 22 });
  assert.equal(r.stdout.includes(KEY) || r.stderr.includes(KEY), false);
});
