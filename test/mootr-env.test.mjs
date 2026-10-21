#!/usr/bin/env node
// The MOOTR_ names with their STAM_ fallbacks (S-2889): reader precedence, the writer's both-names
// rule, the conflict log, and the data dir's default. Free and daemon-free: `node --test test/mootr-env.test.mjs`.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envVar, setEnvVar, entryValue, withMootrTwins } from '../src/env.ts';

const ROOT = join(import.meta.dirname, '..');
const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test('a reader takes the MOOTR_ name, else the STAM_ name', () => {
  assert.equal(envVar('HOME', { MOOTR_HOME: '/new' }), '/new', 'new name only');
  assert.equal(envVar('HOME', { STAM_HOME: '/old' }), '/old', 'old name only: a live daemon under the old env');
  assert.equal(envVar('HOME', { MOOTR_HOME: '/new', STAM_HOME: '/new' }), '/new', 'both, equal');
  assert.equal(envVar('HOME', {}), undefined, 'neither');
});

test('both set and differing: MOOTR_ wins, the conflict is logged once, and no value is logged', () => {
  const logged = [];
  const error = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const env = { MOOTR_TOKEN: 'new-secret-aaa', STAM_TOKEN: 'old-secret-bbb' };
    assert.equal(envVar('TOKEN', env), 'new-secret-aaa');
    assert.equal(envVar('TOKEN', env), 'new-secret-aaa');
  } finally {
    console.error = error;
  }
  assert.equal(logged.length, 1, 'once per name');
  assert.match(logged[0], /MOOTR_TOKEN and STAM_TOKEN are both set and differ/);
  assert.ok(!logged[0].includes('secret'), 'no value in the log');
});

test('a writer sets STAM_ only, or removes both names', () => {
  const env = { MOOTR_HOME: 'stale' };
  setEnvVar('HOME', '/x', env);
  assert.deepEqual(env, { STAM_HOME: '/x' }, 'no MOOTR_ name is written');
  setEnvVar('HOME', undefined, env);
  assert.equal('MOOTR_HOME' in env || 'STAM_HOME' in env, false);
});

test('the twin list names both spellings, for removing or forwarding', () => {
  assert.deepEqual(withMootrTwins(['STAM_TOKEN', 'OTHER']), ['STAM_TOKEN', 'MOOTR_TOKEN', 'OTHER']);
});

test('entries of a /proc environ dump: MOOTR_ first, then STAM_', () => {
  assert.equal(entryValue(['PATH=/bin', 'STAM_AGENT_ID=old'], 'AGENT_ID'), 'old', 'an older daemon\'s agent');
  assert.equal(entryValue(['STAM_AGENT_ID=old', 'MOOTR_AGENT_ID=new'], 'AGENT_ID'), 'new');
  assert.equal(entryValue(['PATH=/bin'], 'AGENT_ID'), undefined);
});

// The data dir default, resolved in a child with HOME set to a scratch folder, so the live home is never touched.
function resolvedHome(home, extra = {}) {
  const out = execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e',
    `const { STAM_HOME } = await import(${JSON.stringify(join(ROOT, 'src/config.ts'))}); console.log(STAM_HOME);`],
  { env: { PATH: process.env.PATH, HOME: home, ...extra }, encoding: 'utf8' });
  return out.trim();
}
function scratchHome(...existing) {
  const home = mkdtempSync(join(tmpdir(), 'mootr-env-home-'));
  dirs.push(home);
  for (const d of existing) mkdirSync(join(home, '.local', 'share', d), { recursive: true });
  return home;
}

test('the data dir default is unchanged: ~/.local/share/stam, with no new env', () => {
  const home = scratchHome();
  assert.equal(resolvedHome(home), join(home, '.local', 'share', 'stam'));
  const withStam = scratchHome('stam');
  assert.equal(resolvedHome(withStam), join(withStam, '.local', 'share', 'stam'));
});

test('an existing mootr data dir is used only when the stam one does not exist', () => {
  const onlyMootr = scratchHome('mootr');
  assert.equal(resolvedHome(onlyMootr), join(onlyMootr, '.local', 'share', 'mootr'));
  const both = scratchHome('mootr', 'stam');
  assert.equal(resolvedHome(both), join(both, '.local', 'share', 'stam'));
});

test('MOOTR_HOME and STAM_HOME override the default, MOOTR_HOME first', () => {
  const home = scratchHome('mootr');
  assert.equal(resolvedHome(home, { MOOTR_HOME: '/srv/m' }), '/srv/m');
  assert.equal(resolvedHome(home, { STAM_HOME: '/srv/s' }), '/srv/s');
  assert.equal(resolvedHome(home, { MOOTR_HOME: '/srv/m', STAM_HOME: '/srv/s' }), '/srv/m');
});
