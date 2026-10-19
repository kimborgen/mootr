import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ignoredTestOnlyEnv, testHome, testOnlyEnv } from '../src/test-env.ts';
import { tempDir } from './tmphome.mjs';

const base = tempDir('test-env-');
const mk = (name, { marker = true, owner = true } = {}) => {
  const dir = join(base, name);
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  if (marker) writeFileSync(join(home, '.stam-test-home'), '');
  if (owner) writeFileSync(join(dir, 'owner'), 'agent=x\n');
  return home;
};
const env = { STAM_TEST_HUMAN_KEY: 'k', STAM_TEST_HUMAN_CODE_DIR: '/x' };

test('honoured in a test home (marker and owner file)', () => {
  const h = mk('ok');
  assert.equal(testOnlyEnv('STAM_TEST_HUMAN_KEY', env, h, false), 'k');
  assert.equal(testOnlyEnv('STAM_TEST_HUMAN_CODE_DIR', env, h, false), '/x');
  assert.equal(testOnlyEnv('STAM_TEST_NOT_SET', env, h, false), undefined);
});
test('ignored on a custom home without the gate, and warned about', () => {
  for (const h of [mk('nomarker', { marker: false }), mk('noowner', { owner: false }), join(base, 'missing')]) {
    assert.equal(testOnlyEnv('STAM_TEST_HUMAN_KEY', env, h, false), undefined);
    assert.equal(testHome(h, false), false);
    assert.equal(ignoredTestOnlyEnv('STAM_TEST_HUMAN_KEY', env, h, false), true);
  }
});
test('ignored on the live home even with the gate', () => {
  const h = mk('live');
  assert.equal(testOnlyEnv('STAM_TEST_HUMAN_KEY', env, h, true), undefined);
  assert.equal(ignoredTestOnlyEnv('STAM_TEST_HUMAN_KEY', {}, h, false), false);
});
