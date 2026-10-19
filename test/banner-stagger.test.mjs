#!/usr/bin/env node
// The banners tick captures at most BANNER_CAPTURES_PER_TICK panes, the ones looked at longest ago (S-349 relook
// staggered). Counts the captures per tick, not time: `node --test test/banner-stagger.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BANNER_CAPTURES_PER_TICK, pickLooks } from '../src/banner-stagger.ts';

test('a tick captures no more than the cap, even when every pane is due', () => {
  const due = Array.from({ length: 300 }, (_, i) => ({ id: `p-${i}`, at: 0 }));
  assert.ok(pickLooks(due).length <= BANNER_CAPTURES_PER_TICK, `${pickLooks(due).length} captures in one tick`);
  assert.ok(BANNER_CAPTURES_PER_TICK <= 8, 'the cap is small enough that one tick is a few captures');
});

test('the oldest looks go first, and never-looked panes before any looked-at one', () => {
  const picked = pickLooks([{ id: 'new', at: 900 }, { id: 'old', at: 100 }, { id: 'never', at: 0 }, { id: 'mid', at: 500 }], 2);
  assert.deepEqual(picked.map((p) => p.id), ['never', 'old']);
});

test('with the cap, every due pane is looked at within ceil(due / cap) ticks, so none waits a whole relook period', () => {
  const panes = Array.from({ length: 40 }, (_, i) => ({ id: `p-${i}`, at: 0 }));
  const cap = 4;
  const looked = new Map(panes.map((p) => [p.id, 0]));
  for (let tick = 1; tick <= 10; tick++) {
    for (const p of pickLooks(panes.map((p) => ({ ...p, at: looked.get(p.id) })), cap)) looked.set(p.id, tick);
  }
  assert.ok([...looked.values()].every((t) => t > 0 && t <= Math.ceil(40 / cap)), 'a pane was passed over for too long');
});
