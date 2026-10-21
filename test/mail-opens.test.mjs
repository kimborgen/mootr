#!/usr/bin/env node
// settings.mailOpens (S-2310): where Mail opens on the desktop; default the Inbox page, 'sidebar' the sidebar's Mail tab.
// Its own STAM_HOME; no daemon.
// `node --test test/mail-opens.test.mjs`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mail-opens-');
process.env.STAM_HOME = home;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
const { settings } = await import('../src/settings.ts');
after(() => rmSync(home, { recursive: true, force: true }));
const write = (v) => writeFileSync(join(home, 'settings.json'), JSON.stringify(v));

test('opens the Inbox page unless settings.json says sidebar', () => {
  assert.equal(settings().mailOpens, 'inbox');
});
test('settings.json can set sidebar, and the Inbox page again', () => {
  write({ mailOpens: 'sidebar' });
  assert.equal(settings().mailOpens, 'sidebar');
  write({ mailOpens: 'inbox' });
  assert.equal(settings().mailOpens, 'inbox');
});
test('any other value opens the Inbox page', () => {
  write({ mailOpens: 'tab' });
  assert.equal(settings().mailOpens, 'inbox');
  write({ mailOpens: true });
  assert.equal(settings().mailOpens, 'inbox');
});
