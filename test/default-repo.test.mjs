#!/usr/bin/env node
// The install-derived defaults (S-2083): a checkout at ~/projects/stam2 yields the repo key, path, file root and
// storage remote that were hard-coded before. Throwaway HOME and STAM_HOME: `node --test test/default-repo.test.mjs`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome, tempDir } from './tmphome.mjs';

const stamHome = tempHome('stam-defrepo-');
const home = tempDir('stam-defrepo-home-');
process.env.STAM_HOME = stamHome;
process.env.HOME = home;
let dr, st, files;
const checkout = () => realpathSync(join(home, 'projects', 'stam2'));

before(async () => {
  mkdirSync(join(home, 'projects', 'stam2'), { recursive: true });
  execFileSync('git', ['init', '-q', join(home, 'projects', 'stam2')]);
  dr = await import('../src/default-repo.ts');
  st = await import('../src/settings.ts');
  files = await import('../src/files.ts');
});

test('a checkout at ~/projects/stam2 derives the key stam2 and its own path', () => {
  assert.deepEqual(dr.derivedRepos(join(home, 'projects', 'stam2')), { stam2: checkout() });
  assert.deepEqual(st.defaultRepos(join(home, 'projects', 'stam2')), { stam2: checkout() });
  assert.equal(dr.derivedRepoParent(join(home, 'projects', 'stam2')), realpathSync(join(home, 'projects')));
});

test('another directory name keys the repo by that name; no checkout derives nothing', () => {
  mkdirSync(join(home, 'src', 'mootr'), { recursive: true });
  execFileSync('git', ['init', '-q', join(home, 'src', 'mootr')]);
  assert.deepEqual(Object.keys(dr.derivedRepos(join(home, 'src', 'mootr'))), ['mootr']);
  mkdirSync(join(home, 'plain'), { recursive: true });
  assert.deepEqual(dr.derivedRepos(join(home, 'plain')), {});
});

test('a release records its source repo in .release.json', () => {
  const rel = join(home, 'rel');
  mkdirSync(rel, { recursive: true });
  writeFileSync(join(rel, '.release.json'), JSON.stringify({ repo: join(home, 'projects', 'stam2') }));
  assert.deepEqual(dr.derivedRepos(rel), { stam2: checkout() });
});

test('prOpen.repo defaults to the first configured repo', () => {
  assert.equal(st.primaryRepoName({ repos: { stam2: '/a', other: '/b' }, prOpen: { repo: '' } }), 'stam2');
  assert.equal(st.primaryRepoName({ repos: { stam2: '/a', other: '/b' }, prOpen: { repo: 'other' } }), 'other');
  assert.equal(st.primaryRepoName({ repos: {}, prOpen: { repo: '' } }), '');
});

test('default file roots are the folder holding the running checkout plus attachments and worktrees; a registered repo adds none', () => {
  const parent = dr.derivedRepoParent();
  assert.deepEqual(files.defaultRoots(), [parent, join(stamHome, 'attachments'), join(stamHome, 'worktrees')]);
  // Kim's layout: a checkout at ~/projects/stam2 opens ~/projects.
  assert.equal(dr.derivedRepoParent(join(home, 'projects', 'stam2')), realpathSync(join(home, 'projects')));
  // An outside repo in itsa.repos does not open its siblings.
  const siblings = join(home, 'srv', 'repos');
  mkdirSync(join(siblings, 'app'), { recursive: true });
  mkdirSync(join(siblings, 'payroll'), { recursive: true });
  st.setSetting('itsa', { ...st.settings().itsa, repos: { app: join(siblings, 'app') } });
  mkdirSync(join(stamHome, 'attachments'), { recursive: true });
  assert.ok(!files.realRoots(null).includes(realpathSync(siblings)), 'the registered repo\'s parent is not a root');
});

test('storage remote: a named setting wins; else `storage` only with a storage peer configured', () => {
  assert.equal(st.storageRemoteFallback(['origin', 'storage']), '', 'a fresh install with no storage peer');
  assert.equal(st.storageRemoteFallback(['origin']), '');
  st.setSetting('peers', [{ name: 'storage', url: 'http://storage:7878', token: 't' }]);
  assert.equal(st.storageRemoteFallback(['origin', 'storage']), 'storage', 'Kim: storage peer and remote');
  assert.equal(st.storageRemoteFallback(['origin']), '');
  st.setSetting('itsa', { ...st.settings().itsa, prOpen: { ...st.settings().itsa.prOpen, storage: 'backup' } });
  assert.equal(st.storageRemoteFallback(['origin']), 'backup');
});

test('a repo the user configures comes before the derived default, and replaces it under the same name', () => {
  const derived = st.defaultRepos(join(home, 'projects', 'stam2'));
  assert.deepEqual(Object.keys(derived), ['stam2']);
  st.setSetting('itsa', { ...st.settings().itsa, repos: { mine: checkout() } });
  assert.equal(Object.keys(st.settings().itsa.repos)[0], 'mine');
});
