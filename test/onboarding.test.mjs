#!/usr/bin/env node
// Unit test for src/onboarding.ts (S-2145): login checks read files and variables only, and the gaps come out in
// the order to walk them. `node --test test/onboarding.test.mjs`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onboardingStatus } from '../src/onboarding.ts';

const made = [];
const home = () => {
  const h = mkdtempSync(join(tmpdir(), 'stam-test.onboarding.'));
  made.push(h);
  return h;
};
after(() => {
  for (const h of made) rmSync(h, { recursive: true, force: true });
});
const touch = (h, rel) => {
  const f = join(h, rel);
  mkdirSync(join(f, '..'), { recursive: true });
  writeFileSync(f, '{}');
};
const base = (h, over = {}) => ({ versions: { claude: '2.0.0', codex: '1.0.0', opencode: null }, providers: 'unknown', localHuman: true, repos: { app: h }, cos: 'cos', home: h, env: {}, platform: 'linux', ...over });

test('a set-up install has no gaps, and a missing harness is not one', () => {
  const h = home();
  touch(h, '.claude/.credentials.json');
  const s = onboardingStatus(base(h));
  assert.equal(s.harnesses.claude.loggedIn, true);
  assert.equal(s.harnesses.codex.loggedIn, false);
  assert.equal(s.harnesses.opencode.installed, false);
  assert.deepEqual(s.gaps, []);
  assert.deepEqual(s.cos, { exists: true, name: 'cos' });
});

test('only the chief of staff is missing', () => {
  const h = home();
  touch(h, '.claude/.credentials.json');
  assert.deepEqual(onboardingStatus(base(h, { cos: null })).gaps, ['no chief of staff is running']);
});

test('a fresh install lists every gap in order', () => {
  const h = home();
  const s = onboardingStatus(base(h, { localHuman: false, repos: { app: join(h, 'missing') }, userRepoNames: ['app'], cos: null }));
  assert.deepEqual(s.gaps, [
    'no harness is installed and logged in',
    `repo app is missing at ${join(h, 'missing')}`,
    'no chief of staff is running',
  ]);
  assert.equal(s.providers, 'unknown');
});

test('localHuman off is no gap on a set-up install', () => {
  const h = home();
  touch(h, '.claude/.credentials.json');
  const s = onboardingStatus(base(h, { localHuman: false }));
  assert.deepEqual(s.gaps, []);
  assert.equal(s.network.localHuman, false);
});

test('the repo ensureSettings writes on a fresh install is no repo', () => {
  const h = home();
  touch(h, '.claude/.credentials.json');
  // A fresh settings file holds itsa.repos = defaultRepos(), which is the derived checkout.
  const s = onboardingStatus(base(h, { repos: { stam2: h }, derivedRepos: { stam2: h } }));
  assert.deepEqual(s.gaps, ['no repo is configured']);
  assert.equal(s.repos[0].derived, true);
});

test('a repo beside the derived one counts, and the derived one is matched by real path', () => {
  const h = home();
  touch(h, '.claude/.credentials.json');
  const link = join(h, 'link');
  symlinkSync(h, link);
  const other = join(h, 'other');
  mkdirSync(other);
  assert.deepEqual(onboardingStatus(base(h, { repos: { link: link }, derivedRepos: { stam2: h } })).gaps, ['no repo is configured']);
  assert.deepEqual(onboardingStatus(base(h, { repos: { stam2: h, mine: other }, derivedRepos: { stam2: h } })).gaps, []);
});

test('an API key variable and the config dirs count as a login', () => {
  const h = home();
  touch(h, 'cc/.credentials.json');
  touch(h, 'codexhome/auth.json');
  touch(h, 'xdg/opencode/auth.json');
  const env = { CLAUDE_CONFIG_DIR: join(h, 'cc'), CODEX_HOME: join(h, 'codexhome'), XDG_DATA_HOME: join(h, 'xdg') };
  const s = onboardingStatus(base(h, { env, versions: { claude: '1', codex: '1', opencode: '1' } }));
  for (const n of ['claude', 'codex', 'opencode']) assert.equal(s.harnesses[n].loggedIn, true, n);
  assert.equal(onboardingStatus(base(h, { env: { ANTHROPIC_API_KEY: 'x' } })).harnesses.claude.via, 'ANTHROPIC_API_KEY');
});

test('Claude on macOS is unknown, not logged out', () => {
  const h = home();
  const s = onboardingStatus(base(h, { platform: 'darwin' }));
  assert.equal(s.harnesses.claude.loggedIn, 'unknown');
  assert.equal(s.harnesses.codex.loggedIn, false);
  assert.ok(!s.gaps.includes('no harness is installed and logged in'));
});

test('no harness installed at all is a gap', () => {
  const h = home();
  assert.equal(onboardingStatus(base(h, { versions: { claude: null, codex: null } })).gaps[0], 'no harness is installed and logged in');
});
