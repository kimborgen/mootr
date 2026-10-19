#!/usr/bin/env node
// Unit tests for the ITSA fields in the system prompt (S-367): the fields list, and the line
// about who changes columns, which names settings.chiefOfStaff and is never hard-coded.
// Throwaway STAM_HOME, no daemon. Run with `node --test test/itsa-fields-prompt.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-fields-prompt-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `fields-prompt-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

let db, itsa, owners, settings;
before(async () => {
  db = await import('../src/db.ts');
  settings = await import('../src/settings.ts');
  itsa = await import('../src/itsa.ts');
  owners = await import('../src/itsa-owners.ts');
  db.open();
  for (const [id, name] of [['c1', 'boss-agent'], ['w1', 'worker']])
    db.createAgent({ id, name, role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
});
after(() => rmSync(home, { recursive: true, force: true }));

test('no fields: the prompt has no fields list', () => {
  assert.equal(owners.fieldsPrompt(), '');
  assert.ok(!owners.itsaPrompt('w1').includes('Work page columns (ITSA fields) you fill'));
});

test('the fields list names key, label, type, choice options, and description', async () => {
  await itsa.createField({ key: 'stage', label: 'Stage', type: 'choice', options: [{ value: 'dev' }, { value: 'live' }], description: 'Where the work stands' }, null);
  await itsa.createField({ key: 'pr', label: 'PR', type: 'link' }, null);
  const p = owners.itsaPrompt('w1');
  assert.match(p, /`stage` · Stage · choice \(dev \| live\): Where the work stands/);
  assert.match(p, /`pr` · PR · link/);
});

test('no chief of staff: any agent may change fields, sparingly', () => {
  assert.match(owners.itsaPrompt('w1'), /No chief of staff is set, so any agent may .*`itsa_fields`.*sparingly/);
});

test('a non-cos agent is told to mail the chief of staff by name from settings', () => {
  settings.setSetting('chiefOfStaff', 'boss-agent');
  assert.match(owners.itsaPrompt('w1'), /Only the chief of staff \(@boss-agent\) adds, changes, or removes Work columns \(ITSA fields\); mail them to ask\./);
  settings.setSetting('chiefOfStaff', 'someone-else');
  assert.match(owners.itsaPrompt('w1'), /\(@someone-else\)/);
});

test('the chief of staff is told it owns the definitions', () => {
  settings.setSetting('chiefOfStaff', 'boss-agent');
  const p = owners.itsaPrompt('c1');
  assert.match(p, /You own the Work column definitions/);
  assert.ok(!p.includes('Only the chief of staff'));
});
