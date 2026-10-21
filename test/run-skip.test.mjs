// test/run.sh: a test whose tool is missing SKIPs (exit 0), but with STAM_TEST_NO_SKIP=1, which the
// merge gates set, it FAILs (exit 1) with the same reason, so a machine missing a tool can't green a gate.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

// A copy of run.sh in its own folder with a fake test that prints a SKIP line, as e2e-run-timeout.sh does: no real e2e runs.
test('a test that prints a SKIP line and exits 0 shows as SKIP and still passes, even under STAM_TEST_NO_SKIP=1 (S-2297)', () => {
  const work = tempDir('run-skip-fake-');
  mkdirSync(join(work, 'test'));
  copyFileSync(join(ROOT, 'test/run.sh'), join(work, 'test/run.sh'));
  for (const f of ['tmpdir.sh', 'runtmp.sh']) copyFileSync(join(ROOT, 'test', f), join(work, 'test', f));
  writeFileSync(join(work, 'test/e2e-m1.sh'), '#!/bin/sh\necho "SKIP: nothing to forge here"\n');
  writeFileSync(join(work, 'test/e2e-m2.sh'), '#!/bin/sh\necho ok\n');
  for (const extra of [{}, { STAM_TEST_NO_SKIP: '1' }]) {
    const r = spawnSync('sh', [join(work, 'test/run.sh'), 'm1', 'm2'], { cwd: work, encoding: 'utf8', env: { ...process.env, STAM_TEST_NOSLOT: '1', STAM_TEST_NOLOCK: '1', STAM_TEST_NO_SKIP: '', STAM_TEST_TMPDIR: work, ...extra } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /m1\s+SKIP/);
    assert.match(r.stdout, /SKIP: nothing to forge here/);
    assert.match(r.stdout, /m2\s+PASS/);
  }
});
