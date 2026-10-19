#!/usr/bin/env node
// Retro reminders (S-710): the notices before an agent loses context carry the retro reminder when
// settings.retro.reminders.enabled, and not when it is off. The level-2 notice has it before the
// compact_self step. No daemon: `node --test test/retro-reminders.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-retro-reminders-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `retro-reminders-test-${process.pid}`;
const s = await import('../src/settings.ts');
const { render, renderWithRetro, withRetroReminder } = await import('../src/templates.ts');
const save = (obj) => { writeFileSync(join(home, 'settings.json'), JSON.stringify(obj)); s.settingsChanged(); };
const vars = { tokens: '300k', instruct: '400k', enforce: '500k', history: '/h' };
const notices = () => [
  withRetroReminder(render('context-warning', vars)),
  renderWithRetro('context-instruct', vars),
  withRetroReminder(render('compacted-forced', vars)),
  renderWithRetro('respawn-context-exit-self', {}),
  withRetroReminder(render('shutdown-prepare', {})),
];

test('default: enabled, every notice carries the reminder', () => {
  save({});
  assert.equal(s.settings().retro.reminders.enabled, true);
  for (const n of notices()) assert.match(n, /`retro`/);
});

test('level 2 and the context-exit respawn put the reminder before compact_self', () => {
  save({});
  for (const n of [renderWithRetro('context-instruct', vars), renderWithRetro('respawn-context-exit-self', {})]) {
    assert.ok(n.indexOf('`retro`') > 0 && n.indexOf('`retro`') < n.indexOf('compact_self'));
  }
});

test('disabled: no notice mentions retro, and the level 2 text is intact', () => {
  save({ retro: { reminders: { enabled: false } } });
  assert.equal(s.settings().retro.reminders.enabled, false);
  for (const n of notices()) assert.doesNotMatch(n, /retro/);
  assert.match(notices()[1], /Round off your current piece of work\.\n\nThen call/);
});
