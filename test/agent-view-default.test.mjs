#!/usr/bin/env node
// The web UI's default view for an agent (S-173) in src/settings.ts: the conversation unless
// settings.json says terminal. Its own STAM_HOME; no daemon. `node --test test/agent-view-default.test.mjs`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-avd-');
process.env.STAM_HOME = home;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
const { settings, DEFAULTS } = await import('../src/settings.ts');

after(() => rmSync(home, { recursive: true, force: true }));

test('agents open in the conversation when settings.json names no agentView', () => {
  assert.equal(DEFAULTS.agentView.default, 'conversation');
  assert.equal(settings().agentView.default, 'conversation');
});

test("settings.json can keep the terminal as the default", () => {
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ agentView: { default: 'terminal' } }));
  assert.equal(settings().agentView.default, 'terminal');
});

test('an explicit conversation, or any other value, is the conversation', () => {
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ agentView: { default: 'conversation' } }));
  assert.equal(settings().agentView.default, 'conversation');
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ agentView: { default: 'bogus' } }));
  assert.equal(settings().agentView.default, 'conversation');
});
