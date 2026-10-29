#!/usr/bin/env node
// Both spellings of the default home are guarded (S-3347): after the move ~/.local/share/stam is a symlink to
// ~/.local/share/mootr, so a read through either path reaches the token and keys. Before the move the mootr path
// doesn't exist, and its rules cost nothing. Free: `node --test test/secret-homes.test.mjs`.
import './scrub-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tempDir } from './tmphome.mjs';

const home = tempDir('secret-homes-');
process.env.STAM_HOME = home;
const { DEFAULT_HOMES } = await import('../src/config.ts');
const { SECRET_FILES, secretPaths, secretCommandPatterns } = await import('../src/secret-files.ts');
const { denyRules, allowRules } = await import('../src/adapters/claude-permissions.ts');

const stam = join(homedir(), '.local', 'share', 'stam');
const mootr = join(homedir(), '.local', 'share', 'mootr');

test('DEFAULT_HOMES lists the stam and the mootr spelling, whichever exists', () => {
  assert.deepEqual(DEFAULT_HOMES, [stam, mootr]);
});

test('every secret file is denied by path under either spelling, to Read, Edit and Write', () => {
  const rules = denyRules();
  const paths = secretPaths();
  for (const h of [stam, mootr]) for (const f of SECRET_FILES) {
    assert.ok(paths.includes(`${h}/${f}`), `${h}/${f}`);
    for (const tool of ['Read', 'Edit', 'Write']) assert.ok(rules.includes(`${tool}(/${h}/${f})`), `${tool} ${h}/${f}`);
  }
});

test('the command text rules match either spelling', () => {
  const rules = denyRules();
  for (const f of SECRET_FILES) for (const dir of ['stam', 'mootr']) {
    assert.ok(secretCommandPatterns().includes(`*${dir}/${f}*`), `${dir}/${f}`);
    assert.ok(rules.includes(`Bash(*${dir}/${f}*)`), `${dir}/${f}`);
  }
  for (const dir of ['stam', 'mootr']) for (const f of ['stam.db', 'registry.json']) assert.ok(rules.includes(`Bash(*${dir}/${f}*)`), `${dir}/${f}`);
});

test('worktree screenshots are readable under either spelling', () => {
  const rules = allowRules();
  for (const h of [stam, mootr]) assert.ok(rules.includes(`Read(/${h}/worktrees/**/*.png)`), h);
});
