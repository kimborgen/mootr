#!/usr/bin/env node
// The cardLayouts settings record (S-2776, S-1438 PR 1) merges per id, like workViews: writing the
// issue layout never clobbers the agent layout or another view record. No daemon, no network.
// Run: `node --test test/settings-card-layouts.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-card-layouts-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `card-layouts-test-${process.pid}`;
const s = await import('../src/settings.ts');

const text = (obj) => JSON.stringify(obj);
const read = (r) => JSON.parse(r.text);

test('a patch of the issue layout keeps the agent layout and the other views', () => {
  const before = text({ cardLayouts: { agent: { slots: { HEAD: ['cost'] } } }, workViews: { work: { cols: ['work'] } } });
  const r = read(s.patchedSettingsText(before, { cardLayouts: { issue: { slots: { TOP: ['kind'] } } } }));
  assert.deepEqual(r.cardLayouts, { agent: { slots: { HEAD: ['cost'] } }, issue: { slots: { TOP: ['kind'] } } });
  assert.deepEqual(r.workViews, { work: { cols: ['work'] } });
});

test('a patch of the agent layout keeps the issue layout', () => {
  const before = text({ cardLayouts: { issue: { slots: { META: ['status'] } } } });
  const r = read(s.patchedSettingsText(before, { cardLayouts: { agent: { hairline: false } } }));
  assert.deepEqual(r.cardLayouts, { issue: { slots: { META: ['status'] } }, agent: { hairline: false } });
});

test('a null for an id deletes that layout only', () => {
  const before = text({ cardLayouts: { issue: { seen: [] }, agent: { seen: [] } } });
  const r = read(s.patchedSettingsText(before, { cardLayouts: { issue: null } }));
  assert.deepEqual(r.cardLayouts, { agent: { seen: [] } });
});

test('a fill patch (a browser copy moving in) adds only the ids the file lacks', () => {
  const before = text({ cardLayouts: { issue: { seen: ['field:a'] } } });
  const r = read(s.patchedSettingsText(before, { cardLayouts: { issue: { seen: [] }, agent: { seen: [] } } }, true));
  assert.deepEqual(r.cardLayouts, { issue: { seen: ['field:a'] }, agent: { seen: [] } });
});

test('a patch with no file yet creates the record', () => {
  const r = read(s.patchedSettingsText('', { cardLayouts: { issue: { seen: [] } } }));
  assert.deepEqual(r.cardLayouts, { issue: { seen: [] } });
});
