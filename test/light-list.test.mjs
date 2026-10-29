// test/run.sh's LIGHT list (S-1288, S-1768) sends a run of only listed tests to the light slot pool.
// Each entry must be a plain `node --test` file that starts no daemon, tmux, browser or server. The rule lives in
// light-rules.mjs and the CLI (light-check.mjs) applies it; this file checks the rule and that both checks agree.
// The fixture sources are data files in test/fixtures/light-rules/ (cases.json names each file and its token), so this
// file's own text never names a token and stays in LIGHT.
import './scrub-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lightHit, lightMessage } from './light-rules.mjs';
import { lightProblems } from './light-check.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const data = fileURLToPath(new URL('fixtures/light-rules/', import.meta.url));
const cases = JSON.parse(readFileSync(`${data}cases.json`, 'utf8'));

// A one-test fixture tree: test/run.sh lists fix-a in LIGHT and FREE, and its test file is a copy of a data file.
function fixture(file) {
  const dir = mkdtempSync(join(tmpdir(), 'light-list-'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'test', 'run.sh'), 'LIGHT="\nfix-a\n"\nFREE="\nfix-a\n"\ncase x in\n    fix-a) echo "node --test test/fix-a.test.mjs" ;;\nesac\n');
  copyFileSync(`${data}${file}`, join(dir, 'test', 'fix-a.test.mjs'));
  return dir;
}

for (const { file, token } of cases) {
  test(`LIGHT > the rule finds ${token ?? 'no token'} in ${file}`, () => {
    assert.equal(lightHit(readFileSync(`${data}${file}`, 'utf8')), token);
  });
}

test('LIGHT > the CLI and the rule agree on every fixture file', () => {
  for (const { file, token } of cases) {
    const dir = fixture(file);
    try {
      const problems = lightProblems(dir);
      assert.deepEqual(problems, token === null ? [] : [lightMessage('fix-a', 'test/fix-a.test.mjs', token)], file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('LIGHT > the CLI exits 1 and names the token on a heavy LIGHT name (--root)', () => {
  const heavy = cases.find((c) => c.token !== null);
  const token = heavy.token;
  const dir = fixture(heavy.file);
  try {
    const r = spawnSync(process.execPath, [join(root, 'test', 'light-check.mjs'), '--root', dir], { encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.ok(r.stdout.includes(`matched "${token}"`), r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LIGHT > the CLI checks every name in test/run.sh with no problems', () => {
  assert.deepEqual(lightProblems(root), []);
});
