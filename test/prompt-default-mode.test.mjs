#!/usr/bin/env node
// settings.promptDefaultMode (S-523): the mode the web prompt input starts in; default Mail,
// 'direct' switches it. Its own STAM_HOME; no daemon.
// `node --test test/prompt-default-mode.test.mjs`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-pdm-');
process.env.STAM_HOME = home;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
const { settings } = await import('../src/settings.ts');
after(() => rmSync(home, { recursive: true, force: true }));
const write = (v) => writeFileSync(join(home, 'settings.json'), JSON.stringify(v));

test('is mail unless settings.json says direct', () => {
  assert.equal(settings().promptDefaultMode, 'mail');
});
test('settings.json can set direct, and mail again', () => {
  write({ promptDefaultMode: 'direct' });
  assert.equal(settings().promptDefaultMode, 'direct');
  write({ promptDefaultMode: 'mail' });
  assert.equal(settings().promptDefaultMode, 'mail');
});
test('any other value keeps mail', () => {
  write({ promptDefaultMode: 'terminal' });
  assert.equal(settings().promptDefaultMode, 'mail');
  write({ promptDefaultMode: true });
  assert.equal(settings().promptDefaultMode, 'mail');
});
