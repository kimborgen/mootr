#!/usr/bin/env node
// Checks the shared temp home (S-277): tempHome() removes its folder on every exit path (a normal
// end, a thrown error, process.exit, a signal), and the six unit tests that use it don't keep a
// copy of their own. Child processes, no daemon, no model. Run with `node --test test/tmphome.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const helper = join(here, 'tmphome.mjs');

// Runs a child that makes a temp home, prints its path, then ends with BODY.
const run = (body) => {
  const script = `import { tempHome } from ${JSON.stringify(helper)}; const h = tempHome('stam-tmphome-check-'); console.log(h); ${body}`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  return { code: r.status, signal: r.signal, home: r.stdout.trim() };
};

test('the temp home is removed on a normal end', () => {
  const { code, home } = run('');
  assert.equal(code, 0);
  assert.equal(existsSync(home), false, `${home} survived a normal exit`);
});

test('the temp home is removed when the test throws', () => {
  const { code, home } = run("throw new Error('boom');");
  assert.notEqual(code, 0);
  assert.equal(existsSync(home), false, `${home} survived a thrown error`);
});

test('the temp home is removed on process.exit and on a signal', () => {
  const exited = run('process.exit(1);');
  assert.equal(existsSync(exited.home), false, `${exited.home} survived process.exit`);
  const signalled = run("process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 5000);");
  assert.equal(existsSync(signalled.home), false, `${signalled.home} survived SIGTERM`);
});

test('the helper points the test at the stub embedder, never the local model', () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { tempHome } from ${JSON.stringify(helper)}; tempHome('stam-tmphome-check-'); console.log(process.env.STAM_EMBEDDER);`], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), 'stub');
});

test('the six tests that use the helper make no temp home of their own', () => {
  for (const f of ['steps', 'itsa-human', 'codex-usage', 'itsa-thread', 'cost-switch', 'cost-fallback']) {
    const src = readFileSync(join(here, `${f}.test.mjs`), 'utf8');
    assert.match(src, /import \{ tempHome \} from '\.\/tmphome\.mjs';/, `${f} doesn't use the shared helper`);
    assert.doesNotMatch(src, /mkdtempSync\(/, `${f} still makes its own temp home`);
  }
});
