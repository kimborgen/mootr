#!/usr/bin/env node
// settings_ask conflict check (S-974): a patch applies when only keys it doesn't touch changed since
// the ask; a patch whose own key changed is refused. A whole-file save still needs the whole file
// unchanged. No daemon, no network: `node --test test/settings-ask-conflict.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-settings-ask-conflict-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `settings-ask-conflict-test-${process.pid}`;
const file = join(home, 'settings.json');
const s = await import('../src/settings.ts');
const p = await import('../src/permissions.ts');
const save = (obj) => { writeFileSync(file, JSON.stringify(obj)); s.settingsChanged(); };
const current = () => readFileSync(file, 'utf8');
const ask = (change) => p.settingsPayload(change, current());

test('a patch applies when only an untouched key changed since the ask', () => {
  save({ treeCheck: { enabled: false, everyHours: 1 }, context: { warnTokens: 111 } });
  const payload = ask({ kind: 'patch', patch: { treeCheck: { enabled: true, everyHours: 2 } }, fill: false });
  save({ treeCheck: { enabled: false, everyHours: 1 }, context: { warnTokens: 222 } });
  assert.equal(p.settingsUnchangedSince(payload, current()), true);
});

test('a patch is refused when a key it touches changed since the ask', () => {
  save({ treeCheck: { enabled: false, everyHours: 1 }, context: { warnTokens: 111 } });
  const payload = ask({ kind: 'patch', patch: { treeCheck: { enabled: true, everyHours: 2 } }, fill: false });
  save({ treeCheck: { enabled: false, everyHours: 3 }, context: { warnTokens: 111 } });
  assert.equal(p.settingsUnchangedSince(payload, current()), false);
});

test('a patch is refused when the key it sets was unset at the ask and is set since', () => {
  save({ context: { warnTokens: 111 } });
  const payload = ask({ kind: 'patch', patch: { treeCheck: { enabled: true } }, fill: true });
  save({ context: { warnTokens: 111 }, treeCheck: { enabled: false } });
  assert.equal(p.settingsUnchangedSince(payload, current()), false);
});

test('a view record patch applies when another id of the same record changed', () => {
  save({ boardViews: { a: { cols: 1 }, b: { cols: 2 } } });
  const payload = ask({ kind: 'patch', patch: { boardViews: { a: { cols: 3 } } }, fill: false });
  save({ boardViews: { a: { cols: 1 }, b: { cols: 9 } } });
  assert.equal(p.settingsUnchangedSince(payload, current()), true);
  save({ boardViews: { a: { cols: 4 }, b: { cols: 2 } } });
  assert.equal(p.settingsUnchangedSince(payload, current()), false);
});

test('the daemon-owned sub-key of a touched key does not count as a change', () => {
  save({ retro: { lastDigest: 'x', steward: { enabled: false } } });
  const payload = ask({ kind: 'patch', patch: { retro: { steward: { enabled: true } } }, fill: false });
  save({ retro: { lastDigest: 'y', steward: { enabled: false } } });
  assert.equal(p.settingsUnchangedSince(payload, current()), true);
});

test('a corrupt settings file refuses a patch, even one whose keys were unset at the ask', () => {
  save({ context: { warnTokens: 111 } });
  const payload = ask({ kind: 'patch', patch: { treeCheck: { enabled: true } }, fill: false });
  writeFileSync(file, '{ "context": ');
  assert.equal(p.settingsUnchangedSince(payload, current()), false);
});

test('a whole-file save still needs the whole file unchanged', () => {
  save({ context: { warnTokens: 111 }, treeCheck: { enabled: false } });
  const payload = ask({ kind: 'post', text: '{}' });
  save({ context: { warnTokens: 222 }, treeCheck: { enabled: false } });
  assert.equal(p.settingsUnchangedSince(payload, current()), false);
});

test('a request made before touched keys were kept falls back to the whole file', () => {
  save({ context: { warnTokens: 111 } });
  const payload = { change: { kind: 'patch', patch: { treeCheck: { enabled: true } }, fill: false }, baseHash: p.settingsPayload({ kind: 'post', text: '' }, current()).baseHash };
  save({ context: { warnTokens: 222 } });
  assert.equal(p.settingsUnchangedSince(payload, current()), false);
});
