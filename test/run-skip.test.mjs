// test/run.sh: a test whose tool is missing SKIPs (exit 0), but with STAM_TEST_NO_SKIP=1, which the
// merge gates set, it FAILs (exit 1) with the same reason, so a machine missing a tool can't green a gate.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDir } from './tmphome.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const bin = tempDir('run-skip-');
writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n');
chmodSync(join(bin, 'systemctl'), 0o755);
const tmp = tempDir('run-skip-tmp-');
after(() => { rmSync(tmp, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true }); });
const run = (extra) =>
  spawnSync('sh', ['test/run.sh', 'janitor'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STAM_TEST_NOLOCK: '1', STAM_TEST_NO_SKIP: '', STAM_TEST_TMPDIR: tmp, ...extra },
  });

test('a missing tool skips the test and the run passes', () => {
  const r = run({});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /janitor\s+SKIP/);
  assert.match(r.stdout, /1 skipped/);
});

test('with STAM_TEST_NO_SKIP=1 a missing tool fails the run', () => {
  const r = run({ STAM_TEST_NO_SKIP: '1' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /janitor\s+FAIL/);
  assert.doesNotMatch(r.stdout, /SKIP janitor|skipped/);
});
