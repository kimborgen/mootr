#!/usr/bin/env node
// The Assistant tab's default (S-164) in src/settings.ts: 'assistant' unless settings.json names
// another assistant. Its own STAM_HOME; no daemon. `node --test test/assistant-default.test.mjs`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-ad-');
process.env.STAM_HOME = home;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
const { settings } = await import('../src/settings.ts');

after(() => rmSync(home, { recursive: true, force: true }));

test('the Assistant tab opens on the executive assistant when settings.json names none', () => {
  assert.equal(settings().assistantDefault, 'assistant');
});

test('settings.json can name a chief of staff\'s assistant', () => {
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ assistantDefault: ' intake ' }));
  assert.equal(settings().assistantDefault, 'intake');
});

test('an empty or non-text value keeps the executive assistant', () => {
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ assistantDefault: '   ' }));
  assert.equal(settings().assistantDefault, 'assistant');
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ assistantDefault: 3 }));
  assert.equal(settings().assistantDefault, 'assistant');
});
