// test/run.sh NAME refuses a LIGHT-only name, and refuses a named SMOKE test unless --smoke or --live is passed (S-3262).
// STAM_RUNSH_NAMES_ONLY=1 stops run.sh once the names pass, so no slot, lock or test (or harness) starts.
import './scrub-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = readFileSync(`${root}test/run.sh`, 'utf8');
const smokeName = src.match(/^SMOKE="\n([^"]*)"/m)[1].split('\n').filter(Boolean)[0];

// A copy of run.sh in a scratch tree, so a list can be edited without touching the real one.
function scratch(edit) {
  const d = mkdtempSync(join(tmpdir(), 'stam-runsh-names-'));
  mkdirSync(join(d, 'test'));
  for (const f of ['tmpdir.sh', 'runtmp.sh']) copyFileSync(`${root}test/${f}`, join(d, 'test', f));
  writeFileSync(join(d, 'test', 'run.sh'), edit(src));
  return d;
}
const run = (cwd, ...args) => spawnSync('sh', [join(cwd, 'test/run.sh'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, STAM_RUNSH_NAMES_ONLY: '1', STAM_TEST_NOSLOT: '1' } });

test('a name only in LIGHT is refused: add it to FREE', () => {
  const d = scratch((s) => s.replace(/^FREE="\n/m, 'FREE="\n').replace(/^hit-classify\n/gm, (m, i) => (i < s.indexOf('FREE="') ? m : '')));
  try {
    const r = run(d, 'hit-classify');
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /hit-classify is in LIGHT but not FREE; add it to FREE/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a named SMOKE test without --smoke exits 2 and names the flag', () => {
  const r = run(root, smokeName);
  assert.equal(r.status, 2);
  assert.match(r.stderr, new RegExp(`${smokeName} is a smoke test .*pass --smoke`));
});

test('a named SMOKE test with --smoke or --live passes the name check', () => {
  assert.equal(run(root, '--smoke', smokeName).status, 0);
  assert.equal(run(root, '--live', smokeName).status, 0);
});

test('an unknown name still exits 2 and a FREE name is accepted', () => {
  assert.equal(run(root, 'no-such-test').status, 2);
  assert.equal(run(root, 'light-list-unit').status, 0);
});
